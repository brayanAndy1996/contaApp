// Ayudas de T5 (R-RED, R-NEW, R-GP, motor, aplicar). Solo construyen entradas con la API
// pública de 010/011; no es producción. Independiente de `filas.ts` (T4) para no pisarlo.
import { MontosComprobante } from "../../src/comprobante/index";
import type { ColumnaCompra } from "../../src/comprobante/index";
import { Money, TipoCambio } from "../../src/dinero/index";
import type { Moneda } from "../../src/dinero/index";
import type {
  CodigoRegla,
  ContextoReglas,
  FilaEvaluable,
  Hallazgo,
  ResumenXml,
} from "../../src/reglas/index";
import { evaluarReglas } from "../../src/reglas/index";
import { DICCIONARIO_GLOSAS_BASE } from "../../src/texto/index";

export const PROVEEDOR = { tipo: "6", numero: "20100000001" } as const;
export const COMPROBANTE = {
  tipo: "01",
  serie: "F001",
  numero: "123",
} as const;

export type ValoresMontos = Partial<Record<ColumnaCompra, string>> & {
  total: string;
};

export const montos = (moneda: Moneda, v: ValoresMontos): MontosComprobante =>
  MontosComprobante.desde(moneda, v);
export const pen = (s: string): Money => Money.desde(s, "PEN");
export const usd = (s: string): Money => Money.desde(s, "USD");
export const tc = (s: string): TipoCambio => TipoCambio.desde(s);

/** Fila PEN que cuadra y no dispara reglas: BI DG 100.00 + IGV DG 18.00, total 118.00. */
export function fila(over: Partial<FilaEvaluable> = {}): FilaEvaluable {
  return {
    id: "f1",
    proveedor: { ...PROVEEDOR },
    comprobante: { ...COMPROBANTE },
    montos: montos("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" }),
    ...over,
  };
}

/** XML que coincide con `fila()` por defecto. */
export function xml(over: Partial<ResumenXml> = {}): ResumenXml {
  return {
    proveedor: { ...PROVEEDOR },
    comprobante: { ...COMPROBANTE },
    moneda: "PEN",
    gravado: pen("100.00"),
    igv: pen("18.00"),
    noGravado: pen("0.00"),
    isc: pen("0.00"),
    icbper: pen("0.00"),
    total: pen("118.00"),
    glosas: [],
    ...over,
  };
}

/** Contexto donde el proveedor por defecto ya es conocido (R-NEW en silencio). */
export function ctx(over: Partial<ContextoReglas> = {}): ContextoReglas {
  return {
    proveedoresConocidos: [{ ...PROVEEDOR }],
    proveedoresIsc: [],
    diccionario: DICCIONARIO_GLOSAS_BASE,
    ...over,
  };
}

export function evaluar(
  filas: readonly FilaEvaluable[],
  c: ContextoReglas = ctx(),
) {
  return evaluarReglas(filas, c);
}

export function de(
  hallazgos: readonly Hallazgo[],
  regla: CodigoRegla,
): Hallazgo[] {
  return hallazgos.filter((h) => h.regla === regla);
}

/** El único hallazgo de `regla` (falla si hay 0 o más de 1). */
export function unico(
  hallazgos: readonly Hallazgo[],
  regla: CodigoRegla,
): Hallazgo {
  const l = de(hallazgos, regla);
  if (l.length !== 1)
    throw new Error(`se esperaba 1 hallazgo ${regla} y hay ${l.length}`);
  return l[0]!;
}

/** Serialización canónica (Money y MontosComprobante tienen toJSON) para comparar. */
export const ser = (o: unknown): string => JSON.stringify(o);

export function congelarProfundo<T>(o: T): T {
  if (typeof o === "object" && o !== null && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) congelarProfundo(v);
  }
  return o;
}
