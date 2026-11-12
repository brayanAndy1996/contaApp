import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../../lib/sesion";
import {
  BASE,
  C_2056_MIXTA,
  C_3064_BOLSAS,
  MENSAJES_COMPRAS as M,
  PERIODO,
  accionDe,
  filaDe,
  instalarFetchCompras,
  montosDe,
  type OpcionesCompras,
} from "../../../../../pruebas/compras";

// Avisos únicos de la pantalla de compras (spec 018, T1; P-2, CA-10): cada aviso de una acción de fila sale una
// sola vez en el árbol de accesibilidad (un solo `role="alert"` o `role="status"`), no dos regiones con el mismo
// texto. Cubre «Sugerencia aceptada.», «La sugerencia cambió…», «Otra persona cambió esta compra…» y el error de
// fila de 015 T11 (f).

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
const acciones = (comprobante: string) =>
  screen.getByRole("button", { name: `${M.columnas.acciones} ${comprobante}` });

describe("/clientes/:id/compras · avisos únicos (spec 018 T1, CA-10)", () => {
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

  it("feliz: «Sugerencia aceptada.» sale en un solo aviso", async () => {
    const aceptada = filaDe({
      ...C_2056_MIXTA,
      version: 2,
      hallazgos: [],
      montos: montosDe({ biDg: "8.97", noGravado: "12.51" }),
    });
    await montar({
      extra: (estado) => ({
        [`POST ${BASE}/${C_2056_MIXTA.id}/sugerencias/aceptar`]: (_llamada, vez) => {
          if (vez === 1) return { status: 422, cuerpo: { codigo: "requiere_dato", dato: "gravado" } };
          estado.filas = estado.filas.map((x) => (x.id === C_2056_MIXTA.id ? aceptada : x));
          return { status: 200, cuerpo: accionDe(aceptada) };
        },
      }),
    });
    const user = userEvent.setup();
    await screen.findByText(M.cargaCompleta(4));
    await user.click(acciones("F001-2056"));
    await user.click(screen.getByRole("menuitem", { name: M.aceptarSugerencias }));
    await user.click(await screen.findByRole("button", { name: `${M.aceptar} R-MIX` }));
    await user.type(await screen.findByLabelText(M.pedirGravado), "8.97");
    await user.click(screen.getByRole("button", { name: M.aceptarSugerencia }));

    await screen.findAllByText(M.sugerenciaAceptada);
    await act(async () => undefined);
    expect(anunciadores(M.sugerenciaAceptada)).toHaveLength(1);
  });

  it("error: «La sugerencia cambió…» (409 revisar_de_nuevo) sale en un solo aviso", async () => {
    await montar({
      extra: {
        [`POST ${BASE}/${C_2056_MIXTA.id}/sugerencias/aceptar`]: {
          status: 409,
          cuerpo: { codigo: "revisar_de_nuevo" },
        },
      },
    });
    const user = userEvent.setup();
    await screen.findByText(M.cargaCompleta(4));
    await user.click(acciones("F001-2056"));
    await user.click(screen.getByRole("menuitem", { name: M.aceptarSugerencias }));
    await user.click(await screen.findByRole("button", { name: `${M.aceptar} R-MIX` }));

    await screen.findAllByText(M.errores.revisar_de_nuevo!);
    await act(async () => undefined);
    expect(anunciadores(M.errores.revisar_de_nuevo!)).toHaveLength(1);
  });

  it("error de fila: «Otra persona cambió esta compra…» (409 version_obsoleta) sale en un solo aviso", async () => {
    const FILA = C_3064_BOLSAS;
    await montar({
      extra: {
        [`POST ${BASE}/${FILA.id}/clasificar`]: {
          status: 409,
          cuerpo: { codigo: "version_obsoleta", versionVigente: 5 },
        },
      },
    });
    const user = userEvent.setup();
    await screen.findByText(M.cargaCompleta(4));

    await user.click(acciones("F001-3064"));
    await user.click(screen.getByRole("menuitem", { name: M.clasificarComo("DNG") }));

    await screen.findAllByText(M.errores.version_obsoleta!);
    await act(async () => undefined);
    expect(anunciadores(M.errores.version_obsoleta!)).toHaveLength(1);
  });
});
