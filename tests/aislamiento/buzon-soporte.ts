// Soporte de las pruebas de BD de la spec 023 (T4, rojo). No es una prueba (no termina en .spec.ts).
// Cada archivo crea sus propios estudios, usuarios, clientes, credenciales y trabajos con el superusuario
// (MIGRATIONS_DATABASE_URL) y los borra al final; ninguna prueba depende del seed. Las filas de buzon se borran con
// `session_replication_role = replica` en una conexion que se destruye. La fila unica de `buzon_programacion` se guarda al
// empezar y se restaura al terminar (las pruebas que la tocan sin rollback usan `guardarProgramacion`).
//
// CONTRATO DE BD QUE FIJAN LAS PRUEBAS DE T4 (lo implementa T11 en las migraciones 0054-0056; plan 023, Contratos: BD y Programador).
// Donde el plan deja una firma abierta, la decision de T4 esta marcada con [T4]:
//
//  Tablas (0054), todas con tenant_id uuid NOT NULL, RLS ENABLE + FORCE y politica `tenant_isolation`, FK compuestas (tenant_id, ...):
//    buzon_estado_cliente(tenant_id, cliente_id, ultima_programada_en, ultima_solicitud_en, ultima_captura_en, sincronizado_en,
//      cursor_pendiente text <= 200)  PK (tenant_id, cliente_id)
//    buzon_mensaje(id, tenant_id, cliente_id, id_sunat text 1..64, asunto <= 500, remitente <= 200, fecha, codigo_tipo <= 32,
//      categoria, critico, motivo_critico codigo|asunto|duda|NULL, version_catalogo, avisado, leido_sunat, primera_captura_en,
//      ultima_captura_en, adjuntos_declarados, contenido_ruta, contenido_bytes, contenido_obtenido_en)
//      unica (tenant_id, cliente_id, id_sunat); CHECK avisado -> critico; categoria en CATEGORIAS_BUZON de `shared`.
//    buzon_adjunto(id, tenant_id, cliente_id, mensaje_id, id_sunat, nombre, mime, tamano, sha256 bytea(32), ruta, omitido
//      mime|tamano|tope_mensaje, creado_en)  unica (tenant_id, mensaje_id, id_sunat); FK (tenant_id, cliente_id, mensaje_id) ->
//      buzon_mensaje(tenant_id, cliente_id, id); CHECK (ruta IS NULL) = (omitido IS NOT NULL).
//      [T4] un adjunto omitido lleva mime, tamano, sha256 y ruta en NULL; uno guardado los lleva todos.
//    `ruta` y `contenido_ruta` = 'buzon/' || tenant_id || '/' || cliente_id || '/' || uuid || '.' || ext (CHECK; ext en minusculas).
//    buzon_programacion: fila unica (intervalo_min 5..120, reserva_interactiva, lote_estudio, ciclo_dueno, ciclo_hasta,
//      ultimo_ciclo_inicio, ultimo_ciclo_fin) sin ningun privilegio para los roles de la app.
//  Grants: nadie DELETE. backend: SELECT en las tres; UPDATE solo de buzon_estado_cliente(ultima_solicitud_en). worker: mensaje y
//    adjunto SELECT, INSERT; UPDATE de mensaje solo (leido_sunat, ultima_captura_en, contenido_ruta, contenido_bytes,
//    contenido_obtenido_en); estado SELECT, INSERT, UPDATE (ultima_captura_en, sincronizado_en, cursor_pendiente). app y platform: nada.
//  Trigger buzon_mensaje_inmutable: el worker no cambia id, cliente, asunto, fecha, categoria, critico, motivo ni avisado, y
//    `contenido_ruta` solo pasa de NULL a un valor (42501). El superusuario puede reclasificar (sin avisar de nuevo).
//
//  Funciones (0055). SECURITY DEFINER, dueño sin superusuario ni BYPASSRLS, search_path = pg_catalog, pg_temp, mensajes fijos:
//    sistema.buzon_ciclo_tomar(p_dueno text) RETURNS TABLE (ahora timestamptz, intervalo_min int, reserva_interactiva int,
//      lote_estudio int)   [T4] 0 o 1 fila. Toma el ciclo si (ciclo_hasta IS NULL OR ciclo_hasta < clock_timestamp()) AND
//      (ultimo_ciclo_inicio IS NULL OR clock_timestamp() - ultimo_ciclo_inicio >= intervalo_min); al tomarlo fija ciclo_dueno,
//      ciclo_hasta = ahora + 5 min y ultimo_ciclo_inicio = ahora. p_dueno NULL o vacio: 22023.
//    sistema.buzon_ciclo_renovar(p_dueno text) RETURNS boolean   true solo si p_dueno es el dueño y el candado sigue vigente
//      (entonces ciclo_hasta = ahora + 5 min); false si lo perdio (otro dueño o vencido) y sin cambios.
//    sistema.buzon_ciclo_soltar(p_dueno text)   si es el dueño: ultimo_ciclo_fin = ahora y ciclo_hasta = NULL; si no, sin efecto.
//    sistema.estudios_buzon() RETURNS TABLE (tenant_id uuid, frecuencia_min int)  estudios con suscripcion activa o prueba vigente.
//    public.buzon_candidatos() RETURNS TABLE (cliente_id uuid, ultima_programada_en timestamptz)  requiere app.tenant_id (42501):
//      clientes del estudio no archivados, con credencial SOL configurada o verificada y sin captura viva.
//    public.encolar_buzon_programados(p_clientes uuid[]) RETURNS SETOF uuid   [T4] devuelve los ids de los TRABAJOS creados.
//      Lo que ya no cumple (archivado, sin credencial SOL, invalida, captura viva, estudio sin suscripcion vigente o con prueba
//      vencida, tope) se omite sin error y sin consumir la franja; cliente de otro estudio o inexistente: 23503; NULL, vacio,
//      con NULL, repetidos o mas de lote_estudio ids: 22023; sin estudio en la sesion: 42501. Tipo sol.buzon.revisar, cola y canal
//      sol, prioridad programado, creado_por NULL, max_intentos = reintentos(sol) + 1, parametros {}, clave_dedupe = sha256 de
//      ["sol.buzon.revisar","<cliente>",{}] (JSON canonico de `claveDedupe`). Upsert de ultima_programada_en = clock_timestamp().
//      Tope atomico: en_cola de la cola sol del estudio < max_pendientes_tenant - reserva_interactiva; procesa los ids en orden.
//    public.buzon_elevar_prioridad(p_trabajo uuid) RETURNS boolean  solo el backend; true si era sol.buzon.revisar, en_cola y
//      programado del estudio de la sesion (pasa a interactivo, sin tocar otra columna); false en cualquier otro caso.
//
//  Aviso y auditoria (0056):
//    interno.destinatarios_cliente(p_tenant uuid, p_cliente uuid) RETURNS uuid[]  igual que el aviso de credencial invalida de 0043.
//    Trigger BEFORE INSERT en buzon_mensaje: un critico con avisado = false se rechaza (42501) si el cliente ya tiene
//      sincronizado_en o la fecha es de los ultimos 30 dias. Trigger AFTER INSERT con avisado: notificacion `buzon_critico`
//      {categoria, mensajeId}, clave_dedupe 'buzon_critico:' || id, trabajo = el del contexto si es del estudio.
//    public.buzon_auditar(p_accion text, p_cliente uuid, p_mensaje uuid, p_adjunto uuid) RETURNS void  solo el backend.
//      [T4] el plan nombra (p_accion, p_mensaje, p_adjunto); `captura_solicitada` no tiene mensaje, asi que T4 agrega p_cliente.
//      Acciones: buzon.captura_solicitada (entidad cliente, datos {}), buzon.apertura_solicitada y buzon.contenido_visto (entidad
//      buzon_mensaje, datos {mensajeId}), buzon.adjunto_descargado (entidad buzon_adjunto, datos {mensajeId, adjuntoId}); actor
//      usuario. Mensaje o adjunto que no es del cliente o del estudio: 23503; otra accion: 22023.
//    Trigger sobre buzon_mensaje.contenido_ruta (NULL -> valor): `buzon.contenido_obtenido` (actor trabajo, entidad buzon_mensaje,
//      datos {mensajeId, marcoLeido, adjuntos, omitidos}). [T4] adjuntos = guardados y omitidos = omitidos del mensaje al momento
//      del UPDATE (el worker inserta los adjuntos ANTES de fijar contenido_ruta); marcoLeido = ese UPDATE pasa leido_sunat de
//      false a true. Se amplia auditoria_accion_valida con las cinco acciones sin perder las anteriores.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { EscenarioNotif, type ClientePrueba } from "./notificaciones-soporte";
import { enTx } from "./trabajos-soporte";

