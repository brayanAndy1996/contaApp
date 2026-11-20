// Soporte de las pruebas de BD de la spec 024 (T2, rojo). No es una prueba (no termina en .spec.ts).
// Los archivos buzon-atencion-{tablas,funcion,concurrencia}.spec.ts crean sus estudios, usuarios y clientes con el superusuario
// (MIGRATIONS_DATABASE_URL) y los borran al final; ninguno depende del seed.
//
// CONTRATO DE BD QUE FIJAN LAS PRUEBAS DE T2 (lo implementa T7 en las migraciones 0059-0060; plan 024, Contratos: BD):
//   buzon_mensaje suma historico boolean NOT NULL DEFAULT false, atendido_en timestamptz, atendido_por uuid -> usuario(id), con CHECK
//     (atendido_en IS NULL) = (atendido_por IS NULL). Ningun rol de la app tiene UPDATE de esas tres columnas.
//   buzon_atencion(id, tenant_id, cliente_id, mensaje_id, accion 'atendido'|'deshecho', comentario text NULL (1..500, sin controles
//     ni bidi), usuario_id -> usuario(id), creado_en) con FK (tenant_id, cliente_id, mensaje_id) -> buzon_mensaje. RLS ENABLE + FORCE,
//     tenant_isolation. contapp_backend solo SELECT; nadie INSERT, UPDATE ni DELETE directo. Trigger buzon_atencion_inmutable: UPDATE
//     siempre 42501; DELETE 42501 salvo superusuario.
//   Trigger BEFORE INSERT buzon_mensaje_atencion_inicial (SECURITY DEFINER): fuerza atendido_en = NULL, atendido_por = NULL e
//     historico = (cliente sin sincronizado_en AND fecha <= clock_timestamp() - 30 dias), sin importar lo que mande quien inserta.
//     La migracion 0059 reclasifica lo ya guardado: historico = fecha <= primera_captura_en - 30 dias AND (sincronizado_en IS NULL OR
//     primera_captura_en <= sincronizado_en); en los criticos coincide con NOT avisado.
//   public.buzon_atencion_aplicar(p_cliente uuid, p_mensajes uuid[], p_accion text, p_comentario text)
//     RETURNS TABLE (mensaje_id uuid, aplicado boolean, atendido_por uuid, atendido_en timestamptz). SECURITY DEFINER de
//     contapp_migrator, search_path fijo, EXECUTE solo contapp_backend.
//     42501 sin estudio, sin usuario o sin membresia activa; 22023 accion distinta de marcar|deshacer, 0 o mas de 100 ids, nulos,
//     repetidos, comentario no nulo e invalido, o deshacer con p_cliente nulo (lote = solo marcar); P0002 id inexistente, de otro
//     estudio o de otro cliente que p_cliente; 55000 cliente archivado (U-1); 22004 marcar un critico sin comentario (todo el lote).
//     Por mensaje, en orden de id: si el estado lo permite cambia atendido_en/atendido_por, inserta el evento y la auditoria
//     (buzon.atendido | buzon.atencion_deshecha; entidad buzon_mensaje; datos {mensajeId, clienteId, conComentario, lote}) y devuelve
//     aplicado = true; si no, aplicado = false sin evento. Nunca toca notificacion, buzon_estado_cliente ni job_registro.
import { randomUUID } from "node:crypto";
import { enRollback, type ContappDb, type ContextoTenant } from "./soporte";
import { EscenarioBuzon, type OpcionesMensaje, type Q } from "./buzon-soporte";

export {
  abrirAdmin,
  comoRol,
  conExecute,
  crearDb,
  dormir,
  EscenarioBuzon,
  enTx,
  infoFuncion,
  insertarMensaje,
  probar,
  ROLES_APP,
  ROLES_EXEC,
  upsertEstado,
  UUID,
} from "./buzon-soporte";
export type { ClientePrueba, Q } from "./buzon-soporte";

export const FIRMA_APLICAR = "buzon_atencion_aplicar(uuid,uuid[],text,text)";
export const FIRMA_INICIAL = "buzon_mensaje_atencion_inicial()";

export interface FilaAplicar {
  mensaje_id: string;
  aplicado: boolean;
  atendido_por: string | null;
  atendido_en: Date | null;
}

export type ResultadoAplicar =
  | { ok: true; filas: FilaAplicar[] }
  | { ok: false; code: string; message: string };

const SQL_APLICAR =
  "select * from buzon_atencion_aplicar($1::uuid, $2::uuid[], $3::text, $4::text)";

/** Llama a la funcion dentro de withTenant y SIEMPRE revierte: devuelve las filas o el error de PG (nada persiste). */
export async function aplicarRevierte(
  db: ContappDb,
  ctx: ContextoTenant,
  cliente: string | null,
  mensajes: unknown[],
  accion: string,
  comentario: string | null,
): Promise<ResultadoAplicar> {
  return enRollback(db, ctx, async (tx) => {
    try {
      const r = await tx.query(SQL_APLICAR, [
        cliente,
        mensajes,
        accion,
        comentario,
      ]);
      return { ok: true, filas: r.rows as FilaAplicar[] } as ResultadoAplicar;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return {
        ok: false,
        code: String(err.code ?? ""),
        message: String(err.message ?? ""),
      } as ResultadoAplicar;
    }
  });
}

