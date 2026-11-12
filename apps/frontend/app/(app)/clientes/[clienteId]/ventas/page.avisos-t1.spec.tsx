import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../../lib/sesion";
import {
  MENSAJES_ARCHIVO as MA,
  USUARIO_ID,
  previoDe,
} from "../../../../../pruebas/archivos";
import { MENSAJES_VENTAS as TEXTOS } from "../../../../../lib/ventas";
import type { Manejador } from "../../../../../pruebas/soporte";
import {
  BASE,
  MENSAJES_VENTAS as TEXTOS_PRUEBA,
  PERIODO,
  PERMISOS,
  RESUMEN_BASE,
  V290,
  V292,
  V_DESCUADRADA,
  instalarFetchVentas,
  paginaDe,
  type EstadoVentas,
  type FetchVentas,
} from "../../../../../pruebas/ventas";

// Los textos de ventas de 013 vienen del soporte de pruebas; los de 012b, de la pantalla.
const M = { ...TEXTOS_PRUEBA, ...TEXTOS };

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
}));
const busqueda = vi.hoisted(() => ({ actual: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/clientes/c-1/ventas",
  useSearchParams: () => busqueda.actual,
  useParams: () => ({ clienteId: "c-1" }),
}));

async function cargarPagina(): Promise<ReactElement> {
  const modulo = (await import("./page")) as { default: () => ReactElement };
  const Pagina = modulo.default;
  return <Pagina />;
}

// Avisos únicos de ventas (spec 018, T1; P-2, CA-10): cada aviso de la pantalla sale una sola vez en el árbol de
// accesibilidad (un `role="status"` o `role="alert"`), también el que cruza el panel «Generar archivo» y los diálogos.

const ARCH = `${BASE}/archivos`;
const TODOS_Y_GENERAR = [...PERMISOS.todos, "sire.aprobar_generar"];
const MOTIVO = "Factura anulada en el sistema de facturación";
const EN = "2026-11-05T15:30:00.000Z";
const CLAVE_DESCUADRADA = "B001-294";

const previoVentas = (parcial: Parameters<typeof previoDe>[0] = {}) =>
  previoDe({ formato: { id: "rvie-8.1", version: "1", oficial: true }, ...parcial });

const PREVIO_CON_ERROR = previoVentas({
  apto: false,
  generable: false,
  motivo: "prevalidacion_fallida",
  errores: [
    {
      filaId: V_DESCUADRADA.id,
      codigo: "CUADRE",
      campo: "total",
      destino: null,
      explicacion: "El total 118.01 no cuadra con la suma de los componentes 118.00.",
      diferencia: "0.01",
      excluible: true,
    },
  ],
});

const excluidaDe = (motivo: string) => ({
  filaId: V_DESCUADRADA.id,
  comprobante: CLAVE_DESCUADRADA,
  motivo,
});

const conExclusion = (motivo: string) => ({
  ...V_DESCUADRADA,
  exclusion: { motivo, por: USUARIO_ID, en: EN },
});

const resumenCon = (parcial: Record<string, unknown>) => ({ ...RESUMEN_BASE, ...parcial });

interface Opciones {
  permisos?: readonly string[];
  estado?: "abierto" | "revisado" | "generado";
  previo?: (vez: number) => { status: number; cuerpo?: unknown };
  extra?: (e: EstadoVentas) => Record<string, Manejador>;
  filas?: unknown[];
  resumen?: Record<string, unknown>;
}

async function montar(o: Opciones = {}): Promise<FetchVentas> {
  busqueda.actual = new URLSearchParams(`periodo=${PERIODO}`);
  const f = instalarFetchVentas({
    permisos: o.permisos ?? TODOS_Y_GENERAR,
    estado: {
      pagina: paginaDe((o.filas ?? [V290, V292]) as never),
      resumen: resumenCon({ estado: o.estado ?? "abierto", excluidas: 0, ...o.resumen }),
    },
    extra: (e) => ({
      [`GET ${ARCH}/previo`]: (_, vez) =>
        (o.previo ?? (() => ({ status: 200, cuerpo: previoVentas() })))(vez),
      [`GET ${ARCH}`]: { status: 200, cuerpo: [] },
      ...o.extra?.(e),
    }),
  });
  render(await cargarPagina());
  await vi.waitFor(() => expect(f.de("GET /api/acceso/yo")).toHaveLength(1));
  await vi.waitFor(() => expect(f.lecturas("/resumen").length).toBeGreaterThan(0));
  return f;
}

