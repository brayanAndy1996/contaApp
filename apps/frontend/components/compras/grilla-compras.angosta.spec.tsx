import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

// F-4 (verificación de 021): sin columnas fijas la celda activa (columna `seleccionar`, índice 0 del tramo central)
// queda en la ventana aunque la grilla se desplace lejos; las demás columnas se pintaban pegadas a ella, fuera de la
// vista, y las filas de datos parecían en blanco.
describe("<GrillaCompras /> · angosta y desplazada a la derecha (F-4)", () => {
  /** Posición izquierda de cada celda de datos de la primera fila, sumando lo que la precede en la fila. */
  function posicionesDeCeldas(): Map<string, number> {
    const fila = document.querySelector<HTMLElement>("[data-fila]")!;
    const mapa = new Map<string, number>();
    let x = 0;
    for (const hijo of Array.from(fila.children) as HTMLElement[]) {
      const col = hijo.getAttribute("data-col");
      if (col) mapa.set(col, x);
      x += parseFloat(hijo.style.width);
    }
    return mapa;
  }

  /** Posición izquierda real de cada columna, según la fila de encabezados (todos están siempre en el DOM). */
  function posicionesDeEncabezados(): Map<string, number> {
    const ids = new Map<string, number>();
    let x = 0;
    const fila = document.querySelector<HTMLElement>('[role="row"][aria-rowindex="2"]')!;
    const celdas = Array.from(fila.children) as HTMLElement[];
    celdas.forEach((enc) => {
      ids.set(enc.getAttribute("aria-colindex")!, x);
      x += parseFloat(enc.style.width);
    });
    return ids;
  }

  it("390 px con scrollLeft grande: cada celda visible se pinta en la posición de su columna", () => {
    vi.restoreAllMocks();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
    conAncho(true);
    montar();

    const grilla = screen.getByRole("grid");
    act(() => {
      grilla.scrollLeft = 1500;
      fireEvent.scroll(grilla);
    });

    const enFila = posicionesDeCeldas();
    const enEncabezado = posicionesDeEncabezados();
    const visibles = Array.from(document.querySelector("[data-fila]")!.querySelectorAll<HTMLElement>("[data-col]"));
    // Hay celdas en la ventana visible (1500 a 1890 px), no solo la columna activa pegada a la izquierda.
    const dentro = visibles.filter((c) => {
      const x = enFila.get(c.getAttribute("data-col")!)!;
      return x + parseFloat(c.style.width) > 1500 && x < 1890;
    });
    expect(dentro.length).toBeGreaterThan(0);
    for (const c of visibles) {
      const indice = c.getAttribute("aria-colindex")!;
      expect(enFila.get(c.getAttribute("data-col")!)).toBe(enEncabezado.get(indice));
    }
  });
});
