// Soporte de las pruebas de 017 del worker (T4): notificador de la prueba contra el puerto nuevo, lecturas de
// `notificacion` y `auditoria` con la conexión administrativa y la cancelación de trabajos que se quedan `en_cola`.
// No es código de producción ni una prueba. Las limpiezas COMUNES (`Escenario.limpiar` de test/trabajos.ts) son de T2:
// aquí solo se borran, antes de delegar en ellas, las filas de 017 de los estudios de cada archivo (modo replica: el trigger
// de inmutabilidad de `auditoria` bloquea el DELETE incluso al superusuario) en una conexión que se destruye al terminar.
//
// CONTRATO del puerto que fijan las pruebas de T4 (lo implementa T9), en apps/worker/src/trabajos/:
// - `registro.ts`: `interface Notificador { avisar(tenantId: string, usuarioIds: string[]): Promise<void> }`. `NotificadorLog`,
//   `AvisoCredencialInvalida` y `credencialInvalida` desaparecen.
// - `notificador.ts`: `class NotificadorEventos implements Notificador`, `new NotificadorEventos(redis, { prefijo?, logger? })`;
//   `avisar` publica con `publicarAvisoNotificacion` y no lanza nunca.
// - `iniciarTrabajos` usa `NotificadorEventos(deps.redis, { prefijo, logger })` si `deps.notificador` no viene.
import type { ContappDb } from "@contapp/db";

export interface LlamadaAviso {
  tenantId: string;
  usuarioIds: string[];
}

export interface OpcionesEspia {
  /** Se ejecuta al recibir el aviso, antes de fallar o resolver (p. ej. para leer la BD o matar el proceso). */
  alAvisar?: (tenantId: string, usuarioIds: string[]) => Promise<void> | void;
  /** El aviso nunca termina (canal colgado). */
  colgado?: boolean;
}

/**
 * Notificador de la prueba: anota `{ tenantId, usuarioIds }` por aviso y, con `falla`, rechaza (con el texto dado, útil
 * para sembrar un canario en el error). `args` guarda los argumentos tal como llegaron (el puerto recibe solo dos).
 */
export function notificadorEspia(
  falla: boolean | string = false,
  o: OpcionesEspia = {},
) {
  const llamadas: LlamadaAviso[] = [];
  const args: unknown[][] = [];
  return {
    llamadas,
    args,
    avisar: async (
      tenantId: string,
      usuarioIds: string[],
      ...resto: unknown[]
    ): Promise<void> => {
      args.push([tenantId, usuarioIds, ...resto]);
      llamadas.push({ tenantId, usuarioIds: [...usuarioIds] });
      await o.alAvisar?.(tenantId, usuarioIds);
      if (o.colgado) await new Promise<void>(() => undefined);
      if (falla !== false)
        throw new Error(
          typeof falla === "string" ? falla : "el canal de avisos cayó",
        );
    },
  };
}

/** Los usuarios avisados en todas las llamadas, sin repetir y ordenados. */
export const avisados = (llamadas: LlamadaAviso[]): string[] =>
  [...new Set(llamadas.flatMap((l) => l.usuarioIds))].sort();

export const ordenados = (ids: string[]): string[] => [...new Set(ids)].sort();

export interface FilaNotificacion {
  id: string;
  tenant_id: string;
  usuario_id: string;
  tipo: string;
  cliente_id: string | null;
  trabajo_id: string | null;
  params: Record<string, unknown>;
  clave_dedupe: string;
  creada_en: Date;
  leida_en: Date | null;
}

/** Notificaciones del estudio (superusuario, ignora la RLS), de la más vieja a la más nueva. */
export async function notificacionesDe(
  admin: ContappDb,
  tenantId: string,
  f: { tipo?: string; usuarioId?: string; trabajoId?: string } = {},
): Promise<FilaNotificacion[]> {
  const r = await admin.pool.query(
    `select * from notificacion
      where tenant_id = $1
        and ($2::text is null or tipo = $2)
        and ($3::uuid is null or usuario_id = $3)
        and ($4::uuid is null or trabajo_id = $4)
      order by creada_en, id`,
    [tenantId, f.tipo ?? null, f.usuarioId ?? null, f.trabajoId ?? null],
  );
  return r.rows as FilaNotificacion[];
}

