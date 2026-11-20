// Escritura del buzón SOL por el worker y auditoría del backend (spec 023). Todo recibe la `tx` de withTenant: el estudio sale de
// app.tenant_id (default de tenant_id) y ningún valor de la fila viaja en el texto SQL. La clasificación, el crítico y el aviso
// llegan ya decididos por el dominio; la BD exige el aviso (0056) y no deja reescribirlos (0054).
import { BuzonRepoError, consultar, type TxConsulta } from "./errores";

export interface EntradaMensajeBuzon {
  clienteId: string;
  idSunat: string;
  asunto: string;
  remitente: string;
  fecha: Date;
  codigoTipo: string | null;
  categoria: string;
  critico: boolean;
  motivoCritico: "codigo" | "asunto" | "duda" | null;
  versionCatalogo: number;
  avisado: boolean;
  leidoEnSunat: boolean;
  adjuntosDeclarados: number;
}

export interface AdjuntoGuardarBuzon {
  idSunat: string;
  nombre: string;
  mime: string | null;
  tamano: number | null;
  sha256: Uint8Array | null;
  ruta: string | null;
  omitido: "mime" | "tamano" | "tope_mensaje" | null;
}

export type AccionAuditoriaBuzon =
  | "buzon.captura_solicitada"
  | "buzon.apertura_solicitada"
  | "buzon.contenido_visto"
  | "buzon.adjunto_descargado";

const SQL_INSERTAR_MENSAJE = `insert into buzon_mensaje
  (cliente_id, id_sunat, asunto, remitente, fecha, codigo_tipo, categoria, critico, motivo_critico, version_catalogo, avisado,
   leido_sunat, adjuntos_declarados)
values ($1::uuid, $2::text, $3::text, $4::text, $5::timestamptz, $6::text, $7::text, $8::boolean, $9::text, $10::integer,
        $11::boolean, $12::boolean, $13::integer)
on conflict (tenant_id, cliente_id, id_sunat) do nothing
returning id`;
const SQL_CONOCIDOS = `select id, id_sunat, leido_sunat from buzon_mensaje
 where cliente_id = $1::uuid and id_sunat = any($2::text[])`;
const SQL_ACTUALIZAR_CONOCIDOS = `update buzon_mensaje m
   set leido_sunat = x.leido, ultima_captura_en = now()
  from unnest($2::text[], $3::boolean[]) as x(id_sunat, leido)
 where m.cliente_id = $1::uuid and m.id_sunat = x.id_sunat`;
const SQL_ESTADO_CAPTURA = `insert into buzon_estado_cliente (cliente_id, ultima_captura_en, cursor_pendiente, sincronizado_en)
values ($1::uuid, now(), $2::text, case when $3::boolean then now() end)
on conflict (tenant_id, cliente_id) do update
   set ultima_captura_en = excluded.ultima_captura_en,
       cursor_pendiente = excluded.cursor_pendiente,
       sincronizado_en = coalesce(buzon_estado_cliente.sincronizado_en, excluded.sincronizado_en)`;
// H-023-2-1: marca de relleno ANTES de guardar el primer mensaje nuevo de un cliente ya sincronizado. Si el proceso muere a
// mitad, la captura siguiente no se detiene en el primer conocido. No pisa un cursor que ya estuviera guardado.
const SQL_MARCAR_RELLENO = `insert into buzon_estado_cliente (cliente_id, cursor_pendiente)
values ($1::uuid, $2::text)
on conflict (tenant_id, cliente_id) do update
   set cursor_pendiente = coalesce(buzon_estado_cliente.cursor_pendiente, excluded.cursor_pendiente)`;
// H-023-2-4: el reloj de la BD, el mismo con el que el trigger de 0056 exige el aviso.
const SQL_RELOJ = "select clock_timestamp() as ahora";
const SQL_INSERTAR_ADJUNTO = `insert into buzon_adjunto (cliente_id, mensaje_id, id_sunat, nombre, mime, tamano, sha256, ruta, omitido)
values ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::bigint, $7::bytea, $8::text, $9::text)
on conflict (tenant_id, mensaje_id, id_sunat) do nothing`;
// leido_sunat solo puede pasar a true (nunca se desmarca al abrir).
const SQL_GUARDAR_CONTENIDO = `update buzon_mensaje
   set contenido_ruta = $2::text, contenido_bytes = $3::integer, contenido_obtenido_en = now(),
       leido_sunat = leido_sunat or $4::boolean
 where id = $1::uuid and cliente_id = $5::uuid`;
const SQL_AUDITAR =
  "select buzon_auditar($1::text, $2::uuid, $3::uuid, $4::uuid)";

