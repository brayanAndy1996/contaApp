/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y cuerpos JSON dinámicos en pruebas */
// Soporte de las pruebas HTTP de la spec 024 (T4, rojo): bandeja de buzones, atención, detalle e indicador. Encima de
// `soporte-buzon.ts` (023). No es una prueba ni código de producción. Datos sintéticos.
//
// CONTRATO DE BD QUE ASUME LA SIEMBRA (plan 024, «BD»; lo crea T7 con las migraciones 0059 y 0060):
//  - `buzon_mensaje` suma `historico boolean NOT NULL DEFAULT false`, `atendido_en timestamptz` y `atendido_por uuid`.
//  - `buzon_atencion(id, tenant_id, cliente_id, mensaje_id, accion 'atendido'|'deshecho', comentario, usuario_id, creado_en)`.
// La siembra va por la conexión de migraciones con `session_replication_role = replica` (sin RLS, grants ni triggers: un crítico se
// siembra sin notificar y `historico` / `atendido_*` quedan como se piden). Las columnas nuevas solo se tocan si la prueba las pide:
// así, lo que no depende de ellas falla por la ruta que falta (404) y no por la migración.
import { randomUUID } from "node:crypto";
import { createDb } from "@contapp/db";
import { PERMISOS_POR_ROL, type Permiso } from "@contapp/shared";
import {
  abrirBancoBuzon,
  type Actor,
  type BancoBuzon,
  type Estudio,
} from "./soporte-buzon.js";
import type { RolSistema } from "./soporte-acceso.js";

export type { Actor, Estudio, RolSistema };
export { cumple } from "./soporte-buzon.js";

export const CATEGORIAS = [
  "coactiva",
  "resolucion_determinacion",
  "resolucion_multa",
  "requerimiento_fiscalizacion",
  "otro",
] as const;

/** Fechas con empates al microsegundo y bordes del día de Lima (UTC-5): forma fija, así el orden de texto es el cronológico. */
export const FECHAS = [
  "2026-10-20T12:00:00.000000Z",
  "2026-11-10T15:00:00.000001Z",
  "2026-11-10T15:00:00.000002Z",
  "2026-11-12T04:59:59.999999Z", // 23:59:59.999999 del 11 en Lima
  "2026-11-12T05:00:00.000000Z", // 00:00 del 12 en Lima
  "2026-11-12T05:00:00.000000Z",
  "2026-11-13T04:30:00.000000Z", // 23:30 del 12 en Lima
  "2026-11-14T17:00:00.000000Z",
  "2026-11-15T05:00:00.000000Z", // 00:00 del 15 en Lima
  "2026-11-16T12:00:00.500000Z",
  "2026-11-18T03:00:00.000000Z", // 22:00 del 17 en Lima
  "2026-11-18T03:00:00.000000Z",
] as const;

/** Día de Lima (AAAA-MM-DD) de una fecha en la forma fija de `FECHAS`. */
export const diaLima = (f: string): string =>
  new Date(new Date(`${f.slice(0, 23)}Z`).getTime() - 5 * 3_600_000)
    .toISOString()
    .slice(0, 10);

export interface FilaSembrar {
  id?: string;
  clienteId: string;
  /** Forma fija `AAAA-MM-DDTHH:MM:SS.UUUUUUZ`. */
  fecha: string;
  categoria?: string;
  leido?: boolean;
  historico?: boolean;
  atendidoPor?: string | null;
  /** ISO; por omisión, si hay `atendidoPor`, hace una hora. */
  atendidoEn?: string | null;
  asunto?: string;
}

export interface Contadores {
  eventos: number;
  auditoria: number;
  notificaciones: number;
  trabajos: number;
}

export interface BancoBandeja extends BancoBuzon {
  sql<T = any>(texto: string, valores?: unknown[]): Promise<T[]>;
  /** Como `sql`, pero con `session_replication_role = replica` (sin triggers ni FK): siembras masivas de CA-9. */
  sqlReplica<T = any>(texto: string, valores?: unknown[]): Promise<T[]>;
  /** `n` clientes en una sentencia (RUC únicos, razón social `<prefijo> 0001…`); `archivado(i)` marca los archivados. */
  clientesMasivos(
    tenantId: string,
    n: number,
    o?: { prefijo?: string; archivado?: (i: number) => boolean },
  ): Promise<{ id: string; razonSocial: string; archivado: boolean }[]>;
  asignarMasivo(
    tenantId: string,
    usuarioId: string,
    clienteIds: readonly string[],
    tipo: "responsable" | "colaborador",
  ): Promise<void>;
  /** Mensajes en una sentencia; devuelve los ids en el orden de `filas`. Categoría distinta de `otro` = crítico. */
  sembrarLote(tenantId: string, filas: readonly FilaSembrar[]): Promise<string[]>;
  /** Fija `historico` y/o la atención vigente de mensajes ya sembrados (sin evento: es solo el estado). */
  fijarEstado(
    mensajeIds: readonly string[],
    o: { historico?: boolean; atendidoPor?: string | null },
  ): Promise<void>;
  nombrar(actor: Actor, nombre: string): Promise<void>;
  mensaje(mensajeId: string): Promise<any | undefined>;
  /** Eventos del historial de un mensaje, en orden cronológico. */
  eventos(mensajeId: string): Promise<any[]>;
  contadores(tenantId: string): Promise<Contadores>;
  /** Estado de los mensajes (leído, atendido por/en, histórico) para comprobar que una operación no cambió nada. */
  instantanea(mensajeIds: readonly string[]): Promise<any[]>;
}