export {
  abrirAdmin,
  crearDb,
  dormir,
  enTx,
  probar,
  UUID,
} from "./notificaciones-soporte";
export type { ClientePrueba } from "./notificaciones-soporte";
export { conSistema } from "./trabajos-soporte";

export const TABLAS_BUZON = [
  "buzon_estado_cliente",
  "buzon_mensaje",
  "buzon_adjunto",
] as const;
export const CATEGORIAS = [
  "coactiva",
  "resolucion_determinacion",
  "resolucion_multa",
  "requerimiento_fiscalizacion",
  "otro",
] as const;
export const ACCIONES_BUZON = [
  "buzon.captura_solicitada",
  "buzon.apertura_solicitada",
  "buzon.contenido_visto",
  "buzon.adjunto_descargado",
  "buzon.contenido_obtenido",
] as const;
export const ROLES_APP = [
  "contapp_backend",
  "contapp_worker",
  "contapp_app",
  "contapp_platform",
] as const;

/** Cualquier cliente con `query` estilo pg: el pool, una conexion o la `tx` de withTenant. */
export interface Q {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: any[]; rowCount: number | null }>;
}

export const claveBuzon = (clienteId: string): Buffer =>
  createHash("sha256")
    .update(JSON.stringify(["sol.buzon.revisar", clienteId, {}]), "utf8")
    .digest();

