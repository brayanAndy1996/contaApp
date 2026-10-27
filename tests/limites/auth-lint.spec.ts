import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// Cobertura adicional de CA-11 (spec 004, tarea agregada al plan): vías estáticas que
// tests/limites/auth.spec.ts no cubre (concatenación de literales, condicional, TS wrappers)
// y la regla en apps/worker y en apps/frontend.
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BACKEND = "apps/backend/src/modules/auth/__prueba__.ts";
const WORKER = "apps/worker/src/__prueba__.ts";
const FRONTEND = "apps/frontend/app/__prueba__.ts";

let eslint: ESLint;
beforeAll(() => {
  eslint = new ESLint({ cwd: RAIZ });
});

async function sqlAuth(codigo: string, filePath: string) {
  const [r] = await eslint.lintText(codigo, { filePath: path.join(RAIZ, filePath) });
  return r.messages.filter((m) => m.ruleId === "sql-crudo/sin-sql-crudo" && /auth/i.test(m.message));
}

const DECL = "declare const db: { query(t: string): unknown };\n";

describe("CA-11: SQL sobre auth.* por vías estáticas adicionales", () => {
  it.each<[string, string, string]>([
    ["concatenación de literales", `${DECL}db.query("select " + "auth.sesion_validar($1)");`, BACKEND],
    ["condicional", `${DECL}declare const x: boolean;\ndb.query(x ? "select 1" : "select auth.sesion_revocar($1)");`, BACKEND],
    ["as const", `${DECL}db.query("select auth.sesion_validar($1)" as string);`, BACKEND],
    ["en apps/worker", `${DECL}db.query("select auth.sesion_validar($1)");`, WORKER],
    ["en apps/frontend", `${DECL}db.query("select auth.sesion_validar($1)");`, FRONTEND],
  ])("se reporta: %s", async (_n, codigo, archivo) => {
    expect((await sqlAuth(codigo, archivo)).length).toBeGreaterThan(0);
  });

  it("el parámetro (segundo argumento) con la palabra auth no se confunde con el esquema", async () => {
    const codigo = `${DECL.replace("t: string", "t: string, p?: unknown[]")}db.query("select $1", ["auth.x"]);`;
    expect(await sqlAuth(codigo, BACKEND)).toEqual([]);
  });
});
