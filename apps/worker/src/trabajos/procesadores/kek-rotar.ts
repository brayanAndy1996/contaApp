// Trabajo de sistema `kek.rotar` (spec 008, D10, D18, CA-12). Enumera los estudios con `sistema.estudios_ids()` en una
// sola transacción de sistema (ya cerrada al rotar) y rota cada estudio con `rotarKekTenantDetalle` (003) en sus
// propias transacciones `withTenant`, EN SECUENCIA y nunca anidadas. Una fila corrupta no aborta: se cuenta en
// `corruptas` (la KEK anterior sigue necesaria). No crea filas en job_registro. Los logs llevan solo conteos.
import type { KeyUnwrapper, KeyWrapper } from "@contapp/crypto/descifrado";
import { estudiosIds, type ContappDb } from "@contapp/db";
import { rotarKekTenantDetalle } from "../../credenciales/rotar-kek.js";
import { loggerConsola, registrar, type LoggerTrabajos } from "../registro.js";

export interface OpcionesKekRotar {
  db: Pick<ContappDb, "withTenant" | "withSistema">;
  anterior: KeyUnwrapper;
  activa: KeyUnwrapper & KeyWrapper;
  desde: string;
  lote?: number;
  logger?: LoggerTrabajos;
}

export interface ResultadoKekRotar {
  estudios: number;
  reenvueltas: number;
  omitidas: number;
  corruptas: number;
}

export async function kekRotar(
  o: OpcionesKekRotar,
): Promise<ResultadoKekRotar> {
  const logger = o.logger ?? loggerConsola;
  const estudios = await o.db.withSistema((tx) => estudiosIds(tx));
  const r: ResultadoKekRotar = {
    estudios: 0,
    reenvueltas: 0,
    omitidas: 0,
    corruptas: 0,
  };
  for (const tenantId of estudios) {
    const d = await rotarKekTenantDetalle({
      db: o.db,
      anterior: o.anterior,
      activa: o.activa,
      tenantId,
      desde: o.desde,
      ...(o.lote === undefined ? {} : { lote: o.lote }),
    });
    r.estudios += 1;
    r.reenvueltas += d.reenvueltas;
    r.omitidas += d.omitidas;
    r.corruptas += d.corruptas.length;
  }
  registrar(logger, r.corruptas > 0 ? "warn" : "info", {
    evento: "kek_rotar_terminado",
    ...r,
  });
  return r;
}
