// Spec 003 (T6, rojo): CA-4c (el backend no lee el sobre), CA-5 (aislamiento) y CA-8 (auditoria) en BD.
// Solo usa DATABASE_URL, createDb, SEED y los repositorios de @contapp/db; los sobres son bytes aleatorios
// sintéticos (sin @contapp/crypto). Todo cambio ocurre dentro de una transaccion que se revierte.
//
// Contrato de @contapp/db que esta prueba fija (T10):
// - exporta guardarSobre, estadoCredenciales, leerSobre, listarParaReenvolver, reemplazarDekEnvuelta,
//   registrarDescifrado y la clase CredencialRepoError (todas con `tx: Pick<Tx, "query">` como 1er argumento).
// - leerSobre devuelve `null` o una fila con tenant, cliente, tipo y el sobre (plano o en `.sobre`; camelCase o snake_case).
// - CredencialRepoError expone el SQLSTATE en `codigo` y nada mas del error de pg (sin detail, where, cause...).
// - registrarDescifrado no usa RETURNING (contapp_worker no tiene SELECT sobre auditoria_descifrado).
import { randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import * as dbModule from "@contapp/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abrirPool,
  clientesDe,
  crearDb,
  enRollback,
  tenantDe,
  type ContappDb,
  type Estudio,
  type Intento,
  type Tx,
} from "./soporte";

type Rol = "contapp_backend" | "contapp_worker";
type Tipo = "sol" | "sire_api";
interface SobreFalso {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  dekEnvuelta: Buffer;
  kekId: string;
  version: 1;
}

const SENSIBLES = ["ciphertext", "nonce", "tag", "dek_envuelta"];
const COLS_CREDENCIAL = [
  "ciphertext",
  "created_at",
  "cliente_id",
  "dek_envuelta",
  "id",
  "kek_id",
  "nonce",
  "tag",
  "tenant_id",
  "tipo",
  "updated_at",
  "version",
].sort();
const COLS_AUDITORIA = [
  "cliente_id",
  "created_at",
  "credencial_id",
  "id",
  "motivo",
  "resultado",
  "tenant_id",
  "tipo",
].sort();

const ESTADO_BACKEND = [
  "id",
  "tenant_id",
  "cliente_id",
  "tipo",
  "created_at",
  "updated_at",
].sort();
const INSERT_BACKEND = [
  "cliente_id",
  "tipo",
  "ciphertext",
  "nonce",
  "tag",
  "dek_envuelta",
  "kek_id",
  "version",
].sort();
const UPDATE_BACKEND = [
  "ciphertext",
  "nonce",
  "tag",
  "dek_envuelta",
  "kek_id",
  "version",
  "updated_at",
].sort();
const UPDATE_WORKER = ["dek_envuelta", "kek_id", "updated_at"].sort();
const INSERT_AUDITORIA_WORKER = [
  "credencial_id",
  "cliente_id",
  "tipo",
  "motivo",
  "resultado",
].sort();

