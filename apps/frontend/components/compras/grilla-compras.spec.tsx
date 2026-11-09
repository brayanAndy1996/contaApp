import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilaCompraVista } from "@contapp/shared";
import {
  C_1040_ISC,
  C_2056_MIXTA,
  C_3064_BOLSAS,
  FILAS_014,
  MENSAJES_COMPRAS as M,
  TEXTO_HOSTIL,
  filaDe,
  generarFilas,
  montosDe,
  uuidDe,
} from "../../pruebas/compras";
import { GrillaCompras, type PropsGrillaCompras } from "./grilla-compras";

// Contrato (spec 015, T4; D-5, D-16; P-5, P-8; CA-1, CA-2, CA-12, base de CA-16): la grilla de lectura pinta
// las columnas por casillero, el destino informativo, las alertas con icono y texto, la etiqueta
// «Proveedor nuevo», las secciones «con IGV» / «sin IGV» / «excluidas», se virtualiza en filas y en columnas
// y se recorre con el teclado. El texto del SIRE se ve como texto.

const ANCHO_VENTANA = 1200;
const ALTO_VENTANA = 480;

beforeEach(() => {
  // jsdom no mide el diseño: el virtualizador lee `clientWidth`/`clientHeight` del contenedor.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(ANCHO_VENTANA);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(ALTO_VENTANA);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MIXTA = filaDe({
  id: uuidDe(3, 1),
  numero: "6001",
  montos: montosDe({ biDg: "1234567.89", igvDg: "222222.22", biDng: "50.00" }),
});
const SIN_BASE = filaDe({
  id: uuidDe(3, 2),
  numero: "6002",
  montos: montosDe({ icbper: "0.50" }),
});
const EXCLUIDA = filaDe({
  id: uuidDe(3, 3),
  numero: "6003",
  excluida: true,
  motivo: "Gasto personal",
});

function montar(filas: readonly FilaCompraVista[], extra: Partial<PropsGrillaCompras> = {}) {
  const props: PropsGrillaCompras = {
    filas,
    cargando: false,
    seleccion: new Set<string>(),
    alCambiarSeleccion: vi.fn(),
    renderAcciones: (f) => <span>acciones {f.numero}</span>,
    alAbrirHistorial: vi.fn(),
    ...extra,
  };
  render(<GrillaCompras {...props} />);
  return props;
}

const filaDeComprobante = (numero: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>("[data-fila]")].find((f) =>
    f.textContent?.includes(`F001-${numero}`),
  )!;
const atributo = (el: Element, nombre: string) => el.getAttribute(nombre);

