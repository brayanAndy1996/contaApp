import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type ContappDb, type RolApp } from "./client";
import { ContextoInvalidoError, WithTenantAnidadoError } from "./errores";

// Pruebas sin BD. Contrato (plan.md): withTenant/withUsuario validan el contexto ANTES de abrir la
// conexión, usan una transacción (BEGIN ... COMMIT/ROLLBACK), fijan el rol de la app con una lista
// cerrada y pasan los UUID como parámetros (nunca interpolados). Se intercepta Pool.prototype.connect
// con un cliente falso: ninguna prueba toca una BD real.

const URL_FALSA = "postgresql://contapp_app@localhost:1/contapp"; // sin contraseña; nunca se conecta
const TENANT_A = "0190a3b8-0000-7000-8000-00000000000a";
const TENANT_B = "0190a3b8-0000-7000-8000-00000000000b";
const USER_A = "0190a3b8-0000-7000-8000-0000000000a1";

interface Consulta {
  texto: string;
  valores: unknown[];
}

function crearClienteFalso() {
  const consultas: Consulta[] = [];
  const query = vi.fn(async (arg: unknown, valores?: unknown[]) => {
    const cfg =
      typeof arg === "string"
        ? { text: arg, values: undefined }
        : (arg as { text: string; values?: unknown[] });
    consultas.push({ texto: cfg.text, valores: cfg.values ?? valores ?? [] });
    return { rows: [], rowCount: 0, fields: [], command: "", oid: 0 };
  });
  const release = vi.fn();
  return { client: { query, release }, consultas, release };
}

let falso: ReturnType<typeof crearClienteFalso>;
let connect: ReturnType<typeof vi.fn>;
const abiertas: ContappDb[] = [];

function nuevaDb(rolApp: RolApp = "contapp_backend"): ContappDb {
  const db = createDb({ rolApp, url: URL_FALSA, poolMax: 1 });
  abiertas.push(db);
  return db;
}

beforeEach(() => {
  falso = crearClienteFalso();
  connect = vi
    .spyOn(Pool.prototype, "connect")
    .mockImplementation((async () => falso.client) as never) as never;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    abiertas.splice(0).map((d) => d.close().catch(() => undefined)),
  );
});

const valoresInvalidos: Array<[string, unknown]> = [
  ["cadena vacía", ""],
  ["null", null],
  ["undefined", undefined],
  ["solo espacios", "   "],
  ["texto no UUID", "no-es-un-uuid"],
  ["UUID truncado", "0190a3b8-0000-7000-8000"],
  ["número", 12345],
  ["inyección SQL", "'; DROP TABLE cliente; --"],
  ["inyección SQL dentro de un UUID", `${TENANT_A}'; DROP TABLE cliente; --`],
];

describe("withTenant: contexto inválido falla cerrado sin abrir conexión", () => {
  it.each(valoresInvalidos)(
    "tenantId %s lanza ContextoInvalidoError",
    async (_n, valor) => {
      const db = nuevaDb();
      const fn = vi.fn(async () => "no debe ejecutarse");
      await expect(
        db.withTenant({ tenantId: valor as string }, fn),
      ).rejects.toBeInstanceOf(ContextoInvalidoError);
      expect(connect).not.toHaveBeenCalled();
      expect(fn).not.toHaveBeenCalled();
    },
  );

  it.each(valoresInvalidos.filter(([, v]) => v !== undefined))(
    "userId %s lanza ContextoInvalidoError (tenantId válido)",
    async (_n, valor) => {
      const db = nuevaDb();
      const fn = vi.fn(async () => "no debe ejecutarse");
      await expect(
        db.withTenant({ tenantId: TENANT_A, userId: valor as string }, fn),
      ).rejects.toBeInstanceOf(ContextoInvalidoError);
      expect(connect).not.toHaveBeenCalled();
      expect(fn).not.toHaveBeenCalled();
    },
  );

  it("un contexto nulo o sin tenantId lanza ContextoInvalidoError", async () => {
    const db = nuevaDb();
    await expect(
      db.withTenant(null as never, async () => 1),
    ).rejects.toBeInstanceOf(ContextoInvalidoError);
    await expect(
      db.withTenant({} as never, async () => 1),
    ).rejects.toBeInstanceOf(ContextoInvalidoError);
    expect(connect).not.toHaveBeenCalled();
  });

  it.each(
    valoresInvalidos.filter(
      ([, v]) => typeof v === "string" && v.trim().length > 3,
    ),
  )(
    "el mensaje del error no contiene el valor recibido (%s)",
    async (_n, valor) => {
      const db = nuevaDb();
      const error = await db
        .withTenant({ tenantId: valor as string }, async () => 1)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ContextoInvalidoError);
      const { message } = error as Error;
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain((valor as string).trim());
      expect(message).not.toMatch(/DROP/i);
    },
  );
});

