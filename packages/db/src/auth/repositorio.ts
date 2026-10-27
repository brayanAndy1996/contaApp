// AuthRepo: una función TS por función SQL `auth.*` (SECURITY DEFINER, migraciones 0007_auth a 0010_auth_final).
// SQL estático `select * from auth.<función>($1, ...)` con parámetros posicionales (nunca se interpola un
// valor); columnas de salida = nombres OUT del plan (las escalares: columna con el nombre de la función);
// camelCase en TS; cero filas -> null; cualquier error de `pg` -> AuthRepoError (solo SQLSTATE).
import type { Tx } from "../with-tenant";
import { AuthRepoError } from "./errores";

export type TxConsulta = Pick<Tx, "query">;
export type TipoLimite = "login_ip" | "recup_correo" | "recup_ip" | "restab_ip";

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
  /** Hash PHC que se verificó (el de `loginPreparar`): si la credencial cambió, no hay sesión (0010, O-1). */
  hashVerificado: string;
  tokenHash: Buffer;
  tenantActivo: string | null;
  hashNuevo: string | null;
  tokenAnteriorHash: Buffer | null;
}
export interface RecuperacionConsumida {
  usuarioId: string;
  correo: string;
}

export interface AuthRepo {
  limiteConsumir(tipo: TipoLimite, sujeto: string): Promise<boolean>;
  loginPreparar(correo: string, clave: Buffer): Promise<LoginPreparado>;
  /** null si el estudio pedido no tiene membresía o la credencial ya no es la verificada (no se crea sesión). */
  loginExito(a: LoginExitoArgs): Promise<SesionEmitida | null>;
  sesionValidar(tokenHash: Buffer): Promise<SesionValida | null>;
  sesionRotar(tokenHash: Buffer, tokenHashNuevo: Buffer, tenantNuevo: string | null): Promise<SesionEmitida | null>;
  sesionRevocar(tokenHash: Buffer): Promise<void>;
  sesionesCerrarTodas(tokenHash: Buffer): Promise<number>;
  ultimoEstudio(tokenHash: Buffer): Promise<string | null>;
  recuperacionCrear(correo: string, tokenHash: Buffer): Promise<boolean>;
  /** Sin efectos: el token existe, no se usó, no se invalidó y no venció (0008, antes de Argon2). */
  recuperacionVigente(tokenHash: Buffer): Promise<boolean>;
  recuperacionConsumir(tokenHash: Buffer, hashNuevo: string): Promise<RecuperacionConsumida | null>;
  contrasenaCambiar(tokenHash: Buffer, hashNuevo: string, tokenHashNuevo: Buffer): Promise<string | null>;
}

