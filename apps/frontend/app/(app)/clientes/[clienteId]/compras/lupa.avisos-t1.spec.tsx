import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MENSAJES_LUPA as L } from "../../../../../lib/lupa-compras";
import { reiniciarSesion } from "../../../../../lib/sesion";
import { detalleLupaDe, rutaDetalle } from "../../../../../pruebas/lupa-compras";
import {
  BASE,
  C_2056_MIXTA,
  FILAS_014,
  MENSAJES_COMPRAS as M,
  PERIODO,
  accionDe,
  filaDe,
  instalarFetchCompras,
  montosDe,
  type OpcionesCompras,
} from "../../../../../pruebas/compras";

// Avisos únicos de la lupa (spec 018, T1; P-2, CA-10): «Sugerencia aceptada.» y «La sugerencia cambió…» salen una
// sola vez en el árbol de accesibilidad cuando se aceptan desde la lupa, no en la ventana y en la pantalla.

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

async function montar(o: OpcionesCompras = {}) {
  busqueda.actual = new URLSearchParams(`periodo=${PERIODO}`);
  const f = instalarFetchCompras(o);
  render(await cargarPagina());
  await vi.waitFor(() => expect(f.de("GET /api/acceso/yo")).toHaveLength(1));
  return f;
}

/** Los anunciadores (`alert` y `status`) cuyo texto contiene el aviso. */
const anunciadores = (texto: string) =>
  [...screen.queryAllByRole("alert"), ...screen.queryAllByRole("status")].filter((el) =>
    (el.textContent ?? "").includes(texto),
  );

/** Las regiones `aria-live` que contienen el texto (un anunciador extra además de `alert`/`status`). */
const regionesVivas = (texto: string) =>
  [...document.querySelectorAll<HTMLElement>('[aria-live="polite"],[aria-live="assertive"]')].filter((el) =>
    (el.textContent ?? "").includes(texto),
  );

async function abrirAceptacionDeLaLupa(extra: OpcionesCompras["extra"]) {
  const detalles: Record<string, { status: number; cuerpo: unknown }> = {};
  for (const f of FILAS_014) detalles[rutaDetalle(f.id)] = { status: 200, cuerpo: detalleLupaDe(f) };
  await montar({
    extra: (estado) => ({
      ...detalles,
      ...(typeof extra === "function" ? extra(estado) : extra),
    }),
  });
  const user = userEvent.setup();
  await screen.findByText(M.cargaCompleta(4));
  await user.click(screen.getByRole("button", { name: `${M.columnas.lupa} F001-2056` }));
  await screen.findByRole("region", { name: L.secciones.cabecera });
  await user.click(screen.getByRole("button", { name: L.hallazgos.aceptar }));
  await user.click(await screen.findByRole("button", { name: `${M.aceptar} R-MIX` }));
  return user;
}

describe("Lupa · avisos únicos (spec 018 T1, CA-10)", () => {
  beforeEach(() => {
    busqueda.actual = new URLSearchParams();
    reiniciarSesion();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(3200);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("feliz: «Sugerencia aceptada.» desde la lupa sale en un solo aviso", async () => {
    const aceptada = filaDe({
      ...C_2056_MIXTA,
      version: 2,
      hallazgos: [],
      montos: montosDe({ biDg: "8.97", noGravado: "12.51" }),
    });
    const user = await abrirAceptacionDeLaLupa((estado) => ({
      [`POST ${BASE}/${C_2056_MIXTA.id}/sugerencias/aceptar`]: (_llamada, vez) => {
        if (vez === 1) return { status: 422, cuerpo: { codigo: "requiere_dato", dato: "gravado" } };
        estado.filas = estado.filas.map((x) => (x.id === C_2056_MIXTA.id ? aceptada : x));
        return { status: 200, cuerpo: accionDe(aceptada) };
      },
    }));
    await user.type(await screen.findByLabelText(M.pedirGravado), "8.97");
    await user.click(screen.getByRole("button", { name: M.aceptarSugerencia }));

    await screen.findAllByText(M.sugerenciaAceptada);
    await act(async () => undefined);
    expect(anunciadores(M.sugerenciaAceptada)).toHaveLength(1);
    expect(regionesVivas(M.sugerenciaAceptada)).toHaveLength(0);
  });

  it("error: «La sugerencia cambió…» desde la lupa sale en un solo aviso", async () => {
    await abrirAceptacionDeLaLupa({
      [`POST ${BASE}/${C_2056_MIXTA.id}/sugerencias/aceptar`]: {
        status: 409,
        cuerpo: { codigo: "revisar_de_nuevo" },
      },
    });

    await screen.findAllByText(M.errores.revisar_de_nuevo!);
    await act(async () => undefined);
    expect(anunciadores(M.errores.revisar_de_nuevo!)).toHaveLength(1);
    expect(regionesVivas(M.errores.revisar_de_nuevo!)).toHaveLength(0);
  });
});
