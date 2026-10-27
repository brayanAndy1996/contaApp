import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { confianzaProxy, crearApp } from "./app.js";
import { EntornoInvalidoError } from "./config/entorno.js";

// Cableado de `crearApp` sin BD (T12 de 004): el pool no abre conexiones hasta la primera consulta,
// y las rutas probadas aquí se resuelven antes de tocarla. Los flujos completos están en los
// `*.int.spec.ts` de `modules/auth`.
const ORIGEN = "http://localhost:3000";
const ENV = {
  APP_ORIGIN: ORIGEN,
  DATABASE_URL: "postgres://usuario@127.0.0.1:1/inexistente",
  CORREO_PROVIDER: "consola",
  TRUST_PROXY: "2",
};

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("crearApp con el entorno (sin correo ni hasher inyectados)", () => {
  it("arma la app: no-store, sin x-powered-by y errores { codigo } para una ruta inexistente", async () => {
    app = await crearApp({ env: ENV });
    const r = await request(app.getHttpServer()).get("/auth/ruta-que-no-existe-canario");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(r.text).not.toContain("canario");
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(r.headers["x-powered-by"]).toBeUndefined();
    expect(r.headers.etag).toBeUndefined();
  });

  it("el guard de origen corta un POST ajeno antes de tocar la BD", async () => {
    app = await crearApp({ env: ENV });
    const r = await request(app.getHttpServer())
      .post("/auth/login")
      .set("Origin", "https://evil.example")
      .send({ correo: "a@b.c", contrasena: "x" });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ codigo: "origen_invalido" });
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it("limita el JSON a 16 kB (413) y responde { codigo } ante JSON roto (400)", async () => {
    app = await crearApp({ env: ENV });
    const servidor = app.getHttpServer();
    const grande = await request(servidor)
      .post("/auth/login")
      .set("Origin", ORIGEN)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ correo: "a@b.c", contrasena: "x".repeat(20_000) }));
    expect(grande.status).toBe(413);
    expect(grande.headers["cache-control"]).toMatch(/no-store/);
    const roto = await request(servidor)
      .post("/auth/login")
      .set("Origin", ORIGEN)
      .set("Content-Type", "application/json")
      .send('{"correo": "canario-roto"');
    expect(roto.status).toBe(400);
    expect(roto.body).toEqual({ codigo: "solicitud_invalida" });
    expect(roto.text).not.toContain("canario");
  });

  it("un entorno inválido impide arrancar y no nombra el valor", async () => {
    const intento = crearApp({ env: { ...ENV, APP_ORIGIN: "valor-secreto-no-url" } });
    await expect(intento).rejects.toBeInstanceOf(EntornoInvalidoError);
    await expect(intento).rejects.not.toThrow(/valor-secreto/);
  });
});

describe("confianzaProxy", () => {
  it("un entero es el número de saltos; lo demás pasa tal cual", () => {
    expect(confianzaProxy("2")).toBe(2);
    expect(confianzaProxy("loopback")).toBe("loopback");
    expect(confianzaProxy("10.0.0.1, 10.0.0.2")).toBe("10.0.0.1, 10.0.0.2");
  });
});
