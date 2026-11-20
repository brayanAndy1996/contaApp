import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../lib/sesion";
import { MENSAJES_BUZON as M } from "../../../pruebas/buzon";
import { crearRouterFalso } from "../../../pruebas/soporte";
import { instalarFetchPanel, trabajoN } from "../../../pruebas/trabajos";

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
  usePathname: () => "/trabajos",
  useSearchParams: () => new URLSearchParams(),
}));

import Trabajos from "./page";

// Spec 023 · T7 (rojo; CA-2). El panel de trabajos nombra en español los dos tipos nuevos del buzón:
//   `sol.buzon.revisar` → «Revisión de buzón SOL» y `sol.buzon.abrir` → «Apertura de mensaje SOL».
// Nunca se muestra el código crudo del tipo (los tipos desconocidos sí salen tal cual, comportamiento de 007b).
// No se edita `page.spec.tsx` (007b): esta prueba vive aparte.

const REVISAR = "sol.buzon.revisar";
const ABRIR = "sol.buzon.abrir";

beforeEach(() => {
  Object.assign(router, crearRouterFalso());
  reiniciarSesion();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const fila = (texto: string): HTMLElement => {
  const f = screen.queryAllByRole("row").find((r) => r.textContent?.includes(texto));
  if (!f) throw new Error(`no hay fila con "${texto}"`);
  return f;
};

describe("/trabajos · tipos del buzón (023)", () => {
  it("«Revisión de buzón SOL» y «Apertura de mensaje SOL» con su estado, sin el código crudo", async () => {
    instalarFetchPanel({
      listado: () => ({
        status: 200,
        cuerpo: [trabajoN(1, REVISAR, "en_cola"), trabajoN(2, ABRIR, "error", "credencial_invalida")],
      }),
    });
    render(<Trabajos />);

    await vi.waitFor(() => fila(M.tipoRevisar));
    expect(fila(M.tipoRevisar).textContent).toContain("En cola");
    const abrir = fila(M.tipoAbrir);
    expect(abrir.textContent).toContain("Con error");
    expect(abrir.textContent).toContain("Credencial inválida");
    expect(document.body.textContent).not.toContain(REVISAR);
    expect(document.body.textContent).not.toContain(ABRIR);
  });
});
