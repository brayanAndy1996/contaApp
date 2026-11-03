import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../lib/sesion";
import { MENSAJES_ACCESO, rutaSesion, yoDe } from "../../../pruebas/acceso";
import { MENSAJES_PLANES, usoDe } from "../../../pruebas/planes";
import {
  crearRouterFalso,
  instalarFetchFalso,
  type Manejador,
} from "../../../pruebas/soporte";

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
  usePathname: () => "/usuarios",
  useSearchParams: () => new URLSearchParams(),
}));

import Usuarios from "./page";

// Contrato (plan 006, Archivos; CA-6, CA-10, D8). Se suma a page.spec.tsx de 005 (no lo reemplaza):
// - /usuarios muestra el indicador de uso (<UsoPlan />, región "Uso del plan", GET /api/plan/uso).
// - Invitar con 409 cupo_usuarios: el error (role=alert) conserva MENSAJES_ACCESO.cupoUsuarios en su
//   propio elemento y añade, en otro elemento, "Contacta a ContApp para subir de plan" (D8).

const USUARIOS = [
  {
    usuarioId: "u-yo",
    nombre: "Dora Dueña",
    correo: "dora@estudio.test",
    rol: "dueno",
    activo: true,
    esYo: true,
  },
];

function rutas(
  extra: Record<string, Manejador> = {},
): Record<string, Manejador> {
  return {
    ...rutaSesion(),
    "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("dueno") },
    "GET /api/usuarios": { status: 200, cuerpo: USUARIOS },
    "GET /api/invitaciones": { status: 200, cuerpo: [] },
    "GET /api/plan/uso": {
      status: 200,
      cuerpo: usoDe({ usuarios: { usados: 1, pendientes: 0, limite: 1 } }),
    },
    ...extra,
  };
}

describe("/usuarios · plan (006)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("muestra el indicador de uso y avisa del límite de usuarios alcanzado", async () => {
    const f = instalarFetchFalso(rutas());
    render(<Usuarios />);
    const uso = await screen.findByRole("region", { name: "Uso del plan" });
    expect(uso.textContent).toContain("Usuarios: 1 de 1");
    expect(
      await screen.findByText(MENSAJES_PLANES.limiteUsuarios),
    ).toBeTruthy();
    expect(f.de("GET /api/plan/uso")).toHaveLength(1);
  });

  it("invitar: 409 cupo_usuarios → mensaje de límite y cómo subir de plan, en elementos separados", async () => {
    instalarFetchFalso(
      rutas({
        // Con cupo libre en el indicador: el aviso de contacto debe venir del error del servidor.
        "GET /api/plan/uso": {
          status: 200,
          cuerpo: usoDe({ usuarios: { usados: 1, pendientes: 0, limite: 5 } }),
        },
        "POST /api/invitaciones": {
          status: 409,
          cuerpo: { codigo: "cupo_usuarios" },
        },
      }),
    );
    render(<Usuarios />);
    await screen.findByText("Dora Dueña");
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Correo"), "otra@estudio.test");
    await user.click(screen.getByRole("button", { name: "Invitar" }));
    expect(await screen.findByText(MENSAJES_ACCESO.cupoUsuarios)).toBeTruthy();
    const alertas = screen.getAllByRole("alert");
    expect(
      alertas.some((a) =>
        /contacta a ContApp para subir de plan/i.test(a.textContent ?? ""),
      ),
    ).toBe(true);
  });
});
