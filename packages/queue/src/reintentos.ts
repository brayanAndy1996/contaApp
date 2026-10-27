// Reintentos con backoff exponencial y jitter (plan 008 "Worker", CA-8). Funciones puras.
import type { MotivoTrabajo } from "@contapp/shared";

export interface Clasificacion {
  clase: string;
  motivo: string;
}

export interface ContextoReintento {
  /** Reintentos ya consumidos antes de este fallo. */
  intentos: number;
  /** `config_sistema.reintentos`. */
  reintentos: number;
  baseMs: number;
  ahora: Date;
  azar?: () => number;
}

export type DecisionTrasError =
  | { accion: "reintentar"; intentos: number; disponibleDesde: Date }
  | { accion: "terminar"; motivo: MotivoTrabajo };

/** round(base · 2^(n−1) · (0.8 + 0.4·azar)), con n ≥ 1 el número de reintento (±20 %). */
export function calcularBackoffMs(
  n: number,
  baseMs: number,
  azar: () => number = Math.random,
): number {
  return Math.round(baseMs * 2 ** (n - 1) * (0.8 + 0.4 * azar()));
}

const SIN_REINTENTO: Readonly<Record<string, MotivoTrabajo>> = {
  credencial: "credencial_invalida",
  datos: "datos_invalidos",
  portal: "portal_cambio",
};

/** Credencial, datos y portal terminan siempre; el resto (transitorio o no clasificado) reintenta hasta el tope. */
export function decidirTrasError(
  clasificacion: Clasificacion,
  ctx: ContextoReintento,
): DecisionTrasError {
  if (Object.hasOwn(SIN_REINTENTO, clasificacion.clase)) {
    return {
      accion: "terminar",
      motivo: SIN_REINTENTO[clasificacion.clase]!,
    };
  }
  if (ctx.intentos < ctx.reintentos) {
    const n = ctx.intentos + 1;
    return {
      accion: "reintentar",
      intentos: n,
      disponibleDesde: new Date(
        ctx.ahora.getTime() + calcularBackoffMs(n, ctx.baseMs, ctx.azar),
      ),
    };
  }
  return { accion: "terminar", motivo: "sunat_no_responde" };
}
