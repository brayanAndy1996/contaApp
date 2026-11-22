import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reiniciarSesion } from "../../lib/sesion";
import {
  CLIENTE_PRORRATA,
  MENSAJES_PRORRATA as M,
  OBTENIDA_EN,
  VENTANA_M,
  coeficienteDe,
  igvDe,
  instalarFetchProrrata,
  mesDe,
  valorDe,
  vistaDe,
  type ProrrataVistaPrueba,
} from "../../pruebas/prorrata";
import { ProrrataCliente } from "./prorrata-cliente";

// Spec 026 · T19 (tester; H-026-2-4 y H-026-2-6, rojo) de la pantalla de prorrata del cliente:
//  - H-026-2-4: con `coeficiente = {no_determinable, montos_fuera_de_rango}` e `igvEstimado = {no_estimable, coeficiente}` la pantalla
//    muestra IGUAL la tabla de los 12 meses (con sus montos de 12 dígitos), el gráfico y el aviso del coeficiente
//    (M.noDeterminable.montos_fuera_de_rango); no es un error de carga ni deja la pantalla vacía.
//  - H-026-2-6: con `igvEstimado.avisos = ["ventas_usd_sin_tipo_cambio"]` la pantalla muestra «Hay ventas en USD sin tipo de cambio;
//    no se incluyeron» junto al IGV estimado.

vi.mock("../../lib/trabajos", async (original) => {
  const real = await original<typeof import("../../lib/trabajos")>();
  return { ...real, seguirTrabajos: vi.fn(async () => new Promise<void>(() => undefined)) };
});

beforeEach(() => {
  reiniciarSesion();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(OBTENIDA_EN));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const MAXIMO = "999999999999.99";

function montar(vista: ProrrataVistaPrueba) {
  instalarFetchProrrata({ vista });
  return render(<ProrrataCliente clienteId={CLIENTE_PRORRATA} archivado={false} />);
}

describe("<ProrrataCliente /> · montos fuera de rango (H-026-2-4)", () => {
  const vistaFuera = () =>
    vistaDe({
      ventana: VENTANA_M.map((p) => mesDe(p, { origen: "manual", declaracion: null, gravadas: MAXIMO, exportaciones: "0.00", noGravadas: "0.00", total: MAXIMO })),
      coeficiente: { estado: "no_determinable", motivo: "montos_fuera_de_rango" },
      igvEstimado: { estado: "no_estimable", motivo: "coeficiente" },
    });

  it("muestra la tabla de 12 meses con los montos de 12 dígitos, el gráfico y el aviso del coeficiente", async () => {
    montar(vistaFuera());
    const tabla = await screen.findByRole("table", { name: M.tablaMeses });
    expect(within(tabla).getAllByText("999,999,999,999.99").length).toBeGreaterThanOrEqual(12);
    expect(screen.getByRole("img", { name: M.tituloGrafico })).toBeTruthy();
    expect(screen.getByText(M.noDeterminable.montos_fuera_de_rango)).toBeTruthy();
    expect(screen.getByText(M.noEstimable.coeficiente)).toBeTruthy();
  });

  it("no es un error de carga ni de permiso, y no hay porcentaje ni código técnico", async () => {
    montar(vistaFuera());
    await screen.findByText(M.noDeterminable.montos_fuera_de_rango);
    expect(screen.queryByText(M.errorCarga)).toBeNull();
    expect(screen.queryByText(M.sinPermiso)).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d+,\d{2} %/);
    expect(document.body.textContent).not.toMatch(/montos_fuera_de_rango|resumen_fuera_de_rango|no_determinable/);
  });
});

describe("<ProrrataCliente /> · ventas USD sin tipo de cambio (H-026-2-6)", () => {
  const AVISO = "Hay ventas en USD sin tipo de cambio; no se incluyeron";

  it("con el aviso en el IGV estimado: se muestra el texto junto al resultado", async () => {
    montar(vistaDe({ coeficiente: coeficienteDe(), igvEstimado: igvDe({ avisos: ["ventas_usd_sin_tipo_cambio"] }) }));
    expect(await screen.findByText(AVISO)).toBeTruthy();
    expect(valorDe(M.situacion.a_pagar)).toBe("6,000.00");
    expect(document.body.textContent).not.toContain("ventas_usd_sin_tipo_cambio");
  });

  it("sin el aviso no aparece", async () => {
    montar(vistaDe());
    await screen.findByText(M.notaEstimado);
    expect(screen.queryByText(AVISO)).toBeNull();
  });
});
