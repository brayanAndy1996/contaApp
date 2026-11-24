// Envíos, avisos de un envío y destinatario (spec 028; R-3, R-9, R-11, R-12), con la `tx` del worker en el estudio del envío.
// `tomarEnvio`/`cerrarEnvio` y el token pasan por las funciones acotadas de 0074; las lecturas van bajo la RLS del estudio (el worker no
// lee `notificacion` ni `usuario`: el aviso guarda su lista blanca y el correo vigente llega por `correo_destinatario`).
import {
  ARGUMENTO_INVALIDO,
  consultarCorreo,
  CorreoRepoError,
  exigirIdCorreo,
  fechaONull,
  NO_ENCONTRADO,
  type FilaCorreo,
  type TxConsulta,
} from "./errores";

export type TipoCorreo =
  "buzon_critico" | "credencial_invalida" | "plan_limite" | "resumen";
export type OrigenEnvio = "aviso" | "resumen" | "pendientes";
export type EstadoCierre = "enviado" | "omitido" | "fallido";
export type MotivoEnvio =
  | "membresia_inactiva"
  | "sin_correo"
  | "preferencia_apagada"
  | "sin_plan"
  | "sin_contenido"
  | "sin_novedades"
  | "transporte";

export interface EnvioTomado {
  id: string;
  usuarioId: string;
  tipo: TipoCorreo;
  origen: OrigenEnvio;
  /** Intentos incluido este (1 en la primera toma). */
  intentos: number;
  /** AAAA-MM-DD de Lima (resumen y pendientes); null en los avisos. */
  diaLima: string | null;
  /** Solo en `resumen`: `corte_hasta` del último resumen cerrado del usuario en el estudio (`enviado`, u `omitido` por `sin_novedades`); null si no hay. */
  corteDesde: Date | null;
}

/** Plan del estudio al tomar el envío (R-12): suscripción activa o prueba vigente y funciones de correo habilitadas (ausente = true). */
export interface PlanCorreo {
  vigente: boolean;
  avisos: boolean;
  resumen: boolean;
}

/**
 * Lo que el worker revalida al enviar (R-3, R-12), leído en la misma toma: la preferencia efectiva del tipo del envío (la fila o la
 * inicial por rol), la marca guardada de «todos los clientes» y el plan. La membresía y el correo vigente, con `leerDestinatario`.
 */
export interface EnvioTomadoParaEnviar {
  envio: EnvioTomado;
  preferencia: boolean;
  todosClientes: boolean;
  plan: PlanCorreo;
}

export interface CierreEnvio {
  estado: EstadoCierre;
  motivo?: MotivoEnvio | null;
  /** Hasta dónde contó el resumen (solo `enviado` y `omitido` por `sin_novedades`). */
  corteHasta?: Date | null;
}

export interface AvisoEnvio {
  notificacionId: string;
  tipo: "buzon_critico" | "credencial_invalida" | "plan_limite";
  clienteId: string | null;
  razonSocial: string | null;
  /** `params.categoria` (buzón crítico); null en los demás. */
  categoria: string | null;
  /** `params.recurso` y `params.umbral` (plan_limite); null en los demás. */
  recurso: "rucs" | "usuarios" | null;
  porcentaje: number | null;
  /** Fecha del mensaje de buzón (`buzon_mensaje.fecha`) en `buzon_critico`; `creada_en` de la notificación en los demás. */
  fecha: Date;
}

export interface Destinatario {
  usuarioId: string;
  email: string;
  rol: "dueno" | "admin" | "contador" | "asistente" | "lectura";
  estudioNombre: string;
}

const ESTADOS: readonly string[] = ["enviado", "omitido", "fallido"];
const MOTIVOS: readonly string[] = [
  "membresia_inactiva",
  "sin_correo",
  "preferencia_apagada",
  "sin_plan",
  "sin_contenido",
  "sin_novedades",
  "transporte",
];

const SQL_TOMAR = "select correo_envio_tomar($1::uuid) as r";
const SQL_CERRAR =
  "select correo_envio_cerrar($1::uuid, $2::text, $3::text, $4::timestamptz)";
const SQL_DESTINATARIO = "select correo_destinatario($1::uuid) as d";

// Avisos del envío (también los diferidos que un resumen o un «pendientes» lleva unidos), solo los visibles hoy para su usuario: sin
// cliente siempre; con cliente, no archivado y con alcance (global para Dueño y Administrador, asignado para el resto: filtroAlcance).
const SQL_AVISOS = `
select a.notificacion_id, a.tipo, a.cliente_id, c.razon_social, a.categoria, a.recurso, a.umbral,
       coalesce(bm.fecha, a.notificada_en) as fecha
  from correo_envio e
  join membresia m on m.usuario_id = e.usuario_id
  join correo_envio_aviso a on a.tenant_id = e.tenant_id and a.envio_id = e.id
  left join cliente c on c.id = a.cliente_id
  left join buzon_mensaje bm on a.tipo = 'buzon_critico' and bm.cliente_id = a.cliente_id and bm.id = a.mensaje_id
 where e.id = $1::uuid
   and (a.cliente_id is null
        or (c.id is not null and c.archivado_at is null
            and (m.rol in ('dueno', 'admin')
                 or exists (select 1 from asignacion s where s.cliente_id = a.cliente_id and s.usuario_id = e.usuario_id))))
 order by a.notificada_en, a.notificacion_id`;