export const rutaBuzon = (
  tenantId: string,
  clienteId: string,
  ext = "pdf",
): string => `buzon/${tenantId}/${clienteId}/${randomUUID()}.${ext}`;

// ---- SQL de filas de buzon (sirve con el superusuario y con cualquier rol) ------------------------------------------------
export interface OpcionesMensaje {
  idSunat?: string;
  asunto?: string;
  remitente?: string;
  /** Antiguedad de `fecha` como intervalo SQL (por omision '2 days'). */
  fechaHace?: string;
  codigoTipo?: string | null;
  categoria?: string;
  critico?: boolean;
  motivo?: string | null;
  version?: number;
  avisado?: boolean;
  leido?: boolean;
  declarados?: number;
  contenidoRuta?: string | null;
  conflicto?: boolean;
}

export function sqlMensaje(
  tenantId: string,
  clienteId: string,
  o: OpcionesMensaje = {},
): { text: string; values: unknown[] } {
  const critico = o.critico ?? false;
  const motivo =
    o.motivo === undefined ? (critico ? "codigo" : null) : o.motivo;
  return {
    text: `insert into buzon_mensaje
        (tenant_id, cliente_id, id_sunat, asunto, remitente, fecha, codigo_tipo, categoria, critico, motivo_critico,
         version_catalogo, avisado, leido_sunat, primera_captura_en, ultima_captura_en, adjuntos_declarados,
         contenido_ruta, contenido_bytes, contenido_obtenido_en)
       values ($1, $2, $3, $4, $5, now() - $6::interval, $7, $8, $9, $10, $11, $12, $13, now(), now(), $14,
               $15::text, case when $15::text is null then null else 120 end, case when $15::text is null then null else now() end)
       ${o.conflicto ? "on conflict (tenant_id, cliente_id, id_sunat) do nothing" : ""}
       returning id`,
    values: [
      tenantId,
      clienteId,
      o.idSunat ?? `M-${randomUUID().slice(0, 12)}`,
      o.asunto ?? "Asunto de prueba",
      o.remitente ?? "SUNAT",
      o.fechaHace ?? "2 days",
      o.codigoTipo === undefined ? null : o.codigoTipo,
      o.categoria ?? (critico ? "coactiva" : "otro"),
      critico,
      motivo,
      o.version ?? 1,
      o.avisado ?? false,
      o.leido ?? false,
      o.declarados ?? 0,
      o.contenidoRuta ?? null,
    ],
  };
}

