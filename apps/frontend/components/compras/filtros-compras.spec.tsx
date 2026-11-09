import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FILTROS_INICIALES, MENSAJES_COMPRAS as M, type FiltrosCompras } from "../../lib/compras";
import { FiltrosListado, SeleccionDelFiltro } from "./filtros-compras";

// Spec 015 · T5 (D-4, D-8; CA-2): los filtros suben a la página (que pide al servidor) y «seleccionar las N del
// filtro» solo vale con la carga terminada y dentro del tope. Un caso feliz y uno de error por comportamiento.

afterEach(cleanup);

function Arnes({ alCambiar }: { alCambiar: (f: FiltrosCompras) => void }) {
  const [filtros, setFiltros] = useState<FiltrosCompras>(FILTROS_INICIALES);
  return (
    <FiltrosListado
      filtros={filtros}
      retardoMs={20}
      alCambiar={(f) => {
        alCambiar(f);
        setFiltros(f);
      }}
    />
  );
}

describe("<FiltrosListado />", () => {
  it("feliz: vista, alertas y proveedor nuevo suben el filtro completo; la búsqueda espera y sube una sola vez", async () => {
    const alCambiar = vi.fn();
    render(<Arnes alCambiar={alCambiar} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: M.vistas.sin_igv }));
    expect(alCambiar).toHaveBeenLastCalledWith({ ...FILTROS_INICIALES, vista: "sin_igv" });
    await user.click(screen.getByRole("checkbox", { name: M.filtroAlertas }));
    expect(alCambiar).toHaveBeenLastCalledWith({
      ...FILTROS_INICIALES,
      vista: "sin_igv",
      alertas: true,
    });

    const llamadas = alCambiar.mock.calls.length;
    await user.type(screen.getByRole("searchbox", { name: M.buscar }), " 2070 ");
    expect(alCambiar).toHaveBeenCalledTimes(llamadas);
    await vi.waitFor(() => expect(alCambiar).toHaveBeenCalledTimes(llamadas + 1));
    // Se envía recortada y conserva los otros filtros.
    expect(alCambiar).toHaveBeenLastCalledWith({
      ...FILTROS_INICIALES,
      vista: "sin_igv",
      alertas: true,
      q: "2070",
    });
  });

  it("error: los caracteres de control se descartan antes de buscar (el servidor los rechazaría)", () => {
    render(<Arnes alCambiar={vi.fn()} />);
    const campo = screen.getByRole("searchbox", { name: M.buscar }) as HTMLInputElement;
    fireEvent.change(campo, { target: { value: "ab\u0000c\u0007" } });
    expect(campo.value).toBe("abc");
  });
});

describe("<SeleccionDelFiltro />", () => {
  const boton = (n: number) =>
    screen.getByRole("button", { name: M.seleccionarDelFiltro(n) }) as HTMLButtonElement;

  it("feliz: con la carga terminada selecciona las N del filtro", async () => {
    const alSeleccionar = vi.fn();
    render(<SeleccionDelFiltro cantidad={42} cargando={false} seleccionadas={0} alSeleccionar={alSeleccionar} />);
    expect(boton(42).disabled).toBe(false);
    await userEvent.click(boton(42));
    expect(alSeleccionar).toHaveBeenCalledTimes(1);
  });

  it("error: cargando o con más del tope deshabilita el botón y explica por qué", () => {
    const { rerender } = render(
      <SeleccionDelFiltro cantidad={1000} cargando seleccionadas={0} alSeleccionar={vi.fn()} />,
    );
    expect(boton(1000).disabled).toBe(true);
    expect(screen.getByText(M.seleccionarDelFiltroCargando)).toBeTruthy();

    rerender(<SeleccionDelFiltro cantidad={5001} cargando={false} seleccionadas={0} alSeleccionar={vi.fn()} />);
    expect(boton(5001).disabled).toBe(true);
    expect(screen.getByText(M.seleccionarDemasiadas(5000))).toBeTruthy();
  });
});
