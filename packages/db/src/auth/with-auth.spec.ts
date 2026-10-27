// Spec 004 (T5, rojo): withAuth sin BD (cliente falso de pg, como with-tenant.spec.ts).
// Contrato (T9): `ContappDb.withAuth(fn)` abre UNA transacción con SET LOCAL ROLE contapp_backend y
// app.tenant_id / app.user_id vacíos (parámetros, nunca interpolados), entrega un AuthRepo a `fn`, hace
// COMMIT/ROLLBACK y libera la conexión; solo para rolApp = contapp_backend; no se puede anidar con
// withTenant/withUsuario/withAuth (mismo WithTenantAnidadoError). withTenant y withUsuario no cambian.
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type ContappDb, type RolApp } from "../client";
import { WithTenantAnidadoError } from "../errores";

const URL_FALSA = "postgresql://contapp_app@localhost:1/contapp"; // sin contraseña; nunca se conecta
const TENANT = "0190a3b8-0000-7000-8000-00000000000a";
const USER = "0190a3b8-0000-7000-8000-0000000000a1";

type ConAuth = ContappDb & {
  withAuth<T>(fn: (a: Record<string, (...x: unknown[]) => Promise<unknown>>) => Promise<T>): Promise<T>;
};

interface Consulta {
  texto: string;
  valores: unknown[];
}

let consultas: Consulta[];
let release: ReturnType<typeof vi.fn>;
let connect: ReturnType<typeof vi.fn>;
const abiertas: ContappDb[] = [];

beforeEach(() => {
  consultas = [];
  release = vi.fn();
  const query = vi.fn(async (arg: unknown, valores?: unknown[]) => {
    const texto = typeof arg === "string" ? arg : (arg as { text: string }).text;
    consultas.push({ texto, valores: (valores ?? (arg as { values?: unknown[] }).values ?? []) as unknown[] });
    const fila = texto.includes("auth.limite_consumir") ? [{ limite_consumir: true }] : [];
    return { rows: fila, rowCount: fila.length, fields: [], command: "", oid: 0 };
  });
  connect = vi
    .spyOn(Pool.prototype, "connect")
    .mockImplementation((async () => ({ query, release })) as never) as never;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(abiertas.splice(0).map((d) => d.close().catch(() => undefined)));
});

function nuevaDb(rolApp: RolApp = "contapp_backend"): ConAuth {
  const db = createDb({ rolApp, url: URL_FALSA, poolMax: 1 });
  abiertas.push(db);
  if (typeof (db as Partial<ConAuth>).withAuth !== "function") {
    throw new Error("ContappDb aún no expone withAuth (implementación pendiente, T9)");
  }
  return db as ConAuth;
}

const sqls = () => consultas.map((c) => c.texto);

