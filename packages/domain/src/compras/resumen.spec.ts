// Spec 014 · T1 (rojo). Resumen por casillero (D-8, RF-068, RF-069; CA-4, CA-9; casos San Juan y redondeo USD).
// Contrato fijado por estas pruebas (plan 014, Contratos: Dominio), en packages/domain/src/compras/resumen.ts,
// exportado por compras/index.ts:
//   type Casilleros = Readonly<Record<ColumnaCompra | "total", Money>>      // 10 columnas de 010 + total, en PEN
//   interface CompraResumen {
//     id: string; origen: "sire" | "agregada"; excluida: boolean; descartada: boolean;
//     original: MontosComprobante;   // versión 1 tal como la trajo el SIRE (o la agregada al crearla)
//     vigente: MontosComprobante;    // versión vigente
//   }
//   interface ResumenCompras {
//     casilleros: { original: Casilleros; vigente: Casilleros; diferencia: Casilleros };   // diferencia = vigente − original
//     conIgv: { n: number; casilleros: Casilleros };  sinIgv: { n: number; casilleros: Casilleros };  // sobre lo vigente
//     filasSinConvertir: readonly string[];            // ids, sin repetir, por unidades de código
//   }
//   resumirCompras(filas: readonly CompraResumen[], tiposCambio: ReadonlyMap<string, string>): ResumenCompras
//     // `tiposCambio`: id de la compra → tipo de cambio como cadena ("3.300"); solo se consulta para filas USD.
// - original = versión 1 de las filas del SIRE (también las excluidas); las agregadas no están en el original.
//   vigente = versión vigente sin excluidas ni descartadas (las agregadas vivas sí).
// - Filas USD: cada columna se convierte con convertirAPen de 010 (redondeo SUNAT por columna; el total es la
//   suma de las columnas convertidas). Si no se puede (sin TC en el mapa, TC inválido, montos que no cuadran),
//   el id va a `filasSinConvertir` y la fila no suma en ningún lado (ni original, ni vigente, ni con/sin IGV).
// - conIgv / sinIgv: la fila vigente cuenta en `conIgv` si igvDg + igvDgng + igvDng es distinta de 0.00 y en
//   `sinIgv` si es igual a 0.00; `n` es la cantidad de filas y `casilleros` sus sumas.
// - Todo en Money (PEN); ningún monto como number. Sin filas: todo en 0.00 y n = 0.
import { describe, expect, it } from "vitest";
import { MontosComprobante } from "../comprobante/index";
import { Money } from "../dinero/index";
import { montosDe } from "../../tests/ayudas/filas";
import type { Columnas } from "../../tests/ayudas/filas";
import { resumirCompras } from "./index";
import type { CompraResumen } from "./index";

const SIN_TC: ReadonlyMap<string, string> = new Map();
const compra = (id: string, original: Columnas, vigente: Columnas = original, over: Partial<CompraResumen> = {}): CompraResumen => ({
  id,
  origen: "sire",
  excluida: false,
  descartada: false,
  original: montosDe("PEN", original),
  vigente: montosDe("PEN", vigente),
  ...over,
});
const texto = (c: Record<string, Money>): Record<string, string> =>
  Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.toString()]));

const SAN_JUAN = { biDg: "770.00", igvDg: "0.00" };
const SAN_JUAN_CORREGIDA = { isc: "770.00" };
const SIMPLE = { biDg: "100.00", igvDg: "18.00", icbper: "1.50" }; // F001-3064
const OTRA = { biDg: "150.00", igvDg: "27.00" }; // F001-5070
const CERO = "0.00";

