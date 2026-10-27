import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// CA-11 (spec 004): el lint de SQL crudo y de límites impide que el backend llame a las
// funciones del esquema `auth` con SQL propio (todo pasa por AuthRepo de packages/db) y que el
// frontend importe `@node-rs/argon2` o `@contapp/db`. Se prueba con ESLint#lintText sobre rutas
// ficticias, como tests/limites/limites.spec.ts.
// Contrato para la regla (T10/T11, eslint.config.mjs):
//  - en `apps/**` (modo "fuera" de `sql-crudo/sin-sql-crudo`): una llamada `.query(` / `.execute(`
//    cuyo texto estático (literal, plantilla sin interpolación, propiedad `text`, constante)
//    nombra el esquema `auth` (`auth.<algo>` o `"auth"."<algo>"`, sin distinguir mayúsculas)
//    se reporta con ruleId `sql-crudo/sin-sql-crudo` y un mensaje que menciona `auth`;
//  - `packages/db` (modo "dentro") sigue pudiendo hacerlo (es AuthRepo);
//  - el frontend: `@node-rs/argon2` y `@contapp/db` (import estático, dinámico, require,
//    export … from, subruta) se reportan con ruleId `no-restricted-imports` o
//    `limites/imports-relativos` y un mensaje que menciona `apps/frontend` o `argon2`.

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const BACKEND = "apps/backend/src/modules/auth/__prueba__.ts";
const WORKER = "apps/worker/src/__prueba__.ts";
const DB = "packages/db/src/auth/__prueba__.ts";
const FRONTEND = "apps/frontend/app/__prueba__.ts";

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: RAIZ });
});

async function mensajes(codigo: string, filePath: string) {
  const [resultado] = await eslint.lintText(codigo, { filePath: path.join(RAIZ, filePath) });
  return resultado.messages;
}

async function violacionesSqlAuth(codigo: string, filePath: string) {
  return (await mensajes(codigo, filePath)).filter(
    (m) => m.ruleId === "sql-crudo/sin-sql-crudo" && /auth/i.test(m.message),
  );
}

async function violacionesFrontend(codigo: string) {
  return (await mensajes(codigo, FRONTEND)).filter(
    (m) =>
      (m.ruleId === "no-restricted-imports" || m.ruleId === "limites/imports-relativos") &&
      /apps\/frontend|argon2/i.test(m.message),
  );
}

const SQL_AUTH_EN_BACKEND: Array<[string, string]> = [
  [
    "literal con una función de auth",
    `declare const db: { query(t: string, p?: unknown[]): unknown };
db.query("select auth.login_preparar($1, $2)", ["a", "b"]);`,
  ],
  [
    "literal que lee una tabla de auth",
    `declare const db: { query(t: string): unknown };
db.query("SELECT * FROM auth.sesion");`,
  ],
  [
    "mayúsculas mixtas",
    `declare const db: { query(t: string): unknown };
db.query("SeLeCt AUTH.Sesion_Validar($1)");`,
  ],
  [
    "identificadores entre comillas",
    `declare const db: { query(t: string): unknown };
db.query('select * from "auth"."sesion"');`,
  ],
  [
    "plantilla sin interpolación",
    `declare const db: { query(t: string): unknown };
db.query(\`select auth.sesion_validar($1)\`);`,
  ],
  [
    "objeto con la propiedad text",
    `declare const db: { query(t: { text: string; values: unknown[] }): unknown };
db.query({ text: "select auth.sesion_validar($1)", values: ["x"] });`,
  ],
  [
    "constante referenciada",
    `declare const db: { query(t: string): unknown };
const consulta = "select auth.sesion_revocar($1)";
db.query(consulta);`,
  ],
  [
    "execute en lugar de query",
    `declare const db: { execute(t: string): unknown };
db.execute("select auth.sesiones_cerrar_todas($1)");`,
  ],
  [
    "con espacios entre el esquema y el punto",
    `declare const db: { query(t: string): unknown };
db.query("select auth .login_exito($1)");`,
  ],
];

