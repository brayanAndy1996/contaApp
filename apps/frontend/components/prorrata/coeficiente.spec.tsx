import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MENSAJES_PRORRATA as M, anchosFijosMayoresA390, coeficienteDe } from "../../pruebas/prorrata";
import { Coeficiente } from "./coeficiente";

// Spec 026 · T7 (rojo; CA-2, CA-3, CA-4, R-2b, R-3, R-4, R-6, D-8). Coeficiente de prorrata.
// Contrato (T13), `components/prorrata/coeficiente.tsx`: <Coeficiente coeficiente={CoeficienteVista} puedeGestionar={boolean} />.
//   - Título M.tituloCoeficiente (encabezado). `calculado`: el porcentaje con coma decimal y « %» (M.porcentaje) y, solo si
//     `provisional`, la etiqueta M.provisional; más los avisos del coeficiente (M.avisosCoeficiente) como texto.
//   - `faltan_meses`: no hay porcentaje; M.faltanMeses y, por cada periodo faltante en el orden recibido, un enlace
//     (role link, nombre M.ingresarFaltante(periodo)) con href `#mes-AAAAMM` (la fila de <TablaMeses>). Sin `puedeGestionar`
//     se listan los periodos como texto «AAAA-MM» sin enlace.
//   - `no_determinable`: M.noDeterminable[motivo] y ningún porcentaje.

afterEach(() => cleanup());

const montar = (c: Record<string, unknown>, puedeGestionar = true) =>
  render(<Coeficiente coeficiente={c} puedeGestionar={puedeGestionar} />);

describe("<Coeficiente /> · calculado (R-3)", () => {
  it.each([
    ["87.34", "87,34 %"],
    ["100.00", "100,00 %"],
    ["0.00", "0,00 %"],
    ["33.33", "33,33 %"],
    ["5.50", "5,50 %"],
  ])("porcentaje %s se muestra «%s» con coma decimal", (porcentaje, texto) => {
    montar(coeficienteDe({ porcentaje }));
    expect(screen.getByText(texto)).toBeTruthy();
    expect(screen.getByRole("heading", { name: M.tituloCoeficiente })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\d\.\d{2} %/);
  });

  it("«Provisional» solo cuando algún mes es SIRE o manual", () => {
    const { unmount } = montar(coeficienteDe({ provisional: true }));
    expect(screen.getByText(M.provisional)).toBeTruthy();
    unmount();
    montar(coeficienteDe({ provisional: false }));
    expect(screen.queryByText(M.provisional)).toBeNull();
  });

  it("numerador 0: 0,00 % válido con el aviso «revisa si esas compras son DNG»", () => {
    montar(coeficienteDe({ porcentaje: "0.00", numerador: "0.00", avisos: ["numerador_cero"] }));
    expect(screen.getByText("0,00 %")).toBeTruthy();
    expect(screen.getByText(M.avisosCoeficiente.numerador_cero)).toBeTruthy();
  });

  it("exportaciones en meses declarados o manuales con meses SIRE: aviso de revisar los meses SIRE (R-2b)", () => {
    montar(coeficienteDe({ provisional: true, avisos: ["exportaciones_en_sire"] }));
    expect(screen.getByText(M.avisosCoeficiente.exportaciones_en_sire)).toBeTruthy();
  });

  it("sin avisos no se pinta ninguno", () => {
    montar(coeficienteDe());
    expect(screen.queryByText(M.avisosCoeficiente.numerador_cero)).toBeNull();
    expect(screen.queryByText(M.avisosCoeficiente.exportaciones_en_sire)).toBeNull();
  });
});

describe("<Coeficiente /> · faltan meses (R-6, CA-4)", () => {
  const faltan = { estado: "faltan_meses", faltantes: ["202511", "202603"] };

  it("no hay porcentaje; lista los faltantes en orden, cada uno con un enlace a su fila", () => {
    montar(faltan);
    expect(screen.getByText(M.faltanMeses)).toBeTruthy();
    const enlaces = screen.getAllByRole("link");
    expect(enlaces.map((e) => e.textContent)).toEqual([M.ingresarFaltante("202511"), M.ingresarFaltante("202603")]);
    expect(enlaces.map((e) => e.getAttribute("href"))).toEqual(["#mes-202511", "#mes-202603"]);
    expect(document.body.textContent).not.toMatch(/\d+,\d{2} %/);
  });

  it("sin permiso de gestión se listan los meses como texto, sin enlaces", () => {
    montar(faltan, false);
    expect(screen.getByText(M.faltanMeses)).toBeTruthy();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(document.body.textContent).toContain("2025-11");
    expect(document.body.textContent).toContain("2026-03");
  });
});

describe("<Coeficiente /> · no determinable (R-4)", () => {
  it.each(["total_cero", "acumulado_invalido"] as const)("motivo %s: texto en español y ningún porcentaje", (motivo) => {
    montar({ estado: "no_determinable", motivo });
    expect(screen.getByText(M.noDeterminable[motivo])).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\d+,\d{2} %/);
    expect(document.body.textContent).not.toContain(motivo);
  });
});

describe("<Coeficiente /> · 390 px", () => {
  it("sin anchos fijos mayores a la pantalla", () => {
    const { container } = montar(coeficienteDe({ provisional: true, avisos: ["numerador_cero", "exportaciones_en_sire"] }));
    expect(anchosFijosMayoresA390(container)).toEqual([]);
  });
});