const ROLES_TODOS = [
  "contapp_backend",
  "contapp_worker",
  "contapp_platform",
  "contapp_app",
] as const;
const PRIVS_TABLA = ["DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;

// ---------------------------------------------------------------------------------------------
// Soporte
// ---------------------------------------------------------------------------------------------
let pool: ReturnType<typeof abrirPool>;
let db: ContappDb;
beforeAll(() => {
  pool = abrirPool();
  db = crearDb("contapp_backend");
});
afterAll(async () => {
  await db?.close();
  await pool?.end();
});

function exportado<T>(nombre: string): T {
  const v = (dbModule as unknown as Record<string, unknown>)[nombre];
  if (v === undefined)
    throw new Error(
      `@contapp/db aun no exporta ${nombre} (implementacion pendiente, T10)`,
    );
  return v as T;
}
type Repo = (tx: Tx, ...args: any[]) => Promise<any>;
const repo = (nombre: string) => exportado<Repo>(nombre);
const guardarSobre = (tx: Tx, a: object) => repo("guardarSobre")(tx, a);
const estadoCredenciales = (tx: Tx, clienteId: string) =>
  repo("estadoCredenciales")(tx, clienteId);
const leerSobre = (tx: Tx, id: string) => repo("leerSobre")(tx, id);
const listarParaReenvolver = (tx: Tx, kekId: string, limite: number) =>
  repo("listarParaReenvolver")(tx, kekId, limite);
const reemplazarDekEnvuelta = (tx: Tx, a: object) =>
  repo("reemplazarDekEnvuelta")(tx, a);
const registrarDescifrado = (tx: Tx, a: object) =>
  repo("registrarDescifrado")(tx, a);

let contadorSp = 0;
async function intento(
  tx: Tx,
  text: string,
  values: unknown[] = [],
): Promise<Intento> {
  const sp = `sp_${++contadorSp}`;
  await tx.query(`SAVEPOINT ${sp}`);
  try {
    const r = await tx.query(text, values);
    await tx.query(`RELEASE SAVEPOINT ${sp}`);
    return { ok: true, rowCount: r.rowCount ?? 0 };
  } catch (e) {
    await tx.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    const err = e as { code?: string; message?: string };
    return {
      ok: false,
      code: String(err.code ?? ""),
      message: String(err.message ?? ""),
    };
  }
}

/** Ejecuta `fn` (un repositorio) dentro de un savepoint y devuelve valor o error sin abortar la transaccion. */
async function capturar<T>(
  tx: Tx,
  fn: () => Promise<T>,
): Promise<{ ok: true; valor: T } | { ok: false; error: any }> {
  const sp = `sp_${++contadorSp}`;
  await tx.query(`SAVEPOINT ${sp}`);
  try {
    const valor = await fn();
    await tx.query(`RELEASE SAVEPOINT ${sp}`);
    return { ok: true, valor };
  } catch (error) {
    await tx.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    return { ok: false, error };
  }
}

async function como(tx: Tx, rol: Rol): Promise<void> {
  if (rol !== "contapp_backend" && rol !== "contapp_worker")
    throw new Error("rol invalido en la prueba");
  await tx.query(`SET LOCAL ROLE ${rol}`);
}
async function enTenant(tx: Tx, tenantId: string): Promise<void> {
  await tx.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
}

function sobreFalso(o: Partial<SobreFalso> = {}): SobreFalso {
  return {
    ciphertext: randomBytes(64),
    nonce: randomBytes(12),
    tag: randomBytes(16),
    dekEnvuelta: randomBytes(512),
    kekId: "k1",
    version: 1,
    ...o,
  };
}
const argsInsert = (clienteId: string, tipo: Tipo, s: SobreFalso) => [
  clienteId,
  tipo,
  s.ciphertext,
  s.nonce,
  s.tag,
  s.dekEnvuelta,
  s.kekId,
  s.version,
];
const INSERT_SQL = `insert into credencial (cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version)
                    values ($1, $2, $3, $4, $5, $6, $7, $8)`;

/** Inserta una credencial como contapp_backend en el tenant dado; deja la sesion en ese rol y tenant. */
async function sembrar(
  tx: Tx,
  tenantId: string,
  clienteId: string,
  tipo: Tipo,
  s: SobreFalso = sobreFalso(),
) {
  await como(tx, "contapp_backend");
  await enTenant(tx, tenantId);
  const r = await tx.query(
    `${INSERT_SQL} returning id`,
    argsInsert(clienteId, tipo, s),
  );
  return { id: r.rows[0].id as string, sobre: s };
}

const campo = (o: any, ...nombres: string[]) => {
  for (const n of nombres)
    if (o && typeof o === "object" && n in o) return o[n];
  return undefined;
};
const igual = (a: unknown, b: unknown) =>
  Buffer.compare(Buffer.from(a as Buffer), Buffer.from(b as Buffer)) === 0;
function extraerSobre(fila: any) {
  const s = fila?.sobre ?? fila;
  return {
    ciphertext: campo(s, "ciphertext"),
    nonce: campo(s, "nonce"),
    tag: campo(s, "tag"),
    dekEnvuelta: campo(s, "dekEnvuelta", "dek_envuelta"),
    kekId: campo(s, "kekId", "kek_id"),
  };
}

/** Lee el sobre completo como contapp_worker (deja la sesion en ese rol; el tenant no cambia). */
async function sobreEnBd(tx: Tx, id: string) {
  await como(tx, "contapp_worker");
  const r = await tx.query(
    "select ciphertext, nonce, tag, dek_envuelta, kek_id, version, updated_at from credencial where id = $1",
    [id],
  );
  return r.rows[0] as
    | {
        ciphertext: Buffer;
        nonce: Buffer;
        tag: Buffer;
        dek_envuelta: Buffer;
        kek_id: string;
        version: number;
        updated_at: Date;
      }
    | undefined;
}

// ---------------------------------------------------------------------------------------------
// Catalogo y matriz de privilegios
// ---------------------------------------------------------------------------------------------
async function columnasConPrivilegio(
  tabla: string,
  rol: string,
  priv: "SELECT" | "INSERT" | "UPDATE",
): Promise<string[]> {
  const r = await pool.query(
    `select a.attname
       from pg_attribute a
      where a.attrelid = to_regclass($1) and a.attnum > 0 and not a.attisdropped
        and has_column_privilege($2, a.attrelid, a.attname, $3)
      order by a.attname`,
    [`public.${tabla}`, rol, priv],
  );
  return r.rows.map((x) => x.attname as string).sort();
}
async function columnasDe(tabla: string): Promise<string[]> {
  const r = await pool.query(
    `select a.attname from pg_attribute a
      where a.attrelid = to_regclass($1) and a.attnum > 0 and not a.attisdropped`,
    [`public.${tabla}`],
  );
  return r.rows.map((x) => x.attname as string).sort();
}
async function tienePrivTabla(
  tabla: string,
  rol: string,
  priv: string,
): Promise<boolean> {
  const r = await pool.query(
    "select has_table_privilege($1, to_regclass($2), $3) as v",
    [rol, `public.${tabla}`, priv],
  );
  return r.rows[0].v as boolean;
}
async function tieneAlgunaColumna(
  tabla: string,
  rol: string,
  priv: string,
): Promise<boolean> {
  const r = await pool.query(
    "select has_any_column_privilege($1, to_regclass($2), $3) as v",
    [rol, `public.${tabla}`, priv],
  );
  return r.rows[0].v as boolean;
}

describe("catalogo de credencial y auditoria_descifrado", () => {
  it("credencial existe con las columnas del plan", async () => {
    expect(await columnasDe("credencial")).toEqual(COLS_CREDENCIAL);
  });
  it("auditoria_descifrado existe con las columnas del plan", async () => {
    expect(await columnasDe("auditoria_descifrado")).toEqual(COLS_AUDITORIA);
  });

  it.each(["credencial", "auditoria_descifrado"])(
    "%s: dueno contapp_migrator, RLS ENABLE+FORCE y tenant_isolation FOR ALL",
    async (t) => {
      const c = await pool.query(
        `select o.rolname as dueno, c.relrowsecurity as rls, c.relforcerowsecurity as forzada
         from pg_class c join pg_roles o on o.oid = c.relowner
        where c.oid = to_regclass($1)`,
        [`public.${t}`],
      );
      expect(c.rows).toEqual([
        { dueno: "contapp_migrator", rls: true, forzada: true },
      ]);
      const p = await pool.query(
        "select cmd, qual, with_check from pg_policies where schemaname = 'public' and tablename = $1 and policyname = 'tenant_isolation'",
        [t],
      );
      expect(p.rows).toHaveLength(1);
      expect(p.rows[0].cmd).toBe("ALL");
      expect(p.rows[0].qual).toContain("app.tenant_id");
      expect(p.rows[0].with_check).toContain("app.tenant_id");
    },
  );

  it.each(["credencial", "auditoria_descifrado"])(
    "%s: PUBLIC no tiene ningun privilegio (tabla ni columnas)",
    async (t) => {
      const r = await pool.query(
        `select 'tabla' as nivel, a.privilege_type
         from pg_class c cross join lateral aclexplode(c.relacl) a
        where c.oid = to_regclass($1) and a.grantee = 0
       union all
       select 'columna', a2.privilege_type
         from pg_attribute at cross join lateral aclexplode(at.attacl) a2
        where at.attrelid = to_regclass($1) and at.attnum > 0 and a2.grantee = 0`,
        [`public.${t}`],
      );
      expect(r.rows).toEqual([]);
      // Control: la tabla existe (sin esto la prueba pasaria en vacio).
      expect((await columnasDe(t)).length).toBeGreaterThan(0);
    },
  );
});

describe("CA-4c matriz de privilegios de credencial (catalogo)", () => {
  it("contapp_backend: SELECT solo de las columnas de estado", async () => {
    expect(
      await columnasConPrivilegio("credencial", "contapp_backend", "SELECT"),
    ).toEqual(ESTADO_BACKEND);
  });
  it("contapp_backend: INSERT solo del sobre, cliente y tipo", async () => {
    expect(
      await columnasConPrivilegio("credencial", "contapp_backend", "INSERT"),
    ).toEqual(INSERT_BACKEND);
  });
  it("contapp_backend: UPDATE solo del sobre y updated_at", async () => {
    expect(
      await columnasConPrivilegio("credencial", "contapp_backend", "UPDATE"),
    ).toEqual(UPDATE_BACKEND);
  });
  it("contapp_backend: sin SELECT de tabla ni de ninguna columna sensible", async () => {
    expect(
      await tienePrivTabla("credencial", "contapp_backend", "SELECT"),
    ).toBe(false);
    for (const c of SENSIBLES) {
      const r = await pool.query(
        "select has_column_privilege('contapp_backend', to_regclass('public.credencial'), $1, 'SELECT') as v",
        [c],
      );
      expect(r.rows[0].v, `SELECT (${c})`).toBe(false);
    }
  });
  it("contapp_worker: SELECT de todas las columnas", async () => {
    expect(
      await columnasConPrivilegio("credencial", "contapp_worker", "SELECT"),
    ).toEqual(COLS_CREDENCIAL);
  });
  it("contapp_worker: UPDATE solo de dek_envuelta, kek_id y updated_at (ciphertext/nonce/tag los protege la BD)", async () => {
    expect(
      await columnasConPrivilegio("credencial", "contapp_worker", "UPDATE"),
    ).toEqual(UPDATE_WORKER);
  });
  it("contapp_worker: sin INSERT", async () => {
    expect(
      await columnasConPrivilegio("credencial", "contapp_worker", "INSERT"),
    ).toEqual([]);
    expect(await tienePrivTabla("credencial", "contapp_worker", "INSERT")).toBe(
      false,
    );
  });
  it.each(["contapp_platform", "contapp_app"])(
    "%s no tiene ningun privilegio sobre credencial",
    async (rol) => {
      expect((await columnasDe("credencial")).length).toBeGreaterThan(0);
      for (const p of [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
      ]) {
        expect(
          await tienePrivTabla("credencial", rol, p),
          `${rol} ${p} (tabla)`,
        ).toBe(false);
      }
      for (const p of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
        expect(
          await tieneAlgunaColumna("credencial", rol, p),
          `${rol} ${p} (columna)`,
        ).toBe(false);
      }
    },
  );
  it.each(ROLES_TODOS)(
    "%s: sin DELETE, TRUNCATE, REFERENCES ni TRIGGER sobre credencial",
    async (rol) => {
      expect((await columnasDe("credencial")).length).toBeGreaterThan(0);
      for (const p of PRIVS_TABLA)
        expect(await tienePrivTabla("credencial", rol, p), `${rol} ${p}`).toBe(
          false,
        );
    },
  );

  it("information_schema.column_privileges (visto como contapp_backend) coincide con la matriz", async () => {
    const filas = await enRollback(
      db,
      { tenantId: tenantDe("A") },
      async (tx) => {
        await como(tx, "contapp_backend");
        const r = await tx.query(
          `select privilege_type, column_name from information_schema.column_privileges
          where table_schema = 'public' and table_name = 'credencial' and grantee = 'contapp_backend'`,
        );
        return r.rows.map((x) => `${x.privilege_type}:${x.column_name}`).sort();
      },
    );
    const esperado = [
      ...ESTADO_BACKEND.map((c) => `SELECT:${c}`),
      ...INSERT_BACKEND.map((c) => `INSERT:${c}`),
      ...UPDATE_BACKEND.map((c) => `UPDATE:${c}`),
    ].sort();
    expect(filas).toEqual(esperado);
  });

  it("information_schema.column_privileges (visto como contapp_worker) coincide con la matriz", async () => {
    const filas = await enRollback(
      db,
      { tenantId: tenantDe("A") },
      async (tx) => {
        await como(tx, "contapp_worker");
        const r = await tx.query(
          `select privilege_type, column_name from information_schema.column_privileges
          where table_schema = 'public' and table_name = 'credencial' and grantee = 'contapp_worker'`,
        );
        return r.rows.map((x) => `${x.privilege_type}:${x.column_name}`).sort();
      },
    );
    const esperado = [
      ...COLS_CREDENCIAL.map((c) => `SELECT:${c}`),
      ...UPDATE_WORKER.map((c) => `UPDATE:${c}`),
    ].sort();
    expect(filas).toEqual(esperado);
  });
});

describe("CA-8 matriz de privilegios de auditoria_descifrado (catalogo)", () => {
  it("contapp_worker: solo INSERT de las columnas del registro; nada mas", async () => {
    expect(
      await columnasConPrivilegio(
        "auditoria_descifrado",
        "contapp_worker",
        "INSERT",
      ),
    ).toEqual(INSERT_AUDITORIA_WORKER);
    expect(
      await columnasConPrivilegio(
        "auditoria_descifrado",
        "contapp_worker",
        "SELECT",
      ),
    ).toEqual([]);
    expect(
      await columnasConPrivilegio(
        "auditoria_descifrado",
        "contapp_worker",
        "UPDATE",
      ),
    ).toEqual([]);
    expect(
      await tienePrivTabla("auditoria_descifrado", "contapp_worker", "SELECT"),
    ).toBe(false);
  });
  it.each(["contapp_backend", "contapp_platform", "contapp_app"])(
    "%s no tiene ningun privilegio sobre auditoria_descifrado",
    async (rol) => {
      expect((await columnasDe("auditoria_descifrado")).length).toBeGreaterThan(
        0,
      );
      for (const p of [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
      ]) {
        expect(
          await tienePrivTabla("auditoria_descifrado", rol, p),
          `${rol} ${p} (tabla)`,
        ).toBe(false);
      }
      for (const p of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
        expect(
          await tieneAlgunaColumna("auditoria_descifrado", rol, p),
          `${rol} ${p} (columna)`,
        ).toBe(false);
      }
    },
  );
  it.each(ROLES_TODOS)(
    "%s: solo de insercion (sin SELECT, UPDATE, DELETE, TRUNCATE)",
    async (rol) => {
      expect((await columnasDe("auditoria_descifrado")).length).toBeGreaterThan(
        0,
      );
      for (const p of ["SELECT", "UPDATE", ...PRIVS_TABLA]) {
        expect(
          await tienePrivTabla("auditoria_descifrado", rol, p),
          `${rol} ${p}`,
        ).toBe(false);
      }
      expect(
        await tieneAlgunaColumna("auditoria_descifrado", rol, "SELECT"),
        `${rol} SELECT (col)`,
      ).toBe(false);
      expect(
        await tieneAlgunaColumna("auditoria_descifrado", rol, "UPDATE"),
        `${rol} UPDATE (col)`,
      ).toBe(false);
    },
  );
  it("information_schema.column_privileges (visto como contapp_worker) solo lista INSERT de las 5 columnas", async () => {
    const filas = await enRollback(
      db,
      { tenantId: tenantDe("A") },
      async (tx) => {
        await como(tx, "contapp_worker");
        const r = await tx.query(
          `select privilege_type, column_name from information_schema.column_privileges
          where table_schema = 'public' and table_name = 'auditoria_descifrado' and grantee = 'contapp_worker'`,
        );
        return r.rows.map((x) => `${x.privilege_type}:${x.column_name}`).sort();
      },
    );
    expect(filas).toEqual(
      INSERT_AUDITORIA_WORKER.map((c) => `INSERT:${c}`).sort(),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// CA-4c con consultas reales como contapp_backend
// ---------------------------------------------------------------------------------------------
const DENEGADAS_BACKEND: [string, string][] = [
  ["SELECT ciphertext", "select ciphertext from credencial"],
  ["SELECT nonce", "select nonce from credencial"],
  ["SELECT tag", "select tag from credencial"],
  ["SELECT dek_envuelta", "select dek_envuelta from credencial"],
  ["SELECT con alias de tabla", "select c.ciphertext from credencial c"],
  ["SELECT *", "select * from credencial"],
  ["SELECT tabla.*", "select credencial.* from credencial"],
  ["SELECT fila completa", "select c from credencial c"],
  ["fila completa a texto", "select c::text from credencial c"],
  ["row_to_json", "select row_to_json(c) from credencial c"],
  ["to_jsonb", "select to_jsonb(c) from credencial c"],
  ["INSERT RETURNING ciphertext", `${INSERT_SQL} returning ciphertext`],
  ["INSERT RETURNING nonce", `${INSERT_SQL} returning nonce`],
  ["INSERT RETURNING *", `${INSERT_SQL} returning *`],
  ["INSERT RETURNING fila completa", `${INSERT_SQL} returning credencial`],
  [
    "UPDATE RETURNING ciphertext",
    "update credencial set kek_id = 'k9' returning ciphertext",
  ],
  [
    "UPDATE RETURNING dek_envuelta",
    "update credencial set kek_id = 'k9' returning dek_envuelta",
  ],
  [
    "WHERE ciphertext",
    "select id from credencial where ciphertext = '\\x00'::bytea",
  ],
  ["WHERE nonce", "select id from credencial where nonce = '\\x00'::bytea"],
  ["WHERE tag", "select id from credencial where tag = '\\x00'::bytea"],
  [
    "WHERE dek_envuelta",
    "select id from credencial where dek_envuelta = '\\x00'::bytea",
  ],
  [
    "WHERE funcion sobre dek_envuelta (oraculo)",
    "select id from credencial where length(dek_envuelta) > 0",
  ],
  [
    "WHERE substr de ciphertext (oraculo)",
    "select id from credencial where substr(ciphertext, 1, 1) = '\\x00'::bytea",
  ],
  ["WHERE IS NOT NULL", "select id from credencial where tag is not null"],
  [
    "EXISTS sobre columna sensible",
    "select exists (select 1 from credencial where nonce is not null)",
  ],
  ["ORDER BY tag", "select id from credencial order by tag"],
  ["ORDER BY ciphertext", "select id from credencial order by ciphertext"],
  ["GROUP BY nonce", "select count(*) from credencial group by nonce"],
  [
    "JOIN por columna sensible",
    "select a.id from credencial a join credencial b on a.nonce = b.nonce",
  ],
  [
    "COPY de una columna sensible",
    "copy (select ciphertext from credencial) to stdout",
  ],
  ["COPY SELECT *", "copy (select * from credencial) to stdout"],
  ["COPY de la tabla", "copy credencial to stdout"],
  ["COPY con lista de columnas", "copy credencial (nonce) to stdout"],
  [
    "UPDATE ... WHERE sobre columna sensible",
    "update credencial set kek_id = 'k9' where ciphertext = '\\x00'::bytea",
  ],
  ["UPDATE leyendo una columna sensible", "update credencial set tag = nonce"],
  [
    "UPDATE ciphertext = ciphertext",
    "update credencial set ciphertext = ciphertext",
  ],
  ["DELETE", "delete from credencial"],
  ["TRUNCATE", "truncate credencial"],
  [
    "vista sobre credencial",
    "create view v_credencial_prueba as select * from credencial",
  ],
];

const UPSERT_BASE = `insert into credencial (cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version)
                     values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (tenant_id, cliente_id, tipo) do update set`;
const UPSERT_LEE: [string, string][] = [
  [
    "ON CONFLICT DO UPDATE SET ciphertext = EXCLUDED.ciphertext",
    `${UPSERT_BASE} ciphertext = excluded.ciphertext`,
  ],
  [
    "ON CONFLICT DO UPDATE SET dek_envuelta = EXCLUDED.dek_envuelta",
    `${UPSERT_BASE} dek_envuelta = excluded.dek_envuelta`,
  ],
  [
    "ON CONFLICT DO UPDATE SET ciphertext = <columna destino>",
    `${UPSERT_BASE} ciphertext = credencial.ciphertext`,
  ],
  [
    "ON CONFLICT DO UPDATE ... WHERE sobre columna sensible",
    `${UPSERT_BASE} kek_id = excluded.kek_id where credencial.tag = excluded.tag`,
  ],
  [
    "ON CONFLICT DO UPDATE ... RETURNING ciphertext",
    `${UPSERT_BASE} kek_id = $7 returning ciphertext`,
  ],
];

describe("CA-4c contapp_backend no lee el sobre por ninguna via SQL", () => {
  it.each(DENEGADAS_BACKEND)("permission denied: %s", async (_n, sql) => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const base = await sembrar(
        tx,
        tenantDe("A"),
        clientesDe("A")[0].id,
        "sol",
      );
      expect(base.id).toMatch(/^[0-9a-f-]{36}$/);
      const nuevo = sobreFalso();
      const hayParams = sql.includes("$2");
      return intento(
        tx,
        sql,
        hayParams ? argsInsert(randomUUID(), "sire_api", nuevo) : [],
      );
    });
    expect(r.ok, "la consulta debio rechazarse").toBe(false);
    expect(r.ok ? "" : r.code).toBe("42501");
  });

  it.each(UPSERT_LEE)("permission denied: %s", async (_n, sql) => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const cli = clientesDe("A")[0].id;
      await sembrar(tx, tenantDe("A"), cli, "sol");
      return intento(tx, sql, argsInsert(cli, "sol", sobreFalso()));
    });
    expect(r.ok, "el upsert que lee el sobre debio rechazarse").toBe(false);
    expect(r.ok ? "" : r.code).toBe("42501");
  });

  it("los errores de permiso no revelan el contenido (mensaje sin bytes ni hex del sobre)", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const base = await sembrar(
        tx,
        tenantDe("A"),
        clientesDe("A")[0].id,
        "sol",
      );
      const i = await intento(tx, "select ciphertext from credencial");
      return { i, hex: base.sobre.ciphertext.toString("hex") };
    });
    expect(r.i.ok).toBe(false);
    expect(r.i.ok ? "" : r.i.code).toBe("42501");
    expect(r.i.ok ? "" : r.i.message).not.toContain(r.hex.slice(0, 16));
  });

  it("el INSERT del sobre funciona (con RETURNING id) y toma el tenant del contexto", async () => {
    const ok = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const { id } = await sembrar(
        tx,
        tenantDe("A"),
        clientesDe("A")[0].id,
        "sol",
      );
      const r = await tx.query(
        "select tenant_id, tipo from credencial where id = $1",
        [id],
      );
      return r.rows[0];
    });
    expect(ok).toEqual({ tenant_id: tenantDe("A"), tipo: "sol" });
  });

  it("el SELECT de las columnas de estado funciona", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      await sembrar(tx, tenantDe("A"), clientesDe("A")[0].id, "sol");
      return intento(
        tx,
        "select id, tenant_id, cliente_id, tipo, created_at, updated_at from credencial",
      );
    });
    expect(r).toEqual({ ok: true, rowCount: 1 });
  });

  it("el UPDATE del sobre funciona (por id, sin leer el sobre)", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const { id } = await sembrar(
        tx,
        tenantDe("A"),
        clientesDe("A")[0].id,
        "sol",
      );
      const n = sobreFalso({ kekId: "k2" });
      return intento(
        tx,
        `update credencial set ciphertext = $2, nonce = $3, tag = $4, dek_envuelta = $5, kek_id = $6, version = $7, updated_at = now()
          where id = $1 returning id`,
        [id, n.ciphertext, n.nonce, n.tag, n.dekEnvuelta, n.kekId, n.version],
      );
    });
    expect(r).toEqual({ ok: true, rowCount: 1 });
  });

  it("el upsert con parametros (sin EXCLUDED) funciona, devuelve el mismo id y deja una sola fila", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const cli = clientesDe("A")[0].id;
      const { id } = await sembrar(tx, tenantDe("A"), cli, "sol");
      const n = sobreFalso({ kekId: "k2" });
      const up = await tx.query(
        `insert into credencial (cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (tenant_id, cliente_id, tipo) do update set
           ciphertext = $3, nonce = $4, tag = $5, dek_envuelta = $6, kek_id = $7, version = $8, updated_at = now()
         returning id`,
        argsInsert(cli, "sol", n),
      );
      const cuenta = await tx.query(
        "select id from credencial where cliente_id = $1",
        [cli],
      );
      return { mismo: up.rows[0].id === id, filas: cuenta.rowCount };
    });
    expect(r).toEqual({ mismo: true, filas: 1 });
  });

  it("UNIQUE(tenant, cliente, tipo): un INSERT repetido da 23505", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const cli = clientesDe("A")[0].id;
      await sembrar(tx, tenantDe("A"), cli, "sol");
      return intento(tx, INSERT_SQL, argsInsert(cli, "sol", sobreFalso()));
    });
    expect(r.ok ? "" : r.code).toBe("23505");
  });
});

