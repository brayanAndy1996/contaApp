// Correlatividad de la numeración (spec 013, D7 y D8; CA-6 y CA-7). Función pura, sin IO ni `Date`.
// Agrupa por (tipo, serie); los faltantes son los huecos entre el menor y el mayor número presente
// y salen como rangos sin expandir (un salto de 99 999 999 es una sola entrada). Un número que no
// tiene de 1 a 8 dígitos es «no evaluable». Solo alerta: nunca lleva una bandera de bloqueo.
import { enteroDeDigitos } from "../texto/entero";
import type { Entero } from "../texto/entero";

export interface FilaNumeracion {
  readonly tipo: string;
  readonly serie: string;
  /** Tal como llegó: «290», «00291», «ABC». */
  readonly numero: string;
}

export interface Justificado {
  readonly tipo: string;
  readonly serie: string;
  readonly desde: Entero;
  readonly hasta: Entero;
  readonly comentario: string;
}

export type EstadoFaltante = "pendiente" | "justificado" | "parcial";

export interface Faltante {
  readonly desde: Entero;
  readonly hasta: Entero;
  readonly estado: EstadoFaltante;
  /** Solo cuando una única justificación cubre el faltante completo. */
  readonly comentario?: string;
}

export type EstadoSerie = "completa" | "con_faltantes" | "no_evaluable";

export interface SerieCorrelatividad {
  readonly tipo: string;
  readonly serie: string;
  readonly estado: EstadoSerie;
  readonly faltantes: readonly Faltante[];
  /** Cantidad de filas de la serie con un número que no es de 1 a 8 dígitos. */
  readonly noEvaluables: Entero;
}

export interface ResultadoCorrelatividad {
  readonly series: readonly SerieCorrelatividad[];
}

interface Grupo {
  readonly tipo: string;
  readonly serie: string;
  readonly numeros: Entero[];
  noEvaluables: Entero;
}

interface Rango {
  readonly desde: Entero;
  readonly hasta: Entero;
  readonly comentario: string;
}

const claveGrupo = (tipo: string, serie: string): string => JSON.stringify([tipo, serie]);

function comparar(a: string, b: string): -1 | 0 | 1 {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function esEntero(x: unknown): x is Entero {
  return typeof x === "number" && x % 1 === 0;
}

/** Justificaciones utilizables (enteros con desde <= hasta) de cada (tipo, serie), ordenadas por `desde`. */
function agruparJustificados(justificados: readonly Justificado[]): Map<string, Rango[]> {
  const porSerie = new Map<string, Rango[]>();
  for (const j of justificados) {
    if (!esEntero(j.desde) || !esEntero(j.hasta) || j.desde > j.hasta) continue;
    const k = claveGrupo(j.tipo, j.serie);
    const lista = porSerie.get(k);
    const rango: Rango = { desde: j.desde, hasta: j.hasta, comentario: j.comentario };
    if (lista === undefined) porSerie.set(k, [rango]);
    else lista.push(rango);
  }
  for (const lista of porSerie.values()) lista.sort((a, b) => (a.desde < b.desde ? -1 : a.desde > b.desde ? 1 : 0));
  return porSerie;
}

/** Estado de un hueco [desde, hasta] frente a las justificaciones (ordenadas por `desde`) de su serie. */
function estadoDelHueco(desde: Entero, hasta: Entero, justificaciones: readonly Rango[]): Faltante {
  let toca = false;
  let siguiente = desde; // primer número aún sin cubrir
  let cubierto = false;
  let sola: Rango | null = null;
  for (const j of justificaciones) {
    if (j.hasta < desde || j.desde > hasta) continue;
    toca = true;
    if (j.desde <= desde && j.hasta >= hasta && sola === null) sola = j;
    if (!cubierto && j.desde <= siguiente && j.hasta >= siguiente) {
      siguiente = j.hasta + 1;
      if (siguiente > hasta) cubierto = true;
    }
  }
  if (cubierto) {
    return sola === null ? { desde, hasta, estado: "justificado" } : { desde, hasta, estado: "justificado", comentario: sola.comentario };
  }
  return { desde, hasta, estado: toca ? "parcial" : "pendiente" };
}

function analizarGrupo(g: Grupo, justificaciones: readonly Rango[]): SerieCorrelatividad {
  const numeros = g.numeros.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const faltantes: Faltante[] = [];
  for (let i = 1; i < numeros.length; i++) {
    const antes = numeros[i - 1] as Entero;
    const ahora = numeros[i] as Entero;
    // Repetidos (duplicados, que trata 012) no inventan huecos; solo cuenta una distancia > 1.
    if (ahora - antes > 1) faltantes.push(estadoDelHueco(antes + 1, ahora - 1, justificaciones));
  }
  let estado: EstadoSerie;
  if (numeros.length === 0) estado = "no_evaluable";
  else estado = faltantes.length === 0 ? "completa" : "con_faltantes";
  return { tipo: g.tipo, serie: g.serie, estado, faltantes, noEvaluables: g.noEvaluables };
}

/**
 * Analiza la numeración de las filas del periodo. No muta las entradas. Las series salen ordenadas
 * por tipo y luego por serie (comparación de texto).
 */
export function analizarCorrelatividad(
  filas: readonly FilaNumeracion[],
  justificados: readonly Justificado[],
): ResultadoCorrelatividad {
  const grupos = new Map<string, Grupo>();
  for (const f of filas) {
    const k = claveGrupo(f.tipo, f.serie);
    let g = grupos.get(k);
    if (g === undefined) {
      g = { tipo: f.tipo, serie: f.serie, numeros: [], noEvaluables: 0 };
      grupos.set(k, g);
    }
    const n = enteroDeDigitos(f.numero);
    if (n === null) g.noEvaluables++;
    else g.numeros.push(n);
  }
  const porSerie = agruparJustificados(justificados);
  const ordenados = [...grupos.values()].sort((a, b) => comparar(a.tipo, b.tipo) || comparar(a.serie, b.serie));
  return {
    series: ordenados.map((g) => analizarGrupo(g, porSerie.get(claveGrupo(g.tipo, g.serie)) ?? [])),
  };
}
