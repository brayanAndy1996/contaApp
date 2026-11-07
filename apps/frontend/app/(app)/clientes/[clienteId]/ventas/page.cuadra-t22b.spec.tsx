import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../../../lib/sesion";
import { crearRouterFalso } from "../../../../../pruebas/soporte";
import {
  MENSAJES_VENTAS as M,
  PERIODO,
  RESUMEN_BASE,
  V290,
  V292,
  V_DESCUADRADA,
  V_HOSTIL,
  V_MANUAL,
  instalarFetchVentas,
  paginaDe,
  type EstadoVentas,
} from "../../../../../pruebas/ventas";

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

// Spec 013 · T22b (rojo), D26 (decisión del usuario 2026-11-07 a Q-1, opción (a)): una venta descuadrada de la descarga
// del SIRE se guarda tal cual (D3) y la grilla la MARCA. El backend calcula `cuadra` al leer (`VentaDto.cuadra`); la
// grilla solo lo muestra. Contrato:
//  - La fila con `cuadra: false` muestra el texto M.noCuadra («No cuadra»); las filas con `cuadra: true` no lo muestran.
//  - La marca no esconde ni corrige nada: el total se ve tal como llegó (118.01) y el comprobante sigue en su fila.
//  - La marca es texto (no solo color) y está dentro de la fila de la venta, en la tabla M.tablaVentas.
//  - Una venta manual (que siempre cuadra, D9) no lleva la marca.
//  - El texto hostil del SIRE sigue escapado en una fila marcada (la marca no abre un camino a HTML).

function estado(filas = [V290, V_DESCUADRADA, V292]): Partial<EstadoVentas> {
  return { pagina: paginaDe(filas), resumen: RESUMEN_BASE };
}

async function montar(e: Partial<EstadoVentas> = estado()) {
  busqueda.actual = new URLSearchParams(`periodo=${PERIODO}`);
  const f = instalarFetchVentas({ estado: e });
  render(await cargarPagina());
  await vi.waitFor(() => expect(f.de("GET /api/acceso/yo")).toHaveLength(1));
  return f;
}

const tabla = () => screen.findByRole("region", { name: M.tablaVentas });
function filaDe(contenedor: HTMLElement, texto: string): HTMLElement {
  const f = within(contenedor)
    .queryAllByRole("row")
    .find((r) => r.textContent?.includes(texto));
  if (!f) throw new Error(`no hay fila con "${texto}"`);
  return f;
}

describe("/clientes/:id/ventas · «No cuadra» en la grilla (T22b, D26)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    busqueda.actual = new URLSearchParams();
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("la fila con `cuadra: false` dice «No cuadra» y conserva su comprobante y su total tal como llegaron", async () => {
    await montar();
    const ventas = await tabla();
    const f = await vi.waitFor(() => filaDe(ventas, "B001-294"));
    expect(f.textContent).toContain(M.noCuadra);
    expect(f.textContent).toContain("118.01");
  });

  it("las filas que cuadran no llevan la marca: solo la descuadrada la tiene", async () => {
    await montar();
    const ventas = await tabla();
    await vi.waitFor(() => filaDe(ventas, "B001-294"));
    expect(filaDe(ventas, "B001-290").textContent).not.toContain(M.noCuadra);
    expect(filaDe(ventas, "B001-292").textContent).not.toContain(M.noCuadra);
    expect(within(ventas).getAllByText(M.noCuadra)).toHaveLength(1);
  });

  it("sin ninguna descuadrada, «No cuadra» no aparece en la pantalla", async () => {
    await montar(estado([V290, V292]));
    const ventas = await tabla();
    await vi.waitFor(() => filaDe(ventas, "B001-290"));
    expect(screen.queryByText(M.noCuadra)).toBeNull();
    expect(document.body.textContent).not.toContain(M.noCuadra);
  });

  it("varias descuadradas: cada una lleva su marca", async () => {
    const otra = { ...V_DESCUADRADA, id: "00000010-0000-4000-8000-00000000ffff", numero: "295", total: "117.99" };
    await montar(estado([V290, V_DESCUADRADA, otra]));
    const ventas = await tabla();
    await vi.waitFor(() => filaDe(ventas, "B001-295"));
    expect(within(ventas).getAllByText(M.noCuadra)).toHaveLength(2);
    expect(filaDe(ventas, "B001-295").textContent).toContain(M.noCuadra);
  });

  it("la venta manual (que siempre cuadra) no lleva la marca", async () => {
    await montar(estado([V_MANUAL, V_DESCUADRADA]));
    const ventas = await tabla();
    await vi.waitFor(() => filaDe(ventas, "B001-291"));
    expect(filaDe(ventas, "B001-291").textContent).not.toContain(M.noCuadra);
    expect(filaDe(ventas, "B001-294").textContent).toContain(M.noCuadra);
  });

  it("el texto hostil del SIRE en una fila descuadrada sigue siendo texto, no HTML", async () => {
    await montar(estado([{ ...V_HOSTIL, cuadra: false }]));
    const ventas = await tabla();
    const f = await vi.waitFor(() => filaDe(ventas, "B001-293"));
    expect(f.textContent).toContain(M.noCuadra);
    expect(f.querySelector("img")).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });
});
