import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MENSAJES_PRORRATA as M, anchosFijosMayoresA390, igvDe, valorDe } from "../../pruebas/prorrata";
import { IgvEstimado } from "./igv-estimado";

// Spec 026 · T19 (tester; H-026-2-6, rojo). IGV estimado con ventas en USD de M sin tipo de cambio (decisión del usuario, 2026-11-22):
// `igvEstimado.avisos` (solo en estado «calculado») = ["ventas_usd_sin_tipo_cambio"] y la pantalla muestra, como texto,
// «Hay ventas en USD sin tipo de cambio; no se incluyeron» (M.avisosIgv.ventas_usd_sin_tipo_cambio), junto al resultado. Sin el aviso (clave
// ausente o lista vacía) no se muestra nada nuevo. `igvEstimadoVistaSchema` (shared) debe conservar `avisos`; si no, el aviso no llega.

afterEach(() => cleanup());

const AVISO = "Hay ventas en USD sin tipo de cambio; no se incluyeron";

describe("<IgvEstimado /> · aviso de ventas USD sin tipo de cambio (H-026-2-6)", () => {
  it("el texto del contrato es el que fijó el usuario", () => {
    expect(M.avisosIgv.ventas_usd_sin_tipo_cambio).toBe(AVISO);
  });

  it("con el aviso: lo muestra como texto y mantiene los componentes y el resultado", () => {
    render(<IgvEstimado igv={igvDe({ avisos: ["ventas_usd_sin_tipo_cambio"] })} />);
    expect(screen.getByText(AVISO)).toBeTruthy();
    expect(valorDe(M.situacion.a_pagar)).toBe("6000.00");
    expect(valorDe(M.componentes.igvVentas)).toBe("18000.00");
    expect(document.body.textContent).not.toContain("ventas_usd_sin_tipo_cambio");
  });

  it("el aviso va dentro de la tarjeta del IGV estimado (bajo su título), no suelto en la página", () => {
    const { container } = render(<IgvEstimado igv={igvDe({ avisos: ["ventas_usd_sin_tipo_cambio"] })} />);
    const aviso = screen.getByText(AVISO);
    expect(container.contains(aviso)).toBe(true);
    expect(aviso.closest("[aria-labelledby='titulo-igv']")).not.toBeNull();
  });

  it.each([["clave ausente", igvDe()], ["lista vacía", igvDe({ avisos: [] })]])("sin aviso (%s): no muestra el texto", (_n, igv) => {
    render(<IgvEstimado igv={igv} />);
    expect(screen.queryByText(AVISO)).toBeNull();
    expect(valorDe(M.situacion.a_pagar)).toBe("6000.00");
  });

  it("no estimable: no hay montos ni aviso", () => {
    render(<IgvEstimado igv={{ estado: "no_estimable", motivo: "sin_compras" }} />);
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it("390 px: sin anchos fijos mayores a la pantalla", () => {
    const { container } = render(<IgvEstimado igv={igvDe({ avisos: ["ventas_usd_sin_tipo_cambio"] })} />);
    expect(anchosFijosMayoresA390(container)).toEqual([]);
  });
});
