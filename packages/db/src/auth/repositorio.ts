// STUB de T5 (rojo): contrato de AuthRepo (una función TS por función SQL `auth.*`). Implementa T9.
// Convenciones: SQL estático `select * from auth.<función>($1, ...)` con parámetros posicionales; columnas de
// salida = nombres OUT del plan (las funciones escalares: columna con el nombre de la función); camelCase en TS;
// cero filas -> null; cualquier error de `pg` -> AuthRepoError (solo SQLSTATE).
import type { Tx } from "../with-tenant";

export type TxConsulta = Pick<Tx, "query">;
export type TipoLimite = "login_ip" | "recup_correo" | "recup_ip";

export interface LoginPreparado {
  permitido: boolean;
  usuarioId: string | null;
  hash: string | null;
  alcanzaBloqueo: boolean;
}
export interface SesionEmitida {
  sesionId: string;
  expiraAbsoluta: Date;
}
export interface SesionValida {
  sesionId: string;
  usuarioId: string;
  tenantActivo: string | null;
  estudioRevocado: boolean;
  expiraAbsoluta: Date;
}
export interface LoginExitoArgs {
  clave: Buffer;
  usuarioId: string;
  tokenHash: Buffer;
  tenantActivo: string | null;
  hashNuevo: string | null;
  tokenAnteriorHash: Buffer | null;
}

export interface AuthRepo {
  limiteConsumir(tipo: TipoLimite, sujeto: string): Promise<boolean>;
  loginPreparar(correo: string, clave: Buffer): Promise<LoginPreparado>;
  loginExito(a: LoginExitoArgs): Promise<SesionEmitida>;
  sesionValidar(tokenHash: Buffer): Promise<SesionValida | null>;
  sesionRotar(tokenHash: Buffer, tokenHashNuevo: Buffer, tenantNuevo: string | null): Promise<SesionEmitida | null>;
  sesionRevocar(tokenHash: Buffer): Promise<void>;
  sesionesCerrarTodas(tokenHash: Buffer): Promise<number>;
  ultimoEstudio(tokenHash: Buffer): Promise<string | null>;
  recuperacionCrear(correo: string, tokenHash: Buffer): Promise<boolean>;
  recuperacionConsumir(tokenHash: Buffer, hashNuevo: string): Promise<{ usuarioId: string; correo: string } | null>;
  contrasenaCambiar(tokenHash: Buffer, hashNuevo: string, tokenHashNuevo: Buffer): Promise<string | null>;
}

/** Fachada sobre la transacción abierta por `withAuth`. */
export function crearAuthRepo(tx: TxConsulta): AuthRepo {
  void tx;
  throw new Error("crearAuthRepo: no implementado (T9)");
}