describe("restricciones CHECK de credencial (via INSERT del backend)", () => {
  const casos: [string, Partial<SobreFalso> & { tipo?: string }][] = [
    ["ciphertext vacio", { ciphertext: Buffer.alloc(0) }],
    ["ciphertext de 1101 B", { ciphertext: randomBytes(1101) }],
    ["nonce de 11 B", { nonce: randomBytes(11) }],
    ["nonce de 13 B", { nonce: randomBytes(13) }],
    ["tag de 15 B (truncado)", { tag: randomBytes(15) }],
    ["tag de 17 B", { tag: randomBytes(17) }],
    ["dek_envuelta vacia", { dekEnvuelta: Buffer.alloc(0) }],
    ["dek_envuelta de 1025 B", { dekEnvuelta: randomBytes(1025) }],
    ["kek_id con mayusculas", { kekId: "K1" }],
    ["kek_id vacio", { kekId: "" }],
    ["kek_id con espacio", { kekId: "k 1" }],
    ["kek_id de 64 caracteres", { kekId: "a".repeat(64) }],
    ["version 2", { version: 2 as unknown as 1 }],
    ["tipo desconocido", { tipo: "otro" }],
  ];
  it.each(casos)("rechaza %s con 23514", async (_n, o) => {
    const { tipo, ...sobre } = o;
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      await como(tx, "contapp_backend");
      return intento(
        tx,
        INSERT_SQL,
        argsInsert(
          clientesDe("A")[0].id,
          (tipo ?? "sol") as Tipo,
          sobreFalso(sobre),
        ),
      );
    });
    expect(r.ok ? "ok" : r.code).toBe("23514");
  });

  it("acepta los limites validos (ciphertext 1 y 1100 B, dek_envuelta 1 y 1024 B, kek_id de 63)", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      await como(tx, "contapp_backend");
      const cli = clientesDe("A");
      const a = await intento(
        tx,
        INSERT_SQL,
        argsInsert(
          cli[0].id,
          "sol",
          sobreFalso({
            ciphertext: randomBytes(1),
            dekEnvuelta: randomBytes(1),
          }),
        ),
      );
      const b = await intento(
        tx,
        INSERT_SQL,
        argsInsert(
          cli[1].id,
          "sol",
          sobreFalso({
            ciphertext: randomBytes(1100),
            dekEnvuelta: randomBytes(1024),
            kekId: "a".repeat(63),
          }),
        ),
      );
      return [a, b];
    });
    expect(r).toEqual([
      { ok: true, rowCount: 1 },
      { ok: true, rowCount: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// contapp_worker y contapp_platform
// ---------------------------------------------------------------------------------------------
describe("contapp_worker sobre credencial", () => {
  it("lee el sobre completo (ciphertext, nonce, tag, dek_envuelta)", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const { id, sobre } = await sembrar(
        tx,
        tenantDe("A"),
        clientesDe("A")[0].id,
        "sol",
      );
      return { fila: await sobreEnBd(tx, id), sobre };
    });
    expect(r.fila).toBeDefined();
    expect(igual(r.fila!.ciphertext, r.sobre.ciphertext)).toBe(true);
    expect(igual(r.fila!.nonce, r.sobre.nonce)).toBe(true);
    expect(igual(r.fila!.tag, r.sobre.tag)).toBe(true);
    expect(igual(r.fila!.dek_envuelta, r.sobre.dekEnvuelta)).toBe(true);
  });

  it.each([
    "ciphertext",
    "nonce",
    "tag",
    "version",
    "tenant_id",
    "cliente_id",
    "tipo",
    "created_at",
  ])("no puede actualizar %s (permission denied)", async (col) => {
    const valores: Record<string, unknown> = {
      ciphertext: randomBytes(64),
      nonce: randomBytes(12),
      tag: randomBytes(16),
      version: 1,
      tenant_id: tenantDe("A"),
      cliente_id: randomUUID(),
      tipo: "sire_api",
      created_at: new Date(),
    };
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const { id } = await sembrar(
        tx,
        tenantDe("A"),
        clientesDe("A")[0].id,
        "sol",
      );
      await como(tx, "contapp_worker");
      return intento(tx, `update credencial set ${col} = $2 where id = $1`, [
        id,
        valores[col],
      ]);
    });
    expect(r.ok ? "ok" : r.code).toBe("42501");
  });

  it("puede actualizar dek_envuelta, kek_id y updated_at", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const { id } = await sembrar(
        tx,
        tenantDe("A"),
        clientesDe("A")[0].id,
        "sol",
      );
      await como(tx, "contapp_worker");
      return intento(
        tx,
        "update credencial set dek_envuelta = $2, kek_id = 'k2', updated_at = now() where id = $1",
        [id, randomBytes(512)],
      );
    });
    expect(r).toEqual({ ok: true, rowCount: 1 });
  });

  it("no puede insertar ni borrar ni truncar", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const cli = clientesDe("A")[0].id;
      await sembrar(tx, tenantDe("A"), cli, "sol");
      await como(tx, "contapp_worker");
      return [
        await intento(
          tx,
          INSERT_SQL,
          argsInsert(cli, "sire_api", sobreFalso()),
        ),
        await intento(tx, "delete from credencial"),
        await intento(tx, "truncate credencial"),
      ];
    });
    expect(r.map((x) => (x.ok ? "ok" : x.code))).toEqual([
      "42501",
      "42501",
      "42501",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// CA-4c con los repositorios
// ---------------------------------------------------------------------------------------------
describe("CA-4c repositorios: guardarSobre y estadoCredenciales (rol contapp_backend)", () => {
  it("guardarSobre inserta, devuelve { id } y el worker lee el mismo sobre", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const s = sobreFalso();
      const g = await guardarSobre(tx, {
        clienteId: clientesDe("A")[0].id,
        tipo: "sol",
        sobre: s,
      });
      return { g, fila: await sobreEnBd(tx, g.id), s };
    });
    expect(r.g.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(Object.keys(r.g)).toEqual(["id"]);
    expect(igual(r.fila!.ciphertext, r.s.ciphertext)).toBe(true);
    expect(igual(r.fila!.dek_envuelta, r.s.dekEnvuelta)).toBe(true);
    expect(r.fila!.kek_id).toBe("k1");
    expect(r.fila!.version).toBe(1);
  });

  it("guardarSobre sobre un (cliente, tipo) existente actualiza el sobre y conserva el id", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const cli = clientesDe("A")[0].id;
      const a = await guardarSobre(tx, {
        clienteId: cli,
        tipo: "sol",
        sobre: sobreFalso(),
      });
      await como(tx, "contapp_backend");
      const n = sobreFalso({ kekId: "k2" });
      const b = await guardarSobre(tx, {
        clienteId: cli,
        tipo: "sol",
        sobre: n,
      });
      await como(tx, "contapp_backend");
      const filas = await tx.query(
        "select id from credencial where cliente_id = $1",
        [cli],
      );
      return {
        a,
        b,
        n,
        fila: await sobreEnBd(tx, b.id),
        total: filas.rowCount,
      };
    });
    expect(r.b.id).toBe(r.a.id);
    expect(r.total).toBe(1);
    expect(igual(r.fila!.ciphertext, r.n.ciphertext)).toBe(true);
    expect(igual(r.fila!.nonce, r.n.nonce)).toBe(true);
    expect(igual(r.fila!.tag, r.n.tag)).toBe(true);
    expect(igual(r.fila!.dek_envuelta, r.n.dekEnvuelta)).toBe(true);
    expect(r.fila!.kek_id).toBe("k2");
  });

  it("guardarSobre guarda sol y sire_api del mismo cliente como filas distintas", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const cli = clientesDe("A")[0].id;
      const a = await guardarSobre(tx, {
        clienteId: cli,
        tipo: "sol",
        sobre: sobreFalso(),
      });
      const b = await guardarSobre(tx, {
        clienteId: cli,
        tipo: "sire_api",
        sobre: sobreFalso(),
      });
      return { a, b };
    });
    expect(r.a.id).not.toBe(r.b.id);
  });

  it("estadoCredenciales devuelve solo columnas de estado (sin sobre) de las credenciales del cliente", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const cli = clientesDe("A")[0].id;
      const s = sobreFalso();
      const a = await guardarSobre(tx, {
        clienteId: cli,
        tipo: "sol",
        sobre: s,
      });
      const vacio = await estadoCredenciales(tx, clientesDe("A")[1].id);
      const antes = await estadoCredenciales(tx, cli);
      const b = await guardarSobre(tx, {
        clienteId: cli,
        tipo: "sire_api",
        sobre: sobreFalso(),
      });
      const despues = await estadoCredenciales(tx, cli);
      return { a, b, vacio, antes, despues, s };
    });
    expect(r.vacio).toEqual([]);
    expect(r.antes).toHaveLength(1);
    expect(r.antes[0].tipo).toBe("sol");
    expect(r.antes[0].id).toBe(r.a.id);
    expect(r.despues.map((x: any) => x.tipo).sort()).toEqual([
      "sire_api",
      "sol",
    ]);
    for (const fila of [...r.antes, ...r.despues]) {
      const llaves = Object.keys(fila).map((k) =>
        k.toLowerCase().replace(/_/g, ""),
      );
      for (const prohibida of [
        "ciphertext",
        "nonce",
        "tag",
        "dekenvuelta",
        "kekid",
        "version",
      ]) {
        expect(
          llaves,
          `estadoCredenciales no debe exponer ${prohibida}`,
        ).not.toContain(prohibida);
      }
      expect(Object.values(fila).some((v) => Buffer.isBuffer(v))).toBe(false);
    }
    const texto = JSON.stringify(r.despues);
    expect(texto).not.toContain(r.s.nonce.toString("hex"));
    expect(texto).not.toContain(r.s.nonce.toString("base64"));
  });

  it("guardarSobre con un nonce invalido lanza CredencialRepoError (23514) y no guarda nada", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const cli = clientesDe("A")[0].id;
      const c = await capturar(tx, () =>
        guardarSobre(tx, {
          clienteId: cli,
          tipo: "sol",
          sobre: sobreFalso({ nonce: randomBytes(13) }),
        }),
      );
      await como(tx, "contapp_backend");
      return { c, estado: await estadoCredenciales(tx, cli) };
    });
    expect(r.c.ok).toBe(false);
    const CredencialRepoError = exportado<new (...a: any[]) => Error>(
      "CredencialRepoError",
    );
    expect((r.c as any).error).toBeInstanceOf(CredencialRepoError);
    expect((r.c as any).error.codigo).toBe("23514");
    expect(r.estado).toEqual([]);
  });

  it("leerSobre con el rol contapp_backend falla con CredencialRepoError 42501 (el backend no lee el sobre)", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const { id } = await sembrar(
        tx,
        tenantDe("A"),
        clientesDe("A")[0].id,
        "sol",
      );
      return capturar(tx, () => leerSobre(tx, id));
    });
    expect(r.ok).toBe(false);
    const CredencialRepoError = exportado<new (...a: any[]) => Error>(
      "CredencialRepoError",
    );
    expect((r as any).error).toBeInstanceOf(CredencialRepoError);
    expect((r as any).error.codigo).toBe("42501");
  });
});

