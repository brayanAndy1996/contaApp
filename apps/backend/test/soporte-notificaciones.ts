/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y cuerpos JSON dinámicos en pruebas */
// Soporte de las pruebas HTTP de la spec 017 (T5, rojo): notificaciones, auditoría, SSE, autor y HU-40. No es una prueba.
// Siembra por SQL con la conexión de migraciones (superusuario: pasa por los triggers y las FK, no por RLS ni grants) las filas que
// la app solo lee: `notificacion` (la escribe la BD, D-9), `auditoria` (la escribe `auditoria_registrar`, D-2) y
// `auditoria_descifrado` (la escribe el worker, 003). Solo usa el contrato público de la API y de las tablas del plan.
//
// CONTRATO DE TABLAS QUE USA (lo implementa T7 en las migraciones 0041 y 0043; igual que fijan las pruebas de T2 y T3):
//   `notificacion`: id, tenant_id, usuario_id, tipo, cliente_id?, trabajo_id?, params jsonb, clave_dedupe (única por tenant y
//     usuario), creada_en, leida_en?. `auditoria`: id, tenant_id, ocurrida_en, actor_tipo, usuario_id?, trabajo_id?, accion,
//     cliente_id?, entidad, entidad_id, datos jsonb. Ninguna tiene FK a usuario, cliente ni trabajo salvo `notificacion.usuario_id`.
//   Limpieza: el trigger de inmutabilidad de `auditoria` bloquea el DELETE incluso al superusuario; solo
//   `session_replication_role = replica` lo salta (como en 0040). La limpieza COMÚN (soporte-acceso.ts) es de T2: este soporte solo
//   borra las filas que SUS pruebas sembraron o provocaron, y de mejor esfuerzo (si las tablas aún no existen, no hace nada).
import { randomUUID } from "node:crypto";
import { createDb } from "@contapp/db";

export type Sql = <T = any>(texto: string, valores?: unknown[]) => Promise<T[]>;

export type TipoNotificacion = "credencial_invalida" | "trabajo_terminado" | "plan_limite";

export interface OpcionesNotif {
  tenantId: string;
  /** Destinatario. */
  usuarioId: string;
  tipo?: TipoNotificacion;
  clienteId?: string | null;
  trabajoId?: string | null;
  /** Por omisión, los `params` válidos del tipo. */
  params?: Record<string, unknown>;
  /** Antigüedad de `creada_en` en segundos enteros (sin microsegundos: el cursor viaja como Date). Por omisión 60. */
  hace?: number;
  /** `true`: ya leída (un segundo después de creada). */
  leida?: boolean;
  clave?: string;
}

export interface NotifSembrada {
  id: string;
  /** `creada_en` en ISO (milisegundos exactos porque la siembra usa segundos enteros). */
  creadaEn: string;
}

const PARAMS: Record<TipoNotificacion, Record<string, unknown>> = {
  credencial_invalida: { credencial: "sol" },
  trabajo_terminado: { tipoTrabajo: "sire.propuesta.descargar", estado: "completado", motivo: null },
  plan_limite: { recurso: "rucs", umbral: 90, usado: 9, limite: 10 },
};

/** Una notificación sembrada. `plan_limite` va sin cliente; `trabajo_terminado` lleva un trabajoId. */
export async function sembrarNotificacion(sql: Sql, o: OpcionesNotif): Promise<NotifSembrada> {
  const tipo = o.tipo ?? "credencial_invalida";
  const clienteId = tipo === "plan_limite" ? null : (o.clienteId ?? null);
  const trabajoId = o.trabajoId ?? (tipo === "trabajo_terminado" ? randomUUID() : null);
  const filas = await sql<{ id: string; creada_en: Date }>(
    `insert into notificacion (tenant_id, usuario_id, tipo, cliente_id, trabajo_id, params, clave_dedupe, creada_en, leida_en)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7,
             date_trunc('second', now()) - make_interval(secs => $8::int),
             case when $9::boolean then date_trunc('second', now()) - make_interval(secs => $8::int) + interval '1 second' end)
     returning id, creada_en`,
    [
      o.tenantId,
      o.usuarioId,
      tipo,
      clienteId,
      trabajoId,
      JSON.stringify(o.params ?? PARAMS[tipo]),
      o.clave ?? `t5:${randomUUID()}`,
      o.hace ?? 60,
      o.leida === true,
    ],
  );
  return { id: filas[0]!.id, creadaEn: filas[0]!.creada_en.toISOString() };
}

