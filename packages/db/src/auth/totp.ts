// TotpRepo (spec 029): una función TS por función SQL `auth.totp_*` (SECURITY DEFINER, migración 0078_cuenta_segura).
// SQL estático `select * from auth.<función>($1, ...)` con parámetros posicionales (nunca se interpola un valor); camelCase en
// TS; cero filas -> null; cualquier error de `pg` -> AuthRepoError (solo SQLSTATE). El repositorio nunca descifra ni transforma
// el secreto (D1: el cifrado y la evaluación del código son del backend). Los pasos de 30 s son `bigint` en PostgreSQL: viajan
// como texto decimal y vuelven como `bigint` de JS.
import { AuthRepoError } from "./errores";
import type { SesionEmitida, TxConsulta } from "./repositorio";

/** Fila de `auth.totp_leer`: los dos secretos cifrados (activo y pendiente de enrolar) y el último paso aceptado (D3). */
export interface TotpFila {
  activoCifrado: Buffer | null;
  activoVersion: number | null;
  pendienteCifrado: Buffer | null;
  pendienteVersion: number | null;
  pendienteExpira: Date | null;
  ultimoPaso: bigint;
  activadoEn: Date | null;
}
export interface IntentoReservado {
  /** false: la cuenta está bloqueada (004 D7) y el código no se evalúa. */
  permitido: boolean;
  usuarioId: string;
}
export interface VerificarExitoArgs {
  tokenHash: Buffer;
  paso: bigint;
  tokenHashNuevo: Buffer;
  tenantNuevo: string | null;
}
export interface RecuperacionUsarArgs {
  tokenHash: Buffer;
  /** HMAC del código de recuperación (D1). */
  hash: Buffer;
  tokenHashNuevo: Buffer;
  tenantNuevo: string | null;
}
export interface ConfirmarArgs {
  tokenHash: Buffer;
  paso: bigint;
  /** Exactamente 10 HMAC distintos de 32 bytes (si no, AuthRepoError 22023). */
  hashes: Buffer[];
  tokenHashNuevo: Buffer;
}
export type ResultadoDesactivar = "desactivado" | "exigido" | "invalido";

export interface TotpRepo {
  /** null si el usuario nunca inició el enrolamiento. */
  leer(usuarioId: string): Promise<TotpFila | null>;
  /** Guarda (o reemplaza) el pendiente cifrado; devuelve su vencimiento (10 min). */
  enrolarIniciar(usuarioId: string, cifrado: Buffer, version: number): Promise<Date>;
  /** CA-3: reserva un intento en el contador de 004 D7; null si la sesión no está vigente. */
  intentoReservar(tokenHash: Buffer): Promise<IntentoReservado | null>;
  /** CA-2, D3: null si la sesión no es `pendiente` vigente, el paso ya se usó o el estudio no tiene membresía activa. */
  verificarExito(a: VerificarExitoArgs): Promise<SesionEmitida | null>;
  /** CA-9: null si el código no existe, ya se usó o la sesión no sirve. */
  recuperacionUsar(a: RecuperacionUsarArgs): Promise<SesionEmitida | null>;
  /** CA-1: null si no hay pendiente vigente, el paso no es nuevo o la sesión no sirve. */
  confirmar(a: ConfirmarArgs): Promise<SesionEmitida | null>;
  desactivar(tokenHash: Buffer, paso: bigint): Promise<ResultadoDesactivar>;
  recuperacionRegenerar(tokenHash: Buffer, paso: bigint, hashes: Buffer[]): Promise<boolean>;
}

const SQL = {
  leer: "select * from auth.totp_leer($1::uuid)",
  enrolarIniciar: "select * from auth.totp_enrolar_iniciar($1::uuid, $2::bytea, $3::int)",
  intentoReservar: "select * from auth.totp_intento_reservar($1::bytea)",
  verificarExito: "select * from auth.totp_verificar_exito($1::bytea, $2::bigint, $3::bytea, $4::uuid)",
  recuperacionUsar: "select * from auth.totp_recuperacion_usar($1::bytea, $2::bytea, $3::bytea, $4::uuid)",
  confirmar: "select * from auth.totp_confirmar($1::bytea, $2::bigint, $3::bytea[], $4::bytea)",
  desactivar: "select * from auth.totp_desactivar($1::bytea, $2::bigint)",
  recuperacionRegenerar: "select * from auth.totp_recuperacion_regenerar($1::bytea, $2::bigint, $3::bytea[])",
} as const;