describe("withAuth: transacción como contapp_backend con contexto vacío", () => {
  it("BEGIN, SET LOCAL ROLE contapp_backend, GUC vacíos como parámetros, COMMIT y release", async () => {
    const db = nuevaDb();
    const r = await db.withAuth(async () => "listo");
    expect(r).toBe("listo");
    const texto = sqls().join("\n");
    expect(sqls().some((s) => /\bbegin\b/i.test(s))).toBe(true);
    expect(texto).toMatch(/set\s+local\s+role\s+contapp_backend/i);
    expect(texto).not.toContain("contapp_worker");
    expect(sqls().some((s) => /\bcommit\b/i.test(s))).toBe(true);
    expect(sqls().some((s) => /\brollback\b/i.test(s))).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);

    const ajuste = consultas.find((c) => c.texto.includes("app.tenant_id") || c.texto.includes("app.user_id"));
    expect(ajuste, "debe fijar app.tenant_id y app.user_id").toBeDefined();
    expect(ajuste!.texto).toContain("app.tenant_id");
    expect(ajuste!.texto).toContain("app.user_id");
    expect(ajuste!.texto).toMatch(/set_config/i);
    expect(ajuste!.valores.length).toBeGreaterThan(0);
    for (const v of ajuste!.valores) expect(v).toBe("");
  });

  it("el orden es BEGIN, luego el rol, luego fn, luego COMMIT", async () => {
    const db = nuevaDb();
    await db.withAuth(async (a) => a.limiteConsumir!("login_ip", "s"));
    const iBegin = sqls().findIndex((s) => /^\s*begin\b/i.test(s));
    const iRol = sqls().findIndex((s) => /set\s+local\s+role\s+contapp_backend/i.test(s));
    const iFn = sqls().findIndex((s) => s.includes("auth.limite_consumir"));
    const iCommit = sqls().findIndex((s) => /^\s*commit\b/i.test(s));
    expect(iBegin).toBeGreaterThan(-1);
    expect(iBegin).toBeLessThan(iRol);
    expect(iRol).toBeLessThan(iFn);
    expect(iFn).toBeLessThan(iCommit);
  });

  it("entrega un AuthRepo cuyos métodos ejecutan dentro de la transacción", async () => {
    const db = nuevaDb();
    const r = await db.withAuth(async (a) => a.limiteConsumir!("login_ip", "203.0.113.7"));
    expect(r).toBe(true);
    const llamada = consultas.find((c) => c.texto.includes("auth.limite_consumir"));
    expect(llamada?.valores).toEqual(["login_ip", "203.0.113.7"]);
  });

  it("si fn lanza: ROLLBACK, propaga el mismo error y libera la conexión", async () => {
    const db = nuevaDb();
    const boom = new Error("boom de negocio");
    await expect(
      db.withAuth(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(sqls().some((s) => /\brollback\b/i.test(s))).toBe(true);
    expect(sqls().some((s) => /\bcommit\b/i.test(s))).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("withAuth: solo para contapp_backend", () => {
  it("con una BD de rol contapp_worker rechaza sin abrir conexión ni ejecutar fn", async () => {
    const db = nuevaDb("contapp_worker");
    const fn = vi.fn(async () => "no debe ejecutarse");
    await expect(db.withAuth(fn)).rejects.toBeInstanceOf(Error);
    expect(fn).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("withAuth: no se anida (nota [004/008])", () => {
  it("withAuth dentro de withAuth lanza WithTenantAnidadoError", async () => {
    const db = nuevaDb();
    await expect(db.withAuth(async () => db.withAuth(async () => 1))).rejects.toBeInstanceOf(WithTenantAnidadoError);
  });

  it("withTenant dentro de withAuth lanza", async () => {
    const db = nuevaDb();
    await expect(db.withAuth(async () => db.withTenant({ tenantId: TENANT }, async () => 1))).rejects.toBeInstanceOf(
      WithTenantAnidadoError,
    );
  });

  it("withUsuario dentro de withAuth lanza", async () => {
    const db = nuevaDb();
    await expect(db.withAuth(async () => db.withUsuario({ userId: USER }, async () => 1))).rejects.toBeInstanceOf(
      WithTenantAnidadoError,
    );
  });

  it("withAuth dentro de withTenant y dentro de withUsuario lanza", async () => {
    const db = nuevaDb();
    await expect(db.withTenant({ tenantId: TENANT }, async () => db.withAuth(async () => 1))).rejects.toBeInstanceOf(
      WithTenantAnidadoError,
    );
    await expect(db.withUsuario({ userId: USER }, async () => db.withAuth(async () => 1))).rejects.toBeInstanceOf(
      WithTenantAnidadoError,
    );
  });

  it("entre instancias distintas de createDb también se detecta", async () => {
    const a = nuevaDb();
    const b = nuevaDb();
    await expect(a.withAuth(async () => b.withAuth(async () => 1))).rejects.toBeInstanceOf(WithTenantAnidadoError);
  });

  it("llamadas secuenciales no cuentan como anidadas (el estado no queda pegado, ni tras un error)", async () => {
    const db = nuevaDb();
    await expect(db.withAuth(async () => 1)).resolves.toBe(1);
    await expect(db.withAuth(async () => Promise.reject(new Error("x"))).catch(() => "fallo")).resolves.toBe("fallo");
    await expect(db.withAuth(async () => 2)).resolves.toBe(2);
    await expect(db.withTenant({ tenantId: TENANT }, async () => 3)).resolves.toBe(3);
  });
});
