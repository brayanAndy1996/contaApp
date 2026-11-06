// Spec 012 · T13a · ronda adversarial 1a (caja negra) sobre `empaquetar` y el camino
// generarTxt → empaquetar. Solo la spec, los contratos del plan y la API pública.
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { MontosComprobante, generarTxt } from "@contapp/domain";
import type { CabeceraTxt, FilaReemplazo } from "@contapp/domain";
import { EmpaquetadoInvalidoError, empaquetar } from "./index.js";

const TXT = "CONTAPP-PROVISIONAL-20700000002-202610-RCE.txt";
const ZIP = "CONTAPP-PROVISIONAL-20700000002-202610-RCE.zip";
const FECHA = new Date("2026-10-27T16:00:00Z");
const CABECERA: CabeceraTxt = { rucDeclarante: "20700000002", periodo: "202610", libro: "compras" };
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function fila(i: number, usd: boolean): FilaReemplazo {
  const moneda = usd ? "USD" : "PEN";
  return {
    id: `f${i}`,
    estado: i % 7 === 0 ? "excluida" : "original",
    comprobante: { tipo: "01", serie: i % 2 ? "F001" : "f002", numero: String(i).padStart((i % 5) + 1, "0") },
    proveedor: { tipo: "6", numero: "20100070970", razonSocial: i % 3 ? "ÑANDÚ & CÍA S.A.C." : "ACME" },
    fechaEmision: `2026-${i % 2 ? "09" : "10"}-${String((i % 28) + 1).padStart(2, "0")}`,
    montos: MontosComprobante.desde(moneda, { biDg: "10.05", igvDg: "1.81", total: "11.86" }),
    tipoCambio: usd ? "3.759" : null,
    origenUsd: null,
  };
}

function barajar<T>(xs: readonly T[], semilla: number): T[] {
  const out = [...xs];
  let x = semilla >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const j = x % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Cuenta apariciones de una firma de 4 bytes. */
function contar(b: Uint8Array, firma: readonly number[]): number {
  let n = 0;
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === firma[0] && b[i + 1] === firma[1] && b[i + 2] === firma[2] && b[i + 3] === firma[3]) n++;
  }
  return n;
}

describe("R1a · empaquetar", () => {
  it("rechaza una entrada llamada .zip: nombreTxt = nombreZip = «…-RCE.zip» (el ZIP contendría otro .zip, no el TXT)", () => {
    expect(() => empaquetar(new Uint8Array([0x41]), { nombreTxt: ZIP, nombreZip: ZIP }, FECHA)).toThrow(EmpaquetadoInvalidoError);
  });

  it("de punta a punta: 1.000 filas (USD, ñ, excluidas) → ZIP; cualquier permutación da el mismo ZIP y hashes", () => {
    const filas = Array.from({ length: 1000 }, (_, i) => fila(i + 1, i % 2 === 0));
    const g = generarTxt(filas, CABECERA, { permitirProvisional: true });
    expect(g.lineas).toBe(1000 - Math.floor(1000 / 7));
    const a = empaquetar(g.bytes, { nombreTxt: g.nombreTxt, nombreZip: g.nombreZip }, FECHA);
    const entradas = unzipSync(a.zip);
    expect(Object.keys(entradas)).toEqual([g.nombreTxt]);
    expect(Array.from(entradas[g.nombreTxt]!)).toEqual(Array.from(g.bytes));
    expect(a.sha256Txt).toBe(sha256(g.bytes));
    expect(a.sha256Zip).toBe(sha256(a.zip));
    for (const s of [3, 11, 2026]) {
      const g2 = generarTxt(barajar(filas, s), CABECERA, { permitirProvisional: true });
      const b = empaquetar(g2.bytes, { nombreTxt: g2.nombreTxt, nombreZip: g2.nombreZip }, FECHA);
      expect(b.sha256Zip, `semilla ${s}`).toBe(a.sha256Zip);
      expect(b.sha256Txt).toBe(a.sha256Txt);
    }
  });

  it("estructura mínima: una cabecera local, una entrada central, sin campos extra ni comentarios, sin cifrado", () => {
    const { zip } = empaquetar(new Uint8Array([0x41, 0x0d, 0x0a]), { nombreTxt: TXT, nombreZip: ZIP }, FECHA);
    expect(contar(zip, [0x50, 0x4b, 0x03, 0x04])).toBe(1);
    expect(contar(zip, [0x50, 0x4b, 0x01, 0x02])).toBe(1);
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(v.getUint16(6, true) & 0x0001).toBe(0); // sin cifrado
    const largoNombre = v.getUint16(26, true);
    expect(v.getUint16(28, true)).toBe(0); // extra de la cabecera local
    expect(String.fromCharCode(...zip.slice(30, 30 + largoNombre))).toBe(TXT);
    const eocd = zip.length - 22;
    expect(v.getUint32(eocd, true)).toBe(0x06054b50);
    expect(v.getUint16(eocd + 10, true)).toBe(1); // entradas totales
    expect(v.getUint16(eocd + 20, true)).toBe(0); // comentario
  });

  it("un TXT que es una vista (subarray) de un búfer mayor empaqueta y hashea solo la vista", () => {
    const grande = new Uint8Array(64).map((_, i) => i);
    const vista = grande.subarray(10, 20);
    const r = empaquetar(vista, { nombreTxt: TXT, nombreZip: ZIP }, FECHA);
    expect(Array.from(unzipSync(r.zip)[TXT]!)).toEqual(Array.from(vista));
    expect(r.sha256Txt).toBe(sha256(Uint8Array.from(vista)));
  });

  it("los bordes del rango DOS (1980-01-01T00:00:00Z y 2107-12-31T23:59:59Z) se aceptan", () => {
    for (const f of ["1980-01-01T00:00:00Z", "2107-12-31T23:59:59Z"]) {
      expect(() => empaquetar(new Uint8Array([0x41]), { nombreTxt: TXT, nombreZip: ZIP }, new Date(f)), f).not.toThrow();
    }
  });
});