// ---------------------------------------------------------------------------------------------
// Repositorios del worker (lectura y rotacion)
// ---------------------------------------------------------------------------------------------
describe("repositorios del worker: leerSobre", () => {
  it("devuelve el sobre exacto con tenant, cliente y tipo de la fila", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const cli = clientesDe("A")[0].id;
      const { id, sobre } = await sembrar(tx, tenantDe("A"), cli, "sire_api");
      await como(tx, "contapp_worker");
      return { fila: await leerSobre(tx, id), sobre, cli };
    });
    const s = extraerSobre(r.fila);
    expect(igual(s.ciphertext, r.sobre.ciphertext)).toBe(true);
    expect(igual(s.nonce, r.sobre.nonce)).toBe(true);
    expect(igual(s.tag, r.sobre.tag)).toBe(true);
    expect(igual(s.dekEnvuelta, r.sobre.dekEnvuelta)).toBe(true);
    expect(s.kekId).toBe("k1");
    expect(campo(r.fila, "tenantId", "tenant_id")).toBe(tenantDe("A"));
    expect(campo(r.fila, "clienteId", "cliente_id")).toBe(r.cli);
    expect(campo(r.fila, "tipo")).toBe("sire_api");
  });

  it("devuelve null para un id inexistente", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      await como(tx, "contapp_worker");
      return leerSobre(tx, randomUUID());
    });
    expect(r).toBeNull();
  });
});

