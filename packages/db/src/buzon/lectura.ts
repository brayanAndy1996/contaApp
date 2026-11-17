// Lectura del buzón SOL (spec 023, D-8). Todo recibe la `tx` de withTenant (RLS: solo el estudio de la sesión); el cliente va
// siempre en el WHERE, así que un mensaje o adjunto de otro cliente (ids cruzados) no devuelve nada. La lista nunca trae el
// contenido ni su ruta: solo si ya se obtuvo.
import {
  BuzonRepoError,
  consultar,
  type FilaBuzon,
  type TxConsulta,
} from "./errores";

export interface EstadoBuzon {
  ultimaProgramadaEn: Date | null;
  ultimaSolicitudEn: Date | null;
  ultimaCapturaEn: Date | null;
  sincronizadoEn: Date | null;
  cursorPendiente: string | null;
}

export interface MensajeBuzonFila {
  id: string;
  asunto: string;
  remitente: string;
  fecha: Date;
  categoria: string;
  critico: boolean;
  motivoCritico: string | null;
  leidoEnSunat: boolean;
  contenidoObtenido: boolean;
  adjuntosDeclarados: number;
}

export interface AdjuntoBuzon {
  id: string;
  idSunat: string;
  nombre: string;
  mime: string | null;
  tamano: number | null;
  /** SHA-256 en hexadecimal. */
  sha256: string | null;
  ruta: string | null;
  omitido: "mime" | "tamano" | "tope_mensaje" | null;
}

export interface DetalleMensajeBuzon extends MensajeBuzonFila {
  contenidoRuta: string | null;
  adjuntos: AdjuntoBuzon[];
}

const LIMITE_POR_OMISION = 50;
const LIMITE_MAXIMO = 100;

const COLUMNAS_ESTADO =
  "ultima_programada_en, ultima_solicitud_en, ultima_captura_en, sincronizado_en, cursor_pendiente";
const COLUMNAS_MENSAJE = `id, asunto, remitente, fecha, categoria, critico, motivo_critico, leido_sunat,
  contenido_ruta is not null as contenido_obtenido, adjuntos_declarados`;
const COLUMNAS_ADJUNTO =
  "id, id_sunat, nombre, mime, tamano, sha256, ruta, omitido";

const SQL_ESTADO = `select ${COLUMNAS_ESTADO} from buzon_estado_cliente where cliente_id = $1`;
const SQL_LISTAR = `select ${COLUMNAS_MENSAJE}
  from buzon_mensaje
 where cliente_id = $1
   and ($2::timestamptz is null or (fecha, id) < ($2::timestamptz, $3::uuid))
 order by fecha desc, id desc
 limit $4::integer`;
const SQL_MENSAJE = `select ${COLUMNAS_MENSAJE}, contenido_ruta from buzon_mensaje where cliente_id = $1 and id = $2`;
const SQL_ADJUNTOS = `select ${COLUMNAS_ADJUNTO} from buzon_adjunto
 where cliente_id = $1 and mensaje_id = $2 order by creado_en, id`;
const SQL_ADJUNTO = `select ${COLUMNAS_ADJUNTO} from buzon_adjunto where cliente_id = $1 and mensaje_id = $2 and id = $3`;
const SQL_BLOQUEAR_ESTADO = `select ${COLUMNAS_ESTADO} from buzon_estado_bloquear($1::uuid)`;

const fechaONulo = (v: unknown): Date | null =>
  v === null || v === undefined
    ? null
    : v instanceof Date
      ? v
      : new Date(String(v));
const numeroONulo = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
const textoONulo = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

function aEstado(f: FilaBuzon): EstadoBuzon {
  return {
    ultimaProgramadaEn: fechaONulo(f.ultima_programada_en),
    ultimaSolicitudEn: fechaONulo(f.ultima_solicitud_en),
    ultimaCapturaEn: fechaONulo(f.ultima_captura_en),
    sincronizadoEn: fechaONulo(f.sincronizado_en),
    cursorPendiente: textoONulo(f.cursor_pendiente),
  };
}