export async function insertarMensaje(
  q: Q,
  tenantId: string,
  clienteId: string,
  o: OpcionesMensaje = {},
): Promise<string> {
  const { text, values } = sqlMensaje(tenantId, clienteId, o);
  return (await q.query(text, values)).rows[0].id as string;
}

export interface OpcionesAdjunto {
  idSunat?: string;
  nombre?: string;
  mime?: string | null;
  tamano?: number | null;
  sha256?: Buffer | null;
  ruta?: string | null;
  omitido?: string | null;
  ext?: string;
}

export function sqlAdjunto(
  tenantId: string,
  clienteId: string,
  mensajeId: string,
  o: OpcionesAdjunto = {},
): { text: string; values: unknown[] } {
  const omitido = o.omitido ?? null;
  const guardado = omitido === null;
  return {
    text: `insert into buzon_adjunto (tenant_id, cliente_id, mensaje_id, id_sunat, nombre, mime, tamano, sha256, ruta, omitido, creado_en)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now()) returning id`,
    values: [
      tenantId,
      clienteId,
      mensajeId,
      o.idSunat ?? `A-${randomUUID().slice(0, 12)}`,
      o.nombre ?? "factura.pdf",
      o.mime === undefined ? (guardado ? "application/pdf" : null) : o.mime,
      o.tamano === undefined ? (guardado ? 1234 : null) : o.tamano,
      o.sha256 === undefined ? (guardado ? randomBytes(32) : null) : o.sha256,
      o.ruta === undefined
        ? guardado
          ? rutaBuzon(tenantId, clienteId, o.ext ?? "pdf")
          : null
        : o.ruta,
      omitido,
    ],
  };
}

export async function insertarAdjunto(
  q: Q,
  tenantId: string,
  clienteId: string,
  mensajeId: string,
  o: OpcionesAdjunto = {},
): Promise<string> {
  const { text, values } = sqlAdjunto(tenantId, clienteId, mensajeId, o);
  return (await q.query(text, values)).rows[0].id as string;
}

export interface OpcionesEstado {
  /** Cada instante es un intervalo SQL de antiguedad ('3 hours') o null. */
  programadaHace?: string | null;
  solicitudHace?: string | null;
  capturaHace?: string | null;
  sincronizadoHace?: string | null;
  cursor?: string | null;
}

/** Upsert de la fila de estado del cliente (idempotente: sirve para sembrar de forma perezosa). */
export async function upsertEstado(
  q: Q,
  tenantId: string,
  clienteId: string,
  o: OpcionesEstado = {},
): Promise<void> {
  const f = (v: string | null | undefined) => (v === undefined ? null : v);
  await q.query(
    `insert into buzon_estado_cliente
        (tenant_id, cliente_id, ultima_programada_en, ultima_solicitud_en, ultima_captura_en, sincronizado_en, cursor_pendiente)
       values ($1, $2, now() - $3::interval, now() - $4::interval, now() - $5::interval, now() - $6::interval, $7)
     on conflict (tenant_id, cliente_id) do update set
        ultima_programada_en = excluded.ultima_programada_en, ultima_solicitud_en = excluded.ultima_solicitud_en,
        ultima_captura_en = excluded.ultima_captura_en, sincronizado_en = excluded.sincronizado_en,
        cursor_pendiente = excluded.cursor_pendiente`,
    [
      tenantId,
      clienteId,
      f(o.programadaHace),
      f(o.solicitudHace),
      f(o.capturaHace),
      f(o.sincronizadoHace),
      f(o.cursor),
    ],
  );
}

// ---- Roles dentro de una transaccion del superusuario que siempre se revierte -----------------------------------------------
const soloRol = (rol: string): string => {
  if (!/^contapp_[a-z]+$/.test(rol))
    throw new Error("rol invalido en la prueba");
  return rol;
};