describe("repositorios del worker: listarParaReenvolver y reemplazarDekEnvuelta (rotacion)", () => {
  async function tresFilas(tx: Tx) {
    const cli = clientesDe("A");
    const t = tenantDe("A");
    const a = await sembrar(
      tx,
      t,
      cli[0].id,
      "sol",
      sobreFalso({ kekId: "k1" }),
    );
    const b = await sembrar(
      tx,
      t,
      cli[1].id,
      "sol",
      sobreFalso({ kekId: "k1" }),
    );
    const c = await sembrar(
      tx,
      t,
      cli[2].id,
      "sol",
      sobreFalso({ kekId: "k1" }),
    );
    const d = await sembrar(
      tx,
      t,
      cli[0].id,
      "sire_api",
      sobreFalso({ kekId: "k2" }),
    );
    return { a, b, c, d };
  }

  it("lista solo las filas con el kek_id pedido, ordenadas por id y respetando el limite", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const f = await tresFilas(tx);
      await como(tx, "contapp_worker");
      return {
        f,
        dos: await listarParaReenvolver(tx, "k1", 2),
        todas: await listarParaReenvolver(tx, "k1", 10),
        k2: await listarParaReenvolver(tx, "k2", 10),
        ninguna: await listarParaReenvolver(tx, "k9", 10),
      };
    });
    const ids = (xs: any[]) => xs.map((x) => x.id as string);
    expect(r.dos).toHaveLength(2);
    expect(ids(r.todas)).toEqual([...ids(r.todas)].sort());
    expect(ids(r.todas).sort()).toEqual([r.f.a.id, r.f.b.id, r.f.c.id].sort());
    expect(ids(r.dos)).toEqual(ids(r.todas).slice(0, 2));
    expect(ids(r.k2)).toEqual([r.f.d.id]);
    expect(r.ninguna).toEqual([]);
  });

  it("cada fila listada trae la dek_envuelta actual (para el CAS) y su kek_id", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const f = await tresFilas(tx);
      await como(tx, "contapp_worker");
      return { f, lista: await listarParaReenvolver(tx, "k2", 10) };
    });
    expect(r.lista).toHaveLength(1);
    const s = extraerSobre(r.lista[0]);
    expect(igual(s.dekEnvuelta, r.f.d.sobre.dekEnvuelta)).toBe(true);
    expect(s.kekId).toBe("k2");
  });

  it("reemplazarDekEnvuelta cambia solo dek_envuelta y kek_id y devuelve true", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const { id, sobre } = await sembrar(
        tx,
        tenantDe("A"),
        clientesDe("A")[0].id,
        "sol",
      );
      await como(tx, "contapp_worker");
      const nueva = randomBytes(512);
      const ok = await reemplazarDekEnvuelta(tx, {
        id,
        dekAnterior: sobre.dekEnvuelta,
        dekNueva: nueva,
        kekNuevo: "k2",
      });
      return { ok, nueva, sobre, fila: await sobreEnBd(tx, id) };
    });
    expect(r.ok).toBe(true);
    expect(igual(r.fila!.dek_envuelta, r.nueva)).toBe(true);
    expect(r.fila!.kek_id).toBe("k2");
    expect(igual(r.fila!.ciphertext, r.sobre.ciphertext)).toBe(true);
    expect(igual(r.fila!.nonce, r.sobre.nonce)).toBe(true);
    expect(igual(r.fila!.tag, r.sobre.tag)).toBe(true);
    expect(r.fila!.version).toBe(1);
  });

  it("es idempotente: repetir con la misma dekAnterior devuelve false y no cambia nada", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const { id, sobre } = await sembrar(
        tx,
        tenantDe("A"),
        clientesDe("A")[0].id,
        "sol",
      );
      await como(tx, "contapp_worker");
      const nueva = randomBytes(512);
      const args = {
        id,
        dekAnterior: sobre.dekEnvuelta,
        dekNueva: nueva,
        kekNuevo: "k2",
      };
      const a = await reemplazarDekEnvuelta(tx, args);
      const b = await reemplazarDekEnvuelta(tx, {
        ...args,
        dekNueva: randomBytes(512),
      });
      return { a, b, nueva, fila: await sobreEnBd(tx, id) };
    });
    expect(r.a).toBe(true);
    expect(r.b).toBe(false);
    expect(igual(r.fila!.dek_envuelta, r.nueva)).toBe(true);
  });

  it("CAS: con una dekAnterior que ya no coincide devuelve false y deja la fila intacta", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const { id, sobre } = await sembrar(
        tx,
        tenantDe("A"),
        clientesDe("A")[0].id,
        "sol",
      );
      await como(tx, "contapp_worker");
      const ok = await reemplazarDekEnvuelta(tx, {
        id,
        dekAnterior: randomBytes(512),
        dekNueva: randomBytes(512),
        kekNuevo: "k2",
      });
      return { ok, sobre, fila: await sobreEnBd(tx, id) };
    });
    expect(r.ok).toBe(false);
    expect(igual(r.fila!.dek_envuelta, r.sobre.dekEnvuelta)).toBe(true);
    expect(r.fila!.kek_id).toBe("k1");
  });

  it("una escritura concurrente del backend no queda pisada por la rotacion", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const cli = clientesDe("A")[0].id;
      const original = sobreFalso();
      const { id } = await sembrar(tx, tenantDe("A"), cli, "sol", original);
      // La rotacion leyo `original.dekEnvuelta`; antes de escribir, el backend guarda un sobre nuevo.
      const nuevoBackend = sobreFalso({ kekId: "k2" });
      await como(tx, "contapp_backend");
      await guardarSobre(tx, {
        clienteId: cli,
        tipo: "sol",
        sobre: nuevoBackend,
      });
      await como(tx, "contapp_worker");
      const ok = await reemplazarDekEnvuelta(tx, {
        id,
        dekAnterior: original.dekEnvuelta,
        dekNueva: randomBytes(512),
        kekNuevo: "k2",
      });
      return { ok, nuevoBackend, fila: await sobreEnBd(tx, id) };
    });
    expect(r.ok).toBe(false);
    expect(igual(r.fila!.dek_envuelta, r.nuevoBackend.dekEnvuelta)).toBe(true);
    expect(igual(r.fila!.ciphertext, r.nuevoBackend.ciphertext)).toBe(true);
  });

  it("con el rol contapp_backend, reemplazarDekEnvuelta falla con CredencialRepoError 42501", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const { id, sobre } = await sembrar(
        tx,
        tenantDe("A"),
        clientesDe("A")[0].id,
        "sol",
      );
      return capturar(tx, () =>
        reemplazarDekEnvuelta(tx, {
          id,
          dekAnterior: sobre.dekEnvuelta,
          dekNueva: randomBytes(512),
          kekNuevo: "k2",
        }),
      );
    });
    // El backend si puede actualizar dek_envuelta, pero el CAS (WHERE dek_envuelta = ...) lee la columna: 42501.
    expect(r.ok).toBe(false);
    expect((r as any).error.codigo).toBe("42501");
  });
});

