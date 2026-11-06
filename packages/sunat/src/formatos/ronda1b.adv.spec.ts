// Spec 012 · T13b · Ronda adversarial 1b (caja blanca) de empaquetar: getters que se leen dos
// veces, fechas límite del sello DOS, nombres no ASCII y el camino completo generarTxt → empaquetar.
// Las pruebas que fallan son hallazgos H-012-n (ver tasks.md, T13b); las que pasan quedan como
// regresión. Solo API pública.
import { createHash } from "node:crypto";
import { MontosComprobante, generarTxt } from "@contapp/domain";
import type { FilaReemplazo } from "@contapp/domain";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { EmpaquetadoInvalidoError, empaquetar } from "./index.js";
import type { Empaquetado } from "./index.js";

const TXT = "CONTAPP-PROVISIONAL-20700000002-202610-RCE.txt";
const ZIP = "CONTAPP-PROVISIONAL-20700000002-202610-RCE.zip";
const BYTES = Uint8Array.from([0x41, 0x7c, 0xd1, 0x0d, 0x0a]);
const FECHA = new Date("2026-10-27T16:00:00Z");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Sello DOS de la cabecera local (offset 0) y de la del directorio central, decodificados. */
function sellos(zip: Uint8Array): string[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const central = v.getUint32(zip.byteLength - 22 + 16, true);
  return [
    [10, 12],
    [central + 12, central + 14],
  ].map(([h, d]) => {
    const hora = v.getUint16(h as number, true);
    const dia = v.getUint16(d as number, true);
    const anio = (dia >> 9) + 1980;
    const mes = (dia >> 5) & 0x0f;
    const diaMes = dia & 0x1f;
    const p = (n: number) => String(n).padStart(2, "0");
    return `${anio}-${p(mes)}-${p(diaMes)}T${p(hora >> 11)}:${p((hora >> 5) & 0x3f)}:${p((hora & 0x1f) * 2)}`;
  });
}

/** Empaqueta y, si no lanza EmpaquetadoInvalidoError, devuelve el resultado. */
function intentar(nombres: unknown, fecha: unknown = FECHA): Empaquetado | null {
  try {
    return empaquetar(BYTES, nombres as { nombreTxt: string; nombreZip: string }, fecha as Date);
  } catch (e) {
    expect(e).toBeInstanceOf(EmpaquetadoInvalidoError);
    return null;
  }
}

describe("ronda 1b · empaquetar lee sus entradas una sola vez", () => {
  it("H-012-29 · un getter de nombreTxt que cambia tras la validación no mete `../` en la entrada del ZIP", () => {
    let lecturasTxt = 0;
    let lecturasZip = 0;
    const nombres = {
      get nombreTxt() {
        lecturasTxt++;
        return lecturasTxt === 1 ? TXT : "../../tmp/evil.txt";
      },
      get nombreZip() {
        lecturasZip++;
        return lecturasZip === 1 ? ZIP : "../../tmp/evil.zip";
      },
    };
    const r = intentar(nombres);
    if (r === null) return;
    expect(Object.keys(unzipSync(r.zip))).toEqual([TXT]);
    expect(r.nombreZip).toBe(ZIP);
  });

  it("H-012-30 · una fecha cuyo getUTCFullYear cambia tras la validación no escribe un año fuera del rango validado", () => {
    const fecha = new Date("2000-06-15T10:20:30Z");
    let llamadas = 0;
    Object.defineProperty(fecha, "getUTCFullYear", {
      value: () => {
        llamadas++;
        return llamadas === 1 ? 2000 : 2200;
      },
    });
    const r = intentar(NOMBRES_OK(), fecha);
    if (r === null) return;
    expect(sellos(r.zip)).toEqual(["2000-06-15T10:20:30", "2000-06-15T10:20:30"]);
  });
});

function NOMBRES_OK() {
  return { nombreTxt: TXT, nombreZip: ZIP };
}

