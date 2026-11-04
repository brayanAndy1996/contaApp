import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// Spec 007a, D8 y CA-8: la regla `sql-crudo/sin-sql-crudo` también rechaza fuera de packages/db el
// `import * as d from "drizzle-orm"` con `d.sql` (el hueco de espacio de nombres), sin romper el uso
// permitido dentro de packages/db ni los imports con nombre que no traen `sql`.
const RAIZ = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const BACKEND = "apps/backend/src/modules/clientes/__prueba__.ts";
const WORKER = "apps/worker/src/__prueba__.ts";
const DB = "packages/db/src/clientes/__prueba__.ts";

let eslint: ESLint;
beforeAll(() => {
  eslint = new ESLint({ cwd: RAIZ });
});

async function reglaSql(codigo: string, filePath: string) {
  const [r] = await eslint.lintText(codigo, {
    filePath: path.join(RAIZ, filePath),
  });
  return r.messages.filter((m) => m.ruleId === "sql-crudo/sin-sql-crudo");
}

const CON_SQL: Array<[string, string]> = [
  [
    "d.sql como llamada",
    `import * as d from "drizzle-orm";\nexport const q = d.sql("select 1");`,
  ],
  [
    "d.sql como plantilla",
    `import * as d from "drizzle-orm";\nexport const q = d.sql\`select 1\`;`,
  ],
  [
    "d.sql.raw",
    `import * as d from "drizzle-orm";\nexport const q = d.sql.raw("select 1");`,
  ],
  [
    "otro nombre del espacio",
    `import * as orm from "drizzle-orm";\nexport const q = orm.sql\`select 1\`;`,
  ],
  [
    "sql por indexación literal",
    `import * as d from "drizzle-orm";\nexport const q = d["sql"]\`select 1\`;`,
  ],
];

describe("CA-8: import * de drizzle-orm con sql fuera de packages/db", () => {
  it.each(CON_SQL)("apps/backend lo rechaza: %s", async (_n, codigo) => {
    expect((await reglaSql(codigo, BACKEND)).length).toBeGreaterThan(0);
  });

  it("apps/worker también lo rechaza", async () => {
    const [, codigo] = CON_SQL[1]!;
    expect((await reglaSql(codigo, WORKER)).length).toBeGreaterThan(0);
  });

  it("el veto de `import { sql }` sigue vigente", async () => {
    const codigo = `import { sql } from "drizzle-orm";\nexport const q = sql\`select 1\`;`;
    expect((await reglaSql(codigo, BACKEND)).length).toBeGreaterThan(0);
  });

  it("`.raw` y `set_config` siguen prohibidos", async () => {
    const codigo = `declare const x: { raw(t: string): unknown };\nx.raw("select set_config('a','b',true)");`;
    expect((await reglaSql(codigo, BACKEND)).length).toBeGreaterThan(0);
  });
});

describe("CA-8: lo permitido no se rompe", () => {
  it("packages/db puede usar import * as d con d.sql", async () => {
    for (const [, codigo] of CON_SQL) {
      expect(await reglaSql(codigo, DB)).toEqual([]);
    }
  });

  it("packages/db puede seguir usando `import { sql }`", async () => {
    const codigo = `import { sql } from "drizzle-orm";\nexport const q = sql\`select 1\`;`;
    expect(await reglaSql(codigo, DB)).toEqual([]);
  });

  it("apps/backend puede importar operadores con nombre sin sql", async () => {
    const codigo = `import { eq } from "drizzle-orm";\nexport const e = eq;`;
    expect(await reglaSql(codigo, BACKEND)).toEqual([]);
  });

  it("un espacio de nombres de otro módulo con una propiedad `sql` no se confunde", async () => {
    const codigo = `import * as d from "node:path";\nexport const q = (d as unknown as { sql: string }).sql;`;
    expect(await reglaSql(codigo, BACKEND)).toEqual([]);
  });
});