// ---------------------------------------------------------------------------------------------
// CA-5 aislamiento simetrico
// ---------------------------------------------------------------------------------------------
describe.each<[Estudio, Estudio]>([
  ["A", "B"],
  ["B", "A"],
])(
  "CA-5 aislamiento: el worker de %s no ve credenciales de %s",
  (propio, ajeno) => {
    async function dos(tx: Tx) {
      const p = await sembrar(
        tx,
        tenantDe(propio),
        clientesDe(propio)[0].id,
        "sol",
        sobreFalso({ kekId: "k1" }),
      );
      const a = await sembrar(
        tx,
        tenantDe(ajeno),
        clientesDe(ajeno)[0].id,
        "sol",
        sobreFalso({ kekId: "k1" }),
      );
      await como(tx, "contapp_worker");
      await enTenant(tx, tenantDe(propio));
      return { p, a };
    }

    it("SELECT por id y en lote solo devuelve las filas propias", async () => {
      const r = await enRollback(
        db,
        { tenantId: tenantDe(propio) },
        async (tx) => {
          const { p, a } = await dos(tx);
          const porId = await tx.query(
            "select id from credencial where id = $1",
            [a.id],
          );
          const lote = await tx.query(
            "select id from credencial where id = any($1::uuid[]) order by id",
            [[p.id, a.id]],
          );
          const todas = await tx.query("select id from credencial");
          return {
            p,
            a,
            porId: porId.rows,
            lote: lote.rows.map((x) => x.id),
            todas: todas.rows.map((x) => x.id),
          };
        },
      );
      expect(r.porId).toEqual([]);
      expect(r.lote).toEqual([r.p.id]);
      expect(r.todas).toEqual([r.p.id]);
    });

    it("leerSobre de una fila ajena devuelve null; de la propia, el sobre", async () => {
      const r = await enRollback(
        db,
        { tenantId: tenantDe(propio) },
        async (tx) => {
          const { p, a } = await dos(tx);
          return {
            ajena: await leerSobre(tx, a.id),
            propia: await leerSobre(tx, p.id),
            p,
          };
        },
      );
      expect(r.ajena).toBeNull();
      expect(r.propia).not.toBeNull();
      expect(
        igual(extraerSobre(r.propia).ciphertext, r.p.sobre.ciphertext),
      ).toBe(true);
    });

    it("listarParaReenvolver solo trae filas del tenant del contexto", async () => {
      const r = await enRollback(
        db,
        { tenantId: tenantDe(propio) },
        async (tx) => {
          const { p } = await dos(tx);
          return { lista: await listarParaReenvolver(tx, "k1", 100), p };
        },
      );
      expect(r.lista.map((x: any) => x.id)).toEqual([r.p.id]);
    });

    it("reemplazarDekEnvuelta sobre una fila ajena devuelve false y no la toca", async () => {
      const r = await enRollback(
        db,
        { tenantId: tenantDe(propio) },
        async (tx) => {
          const { a } = await dos(tx);
          const ok = await reemplazarDekEnvuelta(tx, {
            id: a.id,
            dekAnterior: a.sobre.dekEnvuelta,
            dekNueva: randomBytes(512),
            kekNuevo: "k2",
          });
          await enTenant(tx, tenantDe(ajeno));
          return { ok, a, fila: await sobreEnBd(tx, a.id) };
        },
      );
      expect(r.ok).toBe(false);
      expect(igual(r.fila!.dek_envuelta, r.a.sobre.dekEnvuelta)).toBe(true);
      expect(r.fila!.kek_id).toBe("k1");
    });

    it("UPDATE directo de una fila ajena afecta 0 filas", async () => {
      const r = await enRollback(
        db,
        { tenantId: tenantDe(propio) },
        async (tx) => {
          const { a } = await dos(tx);
          return intento(
            tx,
            "update credencial set kek_id = 'k9' where id = $1",
            [a.id],
          );
        },
      );
      expect(r).toEqual({ ok: true, rowCount: 0 });
    });

    it("el backend de este estudio ve el estado propio y nada del otro", async () => {
      const r = await enRollback(
        db,
        { tenantId: tenantDe(propio) },
        async (tx) => {
          const { p } = await dos(tx);
          await como(tx, "contapp_backend");
          const propios = await estadoCredenciales(
            tx,
            clientesDe(propio)[0].id,
          );
          const ajenos = await estadoCredenciales(tx, clientesDe(ajeno)[0].id);
          return { propios, ajenos, p };
        },
      );
      expect(r.propios.map((x: any) => x.id)).toEqual([r.p.id]);
      expect(r.ajenos).toEqual([]);
    });
  },
);

