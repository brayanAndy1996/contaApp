// Spec 012 · T15b · Ronda adversarial 2b (caja blanca) de empaquetar tras H-012-29 y H-012-30:
// T14 lee una sola vez los nombres y toma el instante de la fecha con Date.prototype.getTime, pero
// `txt` se sigue leyendo a través de la instancia (fflate) y como bytes intrínsecos (node:crypto).
// Las dos que fallan confirman H-012-42 y H-012-43 de T15a (ver tasks.md, T15b); las que pasan
// quedan como regresión. Solo API pública.
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { EmpaquetadoInvalidoError, empaquetar } from "./index.js";
import type { Empaquetado } from "./index.js";

const TXT = "CONTAPP-PROVISIONAL-20700000002-202610-RCE.txt";
const ZIP = "CONTAPP-PROVISIONAL-20700000002-202610-RCE.zip";
const BYTES = Uint8Array.from([0x41, 0x7c, 0x42, 0x0d, 0x0a]);
const FECHA = new Date("2026-10-27T16:00:00Z");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const nombresOk = () => ({ nombreTxt: TXT, nombreZip: ZIP });

/** Empaqueta; si lanza, el error debe ser EmpaquetadoInvalidoError (Ratificación 14) y da null. */
function intentar(txt: unknown, nombres: unknown = nombresOk(), fecha: unknown = FECHA): Empaquetado | null {
  let r: Empaquetado | null = null;
  let error: unknown = null;
  try {
    r = empaquetar(txt as Uint8Array, nombres as { nombreTxt: string; nombreZip: string }, fecha as Date);
  } catch (e) {
    error = e;
  }
  if (error !== null) {
    expect(error).toBeInstanceOf(EmpaquetadoInvalidoError);
    return null;
  }
  return r;
}

/** Si empaqueta, el contenido descomprimido es el TXT cuyo hash se devuelve (CA-10). */
function coherente(r: Empaquetado | null): void {
  if (r === null) return;
  const entrada = unzipSync(r.zip)[TXT] as Uint8Array;
  expect(sha256(entrada)).toBe(r.sha256Txt);
  expect(sha256(r.zip)).toBe(r.sha256Zip);
}

describe("ronda 2b · empaquetar y el txt recibido", () => {
  it("H-012-43 (T15a, confirmado en caja blanca) · un Proxy de Uint8Array pasa `instanceof` y escapa un TypeError de TypedArray.prototype.length, no EmpaquetadoInvalidoError", () => {
    const proxy = new Proxy(Uint8Array.from(BYTES), {});
    coherente(intentar(proxy));
  });

  it("H-012-42 (T15a, confirmado en caja blanca) · un Uint8Array con `length` propio más corto: el ZIP lleva otros bytes que los del sha256Txt", () => {
    const corto = Uint8Array.from(BYTES);
    Object.defineProperty(corto, "length", { value: 2 });
    coherente(intentar(corto));
  });

  it("un Uint8Array cuyo `subarray`/`slice` propio cambia los bytes no desalinea el ZIP y el hash", () => {
    const raro = Uint8Array.from(BYTES);
    const otros = Uint8Array.from([0x5a, 0x5a, 0x5a, 0x5a, 0x5a]);
    Object.defineProperty(raro, "subarray", { value: () => otros });
    Object.defineProperty(raro, "slice", { value: () => otros });
    coherente(intentar(raro));
  });
});

describe("ronda 2b · regresión de la lectura única de nombres y fecha (T14)", () => {
  it("un Proxy de nombres se lee una vez por clave y la entrada del ZIP es la validada", () => {
    const lecturas = new Map<PropertyKey, number>();
    const nombres = new Proxy(nombresOk(), {
      get(t, k, rcv) {
        lecturas.set(k, (lecturas.get(k) ?? 0) + 1);
        return Reflect.get(t, k, rcv);
      },
    });
    const r = intentar(Uint8Array.from(BYTES), nombres);
    expect(r).not.toBeNull();
    expect(lecturas.get("nombreTxt")).toBe(1);
    expect(lecturas.get("nombreZip")).toBe(1);
    expect(Object.keys(unzipSync((r as Empaquetado).zip))).toEqual([TXT]);
  });

  it("una subclase de Date con getTime, getUTC* y Symbol.toPrimitive mentirosos sella el instante real; un Proxy de Date se rechaza", () => {
    class Mentirosa extends Date {
      override getTime() {
        return Date.UTC(2200, 0, 1);
      }
      override getUTCFullYear() {
        return 2200;
      }
      override getUTCHours() {
        return 23;
      }
    }
    Object.defineProperty(Mentirosa.prototype, Symbol.toPrimitive, { value: () => Date.UTC(2200, 0, 1) });
    const real = intentar(Uint8Array.from(BYTES), nombresOk(), FECHA) as Empaquetado;
    const mentirosa = intentar(Uint8Array.from(BYTES), nombresOk(), new Mentirosa(FECHA.getTime()));
    expect(mentirosa?.zip).toEqual(real.zip);
    expect(intentar(Uint8Array.from(BYTES), nombresOk(), new Proxy(new Date(FECHA.getTime()), {}))).toBeNull();
  });
});
