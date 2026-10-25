import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type ContappDb, type RolApp, type Tx } from "./client";
import { ContextoInvalidoError, WithTenantAnidadoError } from "./errores";
import { ajusteTenant, ejecutarEnContexto, esRolApp } from "./with-tenant";

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

// --- T12d: ramas de ejecutarEnContexto, conexiones sucias y tx.orm -----------------------------
// Cliente falso configurable: cada fallo hace rechazar la n-ésima consulta que contiene `texto`.
const LIMPIAR =
  "CLOSE ALL; RESET ROLE; RESET ALL; UNLISTEN *; DEALLOCATE ALL; SELECT pg_advisory_unlock_all()";

interface OpcionesFalso {
  /** Si se da, el cliente expone getTransactionStatus devolviendo estos valores en orden (el último se repite). */
  estados?: string[];
  conexion?: unknown;
  fallos?: Array<{ texto: string; nesima?: number; con: unknown }>;
}

function clienteConfigurable(o: OpcionesFalso = {}) {
  const textos: string[] = [];
  const veces = new Map<string, number>();
  const release = vi.fn();
  let llamadasEstado = 0;
  const query = vi.fn(async (arg: unknown) => {
    const texto =
      typeof arg === "string" ? arg : (arg as { text: string }).text;
    textos.push(texto);
    for (const f of o.fallos ?? []) {
      if (!texto.includes(f.texto)) continue;
      const n = (veces.get(f.texto) ?? 0) + 1;
      veces.set(f.texto, n);
      if (n === (f.nesima ?? 1)) throw f.con;
    }
    return { rows: [], rowCount: 0, fields: [], command: "", oid: 0 };
  });
  const client: Record<string, unknown> = { release, query };
  if (o.estados) {
    const estados = o.estados;
    client.getTransactionStatus = () =>
      estados[Math.min(llamadasEstado++, estados.length - 1)];
  }
  if (o.conexion !== undefined) client.connection = o.conexion;
  return { client, textos, release, query };
}

function usarClientes(...clientes: Array<Record<string, unknown>>) {
  let i = 0;
  vi.spyOn(Pool.prototype, "connect").mockImplementation(
    (async () => clientes[Math.min(i++, clientes.length - 1)]) as never,
  );
  return () => i;
}