describe("CA-5 aislamiento: casos adicionales", () => {
  it("sin tenant fijado (fail-closed) el worker no ve ninguna fila", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      await sembrar(tx, tenantDe("A"), clientesDe("A")[0].id, "sol");
      await como(tx, "contapp_worker");
      await enTenant(tx, "");
      return (await tx.query("select id from credencial")).rowCount;
    });
    expect(r).toBe(0);
  });

  it("el mismo (cliente, tipo) puede existir en dos estudios sin conflicto ni oraculo", async () => {
    const cli = randomUUID();
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      await sembrar(tx, tenantDe("A"), cli, "sol");
      await enTenant(tx, tenantDe("B"));
      return intento(tx, INSERT_SQL, argsInsert(cli, "sol", sobreFalso()));
    });
    expect(r).toEqual({ ok: true, rowCount: 1 });
  });
});

// ---------------------------------------------------------------------------------------------
// CA-8 auditoria
// ---------------------------------------------------------------------------------------------
const INSERT_AUDITORIA = `insert into auditoria_descifrado (credencial_id, cliente_id, tipo, motivo, resultado) values ($1, $2, $3, $4, $5)`;

describe("CA-8 auditoria_descifrado: solo insercion", () => {
  it("contapp_worker inserta con las columnas permitidas (sin RETURNING)", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      await como(tx, "contapp_worker");
      return intento(tx, INSERT_AUDITORIA, [
        randomUUID(),
        clientesDe("A")[0].id,
        "sol",
        "job:abc-123.x_y",
        "ok",
      ]);
    });
    expect(r).toEqual({ ok: true, rowCount: 1 });
  });

  it("cliente_id y tipo son opcionales (NULL)", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      await como(tx, "contapp_worker");
      return intento(tx, INSERT_AUDITORIA, [
        randomUUID(),
        null,
        null,
        "manual",
        "no_encontrada",
      ]);
    });
    expect(r).toEqual({ ok: true, rowCount: 1 });
  });

  it.each(["ok", "no_encontrada", "integridad", "formato", "llave"])(
    "acepta el resultado %s",
    async (resultado) => {
      const r = await enRollback(
        db,
        { tenantId: tenantDe("A") },
        async (tx) => {
          await como(tx, "contapp_worker");
          return intento(tx, INSERT_AUDITORIA, [
            randomUUID(),
            null,
            null,
            "m",
            resultado,
          ]);
        },
      );
      expect(r).toEqual({ ok: true, rowCount: 1 });
    },
  );

  it.each([
    ["resultado desconocido", "m", "otro"],
    ["motivo vacio", "", "ok"],
    ["motivo con espacio", "a b", "ok"],
    ["motivo con comilla", "a'b", "ok"],
    ["motivo de 121 caracteres", "a".repeat(121), "ok"],
  ])("rechaza %s (23514)", async (_n, motivo, resultado) => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      await como(tx, "contapp_worker");
      return intento(tx, INSERT_AUDITORIA, [
        randomUUID(),
        null,
        null,
        motivo,
        resultado,
      ]);
    });
    expect(r.ok ? "ok" : r.code).toBe("23514");
  });

  it("contapp_worker no puede leer, actualizar, borrar ni truncar la auditoria", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      await como(tx, "contapp_worker");
      await intento(tx, INSERT_AUDITORIA, [
        randomUUID(),
        null,
        null,
        "m",
        "ok",
      ]);
      return [
        await intento(tx, "select id from auditoria_descifrado"),
        await intento(tx, "select * from auditoria_descifrado"),
        await intento(
          tx,
          "select count(*) from auditoria_descifrado where resultado = 'ok'",
        ),
        await intento(tx, `${INSERT_AUDITORIA} returning id`, [
          randomUUID(),
          null,
          null,
          "m",
          "ok",
        ]),
        await intento(tx, "update auditoria_descifrado set resultado = 'ok'"),
        await intento(tx, "delete from auditoria_descifrado"),
        await intento(tx, "truncate auditoria_descifrado"),
        await intento(
          tx,
          "insert into auditoria_descifrado (tenant_id, credencial_id, motivo, resultado) values ($1, $2, 'm', 'ok')",
          [tenantDe("B"), randomUUID()],
        ),
      ];
    });
    expect(r.map((x) => (x.ok ? "ok" : x.code))).toEqual(
      Array(8).fill("42501"),
    );
  });

  it("contapp_backend no puede insertar ni leer la auditoria", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      await como(tx, "contapp_backend");
      return [
        await intento(tx, INSERT_AUDITORIA, [
          randomUUID(),
          null,
          null,
          "m",
          "ok",
        ]),
        await intento(tx, "select id from auditoria_descifrado"),
        await intento(tx, "delete from auditoria_descifrado"),
        await intento(tx, "truncate auditoria_descifrado"),
      ];
    });
    expect(r.map((x) => (x.ok ? "ok" : x.code))).toEqual(
      Array(4).fill("42501"),
    );
  });

  it("sin tenant fijado el registro falla cerrado (no se inserta)", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      await como(tx, "contapp_worker");
      await enTenant(tx, "");
      return intento(tx, INSERT_AUDITORIA, [
        randomUUID(),
        null,
        null,
        "m",
        "ok",
      ]);
    });
    expect(r.ok).toBe(false);
    expect(["23502", "42501"]).toContain(r.ok ? "" : r.code);
  });
});

