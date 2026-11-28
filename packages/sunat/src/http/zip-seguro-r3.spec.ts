// Spec 041 · T15f (CA-10): casos que la ronda adversarial 3 dejó sin cubrir en `zip-seguro.ts`: descriptor de datos en
// la entrada con datos (solo si coincide con la central) y campo extra que no es ZIP64 en la cabecera local.
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { capturarSync, esperarError } from "./pruebas/ayudas-http.js";
import { utf8 } from "./pruebas/ayudas-txt.js";
import { zipManual } from "./pruebas/zip-manual.js";
import { extraerTxtDeZip } from "./zip-seguro.js";

const B = "LE20700000002202610";
const ARCHIVO = `${B}/${B}.txt`;
const TXT = utf8("columna|otra\n1|2\n".repeat(50));
const VACIO = new Uint8Array(0);

const igual = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));
const seRechaza = (zip: Uint8Array): void =>
  esperarError(capturarSync(() => extraerTxtDeZip(zip)), "ErrorPortalSire", "zip_invalido");

/** Desplazamiento del descriptor de datos (la última `PK\x07\x08` del archivo; sin la marca de inicio). */
function posDescriptor(z: Uint8Array): number {
  const b = Buffer.from(z);
  return b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
}

describe("extraerTxtDeZip · descriptor de datos y campo extra (CA-10, T15f)", () => {
  it("la entrada con datos con descriptor que coincide con la central se lee (deflate y stored)", () => {
    const deflate = zipManual([{ nombre: ARCHIVO, datos: TXT, descriptor: true }, { nombre: `${B}/`, datos: VACIO, metodo: 0 }]);
    expect(igual(extraerTxtDeZip(deflate), TXT)).toBe(true);
    const guardado = zipManual([{ nombre: "x.txt", datos: TXT, metodo: 0, descriptor: true }]);
    expect(igual(extraerTxtDeZip(guardado), TXT)).toBe(true);
  });

  it("descriptor que no coincide con la central (CRC, comprimido, descomprimido o sin firma) se rechaza", () => {
    const base = zipManual([{ nombre: "x.txt", datos: TXT, descriptor: true }]);
    const d = posDescriptor(base);
    expect(d).toBeGreaterThan(0);
    for (const campo of [0, 4, 8, 12]) {
      const z = new Uint8Array(base);
      new DataView(z.buffer).setUint32(d + campo, (new DataView(z.buffer).getUint32(d + campo, true) ^ 1) >>> 0, true);
      seRechaza(z);
    }
  });

  it("la vacía ignorada con descriptor se rechaza aunque el descriptor diga 0", () => {
    seRechaza(zipManual([{ nombre: ARCHIVO, datos: TXT }, { nombre: ARCHIVO, datos: VACIO, metodo: 0, descriptor: true }]));
  });

  it("un campo extra que no es ZIP64 en la cabecera local no rechaza; uno ZIP64 sí", () => {
    const conExtra = zipSync({ "x.txt": [TXT, { extra: { 0x5455: new Uint8Array(5) } }] });
    expect(igual(extraerTxtDeZip(conExtra), TXT)).toBe(true);
    seRechaza(zipSync({ "x.txt": [TXT, { extra: { 0x0001: new Uint8Array(16) } }] }));
  });
});
