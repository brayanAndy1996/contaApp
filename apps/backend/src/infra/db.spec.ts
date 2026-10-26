import { ConfiguracionDbError } from "@contapp/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crearDb } from "./db.js";

// `createDb` no abre conexiones hasta la primera consulta: estas pruebas no necesitan BD.
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("crearDb", () => {
  it("usa DATABASE_URL del entorno inyectado y expone withAuth, withUsuario y withTenant", async () => {
    const db = crearDb({ DATABASE_URL: "postgres://usuario@127.0.0.1:1/inexistente" });
    try {
      expect(typeof db.withAuth).toBe("function");
      expect(typeof db.withUsuario).toBe("function");
      expect(typeof db.withTenant).toBe("function");
    } finally {
      await db.close();
    }
  });

  it("sin DATABASE_URL en el entorno inyectado cae al entorno del proceso", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://usuario@127.0.0.1:1/del-proceso");
    const db = crearDb({});
    await db.close();
  });

  it("sin ninguna URL falla con ConfiguracionDbError (sin nombrar valores)", () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(() => crearDb({ DATABASE_URL: "" })).toThrow(ConfiguracionDbError);
  });
});
