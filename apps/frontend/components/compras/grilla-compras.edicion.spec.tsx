import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalcularRespuesta, CuadreCompra } from "@contapp/shared";
import type { ResultadoCompras } from "../../lib/compras";
import {
  C_2056_MIXTA,
  C_3064_BOLSAS,
  FILAS_014,
  MENSAJES_COMPRAS as M,
  filaDe,
  montosDe,
  uuidDe,
} from "../../pruebas/compras";
import { GrillaCompras, type PropsGrillaCompras } from "./grilla-compras";

// Spec 015 · T6 (D-6, D-16; P-3, P-9; CA-4, CA-16): edición por fila con teclado. Enter o F2 abren la fila, Tab pasa
// entre celdas sin guardar, al salir de la fila un solo `editar`, Esc descarta, el total se recalcula al instante
// y `calcular` marca la celda descuadrada con su explicación. Un caso feliz y uno de error por comportamiento.

beforeEach(() => {
  // jsdom no mide el diseño: ancho de sobra para que estén pintadas todas las columnas.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(3200);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CUADRE_IGV: CuadreCompra = {
  cuadra: false,
  celdas: [
    {
      columna: "igvDg",
      cuadra: false,
      explicacion: "El IGV debería ser 27.00 (18 % de la base).",
    },
  ],
};

const respuestaCalcular = (cuadre: CuadreCompra): ResultadoCompras<CalcularRespuesta> => ({
  ok: true,
  status: 200,
  datos: { total: "169.50", cuadre },
});
const calcularCaido: ResultadoCompras<CalcularRespuesta> = {
  ok: false,
  status: 500,
  codigo: "",
  mensaje: "Error",
};

function montar(extra: Partial<PropsGrillaCompras> = {}) {
  const props: PropsGrillaCompras = {
    filas: FILAS_014,
    cargando: false,
    seleccion: new Set<string>(),
    alCambiarSeleccion: vi.fn(),
    renderAcciones: () => null,
    alAbrirHistorial: vi.fn(),
    alGuardarFila: vi.fn(async () => undefined),
    alCalcular: vi.fn(async () => respuestaCalcular({ cuadra: true, celdas: [] })),
    ...extra,
  };
  render(<GrillaCompras {...props} />);
  return props;
}

const celda = (id: string, columna: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-fila="${id}"] [data-col="${columna}"]`)!;
const campo = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>("input[data-edicion]");
const enfocar = (el: HTMLElement) => act(() => el.focus());
const texto = (el: HTMLElement) => el.textContent ?? "";

/** Foco en la celda de monto de F001-3064 y Enter: abre la fila en esa celda. */
async function abrir(user: ReturnType<typeof userEvent.setup>, columna = "biDg") {
  enfocar(celda(C_3064_BOLSAS.id, columna));
  await user.keyboard("{Enter}");
  return campo()!;
}

describe("<GrillaCompras /> · edición por fila (T6)", () => {
  it("feliz (CA-4): Enter, escribir, Tab, Enter guarda con UN solo editar y recalcula el total al instante", async () => {
    const props = montar();
    const user = userEvent.setup();

    const bi = await abrir(user);
    expect(bi).not.toBeNull();
    expect(bi.value).toBe("100.00");
    expect(bi.getAttribute("aria-label")).toBe(M.celdaDe(M.casilleros.biDg, "F001-3064"));

    await user.keyboard("150.00");
    // Total local exacto, sin esperar al servidor: 150.00 + 18.00 + 1.50.
    expect(texto(celda(C_3064_BOLSAS.id, "total"))).toContain("169.50");

    await user.keyboard("{Tab}");
    const igv = campo()!;
    expect(igv.getAttribute("aria-label")).toBe(M.celdaDe(M.casilleros.igvDg, "F001-3064"));
    expect(igv.value).toBe("18.00");
    // Tab no guarda.
    expect(props.alGuardarFila).not.toHaveBeenCalled();

    await user.keyboard("27.00{Enter}");
    expect(props.alGuardarFila).toHaveBeenCalledTimes(1);
    expect(props.alGuardarFila).toHaveBeenCalledWith(C_3064_BOLSAS.id, C_3064_BOLSAS.version, {
      biDg: "150.00",
      igvDg: "27.00",
    });
    // La fila se cerró y el foco quedó en la grilla.
    await vi.waitFor(() => expect(campo()).toBeNull());
  });

  it("las flechas laterales pasan a la celda vecina sin guardar cuando no hay texto que mover", async () => {
    const props = montar();
    const user = userEvent.setup();
    await abrir(user);
    // Recién abierta el texto está seleccionado: ArrowRight va a la celda de al lado.
    await user.keyboard("{ArrowRight}");
    expect(campo()?.getAttribute("aria-label")).toBe(M.celdaDe(M.casilleros.igvDg, "F001-3064"));
    // Con texto y el cursor tras él, la flecha izquierda primero mueve el cursor; recién en el borde cambia de celda.
    await user.keyboard("9");
    await user.keyboard("{ArrowLeft}");
    expect(campo()?.getAttribute("aria-label")).toBe(M.celdaDe(M.casilleros.igvDg, "F001-3064"));
    await user.keyboard("{ArrowLeft}");
    expect(campo()?.getAttribute("aria-label")).toBe(M.celdaDe(M.casilleros.biDg, "F001-3064"));
    expect(props.alGuardarFila).not.toHaveBeenCalled();
  });

  it("la fila ya cerrada vuelve a mostrar el valor del servidor (el padre actualiza la fila)", async () => {
    const props = montar();
    const user = userEvent.setup();
    await abrir(user);
    await user.keyboard("150.00{Enter}");
    await vi.waitFor(() => expect(campo()).toBeNull());
    // Sin actualización optimista: hasta que el padre no cambia `filas`, la celda sigue con el valor del servidor.
    expect(texto(celda(C_3064_BOLSAS.id, "biDg"))).toBe("100.00");
    expect(props.alGuardarFila).toHaveBeenCalledTimes(1);
  });

  it("F2 y doble clic también abren la fila; Enter sin cambios no pide nada", async () => {
    const props = montar();
    const user = userEvent.setup();
    enfocar(celda(C_3064_BOLSAS.id, "igvDg"));
    await user.keyboard("{F2}");
    expect(campo()?.value).toBe("18.00");
    await user.keyboard("{Enter}");
    expect(props.alGuardarFila).not.toHaveBeenCalled();
    expect(campo()).toBeNull();

    fireEvent.doubleClick(celda(C_2056_MIXTA.id, "biDg"));
    expect(campo()?.value).toBe("21.48");
  });

  it("flecha vertical o foco en otra fila guardan la fila con un solo editar", async () => {
    const props = montar();
    const user = userEvent.setup();
    await abrir(user);
    await user.keyboard("120.00{ArrowDown}");
    expect(props.alGuardarFila).toHaveBeenCalledTimes(1);
    expect(props.alGuardarFila).toHaveBeenLastCalledWith(C_3064_BOLSAS.id, 1, { biDg: "120.00" });
    await vi.waitFor(() => expect(campo()).toBeNull());

    // Clic en otra fila.
    await abrir(user, "isc");
    await user.keyboard("5.00");
    enfocar(celda(C_2056_MIXTA.id, "tipo"));
    await vi.waitFor(() => expect(props.alGuardarFila).toHaveBeenCalledTimes(2));
    expect(props.alGuardarFila).toHaveBeenLastCalledWith(C_3064_BOLSAS.id, 1, { isc: "5.00" });
  });

  it("la celda cuyo IGV no cuadra se marca con su explicación visible y aria-invalid (CA-4)", async () => {
    const props = montar({
      alCalcular: vi.fn(async () => respuestaCalcular(CUADRE_IGV)),
    });
    const user = userEvent.setup();
    await abrir(user);
    await user.keyboard("150.00");
    // Antes de los 300 ms no se pide nada; se pide una sola vez con lo tecleado.
    expect(props.alCalcular).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(props.alCalcular).toHaveBeenCalledTimes(1));
    expect(props.alCalcular).toHaveBeenCalledWith(C_3064_BOLSAS.id, { biDg: "150.00" });

    const explicacion = await screen.findByText(
      new RegExp("El IGV debería ser 27.00 \\(18 % de la base\\)"),
    );
    const igv = celda(C_3064_BOLSAS.id, "igvDg");
    expect(igv.getAttribute("aria-invalid")).toBe("true");
    expect(igv.getAttribute("aria-describedby")).toBe(explicacion.id);
    // La BI sí cuadra: no se marca.
    expect(celda(C_3064_BOLSAS.id, "biDg").getAttribute("aria-invalid")).toBeNull();
    // El descuadre no impide guardar.
    await user.keyboard("{Enter}");
    expect(props.alGuardarFila).toHaveBeenCalledTimes(1);
  });

  it("error: `calcular` caído mantiene el total local y avisa «cuadre no verificado»", async () => {
    montar({ alCalcular: vi.fn(async () => calcularCaido) });
    const user = userEvent.setup();
    await abrir(user);
    await user.keyboard("150.00");
    expect(await screen.findAllByText(new RegExp(M.cuadreNoVerificado))).not.toHaveLength(0);
    expect(texto(celda(C_3064_BOLSAS.id, "total"))).toContain("169.50");
    expect(celda(C_3064_BOLSAS.id, "igvDg").getAttribute("aria-invalid")).toBeNull();
  });

  it("error: un monto con 3 decimales no se envía, se explica y la fila sigue abierta", async () => {
    const props = montar();
    const user = userEvent.setup();
    await abrir(user);
    await user.keyboard("100.505{Enter}");
    expect(props.alGuardarFila).not.toHaveBeenCalled();
    expect(props.alCalcular).not.toHaveBeenCalled();
    expect(campo()).not.toBeNull();
    expect((await screen.findAllByText(new RegExp(M.montoMasDeDosDecimales))).length).toBeGreaterThan(0);
    expect(campo()!.getAttribute("aria-invalid")).toBe("true");
    expect(celda(C_3064_BOLSAS.id, "biDg").getAttribute("aria-invalid")).toBe("true");

    // Corregido, ya se guarda.
    await user.keyboard("{Control>}a{/Control}100.50{Enter}");
    expect(props.alGuardarFila).toHaveBeenCalledWith(C_3064_BOLSAS.id, 1, { biDg: "100.50" });
  });

  it("Esc descarta la fila: no guarda, vuelve el valor original y el foco a la celda", async () => {
    const props = montar();
    const user = userEvent.setup();
    await abrir(user);
    await user.keyboard("999.00{Escape}");
    expect(campo()).toBeNull();
    expect(props.alGuardarFila).not.toHaveBeenCalled();
    expect(texto(celda(C_3064_BOLSAS.id, "biDg"))).toBe("100.00");
    expect(texto(celda(C_3064_BOLSAS.id, "total"))).toBe("119.50");
    expect(document.activeElement).toBe(celda(C_3064_BOLSAS.id, "biDg"));
    expect(await screen.findByText(M.edicionCancelada)).toBeTruthy();
  });

  it("error: un `calcular` tardío no pisa la fila que ya se cerró", async () => {
    let responder!: (r: ResultadoCompras<CalcularRespuesta>) => void;
    const alCalcular = vi.fn(
      () => new Promise<ResultadoCompras<CalcularRespuesta>>((resolver) => (responder = resolver)),
    );
    montar({ alCalcular });
    const user = userEvent.setup();
    await abrir(user);
    await user.keyboard("150.00");
    await vi.waitFor(() => expect(alCalcular).toHaveBeenCalledTimes(1));
    await user.keyboard("{Escape}");
    expect(campo()).toBeNull();

    // Llega tarde, con descuadre: la fila ya no está en edición.
    await act(async () => responder(respuestaCalcular(CUADRE_IGV)));
    expect(screen.queryByText(new RegExp("El IGV debería ser 27.00"))).toBeNull();
    // Y al abrirla de nuevo no queda nada del cuadre anterior.
    await abrir(user);
    expect(screen.queryByText(new RegExp("El IGV debería ser 27.00"))).toBeNull();
    expect(celda(C_3064_BOLSAS.id, "igvDg").getAttribute("aria-invalid")).toBeNull();
  });

  it("si el guardado falla (`mantener`) el borrador sigue abierto para corregir o reintentar", async () => {
    const alGuardarFila = vi.fn(async () => "mantener" as const);
    montar({ alGuardarFila });
    const user = userEvent.setup();
    await abrir(user);
    await user.keyboard("150.00{Enter}");
    await vi.waitFor(() => expect(alGuardarFila).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(campo()?.readOnly).toBe(false));
    expect(campo()!.value).toBe("150.00");
    await user.keyboard("{Enter}");
    expect(alGuardarFila).toHaveBeenCalledTimes(2);
  });

  it("no se pegan varias celdas (P-9): se rechaza con su explicación; un valor suelto sí vale", async () => {
    montar();
    const user = userEvent.setup();
    const bi = await abrir(user);
    fireEvent.paste(bi, { clipboardData: { getData: () => "1.00\t2.00\n3.00\t4.00" } });
    expect((await screen.findAllByText(M.pegarRango)).length).toBeGreaterThan(0);
    expect(bi.value).toBe("100.00");

    await user.keyboard("{Control>}a{/Control}");
    await user.paste("77.70");
    expect(campo()!.value).toBe("77.70");
  });

  it("solo lectura y filas excluidas: Enter, F2 y doble clic no abren la edición", async () => {
    const excluida = filaDe({
      id: uuidDe(5, 1),
      numero: "8001",
      excluida: true,
      motivo: "Gasto personal",
      montos: montosDe({ biDg: "10.00", igvDg: "1.80" }),
    });
    const props = montar({ soloLectura: M.soloLectura.generado, filas: [...FILAS_014, excluida] });
    const user = userEvent.setup();
    enfocar(celda(C_3064_BOLSAS.id, "biDg"));
    await user.keyboard("{Enter}");
    await user.keyboard("{F2}");
    fireEvent.doubleClick(celda(C_3064_BOLSAS.id, "biDg"));
    expect(campo()).toBeNull();
    expect(props.alGuardarFila).not.toHaveBeenCalled();
    cleanup();

    const props2 = montar({ filas: [...FILAS_014, excluida] });
    enfocar(celda(excluida.id, "biDg"));
    await user.keyboard("{Enter}");
    fireEvent.doubleClick(celda(excluida.id, "biDg"));
    expect(campo()).toBeNull();
    expect(props2.alGuardarFila).not.toHaveBeenCalled();
  });

  it("sin `alGuardarFila` la grilla es de lectura", async () => {
    montar({ alGuardarFila: undefined });
    const user = userEvent.setup();
    enfocar(celda(C_3064_BOLSAS.id, "biDg"));
    await user.keyboard("{Enter}");
    expect(campo()).toBeNull();
  });

  it("total y fecha no son editables", async () => {
    montar();
    const user = userEvent.setup();
    enfocar(celda(C_3064_BOLSAS.id, "total"));
    await user.keyboard("{Enter}");
    enfocar(celda(C_3064_BOLSAS.id, "fecha"));
    await user.keyboard("{F2}");
    expect(campo()).toBeNull();
  });
});

// Spec 018 · T11d: el foco tras Tab llega siempre a la celda destino. Con un Tab pegado a la última tecla, los
// efectos pasivos del render anterior aún no corrieron; el efecto viejo no debe consumir la marca de foco con la
// celda activa vieja (el campo de «Base DG» se desmonta justo después y el foco caía en `body`). jsdom no reproduce
// el desfase de efectos de React: este caso protege el comportamiento y la lógica de la marca está en foco-grilla.spec.ts.
describe("<GrillaCompras /> · foco tras Tab (018 · T11d)", () => {
  it("feliz: teclear y pulsar Tab en el mismo ciclo deja el foco en el campo «IGV DG»", async () => {
    montar();
    const user = userEvent.setup();
    const bi = await abrir(user);
    // Sin esperar entre la tecla y el Tab: un solo `act`, sin vaciar los efectos pasivos entre ambos.
    act(() => {
      fireEvent.change(bi, { target: { value: "150.00" } });
      fireEvent.keyDown(bi, { key: "Tab" });
    });
    const igv = campo()!;
    expect(igv.getAttribute("aria-label")).toBe(M.celdaDe(M.casilleros.igvDg, "F001-3064"));
    expect(document.activeElement).toBe(igv);
  });
});