/** BEGIN; app.tenant_id (si se da); SET LOCAL ROLE `rol`; `fn`; ROLLBACK. Para hablar con el rol sin `withTenant` y poder ajustar la BD. */
export async function comoRol<T>(
  admin: Pool,
  rol: string | null,
  tenantId: string | null,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  return enTx(admin, null, async (c) => {
    if (tenantId)
      await c.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    if (rol) await c.query(`SET LOCAL ROLE ${soloRol(rol)}`);
    return fn(c);
  });
}

/** Ejecuta `fn` con el superusuario dentro de `comoRol` y vuelve al rol. */
export async function comoAdmin<T>(
  c: PoolClient,
  rol: string,
  fn: () => Promise<T>,
): Promise<T> {
  await c.query("RESET ROLE");
  try {
    return await fn();
  } finally {
    await c.query(`SET LOCAL ROLE ${soloRol(rol)}`);
  }
}

// ---- Catalogo --------------------------------------------------------------------------------------------------------------
export interface InfoFuncion {
  secdef: boolean;
  config: string[];
  dueno: string;
  duenoSuper: boolean;
  duenoBypass: boolean;
}

export async function infoFuncion(
  admin: Pool,
  firma: string,
): Promise<InfoFuncion> {
  const r = await admin.query(
    `select p.prosecdef as secdef, coalesce(p.proconfig, '{}') as config, r.rolname as dueno,
            r.rolsuper as dueno_super, r.rolbypassrls as dueno_bypass
       from pg_proc p join pg_roles r on r.oid = p.proowner
      where p.oid = $1::regprocedure`,
    [firma],
  );
  const f = r.rows[0];
  return {
    secdef: f.secdef,
    config: f.config,
    dueno: f.dueno,
    duenoSuper: f.dueno_super,
    duenoBypass: f.dueno_bypass,
  };
}

/** Roles (de una lista) con EXECUTE sobre la funcion, mas `PUBLIC` si el privilegio esta concedido a todos. */
export async function conExecute(
  admin: Pool,
  firma: string,
  roles: readonly string[],
): Promise<string[]> {
  const salida: string[] = [];
  for (const rol of roles) {
    const r = await admin.query(
      "select has_function_privilege($1, $2::regprocedure, 'execute') as ok",
      [rol, firma],
    );
    if (r.rows[0].ok === true) salida.push(rol);
  }
  const publico = await admin.query(
    `select exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     where p.oid = $1::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') as ok`,
    [firma],
  );
  if (publico.rows[0].ok === true) salida.push("PUBLIC");
  return salida.sort();
}

export const ROLES_EXEC = [
  "contapp_backend",
  "contapp_worker",
  "contapp_app",
  "contapp_platform",
  "contapp_enumerador",
] as const;

/** Escenario de 023: extiende el de notificaciones (estudios, suscripciones, usuarios, clientes, credenciales y trabajos). */
export class EscenarioBuzon extends EscenarioNotif {
  private progOriginal: Record<string, unknown> | undefined;

  /** Estudio con suscripcion (por omision activa, plan de 1440 min). `estado: null` = sin suscripcion. */
  async estudioSub(
    o: {
      estado?: "activa" | "prueba" | null;
      venceEn?: string | null;
      frecuenciaMin?: number;
    } = {},
  ): Promise<string> {
    const x = await this.estudio();
    if (o.estado !== null) {
      const p = await this.ep.plan({
        frecuenciaBuzonMin: o.frecuenciaMin ?? 1440,
      });
      await this.ep.suscribir(x.id, p.id, {
        estado: o.estado ?? "activa",
        ...(o.venceEn !== undefined ? { venceEn: o.venceEn } : {}),
      });
    }
    return x.id;
  }

