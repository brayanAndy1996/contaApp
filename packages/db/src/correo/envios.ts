/* eslint-disable @typescript-eslint/no-unused-vars -- stub en rojo de T4 (spec 028): T10 lo reemplaza */
// STUB (spec 028, T4 rojo): lo reemplaza T10. Envíos, avisos de un envío y destinatario (R-3, R-9, R-11), con la `tx` del worker.
import type { TxConsulta } from "./errores";

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

/** `correo_envio_tomar(p_envio)`: marca `tomado_en`, suma un intento y devuelve el envío. P0002 si es ajeno o no existe. */
export async function tomarEnvio(
  _tx: TxConsulta,
  _envioId: string,
): Promise<EnvioTomado> {
  throw new Error("no implementado: tomarEnvio");
}

/** `correo_envio_cerrar(p_envio, p_estado, p_motivo, p_corte)`. 22023 con estado o motivo fuera de la lista. */
export async function cerrarEnvio(
  _tx: TxConsulta,
  _envioId: string,
  _cierre: CierreEnvio,
): Promise<void> {
  throw new Error("no implementado: cerrarEnvio");
}

/**
 * Avisos del envío, en orden cronológico (`creada_en`, id), solo los de la notificación de su usuario que siguen visibles:
 * sin cliente (plan_limite) siempre; con cliente, solo si no está archivado y el rol del usuario lo deja ver (`filtroAlcance`
 * global para Dueño y Administrador, asignado para el resto). Excluye los diferidos (`envio_id` nulo). Devuelve todos (el dominio
 * recorta a 20); la razón social viene del cliente.
 */
export async function leerAvisosEnvio(
  _tx: TxConsulta,
  _envioId: string,
): Promise<AvisoEnvio[]> {
  throw new Error("no implementado: leerAvisosEnvio");
}

/** Membresía activa del usuario en el estudio del contexto con su correo vigente; null si está desactivada o no es miembro. */
export async function leerDestinatario(
  _tx: TxConsulta,
  _usuarioId: string,
): Promise<Destinatario | null> {
  throw new Error("no implementado: leerDestinatario");
}
