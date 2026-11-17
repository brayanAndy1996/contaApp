import type {
  CredencialSol,
  MensajeSol,
  MetadatosMensajeSol,
  PaginaMensajesSol,
  SolPortal,
} from "../puertos.js";

/** Adjunto de un fixture o de `inyectar`: `base64` (bytes reales) o `tamano` (bytes sintéticos, sin materializarlos). */
export interface AdjuntoFixtureSol {
  idSunat: string;
  nombre: string;
  base64?: string;
  tamano?: number;
}

export interface MensajeFixtureSol
  extends Omit<MetadatosMensajeSol, "adjuntos"> {
  contenido: { formato: "texto" | "html"; cuerpo: string };
  adjuntos: AdjuntoFixtureSol[];
}

export interface FixtureBuzonSol {
  mensajes: MensajeFixtureSol[];
}

export type CasoSolInyectado = FixtureBuzonSol | { error: Error };
export type ModoFallaSolPortal = "credencial" | "transitorio" | null;

export interface OpcionesMockSolPortal {
  dirFixtures?: string;
  latenciaMs?: number;
  mensajesGenerados?: number;
}

// STUB (spec 023, T3, rojo): la implementación es T10.
const NO_IMPLEMENTADO = "no implementado";

export class MockSolPortal implements SolPortal {
  constructor(_opciones: OpcionesMockSolPortal = {}) {
    void _opciones;
  }
  inyectar(_ruc: string, _caso: CasoSolInyectado): void {
    throw new Error(NO_IMPLEMENTADO);
  }
  fallar(
    _modo: ModoFallaSolPortal,
    _opciones: { veces?: number; despuesDe?: number } = {},
  ): void {
    throw new Error(NO_IMPLEMENTADO);
  }
  leidosMarcados(): readonly { ruc: string; idSunat: string }[] {
    throw new Error(NO_IMPLEMENTADO);
  }
  llamadasObtener(): number {
    throw new Error(NO_IMPLEMENTADO);
  }
  llamadasObtenerDe(_idSunat: string): number {
    throw new Error(NO_IMPLEMENTADO);
  }
  llamadasListar(): number {
    throw new Error(NO_IMPLEMENTADO);
  }
  listarMensajes(
    _credencial: CredencialSol,
    _opciones: { cursor: string | null; limite: number },
  ): Promise<PaginaMensajesSol> {
    return Promise.reject(new Error(NO_IMPLEMENTADO));
  }
  obtenerMensaje(
    _credencial: CredencialSol,
    _idSunat: string,
    _opciones: { maxBytesAdjunto: number; maxBytesMensaje: number },
  ): Promise<MensajeSol> {
    return Promise.reject(new Error(NO_IMPLEMENTADO));
  }
}
