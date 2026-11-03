import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../lib/sesion";
import { MENSAJES_PLANES, rutaUso, usoDe } from "../pruebas/planes";
import { asentar } from "../pruebas/acceso";
import { instalarFetchFalso, type Manejador } from "../pruebas/soporte";
import { UsoPlan } from "./uso-plan";

// Contrato (plan 006, HTTP y shared; D7, D8; CA-10). Componente <UsoPlan /> (sin props): al montar
// pide GET /api/plan/uso (con X-Estudio de la sesión) y pinta una región `aria-label="Uso del plan"`:
// - el nombre del plan; en estado `prueba` además "Prueba" y la palabra "vence" (pruebaVenceEn).
// - "RUCs: {usados} de {limite}" y "Usuarios: {usados + pendientes} de {limite}"; con `limite` nulo
//   "Usuarios: N de ilimitado" (D1); con pendientes > 0 añade "N pendiente(s)" (D7: cuentan).
// - Aviso (role=alert, sin precios): al llegar al máximo de RUCs (libres <= 0) un elemento con
//   MENSAJES_PLANES.limiteRucs; de usuarios (limite no nulo y usados + pendientes >= limite) otro con
//   MENSAJES_PLANES.limiteUsuarios; ambos junto a un texto /contacta a ContApp para subir de plan/i
//   (D8, el Dueño aún no cambia de plan). Por debajo del máximo no hay alertas.
// - 403 o error de red: no pinta la región ni alertas, y no rompe la pantalla.
// - 409 sin_plan (D14, T13a): no pinta la región de uso, pero muestra MENSAJES_PLANES.sinPlan (estudio sin
//   plan: la prueba gratis ya se usó con la cuenta) y no rompe la pantalla.

const region = () => screen.findByRole("region", { name: "Uso del plan" });

function montar(uso: Manejador) {
  const f = instalarFetchFalso(rutaUso(uso));
  render(<UsoPlan />);
  return f;
}

