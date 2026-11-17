/* eslint-disable @typescript-eslint/no-unused-vars -- STUB de T4 (rojo): T11 lo reemplaza y quita esta línea */
// Escritura del buzón SOL por el worker y auditoría del backend (spec 023). STUB de T4 (rojo): T11 lo implementa.
import type { TxConsulta } from "./errores";

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

export async function insertarMensajeBuzon(
  _tx: TxConsulta,
  _m: EntradaMensajeBuzon,
): Promise<{ id: string } | null> {
  throw new Error("no implementado");
}

export async function conocidosBuzon(
  _tx: TxConsulta,
  _clienteId: string,
  _idsSunat: string[],
): Promise<Map<string, { id: string; leidoEnSunat: boolean }>> {
  throw new Error("no implementado");
}

export async function actualizarConocidosBuzon(
  _tx: TxConsulta,
  _clienteId: string,
  _items: { idSunat: string; leidoEnSunat: boolean }[],
): Promise<number> {
  throw new Error("no implementado");
}

export async function guardarEstadoCapturaBuzon(
  _tx: TxConsulta,
  _clienteId: string,
  _e: { cursorPendiente: string | null; sincronizado: boolean },
): Promise<void> {
  throw new Error("no implementado");
}

export async function guardarContenidoBuzon(
  _tx: TxConsulta,
  _c: {
    clienteId: string;
    mensajeId: string;
    contenidoRuta: string;
    contenidoBytes: number;
    marcoLeido: boolean;
    adjuntos: AdjuntoGuardarBuzon[];
  },
): Promise<void> {
  throw new Error("no implementado");
}

export async function auditarBuzon(
  _tx: TxConsulta,
  _accion: AccionAuditoriaBuzon,
  _o: {
    clienteId: string;
    mensajeId?: string | null;
    adjuntoId?: string | null;
  },
): Promise<void> {
  throw new Error("no implementado");
}
