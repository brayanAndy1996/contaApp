/* eslint-disable @typescript-eslint/no-unused-vars */
// Stub de T4 (rojo): caché de CIIU por estudio (spec 027, R-14). Lo implementa T10.
import type { TxConsulta } from "../compras/errores";
import { NO_IMPLEMENTADO } from "./errores";

/** RUC sin fila en la caché del estudio o con `consultado_en` de más de 30 días (`clock_timestamp()`), sin repetir y en su orden. */
export async function ciiuPendientes(
  _tx: TxConsulta,
  _rucs: string[],
): Promise<string[]> {
  throw new Error(NO_IMPLEMENTADO);
}

/** `gnd_ciiu_guardar` (worker): hasta 50 entradas; `ciiu = null` es «sin dato». Devuelve cuántas guardó. */
export async function guardarCiiu(
  _tx: TxConsulta,
  _entradas: { ruc: string; ciiu: string | null }[],
): Promise<number> {
  throw new Error(NO_IMPLEMENTADO);
}