// Textos fijos (sin interpolación): las columnas de 0059 solo entran en la variante que las necesita.
const SQL_LOTE = `insert into buzon_mensaje
    (id, tenant_id, cliente_id, id_sunat, asunto, remitente, fecha, categoria, critico, motivo_critico,
     version_catalogo, avisado, leido_sunat, primera_captura_en, ultima_captura_en, adjuntos_declarados)
  select u.id, $1, u.cliente_id, 'M-' || substr(replace(u.id::text, '-', ''), 1, 12), u.asunto, 'SUNAT',
         u.fecha::timestamptz, u.categoria, u.categoria <> 'otro',
         case when u.categoria <> 'otro' then 'codigo' end, 1, false, u.leido, now(), now(), 0
    from unnest($2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::boolean[])
         as u(id, cliente_id, asunto, fecha, categoria, leido)`;
const SQL_LOTE_CON_ESTADO = `insert into buzon_mensaje
    (id, tenant_id, cliente_id, id_sunat, asunto, remitente, fecha, categoria, critico, motivo_critico,
     version_catalogo, avisado, leido_sunat, primera_captura_en, ultima_captura_en, adjuntos_declarados,
     historico, atendido_en, atendido_por)
  select u.id, $1, u.cliente_id, 'M-' || substr(replace(u.id::text, '-', ''), 1, 12), u.asunto, 'SUNAT',
         u.fecha::timestamptz, u.categoria, u.categoria <> 'otro',
         case when u.categoria <> 'otro' then 'codigo' end, 1, false, u.leido, now(), now(), 0,
         u.historico, u.atendido_en::timestamptz, u.atendido_por
    from unnest($2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::boolean[], $8::boolean[], $9::text[], $10::uuid[])
         as u(id, cliente_id, asunto, fecha, categoria, leido, historico, atendido_en, atendido_por)`;