  /** Cliente con RUC unico y, si se pide, credencial SOL en el estado dado, archivado o no. */
  async clienteCon(
    tenantId: string,
    o: {
      cred?: "configurada" | "verificada" | "invalida" | "solo_sire" | null;
      archivado?: boolean;
    } = {},
  ): Promise<ClientePrueba> {
    const c = await this.et.cliente(tenantId);
    const cred = o.cred === undefined ? "configurada" : o.cred;
    if (cred !== null) {
      await this.et.credencial(
        tenantId,
        c.id,
        cred === "solo_sire" ? "sire_api" : "sol",
      );
      if (cred === "verificada" || cred === "invalida") {
        await this.admin.query(
          "update credencial set estado = $3 where tenant_id = $1 and cliente_id = $2 and tipo = 'sol'",
          [tenantId, c.id, cred],
        );
      }
    }
    if (o.archivado)
      await this.admin.query(
        "update cliente set archivado_at = now() where id = $1",
        [c.id],
      );
    return c;
  }

  /** Trabajo `sol.buzon.revisar` sembrado como lo dejaria 023 (clave del catalogo). */
  revisar(
    tenantId: string,
    c: ClientePrueba,
    o: { estado?: string; prioridad?: string; creadoPor?: string | null } = {},
  ): Promise<string> {
    return this.et.job(tenantId, c, {
      tipo: "sol.buzon.revisar",
      cola: "sol",
      canal: "sol",
      prioridad: o.prioridad ?? "programado",
      estado: o.estado ?? "en_cola",
      parametros: {},
      claveDedupe: claveBuzon(c.id),
      maxIntentos: 4,
      creadoPor: o.creadoPor ?? null,
    });
  }

  /** Guarda la fila unica de `buzon_programacion` para restaurarla en `limpiar` (no falla si la tabla aun no existe). */
  async guardarProgramacion(): Promise<void> {
    if (this.progOriginal) return;
    try {
      this.progOriginal = (
        await this.admin.query("select * from buzon_programacion")
      ).rows[0];
    } catch {
      /* rojo: la tabla aun no existe */
    }
  }

  async fijarProgramacion(
    c: Q,
    cambios: Record<string, unknown>,
  ): Promise<void> {
    const cols = Object.keys(cambios);
    if (!cols.every((k) => /^[a-z_]+$/.test(k)))
      throw new Error("columna invalida");
    await c.query(
      `update buzon_programacion set ${cols.map((k, i) => `${k} = $${i + 1}`).join(", ")}`,
      Object.values(cambios),
    );
  }

  async programacion(): Promise<any> {
    return (await this.admin.query("select * from buzon_programacion")).rows[0];
  }

  /** Notificaciones `buzon_critico` de un cliente: usuarios ordenados. */
  async avisados(tenantId: string, clienteId: string): Promise<string[]> {
    return (await this.notifs(tenantId, { tipo: "buzon_critico", clienteId }))
      .map((n) => n.usuario_id)
      .sort();
  }

  async auditoriaDe(tenantId: string, accion: string): Promise<any[]> {
    return (
      await this.admin.query(
        "select * from auditoria where tenant_id = $1 and accion = $2 order by ocurrida_en, id",
        [tenantId, accion],
      )
    ).rows;
  }

  override async limpiar(): Promise<void> {
    const c = await this.admin.connect();
    try {
      await c.query("SET session_replication_role = replica");
      for (const tabla of [
        "buzon_adjunto",
        "buzon_mensaje",
        "buzon_estado_cliente",
      ]) {
        await c
          .query(`delete from ${tabla} where tenant_id = any($1::uuid[])`, [
            this.estudios,
          ])
          .catch(() => undefined);
      }
      const p = this.progOriginal;
      if (p) {
        await c
          .query(
            `update buzon_programacion set intervalo_min = $1, reserva_interactiva = $2, lote_estudio = $3, ciclo_dueno = $4,
                    ciclo_hasta = $5, ultimo_ciclo_inicio = $6, ultimo_ciclo_fin = $7`,
            [
              p.intervalo_min,
              p.reserva_interactiva,
              p.lote_estudio,
              p.ciclo_dueno,
              p.ciclo_hasta,
              p.ultimo_ciclo_inicio,
              p.ultimo_ciclo_fin,
            ],
          )
          .catch(() => undefined);
      }
    } catch {
      /* limpieza de mejor esfuerzo */
    } finally {
      c.release(true);
    }
    await super.limpiar();
  }
}

export const aMs = (d: unknown): number =>
  new Date(d as string | Date).getTime();
