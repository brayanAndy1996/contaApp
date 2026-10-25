// STUB (T5, rojo): tipos del contrato de plan.md.
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
