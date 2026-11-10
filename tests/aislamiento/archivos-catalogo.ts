// Consultas al catalogo de PostgreSQL para las pruebas de BD de la spec 012b (T4). No es una prueba. Solo lectura con el
// superusuario; devuelven formas simples para comparar con `toEqual`.
import type { Pool } from "pg";

const GRANTEE = `case when x.grantee = 0 then 'PUBLIC' else x.grantee::regrole::text end`;

/** Privilegios de TABLA por rol (sin el dueno), p. ej. { contapp_worker: ['INSERT', 'SELECT'] }. */
export async function grantsTabla(
  admin: Pool,
  tabla: string,
): Promise<Record<string, string[]>> {
  const r = await admin.query(
    `select ${GRANTEE} as grantee, array_agg(x.privilege_type::text order by x.privilege_type) as privs
       from pg_class c, aclexplode(c.relacl) x
      where c.oid = to_regclass($1) and x.grantee <> c.relowner group by 1`,
    [`public.${tabla}`],
  );
  return Object.fromEntries(r.rows.map((f) => [f.grantee, f.privs])) as Record<
    string,
    string[]
  >;
}

/** Privilegios de COLUMNA por rol y privilegio: { contapp_backend: { UPDATE: ['restaurada_en', ...] } }. */
export async function grantsColumnas(
  admin: Pool,
  tabla: string,
): Promise<Record<string, Record<string, string[]>>> {
  const r = await admin.query(
    `select ${GRANTEE} as grantee, x.privilege_type::text as priv, array_agg(a.attname::text order by a.attname) as cols
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       cross join lateral aclexplode(a.attacl) x
      where a.attrelid = to_regclass($1) and a.attacl is not null and not a.attisdropped and x.grantee <> c.relowner
      group by 1, 2`,
    [`public.${tabla}`],
  );
  const salida: Record<string, Record<string, string[]>> = {};
  for (const f of r.rows) (salida[f.grantee] ??= {})[f.priv] = f.cols;
  return salida;
}

export async function columnasDe(admin: Pool, tabla: string) {
  return (
    await admin.query(
      `select column_name, data_type, numeric_precision as p, numeric_scale as s, is_nullable, column_default as defecto
         from information_schema.columns where table_schema = 'public' and table_name = $1`,
      [tabla],
    )
  ).rows as {
    column_name: string;
    data_type: string;
    p: number | null;
    s: number | null;
    is_nullable: string;
    defecto: string | null;
  }[];
}

export async function rlsDe(admin: Pool, tabla: string) {
  const t = await admin.query(
    `select relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) as dueno
       from pg_class where oid = to_regclass($1)`,
    [`public.${tabla}`],
  );
  const p = await admin.query(
    `select polname, polcmd, pg_get_expr(polqual, polrelid) as usando, pg_get_expr(polwithcheck, polrelid) as con_check
       from pg_policy where polrelid = to_regclass($1)`,
    [`public.${tabla}`],
  );
  return {
    tabla: t.rows[0] as undefined | Record<string, unknown>,
    politicas: p.rows,
  };
}

export async function fksDe(admin: Pool, tabla: string) {
  return (
    await admin.query(
      `select c.confrelid::regclass::text as destino,
              (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(att, ord)
                 join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.att) as columnas,
              (select array_agg(a.attname::text order by k.ord) from unnest(c.confkey) with ordinality k(att, ord)
                 join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.att) as destinos
         from pg_constraint c where c.conrelid = to_regclass($1) and c.contype = 'f'`,
      [`public.${tabla}`],
    )
  ).rows as { destino: string; columnas: string[]; destinos: string[] }[];
}

/** Indices unicos (incluida la PK) con sus columnas y su predicado parcial. */
export async function unicasDe(admin: Pool, tabla: string) {
  return (
    await admin.query(
      `select (select array_agg(a.attname::text order by k.ord) from unnest(i.indkey::int2[]) with ordinality k(att, ord)
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.att) as columnas,
              i.indisprimary as pk, pg_get_expr(i.indpred, i.indrelid) as parcial
         from pg_index i where i.indrelid = to_regclass($1) and i.indisunique`,
      [`public.${tabla}`],
    )
  ).rows as { columnas: string[]; pk: boolean; parcial: string | null }[];
}

/** Triggers de usuario de una tabla: nombre, momento/eventos (tgtype) y la funcion con su dueno y su configuracion. */
export async function triggersDe(admin: Pool, tabla: string) {
  const r = await admin.query(
    `select t.tgname::text as nombre, t.tgtype::int as tipo, t.tgenabled::text as habilitado,
            p.proname::text as funcion, pg_get_userbyid(p.proowner) as dueno, p.prosecdef as definer, p.proconfig as config
       from pg_trigger t join pg_proc p on p.oid = t.tgfoid
      where t.tgrelid = to_regclass($1) and not t.tgisinternal order by t.tgname`,
    [`public.${tabla}`],
  );
  return (
    r.rows as {
      nombre: string;
      tipo: number;
      habilitado: string;
      funcion: string;
      dueno: string;
      definer: boolean;
      config: string[] | null;
    }[]
  ).map((t) => ({
    ...t,
    // tgtype: ROW=1, BEFORE=2, INSERT=4, DELETE=8, UPDATE=16, TRUNCATE=32, INSTEAD=64.
    porFila: (t.tipo & 1) !== 0,
    antes: (t.tipo & 2) !== 0,
    insert: (t.tipo & 4) !== 0,
    delete: (t.tipo & 8) !== 0,
    update: (t.tipo & 16) !== 0,
  }));
}

export type TriggerDe = Awaited<ReturnType<typeof triggersDe>>[number];

export async function funcionesSinSearchPath(admin: Pool, tabla: string) {
  return (await triggersDe(admin, tabla)).filter(
    (t) =>
      !(t.config ?? []).some((c) =>
        /^search_path=pg_catalog,\s*pg_temp$/.test(c),
      ),
  );
}

export async function checksDe(admin: Pool, tabla: string) {
  return (
    await admin.query(
      `select conname::text as nombre, pg_get_constraintdef(oid) as def
         from pg_constraint where conrelid = to_regclass($1) and contype = 'c'`,
      [`public.${tabla}`],
    )
  ).rows as { nombre: string; def: string }[];
}
