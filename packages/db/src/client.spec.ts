import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, type ContappDb } from "./client";
import { ConfiguracionDbError } from "./errores";

// Cobertura de createDb sin BD: validación de la configuración, error de conexión inactiva y close
// idempotente. El pool es perezoso: ninguna prueba abre una conexión.
const URL_FALSA = "postgresql://contapp_app@localhost:1/contapp"; // sin contraseña; nunca se conecta

const abiertas: ContappDb[] = [];
function crear(...args: Parameters<typeof createDb>): ContappDb {
  const db = createDb(...args);
  abiertas.push(db);
  return db;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(abiertas.splice(0).map((d) => d.close()));
});

describe("createDb: configuración", () => {
  it.each([["admin"], ["contapp_app"], [undefined], [42]])(
    "rolApp fuera de la lista cerrada (%s) -> ConfiguracionDbError de mensaje fijo",
    (rol) => {
      let error: unknown;
      try {
        createDb({ rolApp: rol as never, url: URL_FALSA });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ConfiguracionDbError);
      expect((error as Error).message).toBe("rolApp no permitido para createDb");
      expect((error as Error).message).not.toContain(URL_FALSA);
    },
  );

  it("sin url ni DATABASE_URL -> ConfiguracionDbError 'url'", () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(() => createDb({ rolApp: "contapp_backend" })).toThrow(
      "Falta DATABASE_URL para createDb",
    );
  });

  it("toma DATABASE_URL del entorno cuando no se pasa url y respeta poolMax", () => {
    vi.stubEnv("DATABASE_URL", URL_FALSA);
    const db = crear({ rolApp: "contapp_worker", poolMax: 2 });
    expect((db.pool.options as { max?: number }).max).toBe(2);
    expect(db.pool.options.connectionString).toBe(URL_FALSA);
  });

  it("sin poolMax no fija el máximo del pool", () => {
    const db = crear({ rolApp: "contapp_backend", url: URL_FALSA });
    expect(db.pool.options.connectionString).toBe(URL_FALSA);
  });
});

describe("createDb: ciclo de vida del pool", () => {
  it("un error de una conexión inactiva no tumba el proceso ni se propaga", () => {
    const db = crear({ rolApp: "contapp_backend", url: URL_FALSA });
    expect(db.pool.listenerCount("error")).toBeGreaterThan(0);
    expect(() =>
      db.pool.emit("error", new Error("ECONNRESET con datos de conexión")),
    ).not.toThrow();
  });

  it("close es idempotente: pool.end se llama una sola vez", async () => {
    const db = crear({ rolApp: "contapp_backend", url: URL_FALSA });
    const fin = vi.spyOn(db.pool, "end").mockResolvedValue(undefined);
    await db.close();
    await db.close();
    expect(fin).toHaveBeenCalledTimes(1);
  });
});
