// STUB (spec 023, T1).
/* eslint-disable @typescript-eslint/no-unused-vars */
import type { CategoriaBuzon, MotivoCritico } from "./catalogo";

export interface EntradaClasificacion {
  readonly codigoTipo: string | null;
  readonly asunto: string;
}

export interface Clasificacion {
  readonly categoria: CategoriaBuzon;
  readonly critico: boolean;
  /** `null` solo cuando no es crítico. */
  readonly motivo: MotivoCritico | null;
  readonly versionCatalogo: number;
}

export function clasificarMensaje(
  _entrada: EntradaClasificacion,
): Clasificacion {
  throw new Error("no implementado: clasificarMensaje");
}
