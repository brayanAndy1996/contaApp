import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../lib/sesion";
import {
  MENSAJES,
  crearRouterFalso,
  instalarFetchFalso,
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
  usePathname: () => "/recuperar",
  useSearchParams: () => new URLSearchParams(),
}));

import Recuperar from "./page";

// Contrato (plan 004, Frontend; CA-8, CA-12). Pantalla /recuperar: campo "Correo", botón "Enviar
// enlace". POST /api/auth/recuperar { correo } sin sesión. Con 202 muestra SIEMPRE el mismo mensaje
// (exista o no el correo) y nunca repite el correo escrito.

async function pedir(correo: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Correo"), correo);
  await user.click(screen.getByRole("button", { name: "Enviar enlace" }));
}

describe("/recuperar", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    try {
      reiniciarSesion();
    } catch {
      // stub rojo
    }
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("muestra el campo Correo y el botón Enviar enlace", () => {
    render(<Recuperar />);
    expect(screen.getByLabelText("Correo")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enviar enlace" })).toBeTruthy();
  });

  it("envía POST /api/auth/recuperar { correo } sin sesión ni cabeceras CSRF", async () => {
    const f = instalarFetchFalso({
      "POST /api/auth/recuperar": { status: 202, cuerpo: { ok: true } },
    });
    render(<Recuperar />);
    await pedir("ana@ejemplo.test");
    await screen.findByText(MENSAJES.recuperarEnviado);
    expect(f.llamadas).toHaveLength(1);
    const [llamada] = f.de("POST /api/auth/recuperar");
    expect(llamada?.body).toEqual({ correo: "ana@ejemplo.test" });
    expect(llamada?.credentials).toBe("same-origin");
    expect(llamada?.headers["x-csrf-token"]).toBeUndefined();
  });

  it("muestra el mismo mensaje con cualquier correo (existente o no) y no lo repite", async () => {
    const textos: string[] = [];
    for (const correo of ["ana@ejemplo.test", "nadie@no-existe.test"]) {
      instalarFetchFalso({
        "POST /api/auth/recuperar": { status: 202, cuerpo: { ok: true } },
      });
      const { container, unmount } = render(<Recuperar />);
      await pedir(correo);
      await screen.findByText(MENSAJES.recuperarEnviado);
      expect(container.textContent).not.toContain(correo);
      textos.push(
        screen.getByText(MENSAJES.recuperarEnviado).textContent ?? "",
      );
      unmount();
      vi.unstubAllGlobals();
    }
    expect(new Set(textos)).toEqual(new Set([MENSAJES.recuperarEnviado]));
  });
});
