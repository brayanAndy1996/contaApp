// Spec 016 (plan «Contratos: Dominio», CA-10, CA-11): qué XML pedir tras la descarga de la propuesta. Puro: sin IO ni reloj
// (un `pendiente` de más de 1 h ya llega como `transitorio` desde la capa de BD). Se piden las filas sin XML guardado y sin
// trabajo en vuelo (`pendiente`) ni fallo definitivo (`no_encontrado`, `credencial`: no se insiste sin que el usuario lo
// pida); primero las que tienen hallazgos, con el orden recibido dentro de cada grupo, en lotes de `tamLote`.
import { esEnteroPositivo } from "../texto/entero";
import type { Entero } from "../texto/index";

export type EstadoObtencion = "pendiente" | "no_encontrado" | "credencial" | "transitorio";

/** Una fila de `listarPorObtener`. */
export interface FilaPorObtener {
  readonly compraId: string;
  readonly conHallazgos: boolean;
  readonly tieneXml: boolean;
  readonly obtencion: EstadoObtencion | null;
}

export const TAM_LOTE_XML: Entero = 100;

const sePide = (f: FilaPorObtener): boolean => !f.tieneXml && (f.obtencion === null || f.obtencion === "transitorio");

/** Lotes de ids de compra a pedir (sin lotes vacíos). Lanza `RangeError` si `tamLote` no es un entero ≥ 1. */
export function planificarObtencionXml(filas: readonly FilaPorObtener[], tamLote: Entero = TAM_LOTE_XML): string[][] {
  if (!esEnteroPositivo(tamLote)) throw new RangeError("tamLote debe ser un entero mayor o igual que 1.");
  const pedidas = filas.filter(sePide);
  const orden = [...pedidas.filter((f) => f.conHallazgos), ...pedidas.filter((f) => !f.conHallazgos)].map((f) => f.compraId);
  const lotes: string[][] = [];
  for (let i = 0; i < orden.length; i += tamLote) lotes.push(orden.slice(i, i + tamLote));
  return lotes;
}
