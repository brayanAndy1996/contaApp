import type {
  ClienteDto,
  CrearClienteInput,
  EditarClienteInput,
  EstadoCredencial,
  FiltrosClientes,
} from "@contapp/shared";
import { api, type RespuestaApi } from "./api";

// Llamadas HTTP de clientes (spec 007a, D7, D10). Solo envía y recibe lo del contrato de
// `@contapp/shared`; no calcula nada de negocio. Los errores `{codigo}` llegan tal cual a la pantalla.

export type { ClienteDto, EstadoCredencial, FiltrosClientes };

/** Texto visible de cada estado de credencial (solo estado; nunca un secreto). */
export const ETIQUETA_ESTADO: Record<EstadoCredencial, string> = {
  no_configurada: "No configurada",
  configurada: "Configurada",
  verificada: "Verificada",
  invalida: "Inválida",
};

export const OPCIONES_CREDENCIAL: readonly EstadoCredencial[] = [
  "no_configurada",
  "configurada",
  "verificada",
  "invalida",
];

export const Q_MAX = 100;

/** Query string de los filtros activos: sin parámetros vacíos ni `archivados=0` (D7). */
export function consultaDeFiltros(filtros: FiltrosClientes): string {
  const params = new URLSearchParams();
  if (filtros.responsable) params.set("responsable", filtros.responsable);
  if (filtros.credencial) params.set("credencial", filtros.credencial);
  if (filtros.archivados) params.set("archivados", "1");
  const q = filtros.q?.trim().slice(0, Q_MAX);
  if (q) params.set("q", q);
  const texto = params.toString();
  return texto ? `?${texto}` : "";
}

export const listarClientes = (
  filtros: FiltrosClientes = {},
): Promise<RespuestaApi<ClienteDto[]>> =>
  api<ClienteDto[]>(`/clientes${consultaDeFiltros(filtros)}`);

export const obtenerCliente = (id: string): Promise<RespuestaApi<ClienteDto>> =>
  api<ClienteDto>(`/clientes/${encodeURIComponent(id)}`);

export const crearCliente = (
  datos: CrearClienteInput,
): Promise<RespuestaApi<ClienteDto>> =>
  api<ClienteDto>("/clientes", { method: "POST", body: datos });

export const editarCliente = (
  id: string,
  datos: EditarClienteInput,
): Promise<RespuestaApi<ClienteDto>> =>
  api<ClienteDto>(`/clientes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: datos,
  });

export const archivarCliente = (id: string): Promise<RespuestaApi<ClienteDto>> =>
  api<ClienteDto>(`/clientes/${encodeURIComponent(id)}/archivar`, {
    method: "POST",
  });

export const reactivarCliente = (
  id: string,
): Promise<RespuestaApi<ClienteDto>> =>
  api<ClienteDto>(`/clientes/${encodeURIComponent(id)}/reactivar`, {
    method: "POST",
  });
