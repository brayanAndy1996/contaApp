import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../../lib/sesion";
import { PERMISOS_GESTIONAR, RUTA_ULTIMA, importacionDe, instalarFetchAprendizaje } from "../../../../../pruebas/aprendizaje";
import {
  ETIQUETA_CATEGORIA,
  MENSAJES_GASTOS as M,
  RUTA_CATEGORIAS,
  categoriasRestaurante,
} from "../../../../../pruebas/gastos";
import { RUTA_LISTA_REGLAS } from "../../../../../pruebas/reglas";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/clientes/c-1/reglas",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ clienteId: "c-1" }),
}));

import Pagina from "./page";

// Spec 027 · T7 (rojo; CA-8, R-13). La pantalla «Reglas del cliente» suma «Categorías permitidas» (<CategoriasCliente clienteId />)
// junto a las reglas aprendidas y la importación de 025, que no cambian.

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("página de reglas del cliente · categorías permitidas", () => {
  it("muestra el giro del cliente y las seis categorías, con las efectivas marcadas", async () => {
    const f = instalarFetchAprendizaje({
      importacion: importacionDe(),
      candidatas: [],
      permisos: PERMISOS_GESTIONAR,
      extra: {
        [RUTA_LISTA_REGLAS]: { status: 200, cuerpo: [] },
        [RUTA_CATEGORIAS]: { status: 200, cuerpo: categoriasRestaurante() },
      },
    });
    render(<Pagina />);

    expect(await screen.findByText(M.tituloCategorias)).toBeTruthy();
    expect(await screen.findByText(M.giroDe("5611", "I"))).toBeTruthy();
    expect(((await screen.findByRole("checkbox", { name: ETIQUETA_CATEGORIA["alimentos-personales"] })) as HTMLInputElement).checked).toBe(true);
    expect(f.de(RUTA_CATEGORIAS)).toHaveLength(1);
    // Lo de 021 y 025 sigue ahí.
    expect(f.de(RUTA_ULTIMA).length).toBeGreaterThan(0);
  });
});
