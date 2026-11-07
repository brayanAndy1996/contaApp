import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../../lib/sesion";
import { clienteDe } from "../../../pruebas/clientes";
import { crearRouterFalso } from "../../../pruebas/soporte";
import {
  MENSAJES_TRABAJOS as M,
  TIPO_DESCARGA,
  instalarFetchPanel,
  trabajoDescargaN,
  trabajoN,
  type ConexionStream,
  type OpcionesPanel,
  type PanelFalso,
  type TrabajoPrueba,
} from "../../../pruebas/trabajos";

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

// Spec 013 · T20a (rojo), defecto D-1 de T20 (D24 del usuario, 2026-11-07): el panel de trabajos debe nombrar la
// descarga de la propuesta del SIRE (`sire.propuesta.descargar`) con un texto legible (M.tipos) y mostrar su cliente y
// su periodo. Contrato:
//  - `trabajoVistaSchema` (shared) admite `periodo` (AAAAMM) opcional; los trabajos de otros tipos no lo traen.
//  - El nombre del cliente se resuelve con `GET /api/clientes` (razón social por `clienteId`). Si esa ruta falla o el
//    cliente no está en la lista, la fila sigue mostrando el nombre del tipo y el periodo, sin el UUID ni «undefined».
//  - La fila de una descarga contiene M.tipos[TIPO_DESCARGA], la razón social del cliente y M.periodo(AAAAMM); nunca
//    el código crudo del tipo. Las filas de los demás tipos no cambian (no llevan cliente ni periodo).
//  - El resumen de más de 10 trabajos del mismo tipo también usa el nombre legible.

const CA = "00000000-0000-4000-8000-0000000000c1";
const CB = "00000000-0000-4000-8000-0000000000c2";
const CLIENTES = {
  status: 200,
  cuerpo: [
    clienteDe({ id: CA, razonSocial: "Ventas Mixtas SAC" }),
    clienteDe({ id: CB, razonSocial: "Comercial San Juan SAC" }),
  ],
};

const lista = (trabajos: TrabajoPrueba[]): OpcionesPanel["listado"] => () => ({
  status: 200,
  cuerpo: trabajos,
});

function montar(opciones: OpcionesPanel): PanelFalso {
  const panel = instalarFetchPanel({ clientes: () => CLIENTES, ...opciones });
  render(<Trabajos />);
  return panel;
}
async function conectado(panel: PanelFalso): Promise<ConexionStream> {
  await vi.waitFor(() => expect(panel.conexiones.length).toBeGreaterThanOrEqual(1));
  return panel.conexiones[0]!;
}
function fila(texto: string): HTMLElement {
  const f = screen.queryAllByRole("row").find((r) => r.textContent?.includes(texto));
  if (!f) throw new Error(`no hay fila con "${texto}"`);
  return f;
}
const filasDe = (texto: string) =>
  screen.queryAllByRole("row").filter((r) => r.textContent?.includes(texto));

