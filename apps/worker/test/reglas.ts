// Soporte de las pruebas de integración del worker de la spec 021 (T4, rojo). No es código de producción ni una prueba.
// Siembra reglas aprendidas e interruptores del motor con el rol administrativo (no pasa por RLS ni por grants; sí por triggers
// y FK) y lee `regla_aplicacion` y la auditoría. Los nombres de tablas y columnas son los de `plan.md` (Contratos: BD, 0047-0049).
import { createHash } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import type { MundoVentas } from "./compras.js";

/** Periodo en que se aprendieron las reglas sembradas; la descarga de las pruebas es 202610 (`PERIODO`). */
export const APRENDIDO = "202609";

export type Destino = "DG" | "DGNG" | "DNG";

export const CODIGOS_MOTOR = [
  "R-ISC",
  "R-MIX",
  "R-RED",
  "R-NEW",
  "R-GP",
  "R-HIS",
] as const;
export type CodigoMotor = (typeof CODIGOS_MOTOR)[number];

export interface OpcionesRegla {
  clienteId?: string;
  tenantId?: string;
  docTipo?: string;
  docNumero?: string;
  destino?: Destino;
  activa?: boolean;
  version?: number;
  periodoAprendido?: string;
  eliminada?: boolean;
}

/** Regla aprendida sembrada (el contador `m.u` la creó). Devuelve su id. */
export async function sembrarRegla(
  admin: ContappDb,
  m: Pick<MundoVentas, "T" | "u" | "c">,
  o: OpcionesRegla = {},
): Promise<string> {
  const r = await admin.pool.query(
    `insert into regla_aprendida (tenant_id, cliente_id, doc_tipo, doc_numero, destino, activa, version, periodo_aprendido,
       creada_por, actualizada_por, eliminada_en, eliminada_por)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, case when $10::boolean then now() else null end,
             case when $10::boolean then $9::uuid else null end)
     returning id`,
    [
      o.tenantId ?? m.T,
      o.clienteId ?? m.c.id,
      o.docTipo ?? "6",
      o.docNumero ?? "20100070970",
      o.destino ?? "DNG",
      o.activa ?? true,
      o.version ?? 1,
      o.periodoAprendido ?? APRENDIDO,
      m.u,
      o.eliminada ?? false,
    ],
  );
  return r.rows[0].id as string;
}

/** Interruptor del motor del estudio (sin fila = encendido). */
export async function fijarInterruptor(
  admin: ContappDb,
  m: Pick<MundoVentas, "T" | "u">,
  codigo: CodigoMotor,
  activa: boolean,
): Promise<void> {
  await admin.pool.query(
    `insert into estudio_regla_motor (tenant_id, codigo, activa, actualizada_por) values ($1, $2, $3, $4)
     on conflict (tenant_id, codigo) do update set activa = excluded.activa`,
    [m.T, codigo, activa, m.u],
  );
}

export interface AplicacionBd {
  regla_id: string;
  compra_id: string;
  version_n: number;
  periodo: string;
}

/** Filas de `regla_aplicacion` de un cliente, por compra. */
export async function aplicacionesDe(
  admin: ContappDb,
  clienteId: string,
): Promise<AplicacionBd[]> {
  const r = await admin.pool.query(
    `select a.regla_id, a.compra_id, a.version_n::int as version_n, a.periodo
       from regla_aplicacion a join compra c on c.id = a.compra_id
      where c.cliente_id = $1 order by a.compra_id, a.version_n`,
    [clienteId],
  );
  return r.rows as AplicacionBd[];
}

/** Cuántas filas de `regla_aplicacion` tiene el estudio (todas las compras, de cualquier cliente). */
export async function contarAplicaciones(
  admin: ContappDb,
  tenantId: string,
): Promise<number> {
  const r = await admin.pool.query(
    "select count(*)::int as n from regla_aplicacion where tenant_id = $1",
    [tenantId],
  );
  return r.rows[0].n as number;
}

export interface AuditoriaHistorial {
  actor_tipo: string;
  usuario_id: string | null;
  trabajo_id: string | null;
  datos: Record<string, unknown>;
  texto: string;
}

