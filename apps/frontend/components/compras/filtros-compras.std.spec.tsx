import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FILTROS_INICIALES, MENSAJES_COMPRAS as M, consultaDeListado, type FiltrosCompras } from "../../lib/compras";
import { MENSAJES_APRENDIZAJE as A } from "../../pruebas/aprendizaje";
import { FiltrosListado } from "./filtros-compras";

// Spec 025 · T7 (rojo; CA-9, D-8). Filtro de la grilla por la regla R-STD.
// Contrato (T13): `FiltrosCompras.regla?: "R-STD"` (ausente = sin filtro), casilla «DNG por perfil del cliente» en
// `FiltrosListado` (sube el filtro completo a la página como las demás) y `consultaDeListado` manda `regla=R-STD` solo si está
// puesto. El servidor (`listarComprasSchema`) acepta `regla`; el filtro nunca se aplica en el navegador (D-4 de 015).

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

describe("<FiltrosListado /> · R-STD", () => {
  it("feliz: la casilla sube {regla: «R-STD»} con los demás filtros intactos y al quitarla se va", async () => {
    const alCambiar = vi.fn();
    render(<Arnes alCambiar={alCambiar} />);
    const usuario = userEvent.setup();

    await usuario.click(screen.getByRole("radio", { name: M.vistas.sin_igv }));
    await usuario.click(screen.getByRole("checkbox", { name: A.filtroStd }));
    expect(alCambiar).toHaveBeenLastCalledWith({ ...FILTROS_INICIALES, vista: "sin_igv", regla: "R-STD" });
    expect((screen.getByRole("checkbox", { name: A.filtroStd }) as HTMLInputElement).checked).toBe(true);

    await usuario.click(screen.getByRole("checkbox", { name: A.filtroStd }));
    const ultimo = alCambiar.mock.calls.at(-1)![0] as FiltrosCompras & { regla?: string };
    expect(ultimo.regla).toBeUndefined();
    expect(ultimo.vista).toBe("sin_igv");
  });

  it("sin tocarla, los filtros iniciales no traen regla y la casilla está sin marcar", () => {
    render(<Arnes alCambiar={vi.fn()} />);

    expect((screen.getByRole("checkbox", { name: A.filtroStd }) as HTMLInputElement).checked).toBe(false);
    expect((FILTROS_INICIALES as FiltrosCompras & { regla?: string }).regla).toBeUndefined();
  });
});

describe("consultaDeListado · R-STD", () => {
  it("manda regla=R-STD solo cuando el filtro está puesto, junto con los otros parámetros", () => {
    const con = consultaDeListado({ ...FILTROS_INICIALES, regla: "R-STD", q: "2070" } as FiltrosCompras);
    const q = new URLSearchParams(con);
    expect(q.get("regla")).toBe("R-STD");
    expect(q.get("q")).toBe("2070");
    expect(q.get("vista")).toBe("con_igv");

    expect(new URLSearchParams(consultaDeListado(FILTROS_INICIALES)).has("regla")).toBe(false);
  });
});