describe("ejecutarEnContexto: fallos al cerrar la transacción destruyen la conexión", () => {
  it("si ROLLBACK falla, propaga el error de fn, no limpia y libera con el error del ROLLBACK", async () => {
    const errRollback = new Error("rollback roto");
    const f = clienteConfigurable({
      fallos: [{ texto: "ROLLBACK", con: errRollback }],
    });
    usarClientes(f.client);
    const boom = new Error("boom de negocio");
    await expect(
      nuevaDb().withTenant({ tenantId: TENANT_A }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(f.textos.at(-1)).toBe("ROLLBACK");
    expect(f.textos.filter((t) => t === LIMPIAR)).toHaveLength(1); // solo la de antes de BEGIN
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledWith(errRollback);
  });

  it("si ROLLBACK rechaza con un valor que no es Error, se libera con un Error genérico", async () => {
    const f = clienteConfigurable({
      fallos: [{ texto: "ROLLBACK", con: "texto suelto" }],
    });
    usarClientes(f.client);
    await expect(
      nuevaDb().withTenant({ tenantId: TENANT_A }, async () => {
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
    const arg = f.release.mock.calls[0]?.[0];
    expect(arg).toBeInstanceOf(Error);
    expect((arg as Error).message).toBe("rollback fallido");
  });

  it("si la limpieza final falla, devuelve el resultado y libera con ese error", async () => {
    const errLimpieza = new Error("limpieza rota");
    const f = clienteConfigurable({
      fallos: [{ texto: "CLOSE ALL", nesima: 2, con: errLimpieza }],
    });
    usarClientes(f.client);
    await expect(
      nuevaDb().withTenant({ tenantId: TENANT_A }, async () => "ok"),
    ).resolves.toBe("ok");
    expect(f.textos).toContain("COMMIT");
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledWith(errLimpieza);
  });

  it("si la limpieza final rechaza con un valor que no es Error, se libera con un Error genérico", async () => {
    const f = clienteConfigurable({
      fallos: [{ texto: "CLOSE ALL", nesima: 2, con: 42 }],
    });
    usarClientes(f.client);
    await nuevaDb().withTenant({ tenantId: TENANT_A }, async () => 1);
    const arg = f.release.mock.calls[0]?.[0];
    expect(arg).toBeInstanceOf(Error);
    expect((arg as Error).message).toBe("limpieza de sesión fallida");
  });

  it("si falla la limpieza inicial, propaga ese error sin ejecutar fn ni BEGIN y libera la conexión", async () => {
    const f = clienteConfigurable({
      fallos: [{ texto: "CLOSE ALL", nesima: 1, con: new Error("sucia") }],
    });
    usarClientes(f.client);
    const fn = vi.fn(async () => 1);
    await expect(
      nuevaDb().withTenant({ tenantId: TENANT_A }, fn),
    ).rejects.toThrow("sucia");
    expect(fn).not.toHaveBeenCalled();
    expect(f.textos).not.toContain("BEGIN");
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it.each(["T", "E"])(
    "si tras limpiar la conexión sigue en transacción (%s), se destruye en lugar de devolverla",
    async (estado) => {
      const f = clienteConfigurable({ estados: ["I", estado] });
      usarClientes(f.client);
      await expect(
        nuevaDb().withTenant({ tenantId: TENANT_A }, async () => "ok"),
      ).resolves.toBe("ok");
      const arg = f.release.mock.calls[0]?.[0];
      expect(arg).toBeInstanceOf(Error);
      expect((arg as Error).message).toMatch(/transacción abierta/);
    },
  );

  it("con una conexión limpia, release se llama sin error", async () => {
    const f = clienteConfigurable({ estados: ["I"] });
    usarClientes(f.client);
    await nuevaDb().withTenant({ tenantId: TENANT_A }, async () => 1);
    expect(f.release).toHaveBeenCalledWith(undefined);
  });

  it("withUsuario también destruye la conexión si ROLLBACK falla", async () => {
    const f = clienteConfigurable({
      fallos: [{ texto: "ROLLBACK", con: new Error("r") }],
    });
    usarClientes(f.client);
    await expect(
      nuevaDb().withUsuario({ userId: USER_A }, async () => {
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
    expect(f.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});

describe("ejecutarEnContexto: introspección de la conexión de pg", () => {
  it("un cliente sin getTransactionStatus se trata como sin transacción abierta", async () => {
    const f = clienteConfigurable();
    expect(f.client.getTransactionStatus).toBeUndefined();
    usarClientes(f.client);
    await expect(
      nuevaDb().withTenant({ tenantId: TENANT_A }, async () => 1),
    ).resolves.toBe(1);
    expect(f.release).toHaveBeenCalledWith(undefined);
  });

  it("un cliente con `connection` sin parsedStatements funciona y no se altera", async () => {
    const conexion: Record<string, unknown> = {};
    const f = clienteConfigurable({ conexion });
    usarClientes(f.client);
    await nuevaDb().withTenant({ tenantId: TENANT_A }, async () => 1);
    expect(conexion).toEqual({});
    expect(f.release).toHaveBeenCalledWith(undefined);
  });

  it("vacía la caché de sentencias preparadas de pg tras cada limpieza (H11)", async () => {
    const conexion = {
      parsedStatements: { s1: "select 1" } as Record<string, string>,
    };
    const f = clienteConfigurable({ conexion });
    usarClientes(f.client);
    await nuevaDb().withTenant({ tenantId: TENANT_A }, async (tx) => {
      conexion.parsedStatements = { s2: "select 2" }; // lo que pg cachearía dentro de fn
      await tx.query("select 1");
    });
    expect(conexion.parsedStatements).toEqual({});
  });
});

describe("conexiones del pool con una transacción abierta (H12)", () => {
  it("si las 10 conexiones llegan con transacción abierta, falla sin ejecutar nada en ellas", async () => {
    const sucias = Array.from({ length: 10 }, (_, i) =>
      clienteConfigurable({ estados: [i % 2 === 0 ? "T" : "E"] }),
    );
    const llamadas = usarClientes(...sucias.map((s) => s.client));
    const fn = vi.fn(async () => "no debe ejecutarse");
    await expect(
      nuevaDb().withTenant({ tenantId: TENANT_A }, fn),
    ).rejects.toThrow(/sin transacción abierta/);
    expect(llamadas()).toBe(10);
    expect(fn).not.toHaveBeenCalled();
    for (const s of sucias) {
      expect(s.query).not.toHaveBeenCalled();
      expect(s.release).toHaveBeenCalledTimes(1);
      expect(s.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    }
  });

  it("descarta las conexiones sucias y usa la primera limpia, sin tocar las sucias", async () => {
    const sucia1 = clienteConfigurable({ estados: ["T"] });
    const sucia2 = clienteConfigurable({ estados: ["E"] });
    const limpia = clienteConfigurable({ estados: ["I"] });
    usarClientes(sucia1.client, sucia2.client, limpia.client);
    await expect(
      nuevaDb().withTenant({ tenantId: TENANT_A }, async () => "ok"),
    ).resolves.toBe("ok");
    for (const s of [sucia1, sucia2]) {
      expect(s.query).not.toHaveBeenCalled();
      expect(s.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    }
    expect(limpia.textos).toContain("COMMIT");
    expect(limpia.release).toHaveBeenCalledWith(undefined);
  });

  it("withUsuario aplica la misma protección", async () => {
    const sucia = clienteConfigurable({ estados: ["T"] });
    const limpia = clienteConfigurable({ estados: ["I"] });
    usarClientes(sucia.client, limpia.client);
    await nuevaDb().withUsuario({ userId: USER_A }, async () => 1);
    expect(sucia.query).not.toHaveBeenCalled();
    expect(limpia.textos).toContain("COMMIT");
  });
});

describe("tx: query y orm", () => {
  it("tx.query reenvía texto y valores a la conexión", async () => {
    const f = clienteConfigurable();
    usarClientes(f.client);
    await nuevaDb().withTenant({ tenantId: TENANT_A }, async (tx) => {
      await tx.query("select $1::int", [7]);
    });
    expect(f.query).toHaveBeenCalledWith("select $1::int", [7]);
  });

  it("tx.query rechaza tras cerrar la transacción y no toca la conexión", async () => {
    const f = clienteConfigurable();
    usarClientes(f.client);
    let guardada: Tx | undefined;
    await nuevaDb().withTenant({ tenantId: TENANT_A }, async (tx) => {
      guardada = tx;
    });
    const antes = f.textos.length;
    await expect(guardada!.query("select 1")).rejects.toThrow(
      "La transacción de withTenant ya terminó",
    );
    expect(f.textos).toHaveLength(antes);
  });

  it("tx.orm ejecuta dentro de la transacción y es la misma instancia en cada acceso", async () => {
    const f = clienteConfigurable();
    usarClientes(f.client);
    await nuevaDb().withTenant({ tenantId: TENANT_A }, async (tx) => {
      expect(tx.orm).toBe(tx.orm);
      await tx.orm.execute(sql`select 1 as uno`);
    });
    const iOrm = f.textos.findIndex((t) => t.includes("select 1 as uno"));
    expect(iOrm).toBeGreaterThan(-1);
    expect(f.textos.indexOf("BEGIN")).toBeLessThan(iOrm);
    expect(iOrm).toBeLessThan(f.textos.indexOf("COMMIT"));
  });

  it("tx.orm rechaza tras cerrar la transacción y no envía nada a la conexión", async () => {
    const f = clienteConfigurable();
    usarClientes(f.client);
    let guardada: Tx | undefined;
    await nuevaDb().withTenant({ tenantId: TENANT_A }, async (tx) => {
      guardada = tx;
      void tx.orm; // se crea dentro; se usa fuera
    });
    const antes = f.textos.length;
    const error = await guardada!.orm
      .execute(sql`select 2 as dos`)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const mensajes = [
      (error as Error).message,
      ((error as Error).cause as Error | undefined)?.message,
    ];
    expect(mensajes.join(" | ")).toContain(
      "La transacción de withTenant ya terminó",
    );
    expect(f.textos).toHaveLength(antes);
  });

  it("tx.orm accedido por primera vez fuera de la transacción también rechaza", async () => {
    const f = clienteConfigurable();
    usarClientes(f.client);
    let guardada: Tx | undefined;
    await nuevaDb().withTenant({ tenantId: TENANT_A }, async (tx) => {
      guardada = tx;
    });
    const antes = f.textos.length;
    await expect(guardada!.orm.execute(sql`select 3`)).rejects.toThrow();
    expect(f.textos).toHaveLength(antes);
  });

  it("tx deja de funcionar también tras una excepción de fn (rollback)", async () => {
    const f = clienteConfigurable();
    usarClientes(f.client);
    let guardada: Tx | undefined;
    await nuevaDb()
      .withTenant({ tenantId: TENANT_A }, async (tx) => {
        guardada = tx;
        throw new Error("x");
      })
      .catch(() => undefined);
    await expect(guardada!.query("select 1")).rejects.toThrow(/ya terminó/);
    await expect(guardada!.orm.execute(sql`select 4`)).rejects.toThrow();
  });
});

describe("ajusteTenant / ajusteUsuario / esRolApp", () => {
  it("normaliza a minúsculas los UUID y envía '' si no hay userId", async () => {
    const f = clienteConfigurable();
    usarClientes(f.client);
    await nuevaDb().withTenant(
      { tenantId: TENANT_A.toUpperCase() },
      async () => 1,
    );
    const call = f.query.mock.calls.find(
      (c) =>
        typeof c[0] === "string" && c[0].includes("set_config('app.tenant_id'"),
    );
    expect(call).toBeDefined();
    expect((call as unknown[])[1]).toEqual([TENANT_A, ""]);
  });

  it("withUsuario normaliza a minúsculas el userId", async () => {
    const f = clienteConfigurable();
    usarClientes(f.client);
    await nuevaDb().withUsuario(
      { userId: USER_A.toUpperCase() },
      async () => 1,
    );
    const call = f.query.mock.calls.find(
      (c) =>
        typeof c[0] === "string" && c[0].includes("set_config('app.user_id'"),
    );
    expect(call).toBeDefined();
    expect((call as unknown[])[1]).toEqual([USER_A]);
  });

  it("withUsuario rechaza contexto nulo o sin userId sin abrir conexión", async () => {
    const f = clienteConfigurable();
    const llamadas = usarClientes(f.client);
    const db = nuevaDb();
    await expect(
      db.withUsuario(null as never, async () => 1),
    ).rejects.toBeInstanceOf(ContextoInvalidoError);
    await expect(
      db.withUsuario({} as never, async () => 1),
    ).rejects.toBeInstanceOf(ContextoInvalidoError);
    expect(llamadas()).toBe(0);
  });

  it("ejecutarEnContexto rechaza un rol fuera de la lista aunque el contexto sea válido", async () => {
    const f = clienteConfigurable();
    const llamadas = usarClientes(f.client);
    const pool = new Pool({ connectionString: URL_FALSA });
    try {
      await expect(
        ejecutarEnContexto(
          pool,
          "postgres" as RolApp,
          () => ajusteTenant({ tenantId: TENANT_A }),
          async () => 1,
        ),
      ).rejects.toBeInstanceOf(ContextoInvalidoError);
    } finally {
      await pool.end();
    }
    expect(llamadas()).toBe(0);
  });

  it("esRolApp acepta solo los dos roles cerrados y no prototipos", () => {
    expect(esRolApp("contapp_backend")).toBe(true);
    expect(esRolApp("contapp_worker")).toBe(true);
    for (const x of [
      "constructor",
      "toString",
      "__proto__",
      "contapp_app",
      1,
      null,
      undefined,
      {},
    ]) {
      expect(esRolApp(x)).toBe(false);
    }
  });
});