/** Llama a la funcion y CONFIRMA (una transaccion propia); un error de PG se propaga. */
export async function aplicar(
  db: ContappDb,
  ctx: ContextoTenant,
  cliente: string | null,
  mensajes: string[],
  accion: "marcar" | "deshacer",
  comentario: string | null = null,
  sostenerMs = 0,
): Promise<FilaAplicar[]> {
  return db.withTenant(ctx, async (tx) => {
    const r = await tx.query(SQL_APLICAR, [
      cliente,
      mensajes,
      accion,
      comentario,
    ]);
    if (sostenerMs > 0)
      await tx.query("select pg_sleep($1::float)", [sostenerMs / 1000]);
    return r.rows as FilaAplicar[];
  });
}

export const idsNuevos = (n: number): string[] =>
  Array.from({ length: n }, () => randomUUID());

export interface EstadoMensaje {
  historico: boolean;
  atendido_en: Date | null;
  atendido_por: string | null;
  leido_sunat: boolean;
}

export async function estadoMensaje(q: Q, id: string): Promise<EstadoMensaje> {
  return (
    await q.query(
      "select historico, atendido_en, atendido_por, leido_sunat from buzon_mensaje where id = $1",
      [id],
    )
  ).rows[0] as EstadoMensaje;
}

export interface EventoAtencion {
  id: string;
  tenant_id: string;
  cliente_id: string;
  mensaje_id: string;
  accion: string;
  comentario: string | null;
  usuario_id: string;
  creado_en: Date;
}

/** Eventos de un mensaje en orden cronologico (superusuario, ignora la RLS). */
export async function eventosDe(
  q: Q,
  mensajeId: string,
): Promise<EventoAtencion[]> {
  return (
    await q.query(
      "select * from buzon_atencion where mensaje_id = $1 order by creado_en, id",
      [mensajeId],
    )
  ).rows as EventoAtencion[];
}

/** Inserta un evento de atencion directamente con el superusuario (no pasa por la funcion). Devuelve su id. */
export async function sembrarEvento(
  q: Q,
  tenantId: string,
  clienteId: string,
  mensajeId: string,
  usuarioId: string,
  o: { accion?: string; comentario?: string | null } = {},
): Promise<string> {
  return (
    await q.query(
      `insert into buzon_atencion (tenant_id, cliente_id, mensaje_id, accion, comentario, usuario_id)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [
        tenantId,
        clienteId,
        mensajeId,
        o.accion ?? "atendido",
        o.comentario === undefined ? null : o.comentario,
        usuarioId,
      ],
    )
  ).rows[0].id as string;
}

export interface OpcionesMensajeAtencion extends OpcionesMensaje {
  /** Lo que MANDA quien inserta: el trigger de 0059 debe ignorarlo. */
  historico?: boolean;
  atendidoHace?: string | null;
  atendidoPor?: string | null;
}

/** INSERT de un mensaje con las columnas de atencion (para probar que el trigger ignora lo que manda quien inserta). */
export function sqlMensajeAtencion(
  tenantId: string,
  clienteId: string,
  o: OpcionesMensajeAtencion = {},
): { text: string; values: unknown[] } {
  const critico = o.critico ?? false;
  return {
    text: `insert into buzon_mensaje
        (tenant_id, cliente_id, id_sunat, asunto, remitente, fecha, categoria, critico, motivo_critico, version_catalogo, avisado,
         leido_sunat, primera_captura_en, ultima_captura_en, adjuntos_declarados, historico, atendido_en, atendido_por)
       values ($1, $2, $3, 'Asunto de prueba', 'SUNAT', now() - $4::interval, $5, $6, $7, 1, $8, false, now(), now(), 0,
               $9, case when $10::text is null then null else now() - $10::interval end, $11)
       returning id, historico, atendido_en, atendido_por`,
    values: [
      tenantId,
      clienteId,
      o.idSunat ?? `M-${randomUUID().slice(0, 12)}`,
      o.fechaHace ?? "2 days",
      o.categoria ?? (critico ? "coactiva" : "otro"),
      critico,
      critico ? "codigo" : null,
      o.avisado ?? false,
      o.historico ?? false,
      o.atendidoHace ?? null,
      o.atendidoPor ?? null,
    ],
  };
}

/** Escenario de 024: el de 023 mas la limpieza del historial de atencion (que referencia mensajes y usuarios). */
export class EscenarioAtencion extends EscenarioBuzon {
  override async limpiar(): Promise<void> {
    const c = await this.admin.connect();
    try {
      await c.query("SET session_replication_role = replica");
      await c
        .query("delete from buzon_atencion where tenant_id = any($1::uuid[])", [
          this.estudios,
        ])
        .catch(() => undefined);
    } catch {
      /* limpieza de mejor esfuerzo */
    } finally {
      c.release(true);
    }
    await super.limpiar();
  }

  /** Cuenta filas de una tabla del estudio (superusuario) para comparar antes y despues. */
  async contar(
    tenantId: string,
    tabla: "notificacion" | "buzon_estado_cliente" | "job_registro",
  ): Promise<number> {
    return Number(
      (
        await this.admin.query(
          `select count(*)::int as n from ${tabla} where tenant_id = $1`,
          [tenantId],
        )
      ).rows[0].n,
    );
  }
}