function aFila(f: FilaBuzon): MensajeBuzonFila {
  return {
    id: String(f.id),
    asunto: String(f.asunto),
    remitente: String(f.remitente),
    fecha: fechaONulo(f.fecha)!,
    categoria: String(f.categoria),
    critico: f.critico === true,
    motivoCritico: textoONulo(f.motivo_critico),
    leidoEnSunat: f.leido_sunat === true,
    contenidoObtenido: f.contenido_obtenido === true,
    adjuntosDeclarados: Number(f.adjuntos_declarados),
  };
}

function aAdjunto(f: FilaBuzon): AdjuntoBuzon {
  const sha = f.sha256 as Uint8Array | null | undefined;
  return {
    id: String(f.id),
    idSunat: String(f.id_sunat),
    nombre: String(f.nombre),
    mime: textoONulo(f.mime),
    tamano: numeroONulo(f.tamano),
    sha256:
      sha === null || sha === undefined
        ? null
        : Buffer.from(sha).toString("hex"),
    ruta: textoONulo(f.ruta),
    omitido: textoONulo(f.omitido) as AdjuntoBuzon["omitido"],
  };
}

const acotarLimite = (limite: number | undefined): number =>
  Number.isInteger(limite)
    ? Math.min(Math.max(limite!, 1), LIMITE_MAXIMO)
    : LIMITE_POR_OMISION;

/** Estado de captura del cliente; `null` si nunca se programó, pidió ni capturó. */
export async function leerEstadoBuzon(
  tx: TxConsulta,
  clienteId: string,
): Promise<EstadoBuzon | null> {
  const f = (await consultar(tx, SQL_ESTADO, [clienteId])).rows[0];
  return f === undefined ? null : aEstado(f);
}

/**
 * «Revisar ahora» (backend, orden de bloqueo del plan: estado -> trabajo): crea la fila de estado si falta y la bloquea FOR UPDATE
 * hasta el fin de la transacción (función acotada `buzon_estado_bloquear`, sin INSERT directo). Cliente ajeno: BuzonRepoError 23503.
 */
export async function bloquearEstadoBuzon(
  tx: TxConsulta,
  clienteId: string,
): Promise<EstadoBuzon> {
  const f = (await consultar(tx, SQL_BLOQUEAR_ESTADO, [clienteId])).rows[0];
  if (f === undefined) throw new BuzonRepoError("P0002");
  return aEstado(f);
}

/** Mensajes del cliente del más reciente al más antiguo (fecha desc, id desc), desde el cursor `antes` (exclusivo). */
export async function listarMensajesBuzon(
  tx: TxConsulta,
  clienteId: string,
  o: { antes?: { fecha: Date; id: string }; limite?: number },
): Promise<MensajeBuzonFila[]> {
  const r = await consultar(tx, SQL_LISTAR, [
    clienteId,
    o.antes?.fecha ?? null,
    o.antes?.id ?? null,
    acotarLimite(o.limite),
  ]);
  return r.rows.map(aFila);
}

/** Mensaje del cliente con la ruta del contenido y sus adjuntos; `null` si no es del cliente o no existe. */
export async function leerMensajeBuzon(
  tx: TxConsulta,
  clienteId: string,
  mensajeId: string,
): Promise<DetalleMensajeBuzon | null> {
  const f = (await consultar(tx, SQL_MENSAJE, [clienteId, mensajeId])).rows[0];
  if (f === undefined) return null;
  const adjuntos = (
    await consultar(tx, SQL_ADJUNTOS, [clienteId, mensajeId])
  ).rows.map(aAdjunto);
  return { ...aFila(f), contenidoRuta: textoONulo(f.contenido_ruta), adjuntos };
}

/** Adjunto por cliente, mensaje y adjunto a la vez; `null` si alguno no corresponde. */
export async function leerAdjuntoBuzon(
  tx: TxConsulta,
  clienteId: string,
  mensajeId: string,
  adjuntoId: string,
): Promise<AdjuntoBuzon | null> {
  const f = (
    await consultar(tx, SQL_ADJUNTO, [clienteId, mensajeId, adjuntoId])
  ).rows[0];
  return f === undefined ? null : aAdjunto(f);
}
