// Spec 012 · T14: rutas nuevas de empaquetar tras H-012-29 y H-012-30 (lectura única de nombres y
// fecha). Caso feliz y de error de cada una. Solo API pública.
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { EmpaquetadoInvalidoError, empaquetar } from "./index.js";

const TXT = "CONTAPP-PROVISIONAL-20700000002-202610-RCE.txt";
const ZIP = "CONTAPP-PROVISIONAL-20700000002-202610-RCE.zip";
const BYTES = Uint8Array.from([0x41, 0x0d, 0x0a]);
const FECHA = new Date("2026-10-27T16:00:00Z");

describe("empaquetar lee nombres y fecha una sola vez (H-012-29, H-012-30)", () => {
  it("nombres y fecha válidos dan el ZIP con la entrada nombreTxt; la fecha recibida no se muta", () => {
    const fecha = new Date(FECHA.getTime());
    const r = empaquetar(BYTES, { nombreTxt: TXT, nombreZip: ZIP }, fecha);
    expect(Object.keys(unzipSync(r.zip))).toEqual([TXT]);
    expect(r.nombreZip).toBe(ZIP);
    expect(fecha.getTime()).toBe(FECHA.getTime());
  });

  it("un objeto con el prototipo de Date que no es una Date real, o nombres que no son string, lanzan", () => {
    const falsa = Object.create(Date.prototype) as Date;
    expect(() => empaquetar(BYTES, { nombreTxt: TXT, nombreZip: ZIP }, falsa)).toThrow(EmpaquetadoInvalidoError);
    for (const nombres of [{ nombreTxt: 1, nombreZip: ZIP }, { nombreTxt: TXT, nombreZip: null }, { nombreTxt: TXT, nombreZip: TXT }]) {
      expect(() => empaquetar(BYTES, nombres as never, FECHA)).toThrow(EmpaquetadoInvalidoError);
    }
  });
});