/** Filas de auditoría `compra.historial` del estudio (actor `trabajo` en la descarga; `datos` solo con ids). */
export async function auditoriaHistorialDe(
  admin: ContappDb,
  tenantId: string,
): Promise<AuditoriaHistorial[]> {
  const r = await admin.pool.query(
    `select actor_tipo, usuario_id, trabajo_id, datos, datos::text as texto from auditoria
      where tenant_id = $1 and accion = 'compra.historial' order by ocurrida_en, id`,
    [tenantId],
  );
  return r.rows as AuditoriaHistorial[];
}

/** Todo el `datos` de la auditoría del estudio como texto (para buscar canarios que no deben estar). */
export async function volcarAuditoria(
  admin: ContappDb,
  tenantId: string,
): Promise<string> {
  const r = await admin.pool.query(
    "select datos::text as t from auditoria where tenant_id = $1",
    [tenantId],
  );
  return (r.rows as Array<{ t: string }>).map((f) => f.t).join("\n");
}

/** Texto de las tablas de reglas del estudio (para buscar canarios). */
export async function volcarTablasReglas(
  admin: ContappDb,
  estudios: string[],
): Promise<string> {
  const r = await admin.pool.query(
    `select to_jsonb(t)::text as t from regla_aplicacion t where tenant_id = any($1::uuid[])
     union all select to_jsonb(t)::text from regla_aprendida t where tenant_id = any($1::uuid[])`,
    [estudios],
  );
  return (r.rows as Array<{ t: string }>).map((f) => f.t).join("\n");
}

/**
 * Resumen `md5` de las columnas de una versión (montos, estado, acción y autoría; no `id`, `compra_id` ni `creada_en`). Sirve
 * para probar que la versión 1 sigue igual a la fila de la propuesta con la misma comparación que `esperadoMd5`.
 */
export async function md5Version(
  admin: ContappDb,
  compraId: string,
  n: number,
): Promise<string> {
  const r = await admin.pool.query(
    `select md5(concat_ws('|', bi_dg::text, igv_dg::text, bi_dgng::text, igv_dgng::text, bi_dng::text, igv_dng::text,
            no_gravado::text, isc::text, icbper::text, otros_tributos::text, total::text, excluida::text,
            coalesce(motivo, '~'), clasificada::text, accion, coalesce(operacion_id::text, '~'),
            coalesce(usuario_id::text, '~'))) as h
       from compra_version where compra_id = $1 and n = $2`,
    [compraId, n],
  );
  return String(r.rows[0]?.h);
}

/** El `md5` que debe tener la versión 1 de una compra del SIRE (`original`, sin operación ni usuario, sin clasificar). */
export function esperadoMd5(montos: {
  biDg: string;
  igvDg: string;
  biDgng: string;
  igvDgng: string;
  biDng: string;
  igvDng: string;
  noGravado: string;
  isc: string;
  icbper: string;
  otros: string;
  total: string;
}): string {
  const partes = [
    montos.biDg,
    montos.igvDg,
    montos.biDgng,
    montos.igvDgng,
    montos.biDng,
    montos.igvDng,
    montos.noGravado,
    montos.isc,
    montos.icbper,
    montos.otros,
    montos.total,
    "false",
    "~",
    "false",
    "original",
    "~",
    "~",
  ];
  return createHash("md5").update(partes.join("|")).digest("hex");
}

/**
 * Borra lo que dejan las pruebas en las tablas de reglas de los estudios dados. Va con `session_replication_role = replica`
 * (las tablas de 021 son de solo inserción y las FK compuestas impiden borrar en cualquier orden). Llamar ANTES de
 * `limpiarCompras`. Si las tablas aún no existen (rojo), no falla.
 */
export async function limpiarReglas(
  admin: ContappDb,
  estudios: string[],
): Promise<void> {
  const c = await admin.pool.connect();
  try {
    await c.query("SET session_replication_role = replica");
    // Un SQL estático por tabla (la tabla nunca se interpola).
    for (const sql of [
      "delete from regla_confirmacion where tenant_id = any($1::uuid[])",
      "delete from regla_aceptacion where tenant_id = any($1::uuid[])",
      "delete from regla_aplicacion where tenant_id = any($1::uuid[])",
      "delete from regla_aprendida where tenant_id = any($1::uuid[])",
      "delete from estudio_regla_motor where tenant_id = any($1::uuid[])",
      "delete from estudio_reglas_config where tenant_id = any($1::uuid[])",
    ])
      await c.query(sql, [estudios]).catch(() => undefined);
  } finally {
    c.release(true); // se destruye: no vuelve al pool con session_replication_role = replica
  }
}
