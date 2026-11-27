// T3 (029) · «auditoria-rutas incluye las rutas nuevas» (CA-4/CA-11 de 005: toda ruta declara una familia de acceso) y arranque con
// `TOTP_CLAVE` (D1, plan: Entorno). Sin BD, como `acceso/rutas.spec.ts`: `crearApp` no conecta hasta la primera consulta.
// Rojo: los controladores de 029 y la variable `TOTP_CLAVE` aún no existen (T6, T7).
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crearApp } from "../../app.js";
import { infracciones, rutasRegistradas, type RutaDeclarada } from "../../../test/auditoria-rutas.js";

const CLAVE = `2:${randomBytes(32).toString("base64")}`;
const ENV = {
  APP_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgres://usuario@127.0.0.1:1/inexistente",
  CORREO_PROVIDER: "consola",
  TOTP_CLAVE: CLAVE,
};

/** Las nueve rutas de 029 (plan: Contratos: HTTP). Todas son de `/auth`: sesión sin estudio activo (`@SinEstudio`). */
const NUEVAS: ReadonlyArray<readonly [string, string]> = [
  ["POST", "/auth/2fa/verificar"],
  ["POST", "/auth/totp/enrolar"],
  ["POST", "/auth/totp/confirmar"],
  ["POST", "/auth/totp/desactivar"],
  ["POST", "/auth/totp/recuperacion"],
  ["GET", "/auth/sesiones"],
  ["POST", "/auth/sesiones/:id/revocar"],
  ["POST", "/auth/sesiones/revocar-otras"],
];

describe("rutas de 029 registradas y auditadas", () => {
  let app: INestApplication;
  let rutas: RutaDeclarada[];
  beforeAll(async () => {
    app = await crearApp({ env: ENV });
    rutas = rutasRegistradas(app);
  });
  afterAll(async () => {
    await app?.close();
  });

  it.each(NUEVAS)("%s %s está registrada y declara solo @SinEstudio (sesión sin estudio activo, nunca @Publico)", (metodo, ruta) => {
    const r = rutas.find((x) => x.metodo === metodo && x.ruta === ruta);
    expect(r, `${metodo} ${ruta} no está registrada`).toBeDefined();
    expect(r!.declaraciones).toContain("SinEstudio");
    expect(r!.declaraciones).not.toContain("Publico"); // la pendiente y la verificada se resuelven por sesión
    expect(r!.declaraciones).not.toContain("SoloPlataforma");
    expect(r!.usaClienteId).toBe(false);
  });

  it("ninguna ruta, vieja o nueva, queda sin familia de acceso ni con más de una", () => {
    expect(infracciones(rutas)).toEqual([]);
  });

  it("no hay otras rutas de 2fa ni de totp que las del plan (cada ruta nueva está en la lista cerrada)", () => {
    const nuevas = rutas.filter((r) => /\/(2fa|totp)\b|^\/auth\/sesiones(\/|$)/.test(r.ruta) && r.ruta !== "/auth/sesiones/cerrar-todas");
    expect(nuevas.map((r) => `${r.metodo} ${r.ruta}`).sort()).toEqual(NUEVAS.map(([m, r]) => `${m} ${r}`).sort());
  });
});

describe("arranque: crearApp exige TOTP_CLAVE (la validación fina vive en config/entorno.totp.spec.ts)", () => {
  it("sin TOTP_CLAVE o con una inválida el backend no arranca y el error no repite el valor", async () => {
    const { TOTP_CLAVE: _omitida, ...sin } = ENV;
    void _omitida;
    await expect(crearApp({ env: sin })).rejects.toThrow(/TOTP_CLAVE/);
    const malo = `0:${randomBytes(32).toString("base64")}`;
    const e = await crearApp({ env: { ...sin, TOTP_CLAVE: malo } }).then(
      () => null,
      (x: Error) => x,
    );
    expect(e).not.toBeNull();
    expect(e!.message).toMatch(/TOTP_CLAVE/);
    expect(e!.message).not.toContain(malo);
  });
});
