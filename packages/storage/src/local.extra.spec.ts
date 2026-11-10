// LocalStorage: bordes que las pruebas de T3 no cubren (enlaces colgantes, directorios, raíz ausente).
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ArchivoNoEncontradoError, RutaStorageError, StorageIOError } from "./errores.js";
import { LocalStorage } from "./local.js";
import { rutaXml } from "./ruta.js";

let base: string;
let raiz: string;
const bases: string[] = [];
afterAll(() => {
  for (const b of bases) rmSync(b, { recursive: true, force: true });
});
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "storage-extra-"));
  bases.push(base);
  raiz = join(base, "raiz");
  mkdirSync(raiz);
});

const bytes = Uint8Array.from([1]);

describe("LocalStorage · bordes", () => {
  it("un directorio-enlace colgante se rechaza al guardar", async () => {
    const t = randomUUID();
    mkdirSync(join(raiz, "xml"));
    symlinkSync(join(base, "no-existe"), join(raiz, "xml", t), "dir");
    await expect(new LocalStorage(raiz).guardar(rutaXml(t, randomUUID(), randomUUID()), bytes)).rejects.toBeInstanceOf(
      RutaStorageError,
    );
  });

  it("un archivo-enlace colgante se rechaza al guardar", async () => {
    const [t, c, u] = [randomUUID(), randomUUID(), randomUUID()];
    mkdirSync(join(raiz, "xml", t, c), { recursive: true });
    symlinkSync(join(base, "no-existe.txt"), join(raiz, "xml", t, c, `${u}.xml`));
    await expect(new LocalStorage(raiz).guardar(rutaXml(t, c, u), bytes)).rejects.toBeInstanceOf(RutaStorageError);
  });

  it("leer sobre una raíz inexistente es «no encontrado»", async () => {
    const s = new LocalStorage(join(base, "nada"));
    await expect(s.leer(rutaXml(randomUUID(), randomUUID(), randomUUID()))).rejects.toBeInstanceOf(
      ArchivoNoEncontradoError,
    );
  });

  it("eliminar sobre una raíz inexistente no falla", async () => {
    const s = new LocalStorage(join(base, "nada"));
    await expect(s.eliminar(rutaXml(randomUUID(), randomUUID(), randomUUID()))).resolves.toBeUndefined();
  });

  it("leer algo que es un directorio es «no encontrado»", async () => {
    const [t, c, u] = [randomUUID(), randomUUID(), randomUUID()];
    mkdirSync(join(raiz, rutaXml(t, c, u)), { recursive: true });
    await expect(new LocalStorage(raiz).leer(rutaXml(t, c, u))).rejects.toBeInstanceOf(ArchivoNoEncontradoError);
  });

  it("eliminar un directorio falla con un error de E/S sin ruta", async () => {
    const [t, c, u] = [randomUUID(), randomUUID(), randomUUID()];
    const ruta = rutaXml(t, c, u);
    mkdirSync(join(raiz, ruta), { recursive: true });
    const e = await new LocalStorage(raiz).eliminar(ruta).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(StorageIOError);
    expect((e as Error).message).not.toContain(u);
  });

  it("un fallo del sistema al eliminar (bucle de enlaces) es un error de E/S sin ruta", async () => {
    const [t, c, u] = [randomUUID(), randomUUID(), randomUUID()];
    mkdirSync(join(raiz, "xml"));
    symlinkSync(join(raiz, "xml", t), join(raiz, "xml", t), "dir");
    const e = await new LocalStorage(raiz).eliminar(rutaXml(t, c, u)).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(StorageIOError);
    expect((e as Error).message).not.toContain(t);
  });
});