describe("resumirCompras: original frente a vigente (D-8)", () => {
  it("sin cambios: original = vigente y la diferencia es 0.00 en todo casillero", () => {
    const r = resumirCompras([compra("a", SIMPLE), compra("b", OTRA)], SIN_TC);
    expect(texto(r.casilleros.original)).toEqual(texto(r.casilleros.vigente));
    expect(Object.values(texto(r.casilleros.diferencia)).every((v) => v === CERO)).toBe(true);
  });

  it("suma cada casillero: BI, IGV, no gravado, ISC, ICBPER, otros y total", () => {
    const r = resumirCompras([compra("a", SIMPLE), compra("b", OTRA)], SIN_TC);
    expect(texto(r.casilleros.vigente)).toEqual({
      biDg: "250.00",
      igvDg: "45.00",
      biDgng: CERO,
      igvDgng: CERO,
      biDng: CERO,
      igvDng: CERO,
      noGravado: CERO,
      isc: CERO,
      icbper: "1.50",
      otrosTributos: CERO,
      total: "296.50",
    });
  });

  it("San Juan corregido: BI de DG −770.00 e ISC +770.00 frente a la original (CA-9)", () => {
    const r = resumirCompras([compra("sj", SAN_JUAN, SAN_JUAN_CORREGIDA), compra("b", OTRA)], SIN_TC);
    const d = texto(r.casilleros.diferencia);
    expect(d.biDg).toBe("-770.00");
    expect(d.isc).toBe("770.00");
    expect(d.total).toBe(CERO);
    expect(d.igvDg).toBe(CERO);
    expect(texto(r.casilleros.original).biDg).toBe("920.00");
    expect(texto(r.casilleros.vigente).biDg).toBe("150.00");
    expect(texto(r.casilleros.vigente).isc).toBe("770.00");
  });

  it("clasificar F001-3064 como DNG mueve BI e IGV a las columnas 3 y el total no cambia (CA-4)", () => {
    const r = resumirCompras([compra("a", SIMPLE, { biDng: "100.00", igvDng: "18.00", icbper: "1.50" })], SIN_TC);
    const d = texto(r.casilleros.diferencia);
    expect([d.biDg, d.igvDg, d.biDng, d.igvDng, d.total]).toEqual(["-100.00", "-18.00", "100.00", "18.00", CERO]);
  });

  it("todos los casilleros son Money, nunca number", () => {
    const r = resumirCompras([compra("a", SIMPLE)], SIN_TC);
    for (const grupo of [r.casilleros.original, r.casilleros.vigente, r.casilleros.diferencia, r.conIgv.casilleros, r.sinIgv.casilleros]) {
      expect(Object.keys(grupo).sort()).toEqual(
        ["biDg", "biDgng", "biDng", "icbper", "igvDg", "igvDgng", "igvDng", "isc", "noGravado", "otrosTributos", "total"].sort(),
      );
      for (const v of Object.values(grupo)) expect(v).toBeInstanceOf(Money);
    }
  });

  it("sin filas: todo en 0.00, n = 0 y nada sin convertir", () => {
    const r = resumirCompras([], SIN_TC);
    for (const grupo of [r.casilleros.original, r.casilleros.vigente, r.casilleros.diferencia, r.conIgv.casilleros, r.sinIgv.casilleros]) {
      expect(Object.values(texto(grupo)).every((v) => v === CERO)).toBe(true);
    }
    expect([r.conIgv.n, r.sinIgv.n, r.filasSinConvertir]).toEqual([0, 0, []]);
  });

  it("no muta la entrada ni el mapa de tipos de cambio", () => {
    const filas = Object.freeze([Object.freeze(compra("a", SIMPLE))]);
    expect(() => resumirCompras(filas, SIN_TC)).not.toThrow();
  });
});

describe("resumirCompras: excluidas, agregadas y descartadas", () => {
  it("una excluida del SIRE cuenta en el original pero no en el vigente", () => {
    const r = resumirCompras([compra("a", SIMPLE), compra("z", OTRA, OTRA, { excluida: true })], SIN_TC);
    expect(texto(r.casilleros.original).total).toBe("296.50");
    expect(texto(r.casilleros.vigente).total).toBe("119.50");
    expect(texto(r.casilleros.diferencia).total).toBe("-177.00");
  });

  it("excluida: sale también de con/sin IGV", () => {
    const r = resumirCompras([compra("z", OTRA, OTRA, { excluida: true })], SIN_TC);
    expect([r.conIgv.n, r.sinIgv.n]).toEqual([0, 0]);
  });

  it("una agregada viva suma solo en el vigente", () => {
    const r = resumirCompras([compra("a", SIMPLE), compra("n", OTRA, OTRA, { origen: "agregada" })], SIN_TC);
    expect(texto(r.casilleros.original).total).toBe("119.50");
    expect(texto(r.casilleros.vigente).total).toBe("296.50");
    expect(texto(r.casilleros.diferencia).total).toBe("177.00");
  });

  it("una agregada descartada no suma en ningún lado ni cuenta como excluida", () => {
    const r = resumirCompras([compra("a", SIMPLE), compra("n", OTRA, OTRA, { origen: "agregada", descartada: true })], SIN_TC);
    expect(texto(r.casilleros.original).total).toBe("119.50");
    expect(texto(r.casilleros.vigente).total).toBe("119.50");
    expect(r.conIgv.n + r.sinIgv.n).toBe(1);
  });
});

