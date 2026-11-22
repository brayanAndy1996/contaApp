import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MENSAJES_PRORRATA as M, anchosFijosMayoresA390, mesDe, mesFaltaDe, ventanaDe } from "../../pruebas/prorrata";
import { GraficoProrrata } from "./grafico-prorrata";

// Spec 026 · T7 (rojo; D-8, RNF-070). Gráfico de barras en SVG propio (sin dependencias nuevas).
// Contrato (T13), `components/prorrata/grafico-prorrata.tsx`: <GraficoProrrata meses={MesVista[12]} />.
//   - <svg role="img"> con nombre accesible M.tituloGrafico (también como <title> hijo directo) y `viewBox` (sin ancho fijo).
//   - Por mes, dos <rect>: serie «gravadas más exportaciones» y serie «no gravadas». Atributos de prueba:
//       data-periodo="AAAAMM", data-serie="gravadas_exportaciones" | "no_gravadas", y data-negativo="true" cuando el
//       valor de la barra es negativo (la barra se dibuja hacia abajo del eje con altura positiva).
//     Los atributos geométricos (x, y, width, height) son números finitos y las alturas, mayores o iguales a 0.
//   - Tabla accesible con nombre M.tablaGrafico y columnas M.columnasGrafico, 12 filas con los valores como llegan
//     (gravadas + exportaciones se muestran ya sumadas).
//   - Solo tokens de color: ningún `#rrggbb`.

afterEach(() => cleanup());

const barras = (c: HTMLElement) => [...c.querySelectorAll<SVGRectElement>("svg rect[data-serie]")];
const alto = (r: Element) => Number(r.getAttribute("height"));

const ventana = (parcial: Record<string, ReturnType<typeof mesDe>> = {}) =>
  ventanaDe("202610").map((p) => parcial[p] ?? mesDe(p));

describe("<GraficoProrrata /> · SVG accesible (D-8)", () => {
  it("es una imagen con título y viewBox, sin ancho fijo", () => {
    const { container } = render(<GraficoProrrata meses={ventana()} />);
    const svg = screen.getByRole("img", { name: M.tituloGrafico });
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.querySelector(":scope > title")?.textContent).toBe(M.tituloGrafico);
    expect(svg.getAttribute("viewBox")).toBeTruthy();
    const ancho = svg.getAttribute("width");
    expect(ancho === null || ancho === "100%").toBe(true);
    expect(anchosFijosMayoresA390(container)).toEqual([]);
  });

  it("tabla accesible con los 12 meses y los valores del gráfico", () => {
    render(<GraficoProrrata meses={ventana({ "202603": mesDe("202603", { gravadas: "70000.00", exportaciones: "30000.50", noGravadas: "1234.00", total: "101234.50" }) })} />);
    const tabla = screen.getByRole("table", { name: M.tablaGrafico });
    const encabezados = within(tabla).getAllByRole("columnheader").map((c) => c.textContent?.trim());
    for (const titulo of Object.values(M.columnasGrafico)) expect(encabezados).toContain(titulo);
    const filas = within(tabla).getAllByRole("row").filter((f) => f.querySelector("td, [role=cell]"));
    expect(filas).toHaveLength(12);
    const marzo = filas.find((f) => f.textContent?.includes("2026-03"))!;
    expect(marzo.textContent).toContain("100000.50");
    expect(marzo.textContent).toContain("1234.00");
    const noviembre = filas.find((f) => f.textContent?.includes("2025-11"))!;
    expect(noviembre.textContent).toContain("100000.00");
    expect(noviembre.textContent).toContain("20000.00");
  });
});

describe("<GraficoProrrata /> · barras", () => {
  it("dos barras por mes (24), cada una con su periodo y su serie", () => {
    const { container } = render(<GraficoProrrata meses={ventana()} />);
    const rects = barras(container);
    expect(rects).toHaveLength(24);
    for (const p of ventanaDe("202610")) {
      const deMes = rects.filter((r) => r.getAttribute("data-periodo") === p);
      expect(deMes.map((r) => r.getAttribute("data-serie")).sort()).toEqual(["gravadas_exportaciones", "no_gravadas"]);
    }
  });

  it("la altura es proporcional al valor: 100000 es cinco veces 20000 y valores iguales dan alturas iguales", () => {
    const { container } = render(<GraficoProrrata meses={ventana()} />);
    const rects = barras(container).filter((r) => r.getAttribute("data-periodo") === "202511");
    const g = alto(rects.find((r) => r.getAttribute("data-serie") === "gravadas_exportaciones")!);
    const n = alto(rects.find((r) => r.getAttribute("data-serie") === "no_gravadas")!);
    expect(g).toBeGreaterThan(n);
    expect(g / n).toBeCloseTo(5, 1);
    const otro = barras(container).filter((r) => r.getAttribute("data-periodo") === "202610");
    expect(alto(otro.find((r) => r.getAttribute("data-serie") === "gravadas_exportaciones")!)).toBeCloseTo(g, 5);
  });

  it("las exportaciones se suman a las gravadas en la misma barra", () => {
    const { container } = render(
      <GraficoProrrata
        meses={ventana({
          "202604": mesDe("202604", { gravadas: "60000.00", exportaciones: "40000.00", noGravadas: "20000.00", total: "120000.00" }),
        })}
      />,
    );
    const g = (p: string) =>
      alto(barras(container).find((r) => r.getAttribute("data-periodo") === p && r.getAttribute("data-serie") === "gravadas_exportaciones")!);
    expect(g("202604")).toBeCloseTo(g("202511"), 5);
  });

  it("un mes negativo (más notas de crédito que ventas) se dibuja hacia abajo con altura positiva y marcado", () => {
    const { container } = render(
      <GraficoProrrata
        meses={ventana({
          "202607": mesDe("202607", { gravadas: "-8000.00", exportaciones: "0.00", noGravadas: "1000.00", total: "-7000.00" }),
        })}
      />,
    );
    const rects = barras(container).filter((r) => r.getAttribute("data-periodo") === "202607");
    const g = rects.find((r) => r.getAttribute("data-serie") === "gravadas_exportaciones")!;
    const n = rects.find((r) => r.getAttribute("data-serie") === "no_gravadas")!;
    expect(g.getAttribute("data-negativo")).toBe("true");
    expect(n.getAttribute("data-negativo")).not.toBe("true");
    expect(alto(g)).toBeGreaterThan(0);
    expect(barras(container).filter((r) => r.getAttribute("data-negativo") === "true")).toHaveLength(1);
  });

  it("todas las medidas son números finitos y las alturas no son negativas (incluso con todos los meses en falta)", () => {
    const { container } = render(<GraficoProrrata meses={ventanaDe("202610").map((p) => mesFaltaDe(p))} />);
    const rects = barras(container);
    expect(rects).toHaveLength(24);
    for (const r of rects) {
      for (const a of ["x", "y", "width", "height"]) {
        const v = Number(r.getAttribute(a));
        expect(Number.isFinite(v), `${a}=${r.getAttribute(a)}`).toBe(true);
      }
      expect(alto(r)).toBeGreaterThanOrEqual(0);
      expect(alto(r)).toBe(0);
    }
  });

  it("solo tokens de color: sin #rrggbb en el SVG", () => {
    const { container } = render(<GraficoProrrata meses={ventana()} />);
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{6}/);
  });
});
