import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { C_1040_ISC, C_3064_BOLSAS } from "../../pruebas/compras";
import { GrillaCompras, type PropsGrillaCompras } from "./grilla-compras";

// T23a-1 (prueba manual de 021): a 390 px las columnas fijas de los extremos (886 px) tapaban Comprobante, Proveedor y
// Destino. Bajo 1024 px la grilla no fija columnas; el orden de las columnas no cambia.

beforeEach(() => {
  // jsdom no mide el diseño: se da un ancho que deja en el DOM todas las columnas; lo angosto lo decide matchMedia.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(3200);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const conAncho = (angosta: boolean) =>
  vi.stubGlobal(
    "matchMedia",
    vi.fn((consulta: string) => ({
      matches: angosta,
      media: consulta,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );

function montar() {
  const props: PropsGrillaCompras = {
    filas: [C_1040_ISC, C_3064_BOLSAS],
    cargando: false,
    seleccion: new Set<string>(),
    alCambiarSeleccion: vi.fn(),
    renderAcciones: (f) => <span>acciones {f.numero}</span>,
    alAbrirHistorial: vi.fn(),
  };
  render(<GrillaCompras {...props} />);
}

const celda = (columna: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-fila] [data-col="${columna}"]`)!;
const fija = (el: HTMLElement) => el.style.position === "sticky";
const encabezados = () =>
  screen.getAllByRole("columnheader").map((c) => c.getAttribute("aria-colindex")).filter((x) => x !== null);

describe("<GrillaCompras /> · pantalla angosta (T23a-1)", () => {
  it("ancho normal: identidad a la izquierda y total y acciones a la derecha siguen fijos", () => {
    conAncho(false);
    montar();

    expect(fija(celda("comprobante"))).toBe(true);
    expect(fija(celda("proveedor"))).toBe(true);
    expect(fija(celda("total"))).toBe(true);
    expect(fija(celda("acciones"))).toBe(true);
  });

  it("390 px: ninguna columna queda fija, así la derecha no tapa Comprobante, Proveedor ni Destino", () => {
    conAncho(true);
    montar();

    for (const columna of ["seleccionar", "comprobante", "proveedor", "total", "acciones"]) {
      expect(fija(celda(columna))).toBe(false);
    }
    expect(celda("comprobante").textContent).toMatch(/^F001-/);
    expect(document.querySelector('[role="columnheader"].sticky')).toBeNull();
    // Mismo orden de columnas que a ancho normal: Comprobante sigue en la tercera posición.
    expect(celda("comprobante").getAttribute("aria-colindex")).toBe("3");
    expect(encabezados().length).toBeGreaterThan(0);
  });
});