const SQL = {
  limiteConsumir: "select * from auth.limite_consumir($1::text, $2::text)",
  loginPreparar: "select * from auth.login_preparar($1::text, $2::bytea)",
  loginExito:
    "select * from auth.login_exito($1::bytea, $2::uuid, $3::text, $4::bytea, $5::uuid, $6::text, $7::bytea)",
  sesionValidar: "select * from auth.sesion_validar($1::bytea)",
  sesionRotar: "select * from auth.sesion_rotar($1::bytea, $2::bytea, $3::uuid)",
  sesionRevocar: "select * from auth.sesion_revocar($1::bytea)",
  sesionesCerrarTodas: "select * from auth.sesiones_cerrar_todas($1::bytea)",
  ultimoEstudio: "select * from auth.ultimo_estudio($1::bytea)",
  recuperacionCrear: "select * from auth.recuperacion_crear($1::text, $2::bytea)",
  recuperacionVigente: "select * from auth.recuperacion_vigente($1::bytea)",
  recuperacionConsumir: "select * from auth.recuperacion_consumir($1::bytea, $2::text)",
  contrasenaCambiar: "select * from auth.contrasena_cambiar($1::bytea, $2::text, $3::bytea)",
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fila = Record<string, any>;

const sesionEmitida = (f: Fila): SesionEmitida => ({
  sesionId: f.sesion_id,
  expiraAbsoluta: f.expira_absoluta,
});

/** Fachada sobre la transacción abierta por `withAuth`. */
export function crearAuthRepo(tx: TxConsulta): AuthRepo {
  /** Ejecuta y mapea; todo error (de pg o de forma) sale como AuthRepoError sin rastro del original. */
  async function ejecutar<T>(texto: string, valores: unknown[], mapear: (filas: Fila[]) => T): Promise<T> {
    try {
      const r = await tx.query(texto, valores);
      return mapear(r.rows as Fila[]);
    } catch (e) {
      throw AuthRepoError.desde(e);
    }
  }

  return {
    limiteConsumir: (tipo, sujeto) =>
      ejecutar(SQL.limiteConsumir, [tipo, sujeto], (f) => f[0]!.limite_consumir === true),
    loginPreparar: (correo, clave) =>
      ejecutar(SQL.loginPreparar, [correo, clave], (f) => ({
        permitido: f[0]!.permitido === true,
        usuarioId: f[0]!.usuario_id ?? null,
        hash: f[0]!.hash ?? null,
        alcanzaBloqueo: f[0]!.alcanza_bloqueo === true,
      })),
    loginExito: (a) =>
      ejecutar(
        SQL.loginExito,
        [a.clave, a.usuarioId, a.hashVerificado, a.tokenHash, a.tenantActivo, a.hashNuevo, a.tokenAnteriorHash],
        (f) => (f.length === 0 ? null : sesionEmitida(f[0]!)),
      ),
    sesionValidar: (tokenHash) =>
      ejecutar(SQL.sesionValidar, [tokenHash], (f) =>
        f.length === 0
          ? null
          : {
              sesionId: f[0]!.sesion_id,
              usuarioId: f[0]!.usuario_id,
              tenantActivo: f[0]!.tenant_activo ?? null,
              estudioRevocado: f[0]!.estudio_revocado === true,
              expiraAbsoluta: f[0]!.expira_absoluta,
            },
      ),
    sesionRotar: (tokenHash, tokenHashNuevo, tenantNuevo) =>
      ejecutar(SQL.sesionRotar, [tokenHash, tokenHashNuevo, tenantNuevo], (f) =>
        f.length === 0 ? null : sesionEmitida(f[0]!),
      ),
    sesionRevocar: (tokenHash) => ejecutar(SQL.sesionRevocar, [tokenHash], () => undefined),
    sesionesCerrarTodas: (tokenHash) =>
      ejecutar(SQL.sesionesCerrarTodas, [tokenHash], (f) => Number(f[0]!.sesiones_cerrar_todas)),
    ultimoEstudio: (tokenHash) =>
      ejecutar(SQL.ultimoEstudio, [tokenHash], (f) => (f[0]!.ultimo_estudio as string | null) ?? null),
    recuperacionCrear: (correo, tokenHash) =>
      ejecutar(SQL.recuperacionCrear, [correo, tokenHash], (f) => f[0]!.recuperacion_crear === true),
    recuperacionVigente: (tokenHash) =>
      ejecutar(SQL.recuperacionVigente, [tokenHash], (f) => f[0]!.recuperacion_vigente === true),
    recuperacionConsumir: (tokenHash, hashNuevo) =>
      ejecutar(SQL.recuperacionConsumir, [tokenHash, hashNuevo], (f) =>
        f.length === 0 ? null : { usuarioId: f[0]!.usuario_id as string, correo: f[0]!.correo as string },
      ),
    contrasenaCambiar: (tokenHash, hashNuevo, tokenHashNuevo) =>
      ejecutar(
        SQL.contrasenaCambiar,
        [tokenHash, hashNuevo, tokenHashNuevo],
        (f) => (f[0]?.contrasena_cambiar as string | null | undefined) ?? null,
      ),
  };
}