export interface FilaAuditoria {
  id: string;
  tenant_id: string;
  ocurrida_en: Date;
  actor_tipo: "usuario" | "trabajo" | "sistema";
  usuario_id: string | null;
  trabajo_id: string | null;
  accion: string;
  cliente_id: string | null;
  entidad: string;
  entidad_id: string | null;
  datos: Record<string, unknown>;
}

/** Filas de `auditoria` del estudio (superusuario), de la más vieja a la más nueva, opcionalmente de una acción. */
export async function auditoriaDe(
  admin: ContappDb,
  tenantId: string,
  accion?: string,
  f: { actor?: FilaAuditoria["actor_tipo"] } = {},
): Promise<FilaAuditoria[]> {
  const r = await admin.pool.query(
    `select * from auditoria
      where tenant_id = $1
        and ($2::text is null or accion = $2)
        and ($3::text is null or actor_tipo = $3)
      order by ocurrida_en, id`,
    [tenantId, accion ?? null, f.actor ?? null],
  );
  return r.rows as FilaAuditoria[];
}

/** Texto de todo lo que hay en `notificacion` y `auditoria` de los estudios (para buscar canarios). */
export async function volcarTablas017(
  admin: ContappDb,
  estudios: string[],
): Promise<string> {
  const filas = async (texto: string): Promise<string[]> =>
    (
      (await admin.pool.query(texto, [estudios])).rows as Array<{ t: string }>
    ).map((x) => x.t);
  return [
    ...(await filas(
      "select to_jsonb(t)::text as t from notificacion t where tenant_id = any($1::uuid[])",
    )),
    ...(await filas(
      "select to_jsonb(t)::text as t from auditoria t where tenant_id = any($1::uuid[])",
    )),
  ].join("\n");
}

/** Asigna al usuario como RESPONSABLE del cliente (P-4: a él va el aviso de credencial inválida). */
export async function asignarResponsable(
  admin: ContappDb,
  tenantId: string,
  clienteId: string,
  usuarioId: string,
): Promise<void> {
  await admin.pool.query(
    "insert into asignacion (tenant_id, cliente_id, usuario_id, tipo) values ($1, $2, $3, 'responsable')",
    [tenantId, clienteId, usuarioId],
  );
}

/**
 * Cancela (UPDATE, nunca DELETE) los `job_registro` que sigan `en_cola` de los estudios de la prueba: sin esto el
 * reconciliador de otra prueba los adopta (lección de 012b).
 */
export async function cancelarEnCola(
  admin: ContappDb,
  estudios: string[],
): Promise<void> {
  await admin.pool.query(
    `update job_registro set estado = 'cancelado', terminado_en = now(), actualizado_en = now()
      where tenant_id = any($1::uuid[]) and estado = 'en_cola'`,
    [estudios],
  );
}

/** Borra las filas de 017 de los estudios (modo replica, conexión descartable). Llamar antes de `Escenario.limpiar`. */
export async function limpiarFilas017(
  admin: ContappDb,
  estudios: string[],
): Promise<void> {
  if (estudios.length === 0) return;
  const c = await admin.pool.connect();
  try {
    await c.query("SET session_replication_role = replica");
    for (const texto of [
      "delete from notificacion where tenant_id = any($1::uuid[])",
      "delete from plan_aviso where tenant_id = any($1::uuid[])",
      "delete from auditoria where tenant_id = any($1::uuid[])",
    ])
      await c.query(texto, [estudios]).catch(() => undefined);
  } catch {
    // limpieza de mejor esfuerzo
  } finally {
    c.release(true); // se destruye: no vuelve al pool con session_replication_role = replica
  }
}