const RESULTADOS_DESACTIVAR: readonly string[] = ["desactivado", "exigido", "invalido"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fila = Record<string, any>;

const emitida = (f: Fila[]): SesionEmitida | null =>
  f.length === 0 ? null : { sesionId: f[0]!.sesion_id as string, expiraAbsoluta: f[0]!.expira_absoluta as Date };

/** El paso viaja como texto decimal (bigint de PostgreSQL); nunca como `number`. */
const BIGINT_MAX = 9_223_372_036_854_775_807n;
function paso(p: bigint): string {
  if (typeof p !== "bigint" || p < 0n || p > BIGINT_MAX) throw new AuthRepoError("22023");
  return p.toString();
}

export function crearTotpRepo(tx: TxConsulta): TotpRepo {
  async function ejecutar<T>(texto: string, valores: () => unknown[], mapear: (filas: Fila[]) => T): Promise<T> {
    try {
      const r = await tx.query(texto, valores());
      return mapear(r.rows as Fila[]);
    } catch (e) {
      throw e instanceof AuthRepoError ? e : AuthRepoError.desde(e);
    }
  }

  return {
    leer: (usuarioId) =>
      ejecutar(SQL.leer, () => [usuarioId], (f) =>
        f.length === 0
          ? null
          : {
              activoCifrado: (f[0]!.activo_cifrado as Buffer | null) ?? null,
              activoVersion: f[0]!.activo_version === null ? null : Number(f[0]!.activo_version),
              pendienteCifrado: (f[0]!.pendiente_cifrado as Buffer | null) ?? null,
              pendienteVersion: f[0]!.pendiente_version === null ? null : Number(f[0]!.pendiente_version),
              pendienteExpira: (f[0]!.pendiente_expira as Date | null) ?? null,
              ultimoPaso: BigInt(f[0]!.ultimo_paso as string),
              activadoEn: (f[0]!.activado_en as Date | null) ?? null,
            },
      ),
    enrolarIniciar: (usuarioId, cifrado, version) =>
      ejecutar(SQL.enrolarIniciar, () => [usuarioId, cifrado, version], (f) => f[0]!.totp_enrolar_iniciar as Date),
    intentoReservar: (tokenHash) =>
      ejecutar(SQL.intentoReservar, () => [tokenHash], (f) =>
        f.length === 0 ? null : { permitido: f[0]!.permitido === true, usuarioId: f[0]!.usuario_id as string },
      ),
    verificarExito: (a) =>
      ejecutar(SQL.verificarExito, () => [a.tokenHash, paso(a.paso), a.tokenHashNuevo, a.tenantNuevo], emitida),
    recuperacionUsar: (a) =>
      ejecutar(SQL.recuperacionUsar, () => [a.tokenHash, a.hash, a.tokenHashNuevo, a.tenantNuevo], emitida),
    confirmar: (a) =>
      ejecutar(SQL.confirmar, () => [a.tokenHash, paso(a.paso), a.hashes, a.tokenHashNuevo], emitida),
    desactivar: (tokenHash, p) =>
      ejecutar(SQL.desactivar, () => [tokenHash, paso(p)], (f) => {
        const r = f[0]?.totp_desactivar as unknown;
        // Falla cerrado: un valor fuera de la lista nunca se trata como 'desactivado'.
        return (typeof r === "string" && RESULTADOS_DESACTIVAR.includes(r) ? r : "invalido") as ResultadoDesactivar;
      }),
    recuperacionRegenerar: (tokenHash, p, hashes) =>
      ejecutar(SQL.recuperacionRegenerar, () => [tokenHash, paso(p), hashes], (f) => f[0]?.totp_recuperacion_regenerar === true),
  };
}