describe("withUsuario: contexto inválido falla cerrado sin abrir conexión", () => {
  it.each(valoresInvalidos)(
    "userId %s lanza ContextoInvalidoError",
    async (_n, valor) => {
      const db = nuevaDb();
      const fn = vi.fn(async () => "no debe ejecutarse");
      await expect(
        db.withUsuario({ userId: valor as string }, fn),
      ).rejects.toBeInstanceOf(ContextoInvalidoError);
      expect(connect).not.toHaveBeenCalled();
      expect(fn).not.toHaveBeenCalled();
    },
  );

  it("el mensaje no contiene el valor recibido", async () => {
    const db = nuevaDb();
    const inyeccion = "'; DROP TABLE membresia; --";
    const error = await db
      .withUsuario({ userId: inyeccion }, async () => 1)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContextoInvalidoError);
    expect((error as Error).message).not.toContain(inyeccion);
    expect((error as Error).message).not.toMatch(/DROP/i);
  });
});

describe("rolApp fuera de la lista cerrada", () => {
  const rolesInvalidos = [
    "postgres",
    "contapp_platform",
    "contapp_migrator",
    "contapp_app",
    "",
    "contapp_backend; DROP ROLE contapp_worker",
  ];

  it.each(rolesInvalidos)("rolApp %j lanza y no abre conexión", async (rol) => {
    // Control: con un rol válido el mismo flujo funciona (la falla se debe solo al rol).
    await nuevaDb("contapp_backend").withTenant(
      { tenantId: TENANT_A },
      async () => 1,
    );
    connect.mockClear();
    const intento = async () => {
      const db = nuevaDb(rol as RolApp);
      await db.withTenant({ tenantId: TENANT_A }, async () => 1);
    };
    await expect(intento()).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("withTenant: transacción con el rol y el contexto fijados", () => {
  it("devuelve el resultado de fn, hace commit y libera la conexión", async () => {
    const db = nuevaDb();
    const r = await db.withTenant({ tenantId: TENANT_A }, async () => "ok");
    expect(r).toBe("ok");
    expect(connect).toHaveBeenCalledTimes(1);
    const sql = falso.consultas.map((c) => c.texto.toLowerCase());
    expect(sql.some((s) => /\bbegin\b/.test(s))).toBe(true);
    expect(sql.some((s) => /\bcommit\b/.test(s))).toBe(true);
    expect(sql.some((s) => /\brollback\b/.test(s))).toBe(false);
    expect(falso.release).toHaveBeenCalledTimes(1);
  });

  it("fija el rol de la app indicado en createDb (backend)", async () => {
    await nuevaDb("contapp_backend").withTenant(
      { tenantId: TENANT_A },
      async () => 1,
    );
    const sql = falso.consultas.map((c) => c.texto).join("\n");
    expect(sql).toMatch(/set\s+(local\s+)?role/i);
    expect(sql).toContain("contapp_backend");
    expect(sql).not.toContain("contapp_worker");
  });

  it("fija el rol de la app indicado en createDb (worker)", async () => {
    await nuevaDb("contapp_worker").withTenant(
      { tenantId: TENANT_A },
      async () => 1,
    );
    const sql = falso.consultas.map((c) => c.texto).join("\n");
    expect(sql).toContain("contapp_worker");
    expect(sql).not.toContain("contapp_backend");
  });

  it("pasa tenantId y userId como parámetros de set_config, nunca interpolados", async () => {
    await nuevaDb().withTenant(
      { tenantId: TENANT_A, userId: USER_A },
      async () => 1,
    );
    const textos = falso.consultas.map((c) => c.texto).join("\n");
    const valores = falso.consultas.flatMap((c) => c.valores);
    expect(textos).toMatch(/set_config/i);
    expect(textos).toContain("app.tenant_id");
    expect(textos).toContain("app.user_id");
    expect(textos).not.toContain(TENANT_A);
    expect(textos).not.toContain(USER_A);
    expect(valores).toContain(TENANT_A);
    expect(valores).toContain(USER_A);
  });

  it("si fn lanza, hace rollback, propaga el mismo error y libera la conexión", async () => {
    const boom = new Error("boom de negocio");
    const db = nuevaDb();
    await expect(
      db.withTenant({ tenantId: TENANT_A }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    const sql = falso.consultas.map((c) => c.texto.toLowerCase());
    expect(sql.some((s) => /\brollback\b/.test(s))).toBe(true);
    expect(sql.some((s) => /\bcommit\b/.test(s))).toBe(false);
    expect(falso.release).toHaveBeenCalledTimes(1);
  });
});

describe("withUsuario: solo app.user_id", () => {
  it("fija app.user_id como parámetro y no fija app.tenant_id", async () => {
    await nuevaDb().withUsuario({ userId: USER_A }, async () => 1);
    const textos = falso.consultas.map((c) => c.texto).join("\n");
    const valores = falso.consultas.flatMap((c) => c.valores);
    expect(textos).toContain("app.user_id");
    expect(textos).not.toContain("app.tenant_id");
    expect(textos).not.toContain(USER_A);
    expect(valores).toContain(USER_A);
    expect(textos).toContain("contapp_backend");
  });
});

describe("anidamiento", () => {
  it("withTenant dentro de withTenant lanza WithTenantAnidadoError", async () => {
    const db = nuevaDb();
    const error = await db
      .withTenant({ tenantId: TENANT_A }, async () =>
        db.withTenant({ tenantId: TENANT_A }, async () => 1),
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WithTenantAnidadoError);
  });

  it("anidar con otro tenant (cambio de tenant a mitad) también lanza", async () => {
    const db = nuevaDb();
    await expect(
      db.withTenant({ tenantId: TENANT_A }, async () =>
        db.withTenant({ tenantId: TENANT_B }, async () => 1),
      ),
    ).rejects.toBeInstanceOf(WithTenantAnidadoError);
  });

  it("withUsuario dentro de withTenant, y withTenant dentro de withUsuario, lanzan", async () => {
    const db = nuevaDb();
    await expect(
      db.withTenant({ tenantId: TENANT_A }, async () =>
        db.withUsuario({ userId: USER_A }, async () => 1),
      ),
    ).rejects.toBeInstanceOf(WithTenantAnidadoError);
    await expect(
      db.withUsuario({ userId: USER_A }, async () =>
        db.withTenant({ tenantId: TENANT_A }, async () => 1),
      ),
    ).rejects.toBeInstanceOf(WithTenantAnidadoError);
  });

  it("el anidamiento entre instancias distintas de createDb también se detecta", async () => {
    const a = nuevaDb("contapp_backend");
    const b = nuevaDb("contapp_worker");
    await expect(
      a.withTenant({ tenantId: TENANT_A }, async () =>
        b.withTenant({ tenantId: TENANT_A }, async () => 1),
      ),
    ).rejects.toBeInstanceOf(WithTenantAnidadoError);
  });

  it("llamadas secuenciales no cuentan como anidadas (el estado no queda pegado)", async () => {
    const db = nuevaDb();
    await expect(
      db.withTenant({ tenantId: TENANT_A }, async () => 1),
    ).resolves.toBe(1);
    await expect(
      db.withTenant({ tenantId: TENANT_A }, async () => 2),
    ).resolves.toBe(2);
    await expect(
      db
        .withTenant({ tenantId: TENANT_A }, async () => {
          throw new Error("x");
        })
        .catch(() => "fallo"),
    ).resolves.toBe("fallo");
    await expect(
      db.withTenant({ tenantId: TENANT_A }, async () => 3),
    ).resolves.toBe(3);
  });

  it("llamadas concurrentes (no anidadas) no lanzan WithTenantAnidadoError", async () => {
    const db = nuevaDb();
    const r = await Promise.all([
      db.withTenant({ tenantId: TENANT_A }, async () => "A"),
      db.withTenant({ tenantId: TENANT_B }, async () => "B"),
    ]);
    expect(r).toEqual(["A", "B"]);
  });
});
