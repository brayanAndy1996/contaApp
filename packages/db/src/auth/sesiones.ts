// SesionesRepo (spec 029, CA-5): listar las sesiones vigentes del usuario, revocar una y revocar las demás (migración
// 0078_cuenta_segura). SQL estático con parámetros posicionales; camelCase en TS; cualquier error de `pg` -> AuthRepoError (solo
// SQLSTATE). Nunca devuelve hashes ni tokens.
import { AuthRepoError } from "./errores";
import type { TxConsulta } from "./repositorio";

export interface SesionListada {
  id: string;
  creadaEn: Date;
  ultimoUso: Date;
  /** Lista cerrada navegador/SO o «Otro» (U6); null en las sesiones anteriores a 029. */
  dispositivo: string | null;
  /** Red truncada a /24 o /48 (U6); null en las sesiones anteriores a 029. */
  ipRed: string | null;
  actual: boolean;
}

export interface SesionesRepo {
  /** Vigentes del usuario de la sesión dada (sin `pendiente`), la más reciente primero; [] si la sesión no sirve. */
  listar(tokenHash: Buffer): Promise<SesionListada[]>;
  /** Revoca una sesión propia vigente; ajena, inexistente o ya revocada: misma salida, sin efectos. */
  revocar(tokenHash: Buffer, sesionId: string): Promise<void>;
  /** Revoca las demás sesiones del usuario (no la actual); devuelve cuántas. */
  revocarOtras(tokenHash: Buffer): Promise<number>;
}

const SQL = {
  listar: "select * from auth.sesiones_listar($1::bytea)",
  revocar: "select * from auth.sesion_revocar_id($1::bytea, $2::uuid)",
  revocarOtras: "select * from auth.sesiones_revocar_otras($1::bytea)",
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fila = Record<string, any>;

export function crearSesionesRepo(tx: TxConsulta): SesionesRepo {
  async function ejecutar<T>(texto: string, valores: unknown[], mapear: (filas: Fila[]) => T): Promise<T> {
    try {
      const r = await tx.query(texto, valores);
      return mapear(r.rows as Fila[]);
    } catch (e) {
      throw AuthRepoError.desde(e);
    }
  }

  return {
    listar: (tokenHash) =>
      ejecutar(SQL.listar, [tokenHash], (f) =>
        f.map((x) => ({
          id: x.id as string,
          creadaEn: x.creada_en as Date,
          ultimoUso: x.ultimo_uso as Date,
          dispositivo: (x.dispositivo as string | null) ?? null,
          ipRed: (x.ip_red as string | null) ?? null,
          actual: x.actual === true,
        })),
      ),
    revocar: (tokenHash, sesionId) => ejecutar(SQL.revocar, [tokenHash, sesionId], () => undefined),
    revocarOtras: (tokenHash) => ejecutar(SQL.revocarOtras, [tokenHash], (f) => Number(f[0]?.sesiones_revocar_otras ?? 0)),
  };
}
