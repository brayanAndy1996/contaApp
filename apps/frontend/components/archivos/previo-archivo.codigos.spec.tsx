import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FILA_ID, MENSAJES_ARCHIVO as M, previoConErrorDe } from "../../pruebas/archivos";
import { PrevioArchivo } from "./previo-archivo";

// Spec 020, T7 (DT-6, CA-8): CUADRE, USD_SIN_TC y SALTO_CORRELATIVIDAD se muestran con su texto, no como código crudo.

afterEach(cleanup);

const error = (codigo: string) => ({
  filaId: FILA_ID,
  comprobante: "F002-2",
  codigo,
  campo: "total",
  destino: null,
  explicacion: `Explicación de ${codigo}`,
  diferencia: null,
  excluible: true,
});

describe("<PrevioArchivo /> · códigos de ventas con texto (spec 020 T7)", () => {
  it("feliz: CUADRE, USD_SIN_TC y SALTO_CORRELATIVIDAD salen en español y no como código", () => {
    const previo = previoConErrorDe({
      errores: [error("CUADRE"), error("USD_SIN_TC")],
      avisos: [{ filaId: null, comprobante: null, codigo: "SALTO_CORRELATIVIDAD", explicacion: "Falta B001-291" }],
    });
    render(<PrevioArchivo previo={previo} libro="ventas" />);

    const errores = screen.getByRole("region", { name: M.tituloErrores });
    expect(within(errores).getByText(M.codigosPrevio.CUADRE!)).toBeTruthy();
    expect(within(errores).getByText(M.codigosPrevio.USD_SIN_TC!)).toBeTruthy();
    const avisos = screen.getByRole("region", { name: M.tituloAvisos });
    expect(within(avisos).getByText(M.codigosPrevio.SALTO_CORRELATIVIDAD!)).toBeTruthy();
    for (const crudo of ["CUADRE", "USD_SIN_TC", "SALTO_CORRELATIVIDAD"]) {
      expect(screen.queryByText(crudo)).toBeNull();
    }
  });

  it("error: un código sin texto propio se muestra tal cual, sin inventar uno", () => {
    render(<PrevioArchivo previo={previoConErrorDe({ errores: [error("OTRO_CODIGO")] })} libro="ventas" />);
    expect(screen.getByText("OTRO_CODIGO")).toBeTruthy();
  });

  it("resumen_fuera_de_rango tiene su mensaje en español", () => {
    expect(M.errores.resumen_fuera_de_rango).toMatch(/fuera de rango/);
  });
});