export async function abrirBancoBandeja(): Promise<BancoBandeja> {
  const b = await abrirBancoBuzon();
  const sql = b.v.b.sql;
  const tenants: string[] = [];
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!url) throw new Error("falta MIGRATIONS_DATABASE_URL para las pruebas de bandeja");
  const admin = createDb({ rolApp: "contapp_backend", url, poolMax: 2 });

  async function conReplica<T>(
    fn: (c: { query(t: string, v?: unknown[]): Promise<{ rows: any[] }> }) => Promise<T>,
  ): Promise<T> {
    const c = await admin.pool.connect();
    try {
      await c.query("SET session_replication_role = replica");
      return await fn(c);
    } finally {
      c.release(true); // se destruye: no vuelve al pool con session_replication_role = replica
    }
  }
  const contar = async (texto: string, valores: unknown[]): Promise<number> => {
    try {
      return Number((await sql(texto, valores))[0].n);
    } catch (e) {
      if ((e as { code?: string }).code === "42P01") return 0; // rojo: la tabla aún no existe
      throw e;
    }
  };

  return {
    ...b,
    estudio: async () => {
      const e = await b.estudio();
      tenants.push(e.tenantId);
      return e;
    },
    sql,
    sqlReplica: (texto, valores) => conReplica(async (c) => (await c.query(texto, valores)).rows),
    clientesMasivos: async (tenantId, n, o = {}) => {
      const prefijo = o.prefijo ?? "Cliente";
      const archivado = o.archivado ?? (() => false);
      const base = 10_000_000_000 + Math.floor(Math.random() * 8_000_000_000);
      const filas: { id: string; razonSocial: string; archivado: boolean }[] = [];
      const ids: string[] = [];
      const rucs: string[] = [];
      const razones: string[] = [];
      const archivados: boolean[] = [];
      for (let i = 0; i < n; i++) {
        const id = randomUUID();
        const razon = `${prefijo} ${String(i + 1).padStart(4, "0")}`;
        ids.push(id);
        rucs.push(String(20_000_000_000 + ((base + i * 7) % 9_999_999_999)));
        razones.push(razon);
        archivados.push(archivado(i));
        filas.push({ id, razonSocial: razon, archivado: archivado(i) });
      }
      await sql(
        `insert into cliente (id, tenant_id, ruc, razon_social, archivado_at)
         select u.id, $1, u.ruc, u.razon, case when u.arch then now() end
           from unnest($2::uuid[], $3::text[], $4::text[], $5::boolean[]) as u(id, ruc, razon, arch)`,
        [tenantId, ids, rucs, razones, archivados],
      );
      return filas;
    },
    asignarMasivo: async (tenantId, usuarioId, clienteIds, tipo) => {
      if (clienteIds.length === 0) return;
      await sql(
        `insert into asignacion (tenant_id, cliente_id, usuario_id, tipo)
         select $1, c, $2, $3 from unnest($4::uuid[]) as c`,
        [tenantId, usuarioId, tipo, clienteIds],
      );
    },
    sembrarLote: async (tenantId, filas) => {
      if (filas.length === 0) return [];
      const usaEstado = filas.some((f) => f.historico !== undefined || f.atendidoPor !== undefined);
      const ids = filas.map((f) => f.id ?? randomUUID());
      const comunes = [
        tenantId,
        ids,
        filas.map((f) => f.clienteId),
        filas.map((f) => f.asunto ?? "Asunto de prueba"),
        filas.map((f) => f.fecha),
        filas.map((f) => f.categoria ?? "otro"),
        filas.map((f) => f.leido ?? false),
      ];
      await conReplica((c) =>
        usaEstado
          ? c.query(SQL_LOTE_CON_ESTADO, [
              ...comunes,
              filas.map((f) => f.historico ?? false),
              filas.map((f) => (f.atendidoPor ? (f.atendidoEn ?? new Date(Date.now() - 3_600_000).toISOString()) : null)),
              filas.map((f) => f.atendidoPor ?? null),
            ])
          : c.query(SQL_LOTE, comunes),
      );
      return ids;
    },
    fijarEstado: async (mensajeIds, o) => {
      await conReplica(async (c) => {
        if (o.historico !== undefined)
          await c.query(
            "update buzon_mensaje set historico = $2 where id = any($1::uuid[])",
            [mensajeIds, o.historico],
          );
        if (o.atendidoPor !== undefined)
          await c.query(
            `update buzon_mensaje
                set atendido_por = $2::uuid,
                    atendido_en = case when $2::uuid is null then null else now() - interval '1 hour' end
              where id = any($1::uuid[])`,
            [mensajeIds, o.atendidoPor],
          );
      });
    },
    nombrar: async (actor, nombre) => {
      await sql("update usuario set nombre = $2 where id = $1", [actor.id, nombre]);
    },
    mensaje: async (mensajeId) =>
      (await sql("select * from buzon_mensaje where id = $1", [mensajeId]))[0],
    eventos: (mensajeId) =>
      sql(
        "select * from buzon_atencion where mensaje_id = $1 order by creado_en, id",
        [mensajeId],
      ),
    contadores: async (tenantId) => ({
      eventos: await contar("select count(*)::int n from buzon_atencion where tenant_id = $1", [tenantId]),
      auditoria: await contar("select count(*)::int n from auditoria where tenant_id = $1 and accion like 'buzon.%'", [tenantId]),
      notificaciones: await contar("select count(*)::int n from notificacion where tenant_id = $1", [tenantId]),
      trabajos: await contar("select count(*)::int n from job_registro where tenant_id = $1", [tenantId]),
    }),
    instantanea: (mensajeIds) =>
      sql(
        `select id, leido_sunat, contenido_ruta, ultima_captura_en, to_jsonb(m) - 'id' as resto
           from buzon_mensaje m where id = any($1::uuid[]) order by id`,
        [mensajeIds],
      ),
    cerrar: async () => {
      try {
        if (tenants.length > 0)
          await conReplica((c) =>
            c
              .query("delete from buzon_atencion where tenant_id = any($1::uuid[])", [tenants])
              .catch(() => undefined),
          );
      } finally {
        await b.cerrar();
        await admin.close();
      }
    },
  };
}

/**
 * Corre `fn` con el rol de sistema `rol` sin el permiso `permiso` (rol simulado: los de sistema no dejan permisos fuera salvo
 * `buzon.atender` en Lectura, y 030 aún no existe). La matriz se restaura siempre.
 */
export async function sinPermiso<T>(
  rol: RolSistema,
  permiso: Permiso,
  fn: () => Promise<T>,
): Promise<T> {
  const conjunto = PERMISOS_POR_ROL[rol] as Set<Permiso>;
  const tenia = conjunto.delete(permiso);
  try {
    return await fn();
  } finally {
    if (tenia) conjunto.add(permiso);
  }
}
