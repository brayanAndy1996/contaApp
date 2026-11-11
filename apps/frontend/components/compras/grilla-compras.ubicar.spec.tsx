import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILAS_014, uuidDe } from "../../pruebas/compras";
import { GrillaCompras, type PropsGrillaCompras } from "./grilla-compras";

// Spec 012b, T23a (P-1): «Ubicar en la grilla» del panel «Generar archivo» resalta la fila de compras y, además de
// mover la ventana del virtualizador, lleva la grilla a la vista de la página (antes la fila quedaba fuera de pantalla).

const scrollIntoView = vi.fn();

beforeEach(() => {
  // jsdom no mide el diseño ni trae `scrollIntoView`.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // @ts-expect-error -- se quita el simulacro: jsdom no define el método
  delete Element.prototype.scrollIntoView;
});

function montar(resaltadas?: ReadonlySet<string>) {
  const props: PropsGrillaCompras = {
    filas: FILAS_014,
    cargando: false,
    seleccion: new Set<string>(),
    alCambiarSeleccion: vi.fn(),
    renderAcciones: () => null,
    alAbrirHistorial: vi.fn(),
    resaltadas,
  };
  return render(<GrillaCompras {...props} />);
}

describe("<GrillaCompras /> · ubicar una fila (T23a, P-1)", () => {
  it("feliz: con una fila resaltada, la grilla se lleva a la vista de la página", () => {
    montar(new Set([FILAS_014[0]!.id]));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    const grilla = scrollIntoView.mock.contexts[0] as HTMLElement;
    expect(grilla.getAttribute("role")).toBe("grid");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });

  it("error: sin filas resaltadas, o con un id que no está en la grilla, no mueve la página", () => {
    const sin = montar(new Set());
    sin.unmount();
    montar(new Set([uuidDe(9, 9)]));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