describe("CA-8 repositorio registrarDescifrado", () => {
  it.each(["ok", "no_encontrada", "integridad", "formato", "llave"])(
    "el worker registra el resultado %s",
    async (resultado) => {
      const r = await enRollback(
        db,
        { tenantId: tenantDe("A") },
        async (tx) => {
          await como(tx, "contapp_worker");
          return capturar(tx, () =>
            registrarDescifrado(tx, {
              credencialId: randomUUID(),
              clienteId: clientesDe("A")[0].id,
              tipo: "sol",
              motivo: "job:1",
              resultado,
            }),
          );
        },
      );
      expect(r.ok, r.ok ? "" : String((r as any).error?.message)).toBe(true);
    },
  );

  it("clienteId y tipo son opcionales", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      await como(tx, "contapp_worker");
      return capturar(tx, () =>
        registrarDescifrado(tx, {
          credencialId: randomUUID(),
          motivo: "manual",
          resultado: "no_encontrada",
        }),
      );
    });
    expect(r.ok).toBe(true);
  });

  it("con el rol contapp_backend falla con CredencialRepoError 42501", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      await como(tx, "contapp_backend");
      return capturar(tx, () =>
        registrarDescifrado(tx, {
          credencialId: randomUUID(),
          motivo: "m",
          resultado: "ok",
        }),
      );
    });
    expect(r.ok).toBe(false);
    const CredencialRepoError = exportado<new (...a: any[]) => Error>(
      "CredencialRepoError",
    );
    expect((r as any).error).toBeInstanceOf(CredencialRepoError);
    expect((r as any).error.codigo).toBe("42501");
  });
});

// ---------------------------------------------------------------------------------------------
// CA-9 (capa BD): CredencialRepoError no filtra detail ni valores
// ---------------------------------------------------------------------------------------------
describe("CredencialRepoError: solo el SQLSTATE, sin detail ni valores", () => {
  const CANARIO = "CANARIO-SECRETO-8842";
  const HEX_CANARIO = Buffer.from(CANARIO).toString("hex");

  function revisar(err: any) {
    const CredencialRepoError = exportado<new (...a: any[]) => Error>(
      "CredencialRepoError",
    );
    expect(err).toBeInstanceOf(CredencialRepoError);
    expect(err.codigo).toBe("23514");
    for (const prohibido of [
      "detail",
      "where",
      "constraint",
      "column",
      "table",
      "schema",
      "hint",
      "internalQuery",
      "routine",
    ]) {
      expect(err, `no debe exponer ${prohibido}`).not.toHaveProperty(prohibido);
    }
    expect(err.cause).toBeUndefined();
    const textos = [
      String(err.message),
      String(err.stack),
      JSON.stringify(err),
      inspect(err, { depth: 8, showHidden: true }),
      String(err),
    ].join("\n");
    expect(textos).not.toContain(CANARIO);
    expect(textos).not.toContain(HEX_CANARIO);
    expect(textos).not.toContain("Failing row");
    expect(textos).not.toContain("violates check constraint");
    expect(textos).not.toContain("DATABASE_URL");
  }

  it("guardarSobre con ciphertext fuera de rango (bytes con canario)", async () => {
    const relleno = Buffer.alloc(1101);
    for (let i = 0; i < relleno.length; i++)
      relleno[i] = CANARIO.charCodeAt(i % CANARIO.length);
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      return capturar(tx, () =>
        guardarSobre(tx, {
          clienteId: clientesDe("A")[0].id,
          tipo: "sol",
          sobre: sobreFalso({ ciphertext: relleno }),
        }),
      );
    });
    expect(r.ok).toBe(false);
    revisar((r as any).error);
  });

  it("registrarDescifrado con un motivo invalido que contiene el canario", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      await como(tx, "contapp_worker");
      return capturar(tx, () =>
        registrarDescifrado(tx, {
          credencialId: randomUUID(),
          motivo: `${CANARIO} con espacios`,
          resultado: "ok",
        }),
      );
    });
    expect(r.ok).toBe(false);
    revisar((r as any).error);
  });

  it("un error de permisos tambien se reduce al SQLSTATE", async () => {
    const r = await enRollback(db, { tenantId: tenantDe("A") }, async (tx) => {
      const { id } = await sembrar(
        tx,
        tenantDe("A"),
        clientesDe("A")[0].id,
        "sol",
      );
      return capturar(tx, () => leerSobre(tx, id));
    });
    expect(r.ok).toBe(false);
    const err = (r as any).error;
    expect(err.codigo).toBe("42501");
    expect(err).not.toHaveProperty("detail");
    expect(err.cause).toBeUndefined();
    expect(JSON.stringify(err)).not.toContain("ciphertext");
  });
});
