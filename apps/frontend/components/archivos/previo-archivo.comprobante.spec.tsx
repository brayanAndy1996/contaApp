import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FILA_ID, MENSAJES_ARCHIVO as M, previoConErrorDe, previoDe } from "../../pruebas/archivos";
import { PrevioArchivo } from "./previo-archivo";

// Spec 012b, T23a (P-3): cada error y aviso del previo dice de qué comprobante es, y sus botones llevan el
// comprobante en el nombre accesible (antes eran dos «Excluir» y dos «Ubicar en la grilla» idénticos).

const OTRA_FILA = "00000000-0000-4000-8000-000000000003";
const error = (filaId: string, comprobante: string | null, codigo: string) => ({
  filaId,
  comprobante,
  codigo,
  campo: "total",
  destino: null,
  explicacion: `Explicación de ${codigo}`,
  diferencia: null,
  excluible: true,
});

afterEach(cleanup);

describe("<PrevioArchivo /> · comprobante de cada error y aviso (T23a, P-3)", () => {
  it("feliz: muestra el comprobante y nombra «Excluir» y «Ubicar en la grilla» por comprobante", async () => {
    const alUbicarFila = vi.fn();
    const alExcluir = vi.fn();
    const previo = previoDe({
      apto: false,
      generable: false,
      motivo: "prevalidacion_fallida",
      errores: [error(FILA_ID, "F002-2", "USD_SIN_TC"), error(OTRA_FILA, "F003-20", "CUADRE")],
      avisos: [{ filaId: FILA_ID, comprobante: "F001-2056", codigo: "R-NEW", explicacion: "Proveedor nuevo" }],
    });
    render(<PrevioArchivo previo={previo} libro="ventas" alUbicarFila={alUbicarFila} alExcluir={alExcluir} />);
    const user = userEvent.setup();

    const errores = screen.getByRole("region", { name: M.tituloErrores });
    expect(within(errores).getByText(/F002-2/)).toBeTruthy();
    expect(within(errores).getByText(/F003-20/)).toBeTruthy();
    await user.click(within(errores).getByRole("button", { name: M.excluirComprobante("F003-20") }));
    expect(alExcluir).toHaveBeenCalledWith(OTRA_FILA);
    await user.click(within(errores).getByRole("button", { name: M.ubicarComprobante("F002-2") }));
    expect(alUbicarFila).toHaveBeenCalledWith(FILA_ID);
    // Dos errores: ya no hay dos botones de nombre idéntico.
    expect(within(errores).queryByRole("button", { name: M.excluir })).toBeNull();

    const avisos = screen.getByRole("region", { name: M.tituloAvisos });
    expect(within(avisos).getByText(/F001-2056/)).toBeTruthy();
    await user.click(within(avisos).getByRole("button", { name: M.ubicarComprobante("F001-2056") }));
    expect(alUbicarFila).toHaveBeenLastCalledWith(FILA_ID);
  });

  it("error: sin comprobante (error del periodo o servidor anterior) no inventa uno y conserva el nombre del botón", () => {
    const previo = previoConErrorDe({
      errores: [
        { ...error(FILA_ID, null, "IGV"), excluible: false },
        { ...error(OTRA_FILA, null, "SIN_FILAS"), filaId: null, excluible: false },
      ],
      avisos: [{ filaId: null, comprobante: null, codigo: "SALTO_CORRELATIVIDAD", explicacion: "Falta B001-291" }],
    });
    render(<PrevioArchivo previo={previo} alUbicarFila={vi.fn()} />);

    const errores = screen.getByRole("region", { name: M.tituloErrores });
    // El botón de la fila sin comprobante sigue llamándose «Ubicar en la grilla»; el error sin fila no tiene botón.
    expect(within(errores).getAllByRole("button", { name: M.ubicarFila })).toHaveLength(1);
    expect(within(errores).queryByText(/ · \s*IGV/)).toBeNull();
    const avisos = screen.getByRole("region", { name: M.tituloAvisos });
    expect(within(avisos).queryByRole("button")).toBeNull();
    expect(within(avisos).getByText("Falta B001-291", { exact: false })).toBeTruthy();
  });
});