describe("CA-11: apps/backend no llama al esquema auth con SQL propio", () => {
  it.each(SQL_AUTH_EN_BACKEND)("falla con un mensaje sobre auth: %s", async (_n, codigo) => {
    const violaciones = await violacionesSqlAuth(codigo, BACKEND);
    expect(violaciones.length).toBeGreaterThan(0);
  });

  it("no se confunde con otros nombres que solo empiezan por 'auth'", async () => {
    const codigo = `declare const db: { query(t: string): unknown };
db.query("select nombre from authors");
db.query("select author.nombre from author");`;
    expect(await violacionesSqlAuth(codigo, BACKEND)).toEqual([]);
  });

  it("una consulta estática sin auth sigue permitida", async () => {
    const codigo = `declare const db: { query(t: string): unknown };
db.query("select 1");`;
    expect((await mensajes(codigo, BACKEND)).filter((m) => m.ruleId === "sql-crudo/sin-sql-crudo")).toEqual([]);
  });

  it("las reglas previas de SQL crudo siguen vigentes (interpolación)", async () => {
    const codigo = `declare const db: { query(t: string): unknown };
declare const nombre: string;
db.query(\`select * from t where n = '\${nombre}'\`);`;
    const m = (await mensajes(codigo, BACKEND)).filter((x) => x.ruleId === "sql-crudo/sin-sql-crudo");
    expect(m.length).toBeGreaterThan(0);
  });

  it("el backend puede importar @contapp/db y @node-rs/argon2 (AuthRepo y Hasher)", async () => {
    const codigo = `import "@contapp/db";\nimport "@node-rs/argon2";`;
    const m = (await mensajes(codigo, BACKEND)).filter(
      (x) => x.ruleId === "no-restricted-imports" || x.ruleId === "limites/imports-relativos",
    );
    expect(m).toEqual([]);
  });
});

describe("CA-11: packages/db (AuthRepo) sí puede usar el esquema auth", () => {
  it("db.query estático con auth.* no se reporta", async () => {
    const codigo = `declare const tx: { query(t: string, p?: unknown[]): unknown };
tx.query("select * from auth.login_preparar($1, $2)", ["a", "b"]);`;
    const m = (await mensajes(codigo, DB)).filter((x) => x.ruleId === "sql-crudo/sin-sql-crudo");
    expect(m).toEqual([]);
  });
});

describe("CA-11: apps/frontend no importa argon2 ni la BD", () => {
  const CASOS: Array<[string, string]> = [
    ["import estático de @node-rs/argon2", `import "@node-rs/argon2";`],
    ["import con nombres de @node-rs/argon2", `import { hash } from "@node-rs/argon2";`],
    ["import dinámico de @node-rs/argon2", `void import("@node-rs/argon2");`],
    ["export … from @node-rs/argon2", `export * from "@node-rs/argon2";`],
    ["require de @node-rs/argon2", `require("@node-rs/argon2");`],
    ["subruta de @node-rs/argon2", `import "@node-rs/argon2/browser";`],
    ["import estático de @contapp/db", `import "@contapp/db";`],
    ["import dinámico de @contapp/db", `void import("@contapp/db");`],
    ["require de @contapp/db", `require("@contapp/db");`],
    ["ruta relativa a packages/db", `import "../../../packages/db/src/index";`],
  ];

  it.each(CASOS)("falla: %s", async (_n, codigo) => {
    expect((await violacionesFrontend(codigo)).length).toBeGreaterThan(0);
  });

  it("@contapp/shared sigue permitido", async () => {
    expect(await violacionesFrontend(`import "@contapp/shared";`)).toEqual([]);
  });

  it("el mismo import de @node-rs/argon2 en apps/worker no lo bloquea la regla del frontend", async () => {
    const m = (await mensajes(`import "@node-rs/argon2";`, WORKER)).filter((x) =>
      /apps\/frontend/i.test(x.message),
    );
    expect(m).toEqual([]);
  });
});