describe("<UsoPlan />", () => {
  beforeEach(() => {
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("pide GET /api/plan/uso con el estudio de la sesión y muestra plan, RUCs y usuarios", async () => {
    const f = montar({ status: 200, cuerpo: usoDe() });
    const r = await region();
    expect(r.textContent).toContain("Estudio");
    expect(r.textContent).toContain("RUCs: 12 de 100");
    expect(r.textContent).toContain("Usuarios: 3 de 5");
    const [llamada] = f.de("GET /api/plan/uso");
    expect(llamada?.headers["x-estudio"]).toBe("e-a");
    expect(llamada?.credentials).toBe("same-origin");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("usuarios ilimitados (limite nulo) → 'de ilimitado' y nunca avisa de límite de usuarios", async () => {
    montar({
      status: 200,
      cuerpo: usoDe({ usuarios: { usados: 40, pendientes: 2, limite: null } }),
    });
    const r = await region();
    expect(r.textContent).toContain("Usuarios: 42 de ilimitado");
    await asentar();
    expect(screen.queryByText(MENSAJES_PLANES.limiteUsuarios)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("las invitaciones pendientes cuentan como usadas y se indican", async () => {
    montar({
      status: 200,
      cuerpo: usoDe({ usuarios: { usados: 3, pendientes: 1, limite: 5 } }),
    });
    const r = await region();
    expect(r.textContent).toContain("Usuarios: 4 de 5");
    expect(r.textContent).toMatch(/1 pendiente/);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("estado prueba → muestra Prueba y cuándo vence", async () => {
    montar({
      status: 200,
      cuerpo: usoDe({
        plan: { codigo: "prueba", nombre: "Prueba" },
        estado: "prueba",
        pruebaVenceEn: "2026-11-17T12:00:00.000Z",
        rucs: { usados: 1, limite: 5, libres: 4, extra: 0 },
        usuarios: { usados: 0, pendientes: 0, limite: 1 },
      }),
    });
    const r = await region();
    expect(r.textContent).toContain("Prueba");
    expect(r.textContent).toMatch(/vence/i);
  });

  it("al llegar al máximo de RUCs avisa con el límite y 'contacta a ContApp para subir de plan'", async () => {
    montar({
      status: 200,
      cuerpo: usoDe({
        rucs: { usados: 100, limite: 100, libres: 0, extra: 0 },
      }),
    });
    const alerta = await screen.findByRole("alert");
    expect(within(alerta).getByText(MENSAJES_PLANES.limiteRucs)).toBeTruthy();
    expect(alerta.textContent).toMatch(
      /contacta a ContApp para subir de plan/i,
    );
    expect((await region()).textContent).toContain("RUCs: 100 de 100");
    expect(screen.queryByText(MENSAJES_PLANES.limiteUsuarios)).toBeNull();
  });

  it("al llegar al máximo de usuarios (activos + pendientes) avisa con el límite y cómo subir de plan", async () => {
    montar({
      status: 200,
      cuerpo: usoDe({ usuarios: { usados: 4, pendientes: 1, limite: 5 } }),
    });
    const alerta = await screen.findByRole("alert");
    expect(
      within(alerta).getByText(MENSAJES_PLANES.limiteUsuarios),
    ).toBeTruthy();
    expect(alerta.textContent).toMatch(
      /contacta a ContApp para subir de plan/i,
    );
    expect(screen.queryByText(MENSAJES_PLANES.limiteRucs)).toBeNull();
  });

  it("un RUC antes del máximo no avisa", async () => {
    montar({
      status: 200,
      cuerpo: usoDe({ rucs: { usados: 99, limite: 100, libres: 1, extra: 0 } }),
    });
    await region();
    await asentar();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("el límite incluye los RUCs adicionales que entrega el servidor", async () => {
    montar({
      status: 200,
      cuerpo: usoDe({ rucs: { usados: 30, limite: 34, libres: 4, extra: 4 } }),
    });
    expect((await region()).textContent).toContain("RUCs: 30 de 34");
  });

  it.each([
    ["403", { status: 403, cuerpo: { codigo: "permiso_denegado" } }],
    ["500", { status: 500, cuerpo: {} }],
  ])("%s → no pinta la región ni alertas", async (_n, respuesta) => {
    const f = montar(respuesta);
    await vi.waitFor(() => expect(f.de("GET /api/plan/uso")).toHaveLength(1));
    await asentar();
    expect(screen.queryByRole("region", { name: "Uso del plan" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("si la petición falla por red no rompe", async () => {
    instalarFetchFalso({ "GET /api/auth/sesion": { status: 200, cuerpo: {} } });
    expect(() => render(<UsoPlan />)).not.toThrow();
    await asentar();
    expect(screen.queryByRole("region", { name: "Uso del plan" })).toBeNull();
  });

  it("D14 · 409 sin_plan → muestra el aviso de estudio sin plan, sin región de uso y sin avisos de límite", async () => {
    const f = montar({ status: 409, cuerpo: { codigo: "sin_plan" } });
    expect(await screen.findByText(MENSAJES_PLANES.sinPlan)).toBeTruthy();
    expect(f.de("GET /api/plan/uso")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Uso del plan" })).toBeNull();
    expect(screen.queryByText(MENSAJES_PLANES.limiteRucs)).toBeNull();
    expect(screen.queryByText(MENSAJES_PLANES.limiteUsuarios)).toBeNull();
  });

  it.each([
    ["403", { status: 403, cuerpo: { codigo: "permiso_denegado" } }],
    ["500", { status: 500, cuerpo: {} }],
  ])("D14 · %s no muestra el aviso de estudio sin plan", async (_n, respuesta) => {
    const f = montar(respuesta);
    await vi.waitFor(() => expect(f.de("GET /api/plan/uso")).toHaveLength(1));
    await asentar();
    expect(screen.queryByText(MENSAJES_PLANES.sinPlan)).toBeNull();
  });
});
