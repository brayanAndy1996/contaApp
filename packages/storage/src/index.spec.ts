// Selección STORAGE=mock|local y guarda de producción (como la de adaptadores de 009).
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ConfiguracionStorageError, LocalStorage, MockStorage, crearStorage, rutaXml } from "./index.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temporal = (): string => {
  const d = mkdtempSync(join(tmpdir(), "storage-env-"));
  dirs.push(d);
  return d;
};
const logger = () => ({ warn: vi.fn<(m: string) => void>() });

describe("crearStorage · selección", () => {
  it("sin STORAGE es MockStorage", () => {
    expect(crearStorage({})).toBeInstanceOf(MockStorage);
  });

  it("STORAGE=mock es MockStorage", () => {
    expect(crearStorage({ STORAGE: "mock" })).toBeInstanceOf(MockStorage);
  });

  it("STORAGE=local es LocalStorage y usa STORAGE_DIR como raíz", async () => {
    const dir = temporal();
    const s = crearStorage({ STORAGE: "local", STORAGE_DIR: dir });
    expect(s).toBeInstanceOf(LocalStorage);
    const ruta = rutaXml(randomUUID(), randomUUID(), randomUUID());
    await s.guardar(ruta, Uint8Array.from([1, 2]));
    expect(Array.from(readFileSync(join(dir, ruta)))).toEqual([1, 2]);
  });

  it("un valor no soportado falla nombrando la variable y sin imprimir el valor", () => {
    let error: unknown;
    try {
      crearStorage({ STORAGE: "s3-secreto" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfiguracionStorageError);
    const err = error as ConfiguracionStorageError;
    expect(err.codigo).toBe("configuracion_storage");
    expect(err.variable).toBe("STORAGE");
    expect(err.message).toContain("STORAGE");
    expect(err.message).not.toContain("s3-secreto");
  });
});

describe("crearStorage · guarda de producción", () => {
  it("mock en producción sin PERMITIR_ADAPTADORES_MOCK no arranca", () => {
    const l = logger();
    expect(() => crearStorage({ NODE_ENV: "production", STORAGE: "mock" }, l)).toThrow(
      ConfiguracionStorageError,
    );
    expect(l.warn).not.toHaveBeenCalled();
  });

  it("mock implícito (sin STORAGE) en producción tampoco arranca", () => {
    expect(() => crearStorage({ NODE_ENV: "production" }, logger())).toThrow(ConfiguracionStorageError);
  });

  it("el error de la guarda nombra STORAGE", () => {
    try {
      crearStorage({ NODE_ENV: "production", STORAGE: "mock" }, logger());
      throw new Error("se esperaba un error");
    } catch (e) {
      expect((e as Error).message).toContain("STORAGE");
      expect((e as Error).message).toContain("PERMITIR_ADAPTADORES_MOCK");
    }
  });

  it("PERMITIR_ADAPTADORES_MOCK distinto de «1» no habilita el mock", () => {
    expect(() =>
      crearStorage({ NODE_ENV: "production", STORAGE: "mock", PERMITIR_ADAPTADORES_MOCK: "true" }, logger()),
    ).toThrow(ConfiguracionStorageError);
  });

  it("con PERMITIR_ADAPTADORES_MOCK=1 arranca y avisa con un warn", () => {
    const l = logger();
    const s = crearStorage({ NODE_ENV: "production", STORAGE: "mock", PERMITIR_ADAPTADORES_MOCK: "1" }, l);
    expect(s).toBeInstanceOf(MockStorage);
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(l.warn.mock.calls[0]?.[0]).toContain("STORAGE");
  });

  it("local en producción arranca sin aviso", () => {
    const l = logger();
    const s = crearStorage({ NODE_ENV: "production", STORAGE: "local", STORAGE_DIR: temporal() }, l);
    expect(s).toBeInstanceOf(LocalStorage);
    expect(l.warn).not.toHaveBeenCalled();
  });

  it("fuera de producción el mock no avisa ni falla", () => {
    const l = logger();
    expect(crearStorage({ NODE_ENV: "development", STORAGE: "mock" }, l)).toBeInstanceOf(MockStorage);
    expect(crearStorage({ NODE_ENV: "test" }, l)).toBeInstanceOf(MockStorage);
    expect(l.warn).not.toHaveBeenCalled();
  });
});
