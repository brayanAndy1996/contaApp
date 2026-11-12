import type {
  CredencialEstadoDto,
  GuardarCredencialRespuesta,
  GuardarCredencialSire,
  GuardarCredencialSol,
  TipoCredencial,
  TrabajoVista,
} from "@contapp/shared";
import { api, type RespuestaApi } from "./api";

// Llamadas HTTP de credenciales (spec 007b, D4–D6). Solo envía y recibe lo del contrato de
// `@contapp/shared`. Es de solo escritura: la API nunca devuelve el secreto y aquí tampoco se conserva,
// registra ni se incluye en mensajes de error; los errores `{codigo}` llegan tal cual a la pantalla.

export type { CredencialEstadoDto, TipoCredencial };

export const MENSAJES_CREDENCIALES = {
  guardada: "Credencial guardada.",
  datosInvalidos: "Revisa los datos de la credencial.",
  verificacionEncolada: "Verificación encolada.",
  enlacePanel: "Ver en el panel de trabajos",
  clienteArchivado: "El cliente está archivado y es de solo lectura.",
  noConfigurada: "Primero guarda la credencial.",
  avisoClaveSol:
    "Si cambió la clave SOL, guarde o verifique de nuevo la credencial SIRE.",
} as const;

/**
 * Motivos que escribe el worker al invalidar una credencial (`MotivoEstadoCredencial`, packages/db) con su texto en
 * español. La pantalla nunca muestra el código crudo (spec 020, DT-3).
 */
export const MOTIVOS_CREDENCIAL: Readonly<Record<string, string>> = {
  credencial_invalida:
    "SUNAT rechazó las credenciales. Revísalas y guárdalas de nuevo.",
};

/** Texto para un motivo que el mapa no conoce. */
export const MOTIVO_CREDENCIAL_GENERICO =
  "No se pudo validar la credencial. Revísala y guárdala de nuevo.";

/** Traduce el motivo de una credencial «Inválida»; un código desconocido da el texto genérico. */
export const textoMotivoCredencial = (motivo: string): string =>
  MOTIVOS_CREDENCIAL[motivo] ?? MOTIVO_CREDENCIAL_GENERICO;

/** Tope de sondeo tras «Verificar»: pasado este tiempo la ficha deja de leer sola y se recarga a mano. */
export const TOPE_VERIFICANDO_MS = 120_000;

const base = (clienteId: string): string =>
  `/clientes/${encodeURIComponent(clienteId)}/credenciales`;

export const listarCredenciales = (
  clienteId: string,
): Promise<RespuestaApi<CredencialEstadoDto[]>> =>
  api<CredencialEstadoDto[]>(base(clienteId));

export const guardarCredencial = (
  clienteId: string,
  tipo: TipoCredencial,
  datos: GuardarCredencialSol | GuardarCredencialSire,
): Promise<RespuestaApi<GuardarCredencialRespuesta>> =>
  api<GuardarCredencialRespuesta>(`${base(clienteId)}/${tipo}`, {
    method: "PUT",
    body: datos,
  });

export const verificarCredencial = (
  clienteId: string,
  tipo: TipoCredencial,
): Promise<RespuestaApi<TrabajoVista>> =>
  api<TrabajoVista>(`${base(clienteId)}/${tipo}/verificar`, {
    method: "POST",
  });