/**
 * `n` notificaciones `credencial_invalida` del usuario, de la más nueva (hace 1 s) a la más vieja. Las últimas `empates` comparten
 * el mismo instante (desempata el id): así el límite de 50 corta un empate. Devuelve los ids de la más nueva a la más vieja
 * (el orden esperado por `GET /notificaciones`: `creada_en` desc y, a igual instante, `id` desc).
 */
export async function sembrarNotificaciones(
  sql: Sql,
  o: { tenantId: string; usuarioId: string; clienteId?: string | null; n: number; empates?: number; leidas?: boolean },
): Promise<string[]> {
  const empates = o.empates ?? 0;
  await sql(
    `insert into notificacion (tenant_id, usuario_id, tipo, cliente_id, params, clave_dedupe, creada_en, leida_en)
     select $1, $2, 'credencial_invalida', $3, '{"credencial":"sol"}'::jsonb, 't5-masa:' || gen_random_uuid()::text,
            date_trunc('second', now()) - make_interval(secs => least(g, $4::int)),
            case when $6::boolean then date_trunc('second', now()) end
       from generate_series(1, $5::int) g`,
    [o.tenantId, o.usuarioId, o.clienteId ?? null, o.n - empates + 1, o.n, o.leidas === true],
  );
  const ordenadas = await sql<{ id: string }>(
    "select id from notificacion where tenant_id = $1 and usuario_id = $2 and clave_dedupe like 't5-masa:%' order by creada_en desc, id desc",
    [o.tenantId, o.usuarioId],
  );
  return ordenadas.map((f) => f.id);
}

export interface OpcionesAuditoria {
  tenantId: string;
  accion?: string;
  actorTipo?: "usuario" | "trabajo" | "sistema";
  usuarioId?: string | null;
  trabajoId?: string | null;
  clienteId?: string | null;
  entidad?: string;
  entidadId?: string;
  datos?: Record<string, unknown>;
  /** Antigüedad en segundos enteros. Por omisión 60. */
  hace?: number;
}

/** Una fila de `auditoria` (coherente con los CHECK de 0041: `usuario` ⇒ usuario_id; `trabajo` ⇒ trabajo_id; `sistema` ⇒ ninguno). */
export async function sembrarAuditoria(sql: Sql, o: OpcionesAuditoria): Promise<NotifSembrada> {
  const actorTipo = o.actorTipo ?? (o.usuarioId ? "usuario" : "sistema");
  const filas = await sql<{ id: string; ocurrida_en: Date }>(
    `insert into auditoria (tenant_id, ocurrida_en, actor_tipo, usuario_id, trabajo_id, accion, cliente_id, entidad, entidad_id, datos)
     values ($1, date_trunc('second', now()) - make_interval(secs => $2::int), $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     returning id, ocurrida_en`,
    [
      o.tenantId,
      o.hace ?? 60,
      actorTipo,
      actorTipo === "sistema" ? null : (o.usuarioId ?? null),
      actorTipo === "trabajo" ? (o.trabajoId ?? randomUUID()) : null,
      o.accion ?? "cliente.editado",
      o.clienteId ?? null,
      o.entidad ?? (o.clienteId ? "cliente" : "sesion"),
      o.entidadId ?? o.clienteId ?? randomUUID(),
      JSON.stringify(o.datos ?? {}),
    ],
  );
  return { id: filas[0]!.id, creadaEn: filas[0]!.ocurrida_en.toISOString() };
}

/** `n` filas `cliente.editado` del estudio, la más nueva hace 1 s; con `empates` últimas en el mismo instante. */
export async function sembrarAuditorias(
  sql: Sql,
  o: { tenantId: string; usuarioId: string; clienteId: string; n: number; empates?: number },
): Promise<string[]> {
  const empates = o.empates ?? 0;
  await sql(
    `insert into auditoria (tenant_id, ocurrida_en, actor_tipo, usuario_id, accion, cliente_id, entidad, entidad_id, datos)
     select $1, date_trunc('second', now()) - make_interval(secs => least(g, $4::int)), 'usuario', $2, 'cliente.editado', $3,
            'cliente', $3, jsonb_build_object('cambios', jsonb_build_object('razon_social', jsonb_build_array('t5-masa-' || g, 'nueva')))
       from generate_series(1, $5::int) g`,
    [o.tenantId, o.usuarioId, o.clienteId, o.n - empates + 1, o.n],
  );
  const filas = await sql<{ id: string }>(
    `select id from auditoria where tenant_id = $1 and cliente_id = $2 and datos::text like '%t5-masa-%'
      order by ocurrida_en desc, id desc`,
    [o.tenantId, o.clienteId],
  );
  return filas.map((f) => f.id);
}