describe("/trabajos · descarga de la propuesta (T20a, D24)", () => {
  beforeEach(() => {
    Object.assign(router, crearRouterFalso());
    reiniciarSesion();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("nombra la descarga con un texto legible, nunca con el código del tipo", async () => {
    montar({ listado: lista([trabajoDescargaN(1, "en_cola", { clienteId: CA })]) });
    await vi.waitFor(() => fila(M.tipos[TIPO_DESCARGA]));
    expect(fila(M.tipos[TIPO_DESCARGA]).textContent).toContain(M.estados.en_cola);
    expect(screen.queryByText(TIPO_DESCARGA)).toBeNull();
    expect(document.body.textContent).not.toContain(TIPO_DESCARGA);
  });

  it("muestra el cliente y el periodo de cada descarga, de modo que dos clientes se distinguen", async () => {
    montar({
      listado: lista([
        trabajoDescargaN(1, "en_cola", { clienteId: CA, periodo: "202610" }),
        trabajoDescargaN(2, "ejecutando", { clienteId: CB, periodo: "202609" }),
      ]),
    });
    await vi.waitFor(() => fila("Ventas Mixtas SAC"));
    const a = fila("Ventas Mixtas SAC");
    expect(a.textContent).toContain(M.tipos[TIPO_DESCARGA]);
    expect(a.textContent).toContain(M.periodo("202610"));
    expect(a.textContent).not.toContain("Comercial San Juan SAC");
    const b = fila("Comercial San Juan SAC");
    expect(b.textContent).toContain(M.periodo("202609"));
    expect(b.textContent).toContain(M.estados.ejecutando);
    expect(b.textContent).not.toContain(M.periodo("202610"));
  });

  it("si la lista de clientes falla o no trae al cliente, muestra el tipo y el periodo sin UUID ni «undefined»", async () => {
    montar({
      clientes: () => ({ status: 500, cuerpo: { codigo: "x" } }),
      listado: lista([trabajoDescargaN(1, "en_cola", { clienteId: CA, periodo: "202610" })]),
    });
    await vi.waitFor(() => fila(M.tipos[TIPO_DESCARGA]));
    const f = fila(M.tipos[TIPO_DESCARGA]);
    expect(f.textContent).toContain(M.periodo("202610"));
    expect(f.textContent).not.toContain(CA);
    expect(f.textContent).not.toContain("undefined");
    cleanup();
    montar({
      clientes: () => ({ status: 200, cuerpo: [clienteDe({ id: CB, razonSocial: "Otro SAC" })] }),
      listado: lista([trabajoDescargaN(1, "en_cola", { clienteId: CA, periodo: "202610" })]),
    });
    await vi.waitFor(() => fila(M.tipos[TIPO_DESCARGA]));
    expect(fila(M.tipos[TIPO_DESCARGA]).textContent).not.toContain(CA);
  });

  it("un trabajo sin periodo (viejo) no inventa uno: nombre y cliente, sin «Periodo» ni «undefined»", async () => {
    montar({
      listado: lista([trabajoDescargaN(1, "completado", { clienteId: CA, periodo: null })]),
    });
    await vi.waitFor(() => fila("Ventas Mixtas SAC"));
    const f = fila("Ventas Mixtas SAC");
    expect(f.textContent).not.toContain("Periodo");
    expect(f.textContent).not.toContain("undefined");
  });

  it("las filas de otros tipos no cambian: sin cliente ni periodo", async () => {
    montar({
      listado: lista([
        trabajoN(1, "credencial.verificar_sol", "en_cola"),
        trabajoDescargaN(2, "en_cola", { clienteId: CA }),
      ]),
    });
    await vi.waitFor(() => fila("Ventas Mixtas SAC"));
    const sol = fila(M.tipos["credencial.verificar_sol"]);
    expect(sol.textContent).not.toContain("Periodo");
    expect(sol.textContent).not.toContain("Ventas Mixtas SAC");
  });

  it("un evento del stream conserva el nombre, el cliente y el periodo al cambiar el estado", async () => {
    const panel = montar({
      listado: lista([trabajoDescargaN(1, "en_cola", { clienteId: CA, periodo: "202610" })]),
    });
    const conexion = await conectado(panel);
    await vi.waitFor(() => fila("Ventas Mixtas SAC"));
    act(() => conexion.evento(trabajoDescargaN(1, "completado", { clienteId: CA, periodo: "202610" })));
    await vi.waitFor(() => expect(fila("Ventas Mixtas SAC").textContent).toContain(M.estados.completado));
    const f = fila("Ventas Mixtas SAC");
    expect(f.textContent).toContain(M.tipos[TIPO_DESCARGA]);
    expect(f.textContent).toContain(M.periodo("202610"));
    expect(filasDe(M.tipos[TIPO_DESCARGA])).toHaveLength(1);
  });

  it("más de 10 descargas se resumen con el nombre legible del tipo", async () => {
    const muchos = Array.from({ length: 12 }, (_, i) =>
      trabajoDescargaN(i + 1, "completado", { clienteId: CA, periodo: "202610" }),
    );
    montar({ listado: lista(muchos) });
    expect(await screen.findByText(M.resumen(M.tipos[TIPO_DESCARGA], "12", "12"))).toBeTruthy();
    expect(document.body.textContent).not.toContain(TIPO_DESCARGA);
  });
});
