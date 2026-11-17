// STUB (spec 023, T1).
/* eslint-disable @typescript-eslint/no-unused-vars */

export const TOPE_ADJUNTO_BYTES = 20 * 1024 * 1024;
export const TOPE_MENSAJE_BYTES = 50 * 1024 * 1024;

export type AdjuntoRecibido =
  | {
      readonly idSunat: string;
      readonly nombre: string;
      readonly bytes: Uint8Array;
    }
  | {
      readonly idSunat: string;
      readonly nombre: string;
      readonly omitido: "tamano";
    };

export type MotivoOmision = "mime" | "tamano" | "tope_mensaje";

export interface AdjuntoAGuardar {
  readonly idSunat: string;
  /** Nombre saneado. */
  readonly nombre: string;
  readonly mime: string;
  readonly ext: string;
  readonly bytes: Uint8Array;
}

export interface AdjuntoOmitido {
  readonly idSunat: string;
  /** Nombre saneado. */
  readonly nombre: string;
  readonly motivo: MotivoOmision;
}

export function sanearNombreAdjunto(_nombre: string): string {
  throw new Error("no implementado: sanearNombreAdjunto");
}

/** Lista blanca por firma: PDF, XML, PNG, JPEG y ZIP opaco; `null` si no está. */
export function mimePorFirma(
  _bytes: Uint8Array,
): { mime: string; ext: string } | null {
  throw new Error("no implementado: mimePorFirma");
}

export function prepararAdjuntos(_adjuntos: readonly AdjuntoRecibido[]): {
  guardar: AdjuntoAGuardar[];
  omitidos: AdjuntoOmitido[];
} {
  throw new Error("no implementado: prepararAdjuntos");
}
