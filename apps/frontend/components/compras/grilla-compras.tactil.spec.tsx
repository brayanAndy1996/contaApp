import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { C_1040_ISC, C_2056_MIXTA, MENSAJES_COMPRAS as M, uuidDe } from "../../pruebas/compras";
import { contextoDe } from "../../pruebas/contexto-compras";
import { reiniciarSesion } from "../../lib/sesion";
import { TEXTOS_GRILLA as T } from "./columnas-compras";
import { GrillaCompras } from "./grilla-compras";
import { HistorialCompra } from "./historial-compra";
import { InformeMasivo } from "./informe-masivo";

// Spec 038 · T-final-c, T-final-e y T-final-f: lo que se ve cortado o corto de área táctil en celular.
// jsdom no mide el diseño: se fijan las clases que lo producen y los textos que siguen a la vista.

beforeEach(() => {
  reiniciarSesion();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function montar() {
  render(
    <GrillaCompras
      filas={[C_1040_ISC, C_2056_MIXTA]}
      cargando={false}
      seleccion={new Set<string>()}
      alCambiarSeleccion={vi.fn()}
      renderAcciones={(f) => <span>acciones {f.numero}</span>}
      alAbrirHistorial={vi.fn()}
    />,
  );
}

describe("GrillaCompras · texto completo y área táctil (038 T-final-e, T-final-f)", () => {
  it("la casilla de cada fila queda dentro de una etiqueta de 44 px bajo 1024 px", () => {
    montar();
    const casilla = screen.getAllByRole("checkbox")[0]!;
    const etiqueta = casilla.closest("label")!;
    expect(etiqueta.className).toContain("max-lg:size-11");
    expect(etiqueta.className).toContain("max-lg:-mx-2");
    // El nombre accesible no cambia.
    expect(casilla.getAttribute("aria-label")).toMatch(/^Seleccionar /);
  });

  it("el chip de alerta conserva el texto completo y su `title` también lo lleva", () => {
    montar();
    const reglas = C_1040_ISC.hallazgos.map((h) => h.regla).join(", ");
    const texto = screen.getAllByText(T.alertaDe(reglas))[0]!;
    expect(texto.className).toContain("truncate");
    const chip = texto.closest("[data-slot=badge]")!;
    expect(chip.getAttribute("title")).toContain(T.alertaDe(reglas));
    expect(chip.className).toContain("max-w-full");
  });

  it("el encabezado de la lupa no pierde sentido: texto corto «Lupa» y nombre completo accesible", () => {
    montar();
    const cabecera = screen.getByRole("columnheader", { name: M.columnas.lupa });
    expect(cabecera.textContent).toBe("Lupa");
    expect(cabecera.getAttribute("title")).toBe(M.columnas.lupa);
  });

  it("la columna Comprobante es más ancha que el chip y Destino cabe «Por clasificar»", () => {
    montar();
    const ancho = (id: string) => {
      const celda = document.querySelector<HTMLElement>(`[data-col="${id}"]`)!;
      return Number.parseInt(celda.style.width, 10);
    };
    expect(ancho("comprobante")).toBeGreaterThanOrEqual(216);
    expect(ancho("destino")).toBeGreaterThanOrEqual(116);
  });
});

describe("HistorialCompra e InformeMasivo · celular (038 T-final-c, T-final-f)", () => {
  it("el panel de historial nunca excede el ancho de la ventana", () => {
    render(<HistorialCompra contexto={contextoDe()} compraId={C_1040_ISC.id} alCerrar={vi.fn()} />);
    const panel = screen.getByRole("complementary", { name: M.tituloHistorial });
    expect(panel.className).toContain("max-w-[100vw]");
    expect(panel.className).not.toContain("max-w-full");
  });

  it("«Cerrar» del informe masivo mide 44 px de alto bajo 1024 px", () => {
    render(
      <InformeMasivo
        informe={{ operacionId: uuidDe(9, 1), aplicadas: 1, rechazadas: [] }}
        filas={[C_1040_ISC]}
        alCerrar={vi.fn()}
      />,
    );
    expect(within(document.body).getByRole("button", { name: M.cerrar }).className).toContain("max-lg:h-11");
  });
});
