// Validación de las presentaciones del PDT 621 de un periodo (spec 026, D-1 a D-3; H-026-2-1 y H-026-2-2). Las mismas reglas que
// `prorrata_declaraciones_registrar` (0066/0067) aplica a cada presentación, para que un defecto sea `ErrorDatos` del periodo
// («sin declaración») y no un 22023 que rechace toda la obtención: el mock la usa al inyectar y el worker con lo que entregue
// cualquier adaptador. Todo defecto es `ErrorDatos` con su mensaje fijo (nunca repite el RUC, montos ni datos recibidos).
import { ErrorDatos } from "./errores.js";
import type { Declaracion621 } from "./puertos.js";

/** Presentaciones por periodo: 12 × 100 = 1.200, el tope de la función acotada por obtención. */
export const MAX_PRESENTACIONES_621 = 100;

const RE_NUMERO_ORDEN = /^[0-9]{1,15}$/;
const RE_FECHA = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const RE_MONTO = /^-?[0-9]{1,12}(\.[0-9]{1,2})?$/;
const RE_PRORRATA = /^(100(\.0{1,2})?|[0-9]{1,2}(\.[0-9]{1,2})?)$/;
/** La BD guarda `fecha_presentacion` desde 1900-01-01. */
const ANIO_MINIMO = 1900;
const CAMPOS_MONTO_621 = [
  "ventasGravadasBase",
  "ventasGravadasIgv",
  "exportaciones",
  "noGravadas",
  "igvAdquisicionesDg",
  "igvAdquisicionesDgng",
] as const;

function esObjeto(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** AAAA-MM-DD que existe en el calendario, desde el año 1900. */
function fechaValida(f: string): boolean {
  const g = RE_FECHA.exec(f);
  if (g === null) return false;
  const [a, m, d] = [Number(g[1]), Number(g[2]), Number(g[3])];
  if (a < ANIO_MINIMO) return false;
  const t = new Date(Date.UTC(a, m - 1, d));
  return t.getUTCFullYear() === a && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Número de orden como número: sin ceros a la izquierda («01» y «1» son la misma presentación). */
function ordenCanonico(n: string): string {
  return n.replace(/^0+/, "");
}

function validarDeclaracion(x: unknown, periodo: string): Declaracion621 {
  if (!esObjeto(x)) throw new ErrorDatos();
  if (
    x.periodo !== periodo ||
    typeof x.numeroOrden !== "string" ||
    !RE_NUMERO_ORDEN.test(x.numeroOrden) ||
    ordenCanonico(x.numeroOrden) === "" || // número de orden 0
    typeof x.fechaPresentacion !== "string" ||
    !fechaValida(x.fechaPresentacion) ||
    (x.tipo !== "original" && x.tipo !== "rectificatoria") ||
    !(x.prorrataUsada === null || (typeof x.prorrataUsada === "string" && RE_PRORRATA.test(x.prorrataUsada)))
  )
    throw new ErrorDatos();
  for (const campo of CAMPOS_MONTO_621) {
    const v = x[campo];
    if (typeof v !== "string" || !RE_MONTO.test(v)) throw new ErrorDatos();
  }
  // Copia con exactamente los campos del contrato (sin claves extra del adaptador).
  return {
    periodo,
    numeroOrden: x.numeroOrden,
    fechaPresentacion: x.fechaPresentacion,
    tipo: x.tipo,
    ventasGravadasBase: x.ventasGravadasBase as string,
    ventasGravadasIgv: x.ventasGravadasIgv as string,
    exportaciones: x.exportaciones as string,
    noGravadas: x.noGravadas as string,
    igvAdquisicionesDg: x.igvAdquisicionesDg as string,
    igvAdquisicionesDgng: x.igvAdquisicionesDgng as string,
    prorrataUsada: x.prorrataUsada,
  };
}

/**
 * Valida las presentaciones del PDT 621 de `periodo` y devuelve una copia validada. Lanza `ErrorDatos` si la lista no es un arreglo,
 * pasa de {@link MAX_PRESENTACIONES_621}, alguna presentación no cumple (periodo, número de orden 1..15 dígitos y distinto de 0, fecha
 * real desde 1900, tipo, montos NUMERIC(14,2), prorrata usada) o dos tienen el mismo número de orden como número.
 */
export function validarDeclaraciones621(lista: unknown, periodo: string): Declaracion621[] {
  if (!Array.isArray(lista) || lista.length > MAX_PRESENTACIONES_621) throw new ErrorDatos();
  const salida = (lista as unknown[]).map((d) => validarDeclaracion(d, periodo));
  if (new Set(salida.map((d) => ordenCanonico(d.numeroOrden))).size !== salida.length) throw new ErrorDatos();
  return salida;
}
