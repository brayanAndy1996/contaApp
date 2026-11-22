import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MENSAJES_PRORRATA as M, anchosFijosMayoresA390 } from "../../pruebas/prorrata";
import { Coeficiente } from "./coeficiente";

// Spec 026 · T19 (tester; H-026-2-4, rojo). Coeficiente «no determinable» por montos fuera de rango (decisión del usuario, 2026-11-22):
// con los 12 meses sumando más de lo que cabe en NUMERIC(14,2) el servidor responde 200 con `coeficiente = {estado: "no_determinable",
// motivo: "montos_fuera_de_rango"}` y la pantalla lo dice con M.noDeterminable.montos_fuera_de_rango (texto en español, sin el código
// técnico y sin ningún porcentaje). `coeficienteVistaSchema` (shared) debe aceptar ese motivo; si no, el componente no pinta nada.

afterEach(() => cleanup());

const FUERA = { estado: "no_determinable", motivo: "montos_fuera_de_rango" };
const montar = (c: Record<string, unknown>, puedeGestionar = true) =>
  render(<Coeficiente coeficiente={c} puedeGestionar={puedeGestionar} />);

describe("<Coeficiente /> · no determinable por montos fuera de rango (H-026-2-4)", () => {
  it("muestra el aviso en español, sin porcentaje ni el código técnico", () => {
    montar(FUERA);
    expect(screen.getByRole("heading", { name: M.tituloCoeficiente })).toBeTruthy();
    expect(screen.getByText(M.noDeterminable.montos_fuera_de_rango)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\d+,\d{2} %/);
    expect(document.body.textContent).not.toContain("montos_fuera_de_rango");
    expect(document.body.textContent).not.toContain("no_determinable");
  });

  it("no pide ingresar meses ni ofrece enlaces (los meses no faltan)", () => {
    montar(FUERA, true);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByText(M.faltanMeses)).toBeNull();
  });

  it("es un texto distinto de los otros dos motivos", () => {
    expect(M.noDeterminable.montos_fuera_de_rango).not.toBe(M.noDeterminable.total_cero);
    expect(M.noDeterminable.montos_fuera_de_rango).not.toBe(M.noDeterminable.acumulado_invalido);
  });

  it("390 px: sin anchos fijos mayores a la pantalla", () => {
    const { container } = montar(FUERA);
    expect(anchosFijosMayoresA390(container)).toEqual([]);
  });
});
