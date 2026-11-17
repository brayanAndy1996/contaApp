// STUB (spec 023, T1).
/* eslint-disable @typescript-eslint/no-unused-vars */

export interface CandidatoCaptura {
  readonly clienteId: string;
  /** `null` = nunca se programó una captura. */
  readonly ultimaProgramadaEn: Date | null;
}

/** FNV-1a de 32 bits sobre el uuid en minúsculas, módulo 180: 0..179 minutos. */
export function desfaseCliente(_clienteId: string): number {
  throw new Error("no implementado: desfaseCliente");
}

/**
 * Última franja ≤ `ahora`: hora de Lima (UTC−5), 02:00 + desfase + k·frecuencia, sin pasar a la
 * ancla del día siguiente.
 */
export function ultimaFranja(_p: {
  readonly ahora: Date;
  readonly frecuenciaMin: number;
  readonly desfaseMin: number;
}): Date {
  throw new Error("no implementado: ultimaFranja");
}

export function capturaVencida(_p: {
  readonly ahora: Date;
  readonly frecuenciaMin: number;
  readonly clienteId: string;
  readonly ultimaProgramadaEn: Date | null;
}): boolean {
  throw new Error("no implementado: capturaVencida");
}

/** Ids de los vencidos: primero los nunca capturados, luego por franja más antigua e id; hasta `cupo`. */
export function seleccionarVencidos(
  _candidatos: readonly CandidatoCaptura[],
  _p: {
    readonly ahora: Date;
    readonly frecuenciaMin: number;
    readonly cupo: number;
  },
): string[] {
  throw new Error("no implementado: seleccionarVencidos");
}
