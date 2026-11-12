import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../../lib/sesion";
import {
  BASE,
  MENSAJES_COMPRAS as M,
  PERIODO,
  instalarFetchCompras,
} from "../../../../../pruebas/compras";

// Spec 018 · T8a (CA-10): con un cliente inexistente o de otro estudio, «No se encontró lo que buscas.» (resumen y
// listado dan 404) se anuncia una sola vez, no en dos `role="alert"`.

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const busqueda = vi.hoisted(() => ({ actual: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/clientes/c-1/compras",
  useSearchParams: () => busqueda.actual,
  useParams: () => ({ clienteId: "c-1" }),
}));
vi.mock("../../../../../lib/trabajos", async (original) => {
  const real = await original<typeof import("../../../../../lib/trabajos")>();
  return {
    ...real,
    seguirTrabajos: vi.fn(
      (o: { senal: AbortSignal }) =>
        new Promise<void>((resolver) =>
          o.senal.addEventListener("abort", () => resolver(), { once: true }),
        ),
    ),
  };
});

const RUTA_PAGINA = "./page";
async function cargarPagina(): Promise<ReactElement> {
  const modulo = (await import(/* @vite-ignore */ RUTA_PAGINA)) as { default: () => ReactElement };
  const Pagina = modulo.default;
  return <Pagina />;
}

const NO_ENCONTRADO = "No se encontró lo que buscas.";
const no404 = { status: 404, cuerpo: { codigo: "no_encontrado" } };

describe("/clientes/:id/compras · aviso de «no encontrado» (spec 018 T8a, CA-10)", () => {
  beforeEach(() => {
    reiniciarSesion();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(3200);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("error: con resumen y listado en 404 el texto sale en un solo role=alert", async () => {
    busqueda.actual = new URLSearchParams(`periodo=${PERIODO}`);
    const f = instalarFetchCompras({
      extra: {
        [`GET ${BASE}`]: no404,
        [`GET ${BASE}/resumen`]: no404,
        [`GET ${BASE}/propuestas`]: no404,
      },
    });
    render(await cargarPagina());
    await vi.waitFor(() => expect(f.de(`GET ${BASE}`).length).toBeGreaterThan(0));
    await screen.findAllByText(NO_ENCONTRADO);
    await act(async () => undefined);

    const alertas = screen
      .queryAllByRole("alert")
      .filter((el) => (el.textContent ?? "").includes(NO_ENCONTRADO));
    expect(alertas).toHaveLength(1);
    // El texto sigue a la vista junto a «Reintentar».
    expect(screen.getAllByText(NO_ENCONTRADO).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: M.reintentar })).toBeTruthy();
  });

  it("feliz: un error de carga distinto del de la pantalla conserva su propio aviso", async () => {
    busqueda.actual = new URLSearchParams(`periodo=${PERIODO}`);
    const f = instalarFetchCompras({
      extra: { [`GET ${BASE}`]: { status: 500, cuerpo: { codigo: "error" } } },
    });
    render(await cargarPagina());
    await vi.waitFor(() => expect(f.de(`GET ${BASE}`).length).toBeGreaterThan(0));
    await screen.findByRole("button", { name: M.reintentar });
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });
});
