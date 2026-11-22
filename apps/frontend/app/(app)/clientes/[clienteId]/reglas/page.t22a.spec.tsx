import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../../lib/sesion";
import { rutaSesion, yoDe } from "../../../../../pruebas/acceso";
import {
  CAND_A,
  MENSAJES_APRENDIZAJE as M,
  PERMISOS_GESTIONAR,
  RUTA_ACTIVAR,
  RUTA_CANDIDATAS,
  RUTA_ULTIMA,
  importacionDe,
} from "../../../../../pruebas/aprendizaje";
import { RUTA_CATEGORIAS, categoriasDe } from "../../../../../pruebas/gastos";
import { RUTA_LISTA_REGLAS } from "../../../../../pruebas/reglas";
import { instalarFetchFalso } from "../../../../../pruebas/soporte";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/clientes/c-1/reglas",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ clienteId: "c-1" }),
}));

import Pagina from "./page";

// Spec 025 · T22a (D2, D3). Pantalla de reglas del cliente.
//   D3: con el cliente no visible (404 en la importación, las candidatas y las reglas) la página muestra UN solo aviso y no
//       ofrece acciones («Importar historial»).
//   D2: tras activar (aunque el servidor no active ninguna) la tabla de reglas se vuelve a leer.

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NO_ENCONTRADO = { status: 404, cuerpo: { codigo: "no_encontrado" } };

describe("página de reglas · cliente no visible (T22a · D3)", () => {
  it("muestra un solo aviso «No se encontró lo que buscas.» y no ofrece «Importar historial»", async () => {
    const f = instalarFetchFalso({
      ...rutaSesion(),
      "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("contador", PERMISOS_GESTIONAR) },
      [RUTA_ULTIMA]: NO_ENCONTRADO,
      [RUTA_CANDIDATAS]: NO_ENCONTRADO,
      [RUTA_LISTA_REGLAS]: NO_ENCONTRADO,
      [RUTA_CATEGORIAS]: NO_ENCONTRADO,
    });
    render(<Pagina />);

    await vi.waitFor(() => expect(f.de(RUTA_ULTIMA).length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(f.de(RUTA_LISTA_REGLAS).length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(screen.getAllByText(M.noEncontrado).length).toBeGreaterThan(0));
    // Deja pasar las demás lecturas antes de contar.
    await new Promise((r) => setTimeout(r, 100));

    expect(screen.getAllByText(M.noEncontrado)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: M.importar })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("página de reglas · refresco tras activar (T22a · D2)", () => {
  it("con 0 activadas la tabla de reglas se vuelve a leer y se ve el motivo", async () => {
    const f = instalarFetchFalso({
      ...rutaSesion(),
      "GET /api/acceso/yo": { status: 200, cuerpo: yoDe("contador", PERMISOS_GESTIONAR) },
      [RUTA_ULTIMA]: { status: 200, cuerpo: { importacion: importacionDe() } },
      [RUTA_CANDIDATAS]: { status: 200, cuerpo: { candidatas: [CAND_A], siguiente: null } },
      [RUTA_LISTA_REGLAS]: { status: 200, cuerpo: [] },
      [RUTA_CATEGORIAS]: { status: 200, cuerpo: categoriasDe() },
      [RUTA_ACTIVAR]: {
        status: 200,
        cuerpo: { activadas: [], omitidas: [{ id: CAND_A.id, motivo: "no_pendiente" }] },
      },
    });
    const usuario = userEvent.setup();
    render(<Pagina />);

    const fila = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-candidata="${CAND_A.id}"]`);
      if (!el) throw new Error("sin candidata");
      return el;
    });
    await vi.waitFor(() => expect(f.de(RUTA_LISTA_REGLAS)).toHaveLength(1));
    await usuario.click(within(fila).getByRole("checkbox", { name: M.seleccionar("20100070970") }));
    await usuario.click(screen.getByRole("button", { name: M.activarSeleccionadas }));

    expect(await screen.findByText(M.omitidas(1, "no_pendiente"))).toBeTruthy();
    await vi.waitFor(() => expect(f.de(RUTA_LISTA_REGLAS)).toHaveLength(2));
  });
});
