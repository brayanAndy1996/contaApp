import { describe, expect, it } from "vitest";
import type { CuadreCompra } from "@contapp/shared";
import { C_3064_BOLSAS, MENSAJES_COMPRAS as M, filaDe, montosDe } from "../pruebas/compras";
import {
  aplicarCuadre,
  cambiarCelda,
  cambiosParaEnviar,
  errorDeCelda,
  explicaciones,
  hayCambios,
  iniciarEdicion,
  marcarCuadreNoVerificado,
  sinCuadre,
  textoDe,
  totalLocal,
} from "./edicion-compras";

// Spec 015 · T6 (D-3, D-6, P-3; CA-4, CA-5): el estado puro de la edición de una fila. Sin DOM ni red.

const CUADRE_IGV: CuadreCompra = {
  cuadra: false,
  celdas: [
    { columna: "biDg", cuadra: true, explicacion: null },
    { columna: "igvDg", cuadra: false, explicacion: "El IGV debería ser 27.00 (18 % de la base)." },
  ],
};

describe("edicion-compras · estado de la edición de una fila", () => {
  it("feliz: cambiar la BI de F001-3064 recalcula el total exacto y solo envía la celda cambiada", () => {
    const e0 = iniciarEdicion(C_3064_BOLSAS);
    expect(e0.versionBase).toBe(C_3064_BOLSAS.version);
    expect(totalLocal(e0)).toBe("119.50");
    expect(hayCambios(e0)).toBe(false);

    const e1 = cambiarCelda(e0, "biDg", "150.00");
    expect(totalLocal(e1)).toBe("169.50");
    expect(textoDe(e1, "biDg")).toBe("150.00");
    expect(textoDe(e1, "igvDg")).toBe("18.00");
    expect(cambiosParaEnviar(e1)).toEqual({ cambios: { biDg: "150.00" }, invalidas: [] });
    // El original no se tocó (el estado es inmutable).
    expect(totalLocal(e0)).toBe("119.50");
  });

  it("suma exacta sin coma flotante y con negativos (notas de crédito)", () => {
    const fila = filaDe({ montos: montosDe({ biDg: "0.10", igvDg: "0.20" }) });
    const e = cambiarCelda(iniciarEdicion(fila), "noGravado", "-0.30");
    expect(totalLocal(e)).toBe("0.00");
    expect(totalLocal(cambiarCelda(e, "isc", "0.05"))).toBe("0.05");
  });

  it("volver al valor original no es un cambio, aunque se escriba distinto (1.5 = 1.50)", () => {
    const e = cambiarCelda(iniciarEdicion(C_3064_BOLSAS), "icbper", "1.5");
    expect(cambiosParaEnviar(e).cambios).toEqual({});
    expect(hayCambios(e)).toBe(false);
  });

  it("error: un monto con 3 decimales no se envía, se explica y el total lo ignora", () => {
    const e = cambiarCelda(iniciarEdicion(C_3064_BOLSAS), "biDg", "100.505");
    expect(errorDeCelda(e, "biDg")).toBe(M.montoMasDeDosDecimales);
    expect(cambiosParaEnviar(e)).toEqual({ cambios: {}, invalidas: ["biDg"] });
    expect(hayCambios(e)).toBe(true);
    expect(totalLocal(e)).toBe("119.50");
    expect(explicaciones(e)).toEqual([
      { columna: "biDg", tipo: "monto", texto: M.montoMasDeDosDecimales },
    ]);
  });

  it("error: vacío y texto no numérico también son inválidos", () => {
    const base = iniciarEdicion(C_3064_BOLSAS);
    expect(errorDeCelda(cambiarCelda(base, "isc", ""), "isc")).not.toBeNull();
    expect(errorDeCelda(cambiarCelda(base, "isc", "12abc"), "isc")).not.toBeNull();
    expect(errorDeCelda(base, "isc")).toBeNull();
  });

  it("el cuadre del servidor explica solo las celdas que no cuadran; `calcular` caído lo marca no verificado", () => {
    const e = cambiarCelda(iniciarEdicion(C_3064_BOLSAS), "biDg", "150.00");
    const conCuadre = aplicarCuadre(e, CUADRE_IGV);
    expect(explicaciones(conCuadre)).toEqual([
      { columna: "igvDg", tipo: "cuadre", texto: "El IGV debería ser 27.00 (18 % de la base)." },
    ]);

    const caido = marcarCuadreNoVerificado(conCuadre);
    expect(caido.cuadreNoVerificado).toBe(true);
    expect(caido.cuadre).toBeNull();
    expect(explicaciones(caido)).toEqual([]);
    // El total local sigue siendo el de las celdas.
    expect(totalLocal(caido)).toBe("169.50");

    expect(sinCuadre(caido)).toMatchObject({ cuadre: null, cuadreNoVerificado: false });
  });
});
