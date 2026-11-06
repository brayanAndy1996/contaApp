// Spec 012 (T5, rojo): CA-1 y CA-2 con el JSON REAL de fixtures/sire/20700000002-compras-202610.json (009).
// Las mismas conclusiones que packages/domain/tests/casos-reales/prevalidacion.spec.ts, que usa las
// cifras copiadas a mano: si el fixture cambia, esta prueba lo detecta. Solo API pública de
// `@contapp/domain` (construido: `pnpm --filter @contapp/domain build`); sin BD ni red.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DICCIONARIO_GLOSAS_BASE,
  MontosComprobante,
  generarTxt,
  prevalidar,
  type FilaReemplazo,
} from "@contapp/domain";
import type { FilaPropuestaSire, PropuestaSire } from "../puertos.js";

const RUTA = join(__dirname, "..", "..", "..", "..", "fixtures", "sire", "20700000002-compras-202610.json");
const CABECERA = { rucDeclarante: "20700000002", periodo: "202610", libro: "compras" } as const;
const propuesta = JSON.parse(readFileSync(RUTA, "utf8")) as PropuestaSire;

/** FilaPropuestaSire (009) -> FilaReemplazo (012): el mapeo que 014 hará con sus versiones. */
function aFilaReemplazo(f: FilaPropuestaSire, over: Partial<FilaReemplazo> = {}): FilaReemplazo {
  return {
    id: `${f.serie}-${f.numero}`,
    estado: "original",
    comprobante: { tipo: f.tipo, serie: f.serie, numero: f.numero },
    proveedor: { tipo: "6", numero: f.rucContraparte },
    fechaEmision: f.fechaEmision,
    montos: MontosComprobante.desde(f.moneda, {
      biDg: f.biDg,
      igvDg: f.igvDg,
      biDgng: f.biDgng,
      igvDgng: f.igvDgng,
      biDng: f.biDng,
      igvDng: f.igvDng,
      noGravado: f.noGravado,
      isc: f.isc,
      icbper: f.icbper,
      otrosTributos: f.otros,
      total: f.total,
    }),
    tipoCambio: f.tipoCambio ?? null,
    origenUsd: null,
    ...over,
  };
}

const filas = propuesta.filas.map((f) => aFilaReemplazo(f));
const REGLAS = {
  proveedoresConocidos: filas.map((f) => ({ ...f.proveedor })),
  proveedoresIsc: [],
  diccionario: DICCIONARIO_GLOSAS_BASE,
};
const prev = (l: readonly FilaReemplazo[]) => prevalidar(l, { cabecera: CABECERA, reglas: REGLAS });

describe("fixture 009 de compras 202610", () => {
  it("es el que esperan las pruebas: periodo 202610 y las cinco facturas F001", () => {
    expect(propuesta.libro).toBe("compras");
    expect(propuesta.periodo).toBe("202610");
    expect(filas.map((f) => f.id)).toEqual(["F001-1040", "F001-2056", "F001-3064", "F001-4062", "F001-5070"]);
  });
});

describe("CA-1 · propuesta sin corregir (JSON real)", () => {
  const r = prev(filas);

  it("no es apta: el único error es el IGV de F001-2056, «1.61 no es 18 % ni 10 % de 21.48»", () => {
    expect(r.apto).toBe(false);
    expect(r.errores).toHaveLength(1);
    expect(r.errores[0]).toMatchObject({ filaId: "F001-2056", codigo: "IGV" });
    expect(r.errores[0]?.explicacion).toBe("1.61 no es 18 % ni 10 % de 21.48");
  });

  it("F001-1040 (San Juan) solo trae el aviso R-ISC; 3064, 4062 y 5070 no tienen errores", () => {
    expect(r.avisos.map((a) => [a.filaId, a.codigo])).toEqual([["F001-1040", "R-ISC"]]);
    for (const id of ["F001-1040", "F001-3064", "F001-4062", "F001-5070"]) {
      expect(r.errores.filter((e) => e.filaId === id)).toEqual([]);
    }
  });
});

describe("CA-2 · con las correcciones de 011 (JSON real)", () => {
  const corregidas = propuesta.filas.map((f) => {
    if (f.numero === "2056") {
      // mixta: gravado 8.97, IGV 1.61 y el resto (12.51) a no gravado
      return aFilaReemplazo({ ...f, biDg: "8.97", noGravado: "12.51" }, { estado: "modificada" });
    }
    if (f.numero === "1040") {
      // San Juan: la base de 770.00 es ISC
      return aFilaReemplazo({ ...f, biDg: "0.00", isc: "770.00" }, { estado: "modificada" });
    }
    return aFilaReemplazo(f);
  });

  it("es apta, sin errores ni avisos", () => {
    const r = prev(corregidas);
    expect(r.apto).toBe(true);
    expect(r.errores).toEqual([]);
    expect(r.avisos).toEqual([]);
  });

  it("generarTxt produce 5 líneas (formato provisional) y es determinista", () => {
    const a = generarTxt(corregidas, CABECERA, { permitirProvisional: true });
    const b = generarTxt([...corregidas].reverse(), CABECERA, { permitirProvisional: true });
    expect(a.lineas).toBe(5);
    expect(a.provisional).toBe(true);
    expect(Array.from(a.bytes)).toEqual(Array.from(b.bytes));
  });
});
