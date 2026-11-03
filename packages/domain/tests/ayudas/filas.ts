// Ayudas de T4 (R-ISC, R-MIX, rango). Solo construyen entradas con la API pública de 010/011;
// no es producción. El monto total se calcula como Σ columnas para que la fila cuadre.
import { MontosComprobante } from "../../src/comprobante/index";
import type { ColumnaCompra } from "../../src/comprobante/index";
import { Money } from "../../src/dinero/index";
import type { Moneda } from "../../src/dinero/index";
import { evaluarReglas } from "../../src/reglas/index";
import type {
  CodigoRegla,
  ContextoReglas,
  FilaEvaluable,
  Hallazgo,
  ResumenXml,
} from "../../src/reglas/index";
import { DICCIONARIO_GLOSAS_BASE } from "../../src/texto/index";

export const PROV = { tipo: "6", numero: "20100070970" } as const;
export const COMP = { tipo: "01", serie: "F001", numero: "123" } as const;

export type Columnas = Partial<Record<ColumnaCompra, string>>;

/** MontosComprobante con total = Σ columnas (todas de la misma moneda). */
export function montosDe(moneda: Moneda, columnas: Columnas): MontosComprobante {
  const total = Money.suma(
    Object.values(columnas).map((v) => Money.desde(v, moneda)),
    moneda,
  );
  return MontosComprobante.desde(moneda, { ...columnas, total: total.toString() });
}

export const pen = (s: string): Money => Money.desde(s, "PEN");
export const usd = (s: string): Money => Money.desde(s, "USD");

/** Fila PEN con las columnas dadas; proveedor y comprobante por defecto. */
export function fila(
  columnas: Columnas,
  over: Partial<FilaEvaluable> & { moneda?: Moneda } = {},
): FilaEvaluable {
  const { moneda = "PEN", ...resto } = over;
  return {
    id: "f1",
    proveedor: { ...PROV },
    comprobante: { ...COMP },
    montos: montosDe(moneda, columnas),
    ...resto,
  };
}

/** XML cuya identidad coincide con la fila por defecto; montos en 0.00 salvo los dados. */
export function xmlDe(
  v: Partial<Record<"gravado" | "igv" | "noGravado" | "isc" | "icbper", string>> & {
    total?: string;
    moneda?: Moneda;
    glosas?: readonly string[];
  } = {},
): ResumenXml {
  const moneda = v.moneda ?? "PEN";
  const m = (s: string | undefined): Money => Money.desde(s ?? "0.00", moneda);
  const gravado = m(v.gravado);
  const igv = m(v.igv);
  const noGravado = m(v.noGravado);
  const isc = m(v.isc);
  const icbper = m(v.icbper);
  return {
    proveedor: { ...PROV },
    comprobante: { ...COMP },
    moneda,
    gravado,
    igv,
    noGravado,
    isc,
    icbper,
    total: v.total === undefined ? Money.suma([gravado, igv, noGravado, isc, icbper], moneda) : m(v.total),
    glosas: v.glosas ?? [],
  };
}

/** Contexto con el proveedor por defecto ya conocido (R-NEW en silencio). */
export function ctxBase(over: Partial<ContextoReglas> = {}): ContextoReglas {
  return {
    proveedoresConocidos: [{ ...PROV }],
    proveedoresIsc: [],
    diccionario: DICCIONARIO_GLOSAS_BASE,
    ...over,
  };
}

export function evaluar(filas: readonly FilaEvaluable[], ctx: ContextoReglas = ctxBase()) {
  return evaluarReglas(filas, ctx);
}

export function de(hallazgos: readonly Hallazgo[], regla: CodigoRegla): Hallazgo[] {
  return hallazgos.filter((h) => h.regla === regla);
}

/** El único hallazgo de `regla` (falla si hay 0 o más de 1). */
export function unico(hallazgos: readonly Hallazgo[], regla: CodigoRegla): Hallazgo {
  const l = de(hallazgos, regla);
  if (l.length !== 1) throw new Error(`se esperaba 1 hallazgo ${regla} y hay ${l.length}`);
  return l[0]!;
}

/** Sugerencia de tipo `tipo` (falla si es null o de otro tipo). */
export function sug<T extends NonNullable<Hallazgo["sugerencia"]>["tipo"]>(
  h: Hallazgo,
  tipo: T,
): Extract<NonNullable<Hallazgo["sugerencia"]>, { tipo: T }> {
  if (h.sugerencia === null || h.sugerencia.tipo !== tipo) {
    throw new Error(`se esperaba sugerencia ${tipo}`);
  }
  return h.sugerencia as Extract<NonNullable<Hallazgo["sugerencia"]>, { tipo: T }>;
}
