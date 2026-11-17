/* eslint-disable @typescript-eslint/no-unused-vars -- STUB de T4 (rojo): T11 lo reemplaza y quita esta línea */
// Lectura del buzón SOL (spec 023, D-8). STUB de T4 (rojo): T11 lo implementa. Todo recibe la `tx` de withTenant.
import type { TxConsulta } from "./errores";

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

export async function leerEstadoBuzon(
  _tx: TxConsulta,
  _clienteId: string,
): Promise<EstadoBuzon | null> {
  throw new Error("no implementado");
}

export async function listarMensajesBuzon(
  _tx: TxConsulta,
  _clienteId: string,
  _o: { antes?: { fecha: Date; id: string }; limite?: number },
): Promise<MensajeBuzonFila[]> {
  throw new Error("no implementado");
}

export async function leerMensajeBuzon(
  _tx: TxConsulta,
  _clienteId: string,
  _mensajeId: string,
): Promise<DetalleMensajeBuzon | null> {
  throw new Error("no implementado");
}

export async function leerAdjuntoBuzon(
  _tx: TxConsulta,
  _clienteId: string,
  _mensajeId: string,
  _adjuntoId: string,
): Promise<AdjuntoBuzon | null> {
  throw new Error("no implementado");
}
