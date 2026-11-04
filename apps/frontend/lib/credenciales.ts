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
