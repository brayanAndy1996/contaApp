import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ErrorDatos } from "../errores.js";
import { leerFixtureXml, partesDeClave } from "./ruta-fixture.js";

// Spec 009 (D6): rutas de error de `leerFixtureXml` que el sistema de archivos real no produce sin
// privilegios (open/stat/realpath que fallan por otra causa). Para esas se sustituyen `open` y `realpath`;
// el resto de las pruebas usa el disco real.
const falsos = vi.hoisted(() => ({
  open: null as null | (() => Promise<unknown>),
  realpath: null as null | (() => Promise<string>),
}));
vi.mock("node:fs/promises", async (importar) => {
  const real = await importar<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: (...a: Parameters<typeof real.open>) =>
      falsos.open !== null ? falsos.open() : real.open(...a),
    realpath: (...a: Parameters<typeof real.realpath>) =>
      falsos.realpath !== null ? falsos.realpath() : real.realpath(...a),
  };
});

const CLAVE = "20700000011-01-F001-1040";
let raiz: string;
let dir: string;

beforeAll(() => {
  raiz = mkdtempSync(join(tmpdir(), "ruta-fixture-"));
  dir = join(raiz, "xml");
  mkdirSync(dir);
  writeFileSync(join(dir, `${CLAVE}.xml`), "<Invoice/>");
  // enlace que apunta a sí mismo: realpath da ELOOP, que no es «no existe»
  symlinkSync(join(dir, "20700000011-01-F001-2050.xml"), join(dir, "20700000011-01-F001-2050.xml"));
  writeFileSync(join(raiz, "archivo.txt"), "no es carpeta");
});
afterAll(() => rmSync(raiz, { recursive: true, force: true }));
afterEach(() => {
  falsos.open = null;
  falsos.realpath = null;
});

const atrapar = (p: Promise<unknown>): Promise<unknown> => p.then(
  () => {
    throw new Error("se esperaba un error");
  },
  (e: unknown) => e,
);

describe("leerFixtureXml · causas de fallo del disco", () => {
  it("lee un fixture existente", async () => {
    expect(await leerFixtureXml(dir, CLAVE)).toBe("<Invoice/>");
  });

  it("una clave que no es texto da ErrorDatos", () => {
    expect(() => partesDeClave(123 as never)).toThrow(ErrorDatos);
  });

  it("si la «carpeta» es un archivo (ENOTDIR) se trata como sin fixture", async () => {
    expect(await leerFixtureXml(join(raiz, "archivo.txt", "xml"), CLAVE)).toBeNull();
  });

  it("una carpeta imposible de resolver por otra causa es ErrorDatos", async () => {
    expect(await atrapar(leerFixtureXml(join(raiz, "a\0b"), CLAVE))).toBeInstanceOf(ErrorDatos);
  });

  it("un fixture que no se puede resolver por otra causa (ELOOP) es ErrorDatos", async () => {
    const e = await atrapar(leerFixtureXml(dir, "20700000011-01-F001-2050"));
    expect(e).toBeInstanceOf(ErrorDatos);
  });

  it("un error sin código (o que no es objeto) al resolver la carpeta es ErrorDatos", async () => {
    for (const fallo of [new Error("sin codigo"), "texto suelto"]) {
      falsos.realpath = () => Promise.reject(fallo);
      expect(await atrapar(leerFixtureXml(dir, CLAVE))).toBeInstanceOf(ErrorDatos);
    }
  });

  it("si open falla es ErrorDatos", async () => {
    falsos.open = () => Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    expect(await atrapar(leerFixtureXml(dir, CLAVE))).toBeInstanceOf(ErrorDatos);
  });

  it("si stat o la lectura fallan es ErrorDatos y el descriptor se cierra", async () => {
    const cerrar = vi.fn(() => Promise.resolve());
    falsos.open = () =>
      Promise.resolve({
        stat: () => Promise.reject(new Error("EIO")),
        readFile: () => Promise.reject(new Error("EIO")),
        close: cerrar,
      });
    expect(await atrapar(leerFixtureXml(dir, CLAVE))).toBeInstanceOf(ErrorDatos);
    expect(cerrar).toHaveBeenCalledTimes(1);
  });
});
