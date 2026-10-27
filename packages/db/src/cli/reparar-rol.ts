// H7 (decisión del usuario, opción A): todo rol LOGIN puede cambiar sus propios valores por defecto de
// sesión (ALTER ROLE self [IN DATABASE d] SET ...) y su contraseña, y PostgreSQL no permite impedirlo.
// `migrar` deja en cada ejecución la configuración persistente de contapp_app como se espera:
// ajustes (pg_db_role_setting) y atributos. La contraseña la resincroniza `sincronizarPassword`.
// Idempotente: solo altera lo que difiere. Nunca imprime valores de ajustes ni contraseñas.
import type { Client } from "pg";
import { ErrorCli } from "./comun";

export const ROL_LOGIN = "contapp_app";

/** Único ajuste persistente esperado de contapp_app (0000_roles), sin base de datos específica. */
export const AJUSTES_ESPERADOS: readonly string[] = Object.freeze([
  "lc_messages=C",
]);

export interface FilaAjuste {
  /** OID de la base (0 = todas). */
  setdatabase: number;
  setconfig: string[] | null;
}

export interface AtributosRol {
  rolsuper: boolean;
  rolinherit: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolcanlogin: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  rolconnlimit: number;
  /** Como texto: null o 'infinity' = sin vencimiento. */
  rolvaliduntil: string | null;
}

/** true si los ajustes persistentes del rol son exactamente los esperados. */
export function ajustesEnOrden(filas: readonly FilaAjuste[]): boolean {
  if (filas.length !== 1) return false;
  const [f] = filas;
  if (Number(f!.setdatabase) !== 0) return false;
  const actual = [...(f!.setconfig ?? [])].sort();
  const esperado = [...AJUSTES_ESPERADOS].sort();
  return (
    actual.length === esperado.length &&
    actual.every((v, i) => v === esperado[i])
  );
}

function sinVencimiento(v: AtributosRol["rolvaliduntil"]): boolean {
  return v === null || v.toLowerCase() === "infinity";
}

/** true si los atributos del rol de login son los de 0000_roles. */
export function atributosEnOrden(a: AtributosRol): boolean {
  return (
    a.rolcanlogin &&
    !a.rolinherit &&
    !a.rolsuper &&
    !a.rolcreaterole &&
    !a.rolcreatedb &&
    !a.rolreplication &&
    !a.rolbypassrls &&
    a.rolconnlimit === -1 &&
    sinVencimiento(a.rolvaliduntil)
  );
}

/**
 * Borra todos los ajustes persistentes de contapp_app (también los de `IN DATABASE`) y vuelve a fijar
 * los esperados. Texto fijo (sin interpolar): los nombres de base se citan en el servidor con %I.
 */
export const SQL_REPARAR_AJUSTES = `DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT s.setdatabase, d.datname
      FROM pg_db_role_setting s
      LEFT JOIN pg_database d ON d.oid = s.setdatabase
     WHERE s.setrole = (SELECT oid FROM pg_roles WHERE rolname = 'contapp_app')
  LOOP
    IF r.setdatabase = 0 THEN
      EXECUTE 'ALTER ROLE contapp_app RESET ALL';
    ELSIF r.datname IS NOT NULL THEN
      EXECUTE format('ALTER ROLE contapp_app IN DATABASE %I RESET ALL', r.datname);
    END IF;
  END LOOP;
  ALTER ROLE contapp_app SET lc_messages TO 'C';
END
$$`;

export const SQL_REPARAR_ATRIBUTOS =
  "ALTER ROLE contapp_app LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION CONNECTION LIMIT -1 VALID UNTIL 'infinity'";

export type EstadoReparacion = "sin cambios" | "reparados";

export interface ResultadoReparacion {
  ajustes: EstadoReparacion;
  atributos: EstadoReparacion;
}

/** Repara ajustes y atributos de contapp_app. Debe llamarse dentro de una transacción. */
export async function repararRolLogin(
  client: Pick<Client, "query">,
): Promise<ResultadoReparacion> {
  const atr = await client.query<AtributosRol>(
    `select rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication,
            rolbypassrls, rolconnlimit, rolvaliduntil::text as rolvaliduntil
       from pg_roles where rolname = $1`,
    [ROL_LOGIN],
  );
  if (atr.rowCount !== 1) throw new ErrorCli(`no existe el rol ${ROL_LOGIN}`);
  const ajustes = await client.query<FilaAjuste>(
    `select s.setdatabase::int as setdatabase, s.setconfig
       from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
      where r.rolname = $1`,
    [ROL_LOGIN],
  );

  const resultado: ResultadoReparacion = {
    ajustes: "sin cambios",
    atributos: "sin cambios",
  };
  if (!atributosEnOrden(atr.rows[0]!)) {
    await client.query(SQL_REPARAR_ATRIBUTOS);
    resultado.atributos = "reparados";
  }
  if (!ajustesEnOrden(ajustes.rows)) {
    await client.query(SQL_REPARAR_AJUSTES);
    resultado.ajustes = "reparados";
  }
  return resultado;
}
