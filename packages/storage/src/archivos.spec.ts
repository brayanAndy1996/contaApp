// 012b T3: MockStorage y LocalStorage guardan y leen un .zip; sha256Hex; leerVerificado. Rojo.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ArchivoAlteradoError, ArchivoNoEncontradoError, RutaStorageError } from "./errores.js";
import { leerVerificado, sha256Hex } from "./hash.js";
import * as indice from "./index.js";
import { LocalStorage } from "./local.js";
import { MockStorage } from "./mock.js";
import type { StorageProvider } from "./puerto.js";
import { rutaArchivo } from "./ruta.js";

const raices: string[] = [];
afterAll(() => {
  for (const r of raices) rmSync(r, { recursive: true, force: true });
});

const fabricas: ReadonlyArray<[string, () => StorageProvider]> = [
  ["MockStorage", () => new MockStorage()],
  [
    "LocalStorage",
    () => {
      const raiz = mkdtempSync(join(tmpdir(), "storage-archivos-"));
      raices.push(raiz);
      return new LocalStorage(raiz);
    },
  ],
];

const nuevaRuta = (): string => rutaArchivo(randomUUID(), randomUUID(), randomUUID());
/** Cabecera de un ZIP (PK\x03\x04) seguida de todos los valores de byte. */
const zipDePrueba = (): Uint8Array =>
  Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...Array.from({ length: 256 }, (_, i) => i)]);