describe("ronda 1b · fechas límite del sello DOS", () => {
  it("acepta 1980-01-01T00:00:00Z y 2107-12-31T23:59:59Z con sus campos UTC, y rechaza un milisegundo fuera", () => {
    const bajo = empaquetar(BYTES, NOMBRES_OK(), new Date("1980-01-01T00:00:00.000Z"));
    expect(sellos(bajo.zip)).toEqual(["1980-01-01T00:00:00", "1980-01-01T00:00:00"]);
    const alto = empaquetar(BYTES, NOMBRES_OK(), new Date("2107-12-31T23:59:59.999Z"));
    expect(sellos(alto.zip)).toEqual(["2107-12-31T23:59:58", "2107-12-31T23:59:58"]);
    expect(Object.keys(unzipSync(alto.zip))).toEqual([TXT]);
    for (const f of [
      new Date("1979-12-31T23:59:59.999Z"),
      new Date("2108-01-01T00:00:00.000Z"),
      new Date(Number.NaN),
      "2026-10-27T16:00:00Z",
      FECHA.getTime(),
    ]) {
      expect(() => empaquetar(BYTES, NOMBRES_OK(), f as Date)).toThrow(EmpaquetadoInvalidoError);
    }
  });
});

describe("ronda 1b · nombres no ASCII y casi iguales", () => {
  it("rechaza dígitos de ancho completo, homoglifos cirílicos, NFD, saltos de línea finales y extensiones en mayúsculas", () => {
    const base = "CONTAPP-PROVISIONAL-20700000002-202610-RCE";
    const variantes = [
      `CONTAPP-PROVISIONAL-２0700000002-202610-RCE`,
      `СONTAPP-PROVISIONAL-20700000002-202610-RCE`, // С cirílica
      `CONTAPP-PROVISIONAL-20700000002-202610-RCÉ`,
      `${base}​`,
    ];
    for (const v of variantes) {
      expect(() => empaquetar(BYTES, { nombreTxt: `${v}.txt`, nombreZip: `${v}.zip` }, FECHA)).toThrow(
        EmpaquetadoInvalidoError,
      );
    }
    for (const [t, z] of [
      [`${base}.txt\n`, `${base}.zip`],
      [`${base}.TXT`, `${base}.zip`],
      [`${base}.txt`, `${base}.ZIP`],
      [`${base}.txt`, `${base}.txt.zip`],
      [`dir/${base}.txt`, `dir/${base}.zip`],
    ]) {
      expect(() => empaquetar(BYTES, { nombreTxt: t as string, nombreZip: z as string }, FECHA)).toThrow(
        EmpaquetadoInvalidoError,
      );
    }
  });
});

describe("ronda 1b · generarTxt → empaquetar", () => {
  it("el TXT latin1 con tildes y eñes sale idéntico del ZIP, con los hashes calculados aparte y sin depender del huso", () => {
    const fila: FilaReemplazo = {
      id: "f1",
      estado: "original",
      comprobante: { tipo: "01", serie: "F001", numero: "123" },
      proveedor: { tipo: "6", numero: "20100070970", razonSocial: "ÑANDÚ ¡¿ÿ ÁÉÍÓÚ" },
      fechaEmision: "2026-10-05",
      montos: MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" }),
      tipoCambio: null,
      origenUsd: null,
    };
    const txt = generarTxt([fila], { rucDeclarante: "20700000002", periodo: "202610", libro: "compras" }, {
      permitirProvisional: true,
    });
    const r = empaquetar(txt.bytes, { nombreTxt: txt.nombreTxt, nombreZip: txt.nombreZip }, FECHA);
    const entradas = unzipSync(r.zip);
    expect(Object.keys(entradas)).toEqual([txt.nombreTxt]);
    expect([...(entradas[txt.nombreTxt] as Uint8Array)]).toEqual([...txt.bytes]);
    expect(txt.bytes.includes(0xd1)).toBe(true); // Ñ en un solo byte latin1
    expect(r.sha256Txt).toBe(sha256(txt.bytes));
    expect(r.sha256Zip).toBe(sha256(r.zip));
    const otra = empaquetar(Uint8Array.from(txt.bytes), { ...NOMBRES_OK() }, new Date(FECHA.getTime()));
    expect(otra.sha256Zip).toBe(r.sha256Zip);
  });
});