/** Una fila de `auditoria_descifrado` (003: la escribe el worker al descifrar). Devuelve su id y `created_at`. */
export async function sembrarDescifrado(
  sql: Sql,
  o: { tenantId: string; clienteId: string; tipo?: "sol" | "sire_api"; motivo?: string; resultado?: string; hace?: number },
): Promise<NotifSembrada> {
  const filas = await sql<{ id: string; created_at: Date }>(
    `insert into auditoria_descifrado (tenant_id, credencial_id, cliente_id, tipo, motivo, resultado, created_at)
     values ($1, $2, $3, $4, $5, $6, date_trunc('second', now()) - make_interval(secs => $7::int))
     returning id, created_at`,
    [o.tenantId, randomUUID(), o.clienteId, o.tipo ?? "sol", o.motivo ?? "sire.propuesta.descargar", o.resultado ?? "ok", o.hace ?? 60],
  );
  return { id: filas[0]!.id, creadaEn: filas[0]!.created_at.toISOString() };
}

/** Conexión de migraciones en modo `replica` (salta el trigger de inmutabilidad) para borrar lo que sembró una prueba. */
async function conReplica(fn: (q: (texto: string, valores?: unknown[]) => Promise<void>) => Promise<void>): Promise<void> {
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!url) return;
  const admin = createDb({ rolApp: "contapp_backend", url, poolMax: 1 });
  try {
    const c = await admin.pool.connect();
    try {
      await c.query("set session_replication_role = replica");
      await fn(async (texto, valores) => {
        try {
          await c.query(texto, valores);
        } catch {
          /* limpieza de mejor esfuerzo: la tabla puede no existir todavía (rojo) */
        }
      });
      await c.query("set session_replication_role = origin").catch(() => undefined);
    } finally {
      c.release();
    }
  } catch {
    /* sin conexión no hay nada que limpiar */
  } finally {
    await admin.close().catch(() => undefined);
  }
}

/** Borra las filas de `notificacion`, `auditoria` y `auditoria_descifrado` (y el estado `plan_aviso`) de ESTOS estudios de prueba. */
export async function limpiarAvisosDeEstudios(tenantIds: readonly string[]): Promise<void> {
  if (tenantIds.length === 0) return;
  await conReplica(async (q) => {
    for (const tabla of ["notificacion", "auditoria", "auditoria_descifrado", "plan_aviso"])
      await q(`delete from ${tabla} where tenant_id = any($1::uuid[])`, [[...tenantIds]]);
  });
}

/** Borra por id (estudios persistentes, como los del seed, que no se pueden vaciar enteros). */
export async function borrarPorId(tabla: "notificacion" | "auditoria" | "auditoria_descifrado", ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await conReplica(async (q) => {
    await q(`delete from ${tabla} where id = any($1::uuid[])`, [[...ids]]);
  });
}

/** `Cache-Control` con `no-store` (todas las rutas nuevas, plan: Contratos HTTP). */
export const esNoStore = (valor: unknown): boolean => /no-store/.test(String(valor ?? ""));

/** Texto sin las claves de la tabla ni del destinatario: el DTO nunca expone `tenant_id`, `usuario_id` ni `clave_dedupe`. */
export const CLAVES_INTERNAS = ["tenantId", "tenant_id", "usuarioId", "usuario_id", "claveDedupe", "clave_dedupe"] as const;

/**
 * Quita la membresía de un usuario SIN las restricciones (modo `replica`: no corren las FK que la referencian ni el trigger del
 * último Dueño). Modela un id de autor que ya no es miembro del estudio (D-12, CA-13): `resolverAutores` lo devuelve como
 * `{ id, nombre: null, activo: false }`. Las filas que lo citan (compra_version, compra_periodo, documento_xml...) quedan intactas.
 */
export async function quitarMembresiaSinRestricciones(tenantId: string, usuarioId: string): Promise<void> {
  await conReplica(async (q) => {
    await q("delete from membresia where tenant_id = $1 and usuario_id = $2", [tenantId, usuarioId]);
  });
}