async function abrirPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: MA.abrir }));
  return screen.findByRole("complementary", { name: MA.titulo });
}

/** Los anunciadores (`alert` y `status`) y las regiones `aria-live` cuyo texto contiene el aviso. */
const anunciadores = (texto: string) =>
  [...screen.queryAllByRole("alert"), ...screen.queryAllByRole("status")].filter((el) =>
    (el.textContent ?? "").includes(texto),
  );
const regionesVivas = (texto: string) =>
  [...document.querySelectorAll<HTMLElement>('[aria-live="polite"],[aria-live="assertive"]')].filter(
    (el) => (el.textContent ?? "").includes(texto),
  );

const servidor = (excluida: { motivo: string | null }) => ({
  previo: () => ({
    status: 200,
    cuerpo:
      excluida.motivo === null
        ? PREVIO_CON_ERROR
        : previoVentas({
            excluidas: [excluidaDe(excluida.motivo)],
            resumen: { ...previoVentas().resumen, excluidas: 1 },
          }),
  }),
  extra: (e: EstadoVentas): Record<string, Manejador> => ({
    [`POST ${BASE}/${V_DESCUADRADA.id}/excluir`]: (llamada) => {
      excluida.motivo = (llamada.body as { motivo: string }).motivo;
      e.pagina = paginaDe([V290, conExclusion(excluida.motivo), V292] as never);
      e.resumen = resumenCon({ estado: "abierto", excluidas: 1 });
      return { status: 200, cuerpo: conExclusion(excluida.motivo) };
    },
  }),
});

describe("Ventas · avisos únicos (spec 018 T1, CA-10)", () => {
  beforeEach(() => reiniciarSesion());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("feliz: «Venta excluida» (desde el panel y su diálogo) sale en un solo aviso", async () => {
    const excluida = { motivo: null as string | null };
    await montar({ filas: [V290, V_DESCUADRADA, V292], ...servidor(excluida) });
    const user = userEvent.setup();
    const panel = await abrirPanel(user);

    await user.click(await within(panel).findByRole("button", { name: MA.excluir }));
    const dialogo = await screen.findByRole("alertdialog");
    await user.type(within(dialogo).getByLabelText(M.motivoExclusion), MOTIVO);
    await user.click(within(dialogo).getByRole("button", { name: M.confirmar }));

    await screen.findByText(M.ventaExcluida);
    expect(anunciadores(M.ventaExcluida)).toHaveLength(1);
    expect(regionesVivas(M.ventaExcluida)).toHaveLength(0);
  });

  it("error: el 409 no_excluible del diálogo sale en un solo aviso", async () => {
    const excluida = { motivo: null as string | null };
    await montar({
      filas: [V290, V_DESCUADRADA, V292],
      ...servidor(excluida),
      extra: (e) => ({
        ...servidor(excluida).extra(e),
        [`POST ${BASE}/${V_DESCUADRADA.id}/excluir`]: {
          status: 409,
          cuerpo: { codigo: "no_excluible" },
        },
      }),
    });
    const user = userEvent.setup();
    const panel = await abrirPanel(user);

    await user.click(await within(panel).findByRole("button", { name: MA.excluir }));
    const dialogo = await screen.findByRole("alertdialog");
    await user.type(within(dialogo).getByLabelText(M.motivoExclusion), MOTIVO);
    await user.click(within(dialogo).getByRole("button", { name: M.confirmar }));

    await within(dialogo).findByText(M.errores.no_excluible!);
    expect(anunciadores(M.errores.no_excluible!)).toHaveLength(1);
    expect(regionesVivas(M.errores.no_excluible!)).toHaveLength(0);
  });

  it("el motivo del periodo `generado` sale en un solo aviso", async () => {
    await montar({ estado: "generado" });
    await screen.findByText(M.soloLectura.generado, { selector: "p" });
    expect(anunciadores(M.soloLectura.generado)).toHaveLength(1);
  });

  it("el aviso «USD sin tipo de cambio» del resumen sale en un solo aviso", async () => {
    await montar({ resumen: { avisos: ["usd_sin_tipo_cambio"] } });
    await screen.findByText(M.avisoUsdSinTipoCambio);
    expect(anunciadores(M.avisoUsdSinTipoCambio)).toHaveLength(1);
  });
});
