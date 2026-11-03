import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../lib/sesion";
import { crearRouterFalso, instalarFetchFalso } from "../../../pruebas/soporte";

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
  usePathname: () => "/login",
  useSearchParams: () => new URLSearchParams(),
}));

import Login from "./page";

// Contrato (plan 006, Archivos; CA-10). /login añade un enlace "Crear estudio" a /registro.

describe("/login · registro (006)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
    instalarFetchFalso({});
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("ofrece el enlace 'Crear estudio' hacia /registro", () => {
    render(<Login />);
    const enlace = screen.getByRole("link", { name: "Crear estudio" });
    expect(enlace.getAttribute("href")).toBe("/registro");
  });
});