function aEnvio(r: FilaCorreo): EnvioTomado {
  return {
    id: String(r.envioId),
    usuarioId: String(r.usuarioId),
    tipo: r.tipo as TipoCorreo,
    origen: r.origen as OrigenEnvio,
    intentos: Number(r.intentos),
    diaLima: typeof r.diaLima === "string" ? r.diaLima : null,
    corteDesde: fechaONull(r.corteDesde),
  };
}

async function tomar(tx: TxConsulta, envioId: string): Promise<FilaCorreo> {
  const id = exigirIdCorreo(envioId);
  const [f] = await consultarCorreo(tx, SQL_TOMAR, [id]);
  const r = f?.r as FilaCorreo | null | undefined;
  if (r === null || r === undefined || typeof r !== "object")
    throw new CorreoRepoError(NO_ENCONTRADO);
  return r;
}

/** `correo_envio_tomar(p_envio)`: marca `tomado_en`, suma un intento y devuelve el envío. P0002 si es ajeno o no existe. */
export async function tomarEnvio(
  tx: TxConsulta,
  envioId: string,
): Promise<EnvioTomado> {
  return aEnvio(await tomar(tx, envioId));
}

/** Como `tomarEnvio`, más la revalidación de R-3 y R-12 leída en la misma toma (preferencia, «todos los clientes» y plan). */
export async function tomarEnvioParaEnviar(
  tx: TxConsulta,
  envioId: string,
): Promise<EnvioTomadoParaEnviar> {
  const r = await tomar(tx, envioId);
  const plan = (r.plan ?? {}) as Record<string, unknown>;
  return {
    envio: aEnvio(r),
    preferencia: r.preferencia === true,
    todosClientes: r.todosClientes === true,
    plan: {
      vigente: plan.vigente === true,
      avisos: plan.avisos === true,
      resumen: plan.resumen === true,
    },
  };
}

/** `correo_envio_cerrar(p_envio, p_estado, p_motivo, p_corte)`. 22023 con estado o motivo fuera de la lista. */
export async function cerrarEnvio(
  tx: TxConsulta,
  envioId: string,
  cierre: CierreEnvio,
): Promise<void> {
  const id = exigirIdCorreo(envioId);
  const estado: unknown = cierre?.estado;
  const motivo: unknown = cierre?.motivo ?? null;
  const corte: unknown = cierre?.corteHasta ?? null;
  if (typeof estado !== "string" || !ESTADOS.includes(estado))
    throw new CorreoRepoError(ARGUMENTO_INVALIDO);
  if (motivo !== null && (typeof motivo !== "string" || !MOTIVOS.includes(motivo)))
    throw new CorreoRepoError(ARGUMENTO_INVALIDO);
  if (corte !== null && (!(corte instanceof Date) || Number.isNaN(corte.getTime())))
    throw new CorreoRepoError(ARGUMENTO_INVALIDO);
  await consultarCorreo(tx, SQL_CERRAR, [id, estado, motivo, corte]);
}

/**
 * Avisos del envío, en orden cronológico (`creada_en`, id), solo los de la notificación de su usuario que siguen visibles:
 * sin cliente (plan_limite) siempre; con cliente, solo si no está archivado y el rol del usuario lo deja ver (`filtroAlcance`
 * global para Dueño y Administrador, asignado para el resto). Excluye los diferidos (`envio_id` nulo). Devuelve todos (el dominio
 * recorta a 20); la razón social viene del cliente.
 */
export async function leerAvisosEnvio(
  tx: TxConsulta,
  envioId: string,
): Promise<AvisoEnvio[]> {
  const id = exigirIdCorreo(envioId);
  const filas = await consultarCorreo(tx, SQL_AVISOS, [id]);
  return filas.map((f) => ({
    notificacionId: String(f.notificacion_id),
    tipo: f.tipo as AvisoEnvio["tipo"],
    clienteId: f.cliente_id === null ? null : String(f.cliente_id),
    razonSocial: f.razon_social === null ? null : String(f.razon_social),
    categoria: f.categoria === null ? null : String(f.categoria),
    recurso: f.recurso === null ? null : (f.recurso as "rucs" | "usuarios"),
    porcentaje: f.umbral === null ? null : Number(f.umbral),
    fecha: new Date(f.fecha as Date),
  }));
}

/** Membresía activa del usuario en el estudio del contexto con su correo vigente; null si está desactivada o no es miembro. */
export async function leerDestinatario(
  tx: TxConsulta,
  usuarioId: string,
): Promise<Destinatario | null> {
  const id = exigirIdCorreo(usuarioId);
  const [f] = await consultarCorreo(tx, SQL_DESTINATARIO, [id]);
  const d = f?.d as FilaCorreo | null | undefined;
  if (d === null || d === undefined) return null;
  return {
    usuarioId: String(d.usuarioId),
    email: String(d.email),
    rol: d.rol as Destinatario["rol"],
    estudioNombre: String(d.estudioNombre),
  };
}
