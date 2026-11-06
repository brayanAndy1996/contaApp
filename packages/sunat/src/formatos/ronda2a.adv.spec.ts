// Spec 012 · T15a · Ronda adversarial 2a (caja negra) de empaquetar: lectura única de nombres,
// txt y fecha tras la corrección de H-012-29 y H-012-30. Solo spec, plan y API pública. Una prueba
// que falla es un hallazgo H-012-40 y siguientes (ver tasks.md, T15a).
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { EmpaquetadoInvalidoError, empaquetar } from "./index.js";
import type { Empaquetado } from "./index.js";

const TXT = "CONTAPP-PROVISIONAL-20700000002-202610-RCE.txt";
const ZIP = "CONTAPP-PROVISIONAL-20700000002-202610-RCE.zip";
const FECHA = new Date("2026-10-27T16:00:00Z");
const bytes = () => Uint8Array.from([0x41, 0x7c, 0xd1, 0x0d, 0x0a]);
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Empaqueta; si lanza, exige EmpaquetadoInvalidoError y devuelve null. */
function intentar(txt: unknown, nombres: unknown, fecha: unknown = FECHA): Empaquetado | null {
  try {
    return empaquetar(txt as Uint8Array, nombres as { nombreTxt: string; nombreZip: string }, fecha as Date);
  } catch (e) {
    expect(e, String(e)).toBeInstanceOf(EmpaquetadoInvalidoError);
    return null;
  }
}

/** El contenido del ZIP es exactamente lo que se hasheó como sha256Txt. */
function coherente(r: Empaquetado, esperado: Uint8Array) {
  const entradas = unzipSync(r.zip);
  expect(Object.keys(entradas)).toEqual([TXT]);
  const dentro = entradas[TXT] as Uint8Array;
  expect(sha256(dentro)).toBe(r.sha256Txt);
  expect([...dentro]).toEqual([...esperado]);
  expect(r.sha256Zip).toBe(sha256(r.zip));
}

describe("ronda 2a · empaquetar: lectura única de nombres", () => {
  it("un Proxy sobre `nombres` ve cada clave leída una sola vez, y el ZIP sale con lo que se validó", () => {
    const lecturas = new Map<PropertyKey, number>();
    const valores: Record<string, string[]> = { nombreTxt: [TXT, "../evil.txt"], nombreZip: [ZIP, "../evil.zip"] };
    const nombres = new Proxy({ nombreTxt: TXT, nombreZip: ZIP }, {
      get(t, k, r) {
        const n = (lecturas.get(k) ?? 0) + 1;
        lecturas.set(k, n);
        if (typeof k === "string" && k in valores) return valores[k]![Math.min(n, 2) - 1];
        return Reflect.get(t, k, r) as unknown;
      },
      getOwnPropertyDescriptor(t, k) {
        // Una lectura por descriptor también cuenta y devuelve el valor malicioso.
        const d = Reflect.getOwnPropertyDescriptor(t, k);
        if (d && typeof k === "string" && k in valores) return { ...d, value: valores[k]![1] };
        return d;
      },
    });
    const r = intentar(bytes(), nombres);
    if (r === null) return;
    expect(lecturas.get("nombreTxt")).toBe(1);
    expect(lecturas.get("nombreZip")).toBe(1);
    expect(r.nombreZip).toBe(ZIP);
    coherente(r, bytes());
  });
});

describe("ronda 2a · empaquetar: el txt que se hashea es el que se comprime", () => {
  it("un `length` propio que miente no separa el contenido del ZIP del sha256Txt", () => {
    const mentiroso = bytes();
    Object.defineProperty(mentiroso, "length", { get: () => 2 });
    const r = intentar(mentiroso, { nombreTxt: TXT, nombreZip: ZIP });
    if (r !== null) coherente(r, bytes());
  });

  it("un getter de nombres que muta el txt en medio de la operación no separa el ZIP del sha256Txt", () => {
    const txt = bytes();
    const nombres = {
      nombreTxt: TXT,
      get nombreZip() {
        txt[0] = 0x5a; // muta el TXT en medio de la operación
        return ZIP;
      },
    };
    const r2 = intentar(txt, nombres);
    if (r2 === null) return;
    const dentro = unzipSync(r2.zip)[TXT] as Uint8Array;
    expect(sha256(dentro)).toBe(r2.sha256Txt);
  });

  it("un txt que no es un Uint8Array real (ArrayBuffer, DataView, arreglo, texto, null o Proxy) da EmpaquetadoInvalidoError o un ZIP coherente", () => {
    const u = bytes();
    for (const txt of [u.buffer, new DataView(u.buffer), [...u], "A|B\r\n", null, new Proxy(u, {})]) {
      const r = intentar(txt, { nombreTxt: TXT, nombreZip: ZIP });
      if (r !== null) coherente(r, u);
    }
  });
});

describe("ronda 2a · empaquetar: la fecha es un instante leído una vez", () => {
  it("un objeto con Date.prototype pero sin ser Date, un Proxy de Date o un `valueOf` engañoso dan EmpaquetadoInvalidoError o el instante real", () => {
    const sinFecha = Object.create(Date.prototype) as Date;
    const proxy = new Proxy(new Date(FECHA.getTime()), {});
    const engano = new Date(FECHA.getTime());
    for (const m of ["getTime", "valueOf", "getUTCFullYear", "getUTCMonth", "getUTCDate", "getUTCHours", "toISOString"] as const) {
      Object.defineProperty(engano, m, { value: () => (m === "toISOString" ? "2200-01-01T00:00:00.000Z" : 2200) });
    }
    Object.defineProperty(engano, Symbol.toPrimitive, { value: () => 0 });
    expect(intentar(bytes(), { nombreTxt: TXT, nombreZip: ZIP }, sinFecha)).toBeNull();
    intentar(bytes(), { nombreTxt: TXT, nombreZip: ZIP }, proxy);
    const real = empaquetar(bytes(), { nombreTxt: TXT, nombreZip: ZIP }, FECHA);
    const r = intentar(bytes(), { nombreTxt: TXT, nombreZip: ZIP }, engano);
    if (r !== null) expect(r.sha256Zip).toBe(real.sha256Zip);
  });
});
