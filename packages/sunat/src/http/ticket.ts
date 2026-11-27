/**
 * Consulta de tickets del SIRE (plan 041, «ticket.ts»; spec CA-8, P-4 c). Puro y sin IO: interpreta la respuesta de
 * `consultaestadotickets` y fija el plan de espera. El registro se elige por `numTicket` EXACTO, nunca `registros[0]`.
 */
import { z } from "zod";
import { ErrorDatosSire, ErrorPortalSire } from "../errores.js";

export interface ParteTicket {
  /** `nomArchivoReporte` tal cual (el cliente valida su gramática antes de pedirlo). */
  nombre: string;
  codTipo: string | null;
}

export type EstadoTicket =
  | { listo: false }
  | { listo: true; codProceso: string; perTributario: string; partes: ParteTicket[] };

/** Tope de espera de un ticket dentro de un intento (P-4 c). */
export const TOPE_ESPERA_TICKET_MS = 20_000;

const PENDIENTES = new Set(["01", "02", "05"]);
const LISTOS = new Set(["04", "06"]);
const CON_ERRORES = "03";

const codTipo = z.string().nullable().optional();
const esquemaArchivo = z.object({
  nomArchivoReporte: z.string(),
  // El portal escribe `codTipoAchivoReporte` (sin «r»); algunas versiones, `codTipoArchivoReporte`.
  codTipoAchivoReporte: codTipo,
  codTipoArchivoReporte: codTipo,
});
const esquemaRegistro = z.object({
  numTicket: z.string(),
  codEstadoProceso: z.string(),
  codProceso: z.string().optional(),
  perTributario: z.string().optional(),
  archivoReporte: z.array(esquemaArchivo).nullable().optional(),
});
const esquemaCuerpo = z.object({ registros: z.array(z.unknown()) });
const conNumTicket = z.object({ numTicket: z.string() });

export function interpretarConsultaTicket(cuerpo: unknown, numTicket: string): EstadoTicket {
  const c = esquemaCuerpo.safeParse(cuerpo);
  if (!c.success) throw new ErrorPortalSire("respuesta_inesperada");

  let algunoIlegible = false;
  let nuestro: unknown;
  for (const r of c.data.registros) {
    const n = conNumTicket.safeParse(r);
    if (!n.success) {
      algunoIlegible = true;
      continue;
    }
    if (n.data.numTicket === numTicket) {
      nuestro = r;
      break;
    }
  }
  if (nuestro === undefined) {
    // Un registro sin `numTicket` legible podría ser el nuestro: la respuesta no se entiende.
    if (algunoIlegible) throw new ErrorPortalSire("respuesta_inesperada");
    throw new ErrorDatosSire("respuesta_ajena");
  }

  const r = esquemaRegistro.safeParse(nuestro);
  if (!r.success) throw new ErrorPortalSire("respuesta_inesperada");
  const reg = r.data;

  if (PENDIENTES.has(reg.codEstadoProceso)) return { listo: false };
  if (reg.codEstadoProceso === CON_ERRORES) throw new ErrorDatosSire("ticket_con_errores");
  if (!LISTOS.has(reg.codEstadoProceso)) throw new ErrorPortalSire("estado_desconocido");

  if (reg.codProceso === undefined || reg.perTributario === undefined) throw new ErrorPortalSire("respuesta_inesperada");
  const partes = (reg.archivoReporte ?? []).map<ParteTicket>((a) => ({
    nombre: a.nomArchivoReporte,
    codTipo: a.codTipoAchivoReporte ?? a.codTipoArchivoReporte ?? null,
  }));
  return { listo: true, codProceso: reg.codProceso, perTributario: reg.perTributario, partes };
}

/** Esperas (ms) entre consultas de un ticket pendiente: 0,5 / 1 / 2 / 4 s y luego 4 s hasta agotar el tope. */
export function planEsperaTicket(): readonly number[] {
  const plan: number[] = [];
  let suma = 0;
  let siguiente = 500;
  while (suma < TOPE_ESPERA_TICKET_MS) {
    const ms = Math.min(siguiente, TOPE_ESPERA_TICKET_MS - suma);
    plan.push(ms);
    suma += ms;
    siguiente = Math.min(siguiente * 2, 4000);
  }
  return plan;
}