/** Inserta el mensaje nuevo; `null` si otra captura ya lo insertó (no se avisa dos veces). */
export async function insertarMensajeBuzon(
  tx: TxConsulta,
  m: EntradaMensajeBuzon,
): Promise<{ id: string } | null> {
  const r = await consultar(tx, SQL_INSERTAR_MENSAJE, [
    m.clienteId,
    m.idSunat,
    m.asunto,
    m.remitente,
    m.fecha,
    m.codigoTipo,
    m.categoria,
    m.critico,
    m.motivoCritico,
    m.versionCatalogo,
    m.avisado,
    m.leidoEnSunat,
    m.adjuntosDeclarados,
  ]);
  const f = r.rows[0];
  return f === undefined ? null : { id: String(f.id) };
}

/** Mensajes ya guardados del cliente entre `idsSunat`, por id de SUNAT. */
export async function conocidosBuzon(
  tx: TxConsulta,
  clienteId: string,
  idsSunat: string[],
): Promise<Map<string, { id: string; leidoEnSunat: boolean }>> {
  const salida = new Map<string, { id: string; leidoEnSunat: boolean }>();
  if (idsSunat.length === 0) return salida;
  const r = await consultar(tx, SQL_CONOCIDOS, [clienteId, idsSunat]);
  for (const f of r.rows)
    salida.set(String(f.id_sunat), {
      id: String(f.id),
      leidoEnSunat: f.leido_sunat === true,
    });
  return salida;
}

/** Actualiza leído en SUNAT y la última captura de los conocidos, en una sola sentencia; devuelve cuántos cambió. */
export async function actualizarConocidosBuzon(
  tx: TxConsulta,
  clienteId: string,
  items: { idSunat: string; leidoEnSunat: boolean }[],
): Promise<number> {
  if (items.length === 0) return 0;
  const r = await consultar(tx, SQL_ACTUALIZAR_CONOCIDOS, [
    clienteId,
    items.map((i) => i.idSunat),
    items.map((i) => i.leidoEnSunat),
  ]);
  return r.rowCount;
}

/** Cierra una captura: última captura, cursor pendiente (relleno de P-5) y, al sincronizar, la primera sincronización. */
export async function guardarEstadoCapturaBuzon(
  tx: TxConsulta,
  clienteId: string,
  e: { cursorPendiente: string | null; sincronizado: boolean },
): Promise<void> {
  await consultar(tx, SQL_ESTADO_CAPTURA, [
    clienteId,
    e.cursorPendiente,
    e.sincronizado,
  ]);
}

/** Deja un cursor pendiente (relleno) si no había uno: se llama antes de guardar el primer mensaje nuevo (H-023-2-1). */
export async function marcarRellenoBuzon(
  tx: TxConsulta,
  clienteId: string,
  cursor: string,
): Promise<void> {
  await consultar(tx, SQL_MARCAR_RELLENO, [clienteId, cursor]);
}

/** Reloj de la BD (`clock_timestamp()`): la regla de los 30 días del aviso se mide con él, no con el del proceso (H-023-2-4). */
export async function relojBdBuzon(tx: TxConsulta): Promise<Date> {
  const r = await consultar(tx, SQL_RELOJ, []);
  const v: unknown = r.rows[0]?.ahora;
  const fecha = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(fecha.getTime())) throw new BuzonRepoError("desconocido");
  return fecha;
}

/**
 * Guarda los adjuntos (ON CONFLICT DO NOTHING) y DESPUÉS fija el contenido del mensaje: el trigger de auditoría
 * (buzon.contenido_obtenido) cuenta lo ya guardado. El contenido se fija una sola vez (0054); un mensaje que no es del cliente
 * sale como BuzonRepoError P0002.
 */
export async function guardarContenidoBuzon(
  tx: TxConsulta,
  c: {
    clienteId: string;
    mensajeId: string;
    contenidoRuta: string;
    contenidoBytes: number;
    marcoLeido: boolean;
    adjuntos: AdjuntoGuardarBuzon[];
  },
): Promise<void> {
  for (const a of c.adjuntos) {
    await consultar(tx, SQL_INSERTAR_ADJUNTO, [
      c.clienteId,
      c.mensajeId,
      a.idSunat,
      a.nombre,
      a.mime,
      a.tamano,
      a.sha256 === null ? null : Buffer.from(a.sha256),
      a.ruta,
      a.omitido,
    ]);
  }
  const r = await consultar(tx, SQL_GUARDAR_CONTENIDO, [
    c.mensajeId,
    c.contenidoRuta,
    c.contenidoBytes,
    c.marcoLeido,
    c.clienteId,
  ]);
  if (r.rowCount === 0) throw new BuzonRepoError("P0002");
}

/** Auditoría de las acciones del backend (actor usuario); la BD valida la pertenencia al cliente y al estudio. */
export async function auditarBuzon(
  tx: TxConsulta,
  accion: AccionAuditoriaBuzon,
  o: {
    clienteId: string;
    mensajeId?: string | null;
    adjuntoId?: string | null;
  },
): Promise<void> {
  await consultar(tx, SQL_AUDITAR, [
    accion,
    o.clienteId,
    o.mensajeId ?? null,
    o.adjuntoId ?? null,
  ]);
}
