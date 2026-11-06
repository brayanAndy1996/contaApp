// Resumen de compras por casillero: original frente a vigente (spec 014, D-8, RF-068, RF-069). Todo en
// Money (PEN). Las filas USD se convierten con convertirAPen de 010; las que no se pueden convertir salen
// en `filasSinConvertir` y no suman en ningún lado, igual que en resumirCambios de 012.
import { COLUMNAS_COMPRA, convertirAPen } from "../comprobante/index";
import type { ColumnaCompra, MontosComprobante } from "../comprobante/index";
import { Money } from "../dinero/index";
import { tipoCambioDe } from "../prevalidacion/aritmetica";
import { compararTexto } from "../prevalidacion/entrada";
import type { Entero } from "../texto/entero";

/** Las 10 columnas de 010 y el total, en PEN. */
export type Casilleros = Readonly<Record<ColumnaCompra | "total", Money>>;

export interface CompraResumen {
  readonly id: string;
  readonly origen: "sire" | "agregada";
  readonly excluida: boolean;
  readonly descartada: boolean;
  /** Versión 1, tal como la trajo el SIRE (o la agregada al crearla). */
  readonly original: MontosComprobante;
  /** Versión vigente. */
  readonly vigente: MontosComprobante;
}

export interface GrupoIgv {
  readonly n: Entero;
  readonly casilleros: Casilleros;
}

export interface ResumenCompras {
  readonly casilleros: {
    readonly original: Casilleros;
    readonly vigente: Casilleros;
    /** vigente − original. */
    readonly diferencia: Casilleros;
  };
  /** Sobre lo vigente: la suma de los tres IGV de la fila es distinta de 0.00. */
  readonly conIgv: GrupoIgv;
  /** Sobre lo vigente: la suma de los tres IGV de la fila es 0.00. */
  readonly sinIgv: GrupoIgv;
  /** Ids, sin repetir, por unidades de código. */
  readonly filasSinConvertir: readonly string[];
}

const CASILLEROS: readonly (ColumnaCompra | "total")[] = Object.freeze([...COLUMNAS_COMPRA, "total"] as const);
const CERO = Money.cero("PEN");

/** Montos en PEN, o `null` si es USD y no convierte (sin TC, TC inválido o montos que no cuadran). */
function enPen(m: MontosComprobante, tc: string | undefined): MontosComprobante | null {
  if (m.moneda === "PEN") return m;
  const tipo = tc === undefined ? null : tipoCambioDe(tc);
  if (tipo === null) return null;
  try {
    return convertirAPen(m, tipo);
  } catch {
    // Con un MontosComprobante USD real y un TipoCambio real solo puede ser descuadre o rango.
    return null;
  }
}

function sumar(lista: readonly MontosComprobante[]): Casilleros {
  const r = {} as Record<ColumnaCompra | "total", Money>;
  for (const c of CASILLEROS) {
    r[c] = Money.suma(lista.map((m) => (c === "total" ? m.total : m.obtener(c))), "PEN");
  }
  return Object.freeze(r);
}

function restar(a: Casilleros, b: Casilleros): Casilleros {
  const r = {} as Record<ColumnaCompra | "total", Money>;
  for (const c of CASILLEROS) r[c] = a[c].restar(b[c]);
  return Object.freeze(r);
}

function tieneIgv(m: MontosComprobante): boolean {
  return !Money.suma([m.obtener("igvDg"), m.obtener("igvDgng"), m.obtener("igvDng")], "PEN").igual(CERO);
}

/**
 * Original = versión 1 de las filas del SIRE (también las excluidas); las agregadas no están en el original.
 * Vigente = versión vigente sin excluidas ni descartadas (las agregadas vivas sí). Las descartadas no
 * suman en ningún lado. `tiposCambio` es id de la compra → tipo de cambio (cadena) y solo se consulta
 * para filas USD.
 */
export function resumirCompras(filas: readonly CompraResumen[], tiposCambio: ReadonlyMap<string, string>): ResumenCompras {
  const original: MontosComprobante[] = [];
  const vigente: MontosComprobante[] = [];
  const sinConvertir = new Set<string>();
  for (const f of filas) {
    if (f.descartada) continue;
    const tc = tiposCambio.get(f.id);
    const aOriginal = f.origen === "sire" ? enPen(f.original, tc) : undefined;
    const aVigente = f.excluida ? undefined : enPen(f.vigente, tc);
    if (aOriginal === null || aVigente === null) {
      sinConvertir.add(f.id);
      continue;
    }
    if (aOriginal !== undefined) original.push(aOriginal);
    if (aVigente !== undefined) vigente.push(aVigente);
  }
  const conIgv = vigente.filter(tieneIgv);
  const sinIgv = vigente.filter((m) => !tieneIgv(m));
  const casilleroOriginal = sumar(original);
  const casilleroVigente = sumar(vigente);
  return Object.freeze({
    casilleros: Object.freeze({
      original: casilleroOriginal,
      vigente: casilleroVigente,
      diferencia: restar(casilleroVigente, casilleroOriginal),
    }),
    conIgv: Object.freeze({ n: conIgv.length, casilleros: sumar(conIgv) }),
    sinIgv: Object.freeze({ n: sinIgv.length, casilleros: sumar(sinIgv) }),
    filasSinConvertir: Object.freeze([...sinConvertir].sort(compararTexto)),
  });
}