describe("sha256Hex · vectores conocidos", () => {
  it("texto: cadena vacía y «abc»", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("bytes: vacío, «abc» y valores no imprimibles", () => {
    expect(sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex(Uint8Array.from([0x61, 0x62, 0x63]))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex(Uint8Array.from([0x00, 0x01, 0x02, 0xff]))).toBe(
      "3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56",
    );
  });

  it("el texto se codifica en UTF-8 (no latin-1)", () => {
    expect(sha256Hex("Perú ñ €")).toBe("c1d6752a20dbbb7b21932a38fd079e10febd60ccc8b971a9d79b2fe5a8e93499");
    expect(sha256Hex("Perú")).toBe("32612cd3a2f923f59857786485237d3ca842fe65aec5de96076b58f9ac2de351");
    expect(sha256Hex("Perú")).not.toBe("77b8809b2dbd8aa61c1cc2d70c449b85c625baed03fe858042a9e2c748dfa018");
  });

  it("texto y sus bytes UTF-8 dan el mismo resultado", () => {
    expect(sha256Hex("Perú")).toBe(sha256Hex(new TextEncoder().encode("Perú")));
  });

  it("devuelve 64 hex en minúsculas", () => {
    expect(sha256Hex("cualquiera")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("respeta la vista (byteOffset) de un Uint8Array que comparte buffer", () => {
    const grande = Uint8Array.from([9, 9, 0x61, 0x62, 0x63, 9]);
    expect(sha256Hex(grande.subarray(2, 5))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe.each(fabricas)("%s · archivos/…zip", (_nombre, crear) => {
  it("guarda y lee un .zip con los mismos bytes", async () => {
    const s = crear();
    const ruta = nuevaRuta();
    await s.guardar(ruta, zipDePrueba());
    expect(Array.from(await s.leer(ruta))).toEqual(Array.from(zipDePrueba()));
  });

  it("eliminar borra el .zip y luego leer lanza ArchivoNoEncontradoError", async () => {
    const s = crear();
    const ruta = nuevaRuta();
    await s.guardar(ruta, zipDePrueba());
    await s.eliminar(ruta);
    await expect(s.leer(ruta)).rejects.toBeInstanceOf(ArchivoNoEncontradoError);
  });

  it("rechaza guardar una ruta archivos/…xml con RutaStorageError", async () => {
    const s = crear();
    const mala = nuevaRuta().replace(/\.zip$/, ".xml");
    await expect(s.guardar(mala, zipDePrueba())).rejects.toBeInstanceOf(RutaStorageError);
  });

  it("rechaza leer una ruta xml/…zip con RutaStorageError", async () => {
    const s = crear();
    const mala = `xml/${randomUUID()}/${randomUUID()}/${randomUUID()}.zip`;
    await expect(s.leer(mala)).rejects.toBeInstanceOf(RutaStorageError);
  });
});

describe.each(fabricas)("%s · leerVerificado", (_nombre, crear) => {
  it("devuelve los bytes si el SHA-256 coincide", async () => {
    const s = crear();
    const ruta = nuevaRuta();
    await s.guardar(ruta, zipDePrueba());
    const bytes = await leerVerificado(s, ruta, sha256Hex(zipDePrueba()));
    expect(Array.from(bytes)).toEqual(Array.from(zipDePrueba()));
  });

  it("lanza ArchivoAlteradoError si se alteró un byte", async () => {
    const s = crear();
    const ruta = nuevaRuta();
    const original = zipDePrueba();
    const hash = sha256Hex(original);
    const alterado = Uint8Array.from(original);
    alterado[100] = (alterado[100] ?? 0) ^ 0x01;
    await s.guardar(ruta, alterado);
    await expect(leerVerificado(s, ruta, hash)).rejects.toBeInstanceOf(ArchivoAlteradoError);
  });

  it("lanza ArchivoAlteradoError si se truncó un byte", async () => {
    const s = crear();
    const ruta = nuevaRuta();
    const original = zipDePrueba();
    const hash = sha256Hex(original);
    await s.guardar(ruta, original.subarray(0, original.length - 1));
    await expect(leerVerificado(s, ruta, hash)).rejects.toBeInstanceOf(ArchivoAlteradoError);
  });

  it("el mensaje del error no incluye la ruta ni el hash", async () => {
    const s = crear();
    const ruta = nuevaRuta();
    const hash = sha256Hex(zipDePrueba());
    await s.guardar(ruta, Uint8Array.from([1, 2, 3]));
    try {
      await leerVerificado(s, ruta, hash);
      throw new Error("se esperaba un error");
    } catch (e) {
      expect(e).toBeInstanceOf(ArchivoAlteradoError);
      const err = e as ArchivoAlteradoError;
      expect(err.message).not.toContain(ruta);
      expect(err.message).not.toContain(hash);
      expect(err.message).not.toContain(ruta.split("/")[3] ?? "x");
      expect(err.codigo).toBe("archivo_alterado");
    }
  });

  it("si el archivo no existe propaga ArchivoNoEncontradoError (no lo disfraza de alterado)", async () => {
    const s = crear();
    await expect(leerVerificado(s, nuevaRuta(), sha256Hex("x"))).rejects.toBeInstanceOf(ArchivoNoEncontradoError);
  });

  it("una ruta inválida lanza RutaStorageError", async () => {
    const s = crear();
    await expect(leerVerificado(s, "../etc/passwd", sha256Hex("x"))).rejects.toBeInstanceOf(RutaStorageError);
  });

  it("un hash esperado mal formado no verifica nada (ArchivoAlteradoError)", async () => {
    const s = crear();
    const ruta = nuevaRuta();
    await s.guardar(ruta, zipDePrueba());
    await expect(leerVerificado(s, ruta, "")).rejects.toBeInstanceOf(ArchivoAlteradoError);
    await expect(leerVerificado(s, ruta, "zz")).rejects.toBeInstanceOf(ArchivoAlteradoError);
  });

  it("acepta el hash esperado en mayúsculas", async () => {
    const s = crear();
    const ruta = nuevaRuta();
    await s.guardar(ruta, zipDePrueba());
    const bytes = await leerVerificado(s, ruta, sha256Hex(zipDePrueba()).toUpperCase());
    expect(bytes.length).toBe(zipDePrueba().length);
  });
});

describe("exportaciones públicas de @contapp/storage", () => {
  it("el índice exporta rutaArchivo, sha256Hex, leerVerificado y ArchivoAlteradoError", () => {
    expect(typeof indice.rutaArchivo).toBe("function");
    expect(typeof indice.sha256Hex).toBe("function");
    expect(typeof indice.leerVerificado).toBe("function");
    expect(indice.ArchivoAlteradoError).toBe(ArchivoAlteradoError);
  });
});
