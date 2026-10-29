// Trabajo de sistema `auth.purgar` (spec 008, D10, D16, CA-13): `auth.purgar` (SECURITY DEFINER, solo contapp_worker) con
// las retenciones de D16 dentro de `withSistema`, y luego los job_registro terminados hace más de `trabajosDias`, en un
// `withTenant` por estudio, en secuencia. Toda retención se valida antes de tocar la BD: menos de un día falla con
// TrabajosRepoError 22023 sin borrar nada. No crea filas en job_registro. Los logs llevan solo conteos.
import {
  estudiosIds,
  purgarTerminados,
  purgarAuth,
  TrabajosRepoError,
  type ContappDb,
  type RetencionesAuth,
} from "@contapp/db";
import type { Reloj } from "@contapp/queue";
import { loggerConsola, registrar, type LoggerTrabajos } from "../registro.js";

/** D16: sesiones 30 días, tokens de recuperación 7, intentos de login 90, ventanas de límite 1. */
export const RETENCIONES_D16: Readonly<RetencionesAuth> = {
  sesionDias: 30,
  tokenDias: 7,
  intentoDias: 90,
  limiteDias: 1,
};
export const TRABAJOS_DIAS = 90;
const DIA_MS = 86_400_000;

export interface OpcionesAuthPurgar {
  db: Pick<ContappDb, "withTenant" | "withSistema">;
  retenciones?: RetencionesAuth;
  trabajosDias?: number;
  reloj?: Reloj;
  logger?: LoggerTrabajos;
}

export interface ResultadoAuthPurgar {
  sesiones: number;
  tokens: number;
  intentos: number;
  limites: number;
  trabajos: number;
}

const diasValidos = (n: unknown): boolean =>
  Number.isSafeInteger(n) && (n as number) >= 1 && (n as number) <= 36_500;

export async function authPurgar(
  o: OpcionesAuthPurgar,
): Promise<ResultadoAuthPurgar> {
  const ret = o.retenciones ?? RETENCIONES_D16;
  const trabajosDias = o.trabajosDias ?? TRABAJOS_DIAS;
  const dias = [
    ret.sesionDias,
    ret.tokenDias,
    ret.intentoDias,
    ret.limiteDias,
    trabajosDias,
  ];
  // Mismo código que el RAISE de auth.purgar (22023, invalid_parameter_value), antes de abrir ninguna transacción.
  if (!dias.every(diasValidos)) throw new TrabajosRepoError("22023");
  const logger = o.logger ?? loggerConsola;
  const ahora = (o.reloj ?? { ahora: () => new Date() }).ahora();

  const { conteos, estudios } = await o.db.withSistema(async (tx) => ({
    conteos: await purgarAuth(tx, ret),
    estudios: await estudiosIds(tx),
  }));
  const corte = new Date(ahora.getTime() - trabajosDias * DIA_MS);
  let trabajos = 0;
  for (const tenantId of estudios) {
    trabajos += await o.db.withTenant({ tenantId }, (tx) =>
      purgarTerminados(tx, corte),
    );
  }
  const r = { ...conteos, trabajos };
  registrar(logger, "info", { evento: "auth_purgar_terminado", ...r });
  return r;
}
