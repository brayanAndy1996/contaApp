// Spec 012 · T16: copia única del TXT en empaquetar (H-012-42 y H-012-43). Las variantes
// adversariales están en ronda2a y ronda2b; aquí, el caso feliz y el de error. Solo API pública.
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { EmpaquetadoInvalidoError, empaquetar } from "./index.js";

const TXT = "CONTAPP-PROVISIONAL-20700000002-202610-RCE.txt";
const ZIP = "CONTAPP-PROVISIONAL-20700000002-202610-RCE.zip";
const FECHA = new Date("2026-10-27T16:00:00Z");
const nombres = () => ({ nombreTxt: TXT, nombreZip: ZIP });
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("empaquetar copia el TXT una sola vez (H-012-42, H-012-43)", () => {
  it("una vista parcial de un búfer mayor empaqueta solo sus bytes, y el ZIP y sha256Txt describen los mismos", () => {
    const buffer = Uint8Array.from([0x5a, 0x41, 0x7c, 0x42, 0x5a]);
    const vista = buffer.subarray(1, 4);
    const r = empaquetar(vista, nombres(), FECHA);
    const dentro = unzipSync(r.zip)[TXT] as Uint8Array;
    expect([...dentro]).toEqual([0x41, 0x7c, 0x42]);
    expect(r.sha256Txt).toBe(sha256(dentro));
    // El llamador muta su arreglo después: el resultado ya no depende de él.
    buffer[1] = 0x00;
    expect(r.sha256Txt).toBe(sha256(dentro));
  });

  it("un TypedArray que no es Uint8Array con su prototipo, un `length` que lanza o un búfer separado dan EmpaquetadoInvalidoError", () => {
    const disfrazado = Object.setPrototypeOf(Int8Array.from([0x41]), Uint8Array.prototype) as Uint8Array;
    const lanza = Uint8Array.from([0x41]);
    Object.defineProperty(lanza, "length", {
      get: () => {
        throw new Error("x");
      },
    });
    const separado = Uint8Array.from([0x41]);
    (separado.buffer as ArrayBuffer & { transfer(): ArrayBuffer }).transfer();
    for (const txt of [disfrazado, lanza, separado]) {
      expect(() => empaquetar(txt, nombres(), FECHA)).toThrow(EmpaquetadoInvalidoError);
    }
  });
});
