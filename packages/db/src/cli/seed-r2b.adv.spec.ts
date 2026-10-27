import { afterEach, describe, expect, it, vi } from "vitest";

// Spec 004 · ronda adversarial 2b (T17b). `pnpm db:seed` siembra usuarios con la contraseña de desarrollo
// versionada (`SEED.contrasenaDesarrollo`, sus PHC en `seed/datos.ts`). Comportamiento seguro esperado:
// con NODE_ENV=production el seed no deja credenciales de desarrollo utilizables (no inserta en
// `auth.usuario_contrasena`; idealmente se niega a correr). Sin BD: `pg.Client` es un doble que registra.

const consultas = vi.hoisted(() => [] as string[]);

vi.mock("pg", () => {
  class Client {
    async connect(): Promise<void> {}
    async end(): Promise<void> {}
    async query(q: unknown): Promise<unknown> {
      const texto = typeof q === "string" ? q : String((q as { text?: unknown }).text ?? "");
      consultas.push(texto);
      return { rows: [], rowCount: 0, fields: [], command: "" };
    }
  }
  return { Client, default: { Client } };
});

describe("db:seed con NODE_ENV=production (T17b)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    consultas.length = 0;
  });

  it("R2b-05 no inserta las credenciales de desarrollo en auth.usuario_contrasena", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MIGRATIONS_DATABASE_URL", "postgresql://seed:x@127.0.0.1:1/r2b");
    const { main } = await import("./seed.js");
    await main().catch(() => undefined); // negarse a correr (rechazo) también es seguro
    const credenciales = consultas.filter((q) => /usuario_contrasena/i.test(q));
    expect(credenciales, "el seed deja la contraseña de desarrollo utilizable en producción").toEqual([]);
  });
});