describe("<GrillaCompras />", () => {
  it("lista las compras de 014 con columnas, destino, alerta, etiqueta y secciones (CA-1, CA-12)", () => {
    montar([...FILAS_014, MIXTA, SIN_BASE, EXCLUIDA]);

    const grilla = screen.getByRole("grid", { name: M.tablaCompras });
    expect(atributo(grilla, "aria-multiselectable")).toBe("true");

    // Encabezados por casillero (nombre completo) y grupos.
    for (const nombre of ["Base DG", "IGV DG", "Base DGNG", "IGV DNG", "No gravado", "ISC", "ICBPER", "Otros", "Total"]) {
      expect(within(grilla).getAllByRole("columnheader", { name: nombre }).length).toBeGreaterThan(0);
    }
    expect(within(grilla).getByRole("columnheader", { name: "DG" })).not.toBeNull();

    // Secciones con su cantidad: 1040 (IGV 0) y SIN_BASE sin IGV; el resto con IGV; una excluida.
    expect(screen.getByText("Con IGV (5)")).not.toBeNull();
    expect(screen.getByText("Sin IGV (2)")).not.toBeNull();
    expect(screen.getByText("Excluidas (1)")).not.toBeNull();

    // F001-1040: R-ISC con icono y texto, sin IGV.
    const f1040 = filaDeComprobante("1040");
    expect(atributo(f1040, "data-seccion")).toBe("sin_igv");
    expect(within(f1040).getByText(/Con alerta: R-ISC/)).not.toBeNull();
    expect(within(f1040).getByText("770.00", { selector: '[data-col="biDg"]' })).not.toBeNull();
    expect(within(f1040).getByText("DG", { selector: "span" })).not.toBeNull();

    // F001-3064: proveedor nuevo y por clasificar.
    const f3064 = filaDeComprobante("3064");
    expect(within(f3064).getByText(M.proveedorNuevo)).not.toBeNull();
    expect(within(f3064).getByText(M.porClasificar)).not.toBeNull();
    expect(C_3064_BOLSAS.proveedorNuevo).toBe(true);

    // F001-4062: USD con su tipo de cambio.
    expect(within(filaDeComprobante("4062")).getByText("TC 3.300")).not.toBeNull();

    // Miles en los montos y destino informativo.
    const mixta = filaDeComprobante("6001");
    expect(within(mixta).getByText("1,234,567.89")).not.toBeNull();
    expect(within(mixta).getByText(M.destinos.Mixta)).not.toBeNull();
    expect(within(filaDeComprobante("6002")).getByText(M.destinos["Sin base"])).not.toBeNull();
    expect(atributo(filaDeComprobante("6003"), "data-seccion")).toBe("excluidas");

    // Lupa deshabilitada con su texto; Historial abre el panel con el id de la fila.
    const lupa = within(f1040).getByRole("button", { name: `${M.columnas.lupa}: ${M.lupaDeshabilitada}` });
    expect((lupa as HTMLButtonElement).disabled).toBe(true);
    expect(C_1040_ISC.hallazgos).toHaveLength(1);
  });

  it("muestra la razón social del SIRE como texto, sin interpretarla (CA-2)", () => {
    montar([
      filaDe({
        id: uuidDe(3, 9),
        numero: "7001",
        proveedor: { tipo: "6", numero: "20700000099", razonSocial: TEXTO_HOSTIL },
      }),
    ]);

    const fila = filaDeComprobante("7001");
    expect(atributo(within(fila).getByText(TEXTO_HOSTIL), "title")).toBe(TEXTO_HOSTIL);
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("[onerror]")).toBeNull();
  });

  it("con 5.000 filas solo pinta las visibles más un margen, en filas y en columnas (CA-16)", () => {
    montar(generarFilas(5000));

    const filas = document.querySelectorAll("[data-fila]");
    expect(filas.length).toBeGreaterThan(5);
    expect(filas.length).toBeLessThan(40);
    expect(atributo(screen.getByRole("grid"), "aria-rowcount")).toBe(String(5000 + 2 + 2));

    // 21 columnas en total: las del centro se pintan por ventana.
    const celdas = filas[0]!.querySelectorAll('[role="gridcell"]');
    expect(celdas.length).toBeLessThan(21);
    expect(celdas.length).toBeGreaterThan(7);
    // Las fijas siempre están: identidad a la izquierda, total y acciones a la derecha.
    for (const col of ["seleccionar", "comprobante", "proveedor", "total", "acciones"]) {
      expect(filas[0]!.querySelector(`[data-col="${col}"]`)).not.toBeNull();
    }
    expect(filas[0]!.querySelector('[data-col="isc"]')).toBeNull();
  });

  it("se recorre con el teclado: flechas, Inicio/Fin, Tab, Ctrl+Fin y espacio (D-16)", async () => {
    const usuario = userEvent.setup();
    const props = montar(FILAS_014);
    const activa = () => document.activeElement as HTMLElement;
    const posicion = () => `${activa().dataset.r},${activa().dataset.c}`;

    const primera = document.querySelector<HTMLElement>('[data-r="0"][data-c="0"]')!;
    primera.focus();
    expect(posicion()).toBe("0,0");

    await usuario.keyboard("{ArrowRight}");
    expect(posicion()).toBe("0,1");
    await usuario.keyboard("{ArrowDown}");
    expect(posicion()).toBe("1,1");
    await usuario.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(posicion()).toBe("4,1"); // se detiene en la última fila
    await usuario.keyboard("{ArrowUp}");
    expect(posicion()).toBe("3,1");

    await usuario.keyboard("{End}");
    expect(activa().dataset.col).toBe("acciones");
    await usuario.keyboard("{Home}");
    expect(activa().dataset.col).toBe("seleccionar");

    // Tab recorre las celdas de la fila (sin saltar a la columna del centro que está fuera de la ventana).
    await usuario.keyboard("{Tab}{Tab}{Tab}{Tab}");
    expect(activa().dataset.col).toBe("fecha");
    expect(posicion()).toBe("3,4");
    await usuario.keyboard("{Shift>}{Tab}{/Shift}");
    expect(posicion()).toBe("3,3");

    await usuario.keyboard("{Control>}{End}{/Control}");
    expect(posicion()).toBe("4,20");
    await usuario.keyboard("{Control>}{Home}{/Control}");
    expect(posicion()).toBe("0,0");

    // Espacio alterna la selección de la fila de la celda activa.
    await usuario.keyboard(" ");
    expect(props.alCambiarSeleccion).toHaveBeenCalledWith(new Set([C_2056_MIXTA.id]));
  });

  it("con 5.000 filas la celda activa sigue en el DOM al saltar al final y sigue habiendo pocas filas", async () => {
    const usuario = userEvent.setup();
    montar(generarFilas(5000));
    document.querySelector<HTMLElement>('[data-r="0"][data-c="0"]')!.focus();

    await usuario.keyboard("{Control>}{End}{/Control}");
    const activa = document.activeElement as HTMLElement;
    expect(activa.dataset.r).toBe("4999");
    expect(activa.dataset.col).toBe("acciones");
    expect(document.querySelectorAll("[data-fila]").length).toBeLessThan(40);

    await usuario.keyboard("{PageUp}");
    expect((document.activeElement as HTMLElement).dataset.r).toBe("4989");
  });

  it("la casilla de la fila y «Historial» avisan a la pantalla", () => {
    const props = montar(FILAS_014);
    const f1040 = filaDeComprobante("1040");

    fireEvent.click(within(f1040).getByRole("checkbox", { name: M.seleccionarFila("F001-1040") }));
    expect(props.alCambiarSeleccion).toHaveBeenCalledWith(new Set([C_1040_ISC.id]));

    fireEvent.click(within(f1040).getByRole("button", { name: /Historial de F001-1040/ }));
    expect(props.alAbrirHistorial).toHaveBeenCalledWith(C_1040_ISC.id);
    expect(within(f1040).getByText("acciones 1040")).not.toBeNull();
  });

  it("sin compras muestra el aviso y, cargando, «Cargando…»", () => {
    montar([]);
    expect(screen.getByRole("status").textContent).toBe(M.sinCompras);
    cleanup();
    montar([], { cargando: true });
    expect(screen.getByRole("status").textContent).toBe(M.cargando);
    expect(atributo(screen.getByRole("grid"), "aria-busy")).toBe("true");
  });
});
