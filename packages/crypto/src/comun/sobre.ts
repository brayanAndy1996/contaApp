// Tipos del contrato (plan.md) y validación de forma del sobre.
import { SobreInvalidoError } from "./errores";

export type TipoCredencial = "sol" | "sire_api";
export type CredencialSol = { usuario: string; clave: string };
export type CredencialSireApi = { clientId: string; clientSecret: string };
export type ValorDe<T> = T extends "sol" ? CredencialSol : CredencialSireApi;
export interface ContextoAad {
  tenantId: string;
  clienteId: string;
  tipo: TipoCredencial;
}
export interface Sobre {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  dekEnvuelta: Buffer;
  kekId: string;
  version: 1;
}

export const LARGO_DEK = 32;
export const LARGO_NONCE = 12;
export const LARGO_TAG = 16;
const MAX_CIPHERTEXT = 1100;
const MAX_DEK_ENVUELTA = 1024;

/** Formato de kek_id (igual que el CHECK de la tabla `credencial`). */
export const PATRON_KEK_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

function bufferEntre(v: unknown, min: number, max: number): boolean {
  return Buffer.isBuffer(v) && v.length >= min && v.length <= max;
}

/** Lanza SobreInvalidoError si el sobre no tiene la forma del contrato. No toca ninguna llave. */
export function validarSobre(s: Sobre): void {
  const ok =
    typeof s === "object" &&
    s !== null &&
    bufferEntre(s.ciphertext, 1, MAX_CIPHERTEXT) &&
    bufferEntre(s.nonce, LARGO_NONCE, LARGO_NONCE) &&
    bufferEntre(s.tag, LARGO_TAG, LARGO_TAG) &&
    bufferEntre(s.dekEnvuelta, 1, MAX_DEK_ENVUELTA) &&
    s.version === 1 &&
    typeof s.kekId === "string" &&
    PATRON_KEK_ID.test(s.kekId);
  if (!ok) throw new SobreInvalidoError();
}