describe("resumirCompras: con y sin IGV por separado, con su cantidad (CA-9)", () => {
  const filas = [
    compra("sj", SAN_JUAN, SAN_JUAN_CORREGIDA), // IGV 0.00 → sin IGV
    compra("a", SIMPLE), // IGV 18.00 → con IGV
    compra("b", OTRA), // IGV 27.00 → con IGV
  ];

  it("cuenta cada grupo", () => {
    const r = resumirCompras(filas, SIN_TC);
    expect(r.conIgv.n).toBe(2);
    expect(r.sinIgv.n).toBe(1);
  });

  it("suma cada grupo sobre lo vigente", () => {
    const r = resumirCompras(filas, SIN_TC);
    expect(texto(r.conIgv.casilleros).total).toBe("296.50");
    expect(texto(r.conIgv.casilleros).igvDg).toBe("45.00");
    expect(texto(r.sinIgv.casilleros).total).toBe("770.00");
    expect(texto(r.sinIgv.casilleros).isc).toBe("770.00");
    expect(texto(r.sinIgv.casilleros).igvDg).toBe(CERO);
  });

  it("los dos grupos suman el total vigente", () => {
    const r = resumirCompras(filas, SIN_TC);
    const suma = r.conIgv.casilleros.total.sumar(r.sinIgv.casilleros.total);
    expect(suma.toString()).toBe(r.casilleros.vigente.total.toString());
  });

  it("se clasifica por la fila vigente, no por la original", () => {
    const r = resumirCompras([compra("x", { biDg: "100.00", igvDg: "18.00" }, { biDg: "100.00", igvDg: "0.00" })], SIN_TC);
    expect([r.conIgv.n, r.sinIgv.n]).toEqual([0, 1]);
  });

  it("«con IGV» es la suma de los tres IGV: +5.00 y −5.00 suman 0.00 y la fila va en «sin IGV»", () => {
    const r = resumirCompras([compra("x", { biDg: "50.00", igvDg: "5.00", biDng: "-50.00", igvDng: "-5.00" })], SIN_TC);
    expect([r.conIgv.n, r.sinIgv.n]).toEqual([0, 1]);
  });

  it("el IGV en DGNG o DNG también cuenta como «con IGV»", () => {
    const r = resumirCompras([compra("x", { biDgng: "100.00", igvDgng: "18.00" }), compra("y", { biDng: "100.00", igvDng: "18.00" })], SIN_TC);
    expect([r.conIgv.n, r.sinIgv.n]).toEqual([2, 0]);
  });
});

describe("resumirCompras: filas en USD (RF-069; redondeo F001-4062)", () => {
  const usd = (id: string, columnas: Columnas = { biDg: "0.15", igvDg: "0.03" }, over: Partial<CompraResumen> = {}): CompraResumen => ({
    id,
    origen: "sire",
    excluida: false,
    descartada: false,
    original: montosDe("USD", columnas),
    vigente: montosDe("USD", columnas),
    ...over,
  });
  const TC = new Map([["u", "3.300"]]);

  it("convierte por columna con redondeo SUNAT: 0.15 × 3.300 = 0.50 y 0.03 × 3.300 = 0.10", () => {
    const r = resumirCompras([usd("u")], TC);
    const v = texto(r.casilleros.vigente);
    expect([v.biDg, v.igvDg]).toEqual(["0.50", "0.10"]);
    expect(r.filasSinConvertir).toEqual([]);
  });

  it("el total es la suma de las columnas convertidas (0.60), no el total USD convertido (0.59)", () => {
    const r = resumirCompras([usd("u")], TC);
    expect(texto(r.casilleros.vigente).total).toBe("0.60");
    expect(texto(r.casilleros.original).total).toBe("0.60");
  });

  it("la fila USD convertida suma con las PEN y entra en «con IGV»", () => {
    const r = resumirCompras([usd("u"), compra("b", OTRA)], TC);
    expect(texto(r.casilleros.vigente).total).toBe("177.60");
    expect(r.conIgv.n).toBe(2);
  });

  it("sin tipo de cambio en el mapa: sale en filasSinConvertir y no suma", () => {
    const r = resumirCompras([usd("u"), compra("b", OTRA)], SIN_TC);
    expect(r.filasSinConvertir).toEqual(["u"]);
    expect(texto(r.casilleros.vigente).total).toBe("177.00");
    expect(texto(r.casilleros.original).total).toBe("177.00");
    expect(r.conIgv.n + r.sinIgv.n).toBe(1);
  });

  it.each(["0", "0.000", "abc", "", "-3.300", "3.3333", "12345.000"])("tipo de cambio inválido (%j): sin convertir", (tc) => {
    const r = resumirCompras([usd("u")], new Map([["u", tc]]));
    expect(r.filasSinConvertir).toEqual(["u"]);
    expect(texto(r.casilleros.vigente).total).toBe(CERO);
  });

  it("montos USD que no cuadran no se pueden convertir: sin convertir", () => {
    // total 0.20 con Σ 0.18: no cuadra y convertirAPen lo rechaza.
    const descuadrada = MontosComprobante.desde("USD", { biDg: "0.15", igvDg: "0.03", total: "0.20" });
    const r = resumirCompras([usd("u", undefined, { original: descuadrada, vigente: descuadrada })], TC);
    expect(r.filasSinConvertir).toEqual(["u"]);
    expect(texto(r.casilleros.vigente).total).toBe(CERO);
  });

  it("filasSinConvertir sin repetir y por unidades de código", () => {
    const r = resumirCompras([usd("b"), usd("B"), usd("a")], SIN_TC);
    expect(r.filasSinConvertir).toEqual(["B", "a", "b"]);
  });

  it("un tipo de cambio de más para una fila PEN no cambia nada", () => {
    const r = resumirCompras([compra("a", SIMPLE)], new Map([["a", "3.300"]]));
    expect(texto(r.casilleros.vigente).total).toBe("119.50");
    expect(r.filasSinConvertir).toEqual([]);
  });
});
