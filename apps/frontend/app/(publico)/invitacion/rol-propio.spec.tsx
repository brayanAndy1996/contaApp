// T15a (030) · defecto menor de la E2E: la pantalla /invitacion mostraba «como propio» para una invitación a un rol propio.
// Contrato: `POST /api/invitaciones/consultar` responde, para un rol propio,
//   { estudio:{nombre}, rol:"propio", rolPropio:{ nombre }, correo, cuentaExiste }  (solo el nombre: sin id ni permisos);
// para un rol de sistema no trae `rolPropio`. La pantalla muestra «como <nombre>» (texto plano) o la etiqueta del rol de sistema.
// Rojo: la pantalla ignora `rolPropio` y muestra la etiqueta cruda del rol.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../lib/sesion";
import { crearRouterFalso, instalarFetchFalso, sesionDe } from "../../../pruebas/soporte";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/invitacion",
  useSearchParams: () => new URLSearchParams(),
}));

import Invitacion from "./page";

const TOKEN = "TokenCanarioDeInvitacion_0123456789abcdefghijklmno";
const CORREO = "nuevo@ejemplo.test";
const BASE = { estudio: { nombre: "Estudio Alfa" }, correo: CORREO, cuentaExiste: false };

function conConsulta(cuerpo: unknown) {
  return instalarFetchFalso({
    "POST /api/invitaciones/consultar": { status: 200, cuerpo },
    "GET /api/auth/sesion": { status: 200, cuerpo: sesionDe(null, "csrf-invitacion") },
  });
}

describe("/invitacion · rol de la invitación (T15a)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    window.history.replaceState(null, "", `/invitacion#t=${TOKEN}`);
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("rol propio: muestra «como <nombre del rol>» y no «propio»", async () => {
    conConsulta({ ...BASE, rol: "propio", rolPropio: { nombre: "Practicante" } });
    const { container } = render(<Invitacion />);
    await screen.findByLabelText("Nombre");
    expect(container.textContent).toContain("Estudio Alfa como Practicante");
    expect(container.textContent).not.toMatch(/como propio/i);
    expect(container.textContent).not.toMatch(/rol propio/i);
  });

  it("rol propio con cuenta existente: también muestra el nombre del rol", async () => {
    conConsulta({ ...BASE, cuentaExiste: true, rol: "propio", rolPropio: { nombre: "Practicante" } });
    const { container } = render(<Invitacion />);
    await screen.findByRole("button", { name: "Iniciar sesión y aceptar" });
    expect(container.textContent).toContain("como Practicante");
    expect(container.textContent).not.toMatch(/como propio/i);
  });

  it("el nombre del rol propio se muestra como texto (nunca como HTML)", async () => {
    const { container } = (conConsulta({ ...BASE, rol: "propio", rolPropio: { nombre: "<b>Pasante</b> & <i>Co</i>" } }), render(<Invitacion />));
    await screen.findByLabelText("Nombre");
    expect(container.textContent).toContain("como <b>Pasante</b> & <i>Co</i>");
    expect(container.querySelector("main b")).toBeNull();
    expect(container.querySelector("main i")).toBeNull();
  });

  it.each([
    ["admin", "Administrador"],
    ["contador", "Contador"],
    ["dueno", "Dueño"],
    ["asistente", "Asistente"],
    ["lectura", "Lectura"],
  ])("rol de sistema %s: sigue mostrando «como %s»", async (rol, etiqueta) => {
    conConsulta({ ...BASE, rol });
    const { container } = render(<Invitacion />);
    await screen.findByLabelText("Nombre");
    expect(container.textContent).toContain(`como ${etiqueta}`);
  });

  it("un rol de sistema ignora un rolPropio que no le corresponde", async () => {
    conConsulta({ ...BASE, rol: "contador", rolPropio: { nombre: "Intruso" } });
    const { container } = render(<Invitacion />);
    await screen.findByLabelText("Nombre");
    expect(container.textContent).toContain("como Contador");
    expect(container.textContent).not.toContain("Intruso");
  });
});
