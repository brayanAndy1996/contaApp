// Spec 012b (T1, rojo): `erroresDeFilaVenta(cabecera, fila)` (D12, P-8). Contrato que fija la prueba (T7):
//  - Devuelve los errores de prevalidación de la PROPIA fila (estructura, fecha, USD/TC, CUADRE, IGV), los mismos que
//    `prevalidar` da para esa fila (misma función por dentro). No devuelve DUPLICADO, SIN_FILAS ni los de la cabecera.
//  - Una fila válida da []. Es la regla con la que el servidor decide si una venta del SIRE es excluible (D12).
import { describe, expect, it } from "vitest";
import { erroresDeFilaVenta, prevalidar } from "../index";
import type { ErrorPrevalidacion, FilaReemplazoVenta } from "../index";
import { CABECERA_VENTAS, filaVenta, ventaNum } from "../../tests/ayudas/filas-venta";

const plano = (e: ErrorPrevalidacion) => ({
  filaId: e.filaId,
  codigo: e.codigo,
  campo: e.campo,
  destino: e.destino,
  explicacion: e.explicacion,
  diferencia: e.diferencia?.toString() ?? null,
});
const deFila = (f: FilaReemplazoVenta) => erroresDeFilaVenta(CABECERA_VENTAS, f).map(plano);
const dePrevalidar = (f: FilaReemplazoVenta) =>
  prevalidar([f], { cabecera: CABECERA_VENTAS }).errores.filter((e) => e.filaId === f.id).map(plano);

const CASOS: ReadonlyArray<readonly [string, FilaReemplazoVenta, string[]]> = [
  ["descuadrada", filaVenta({ montos: { baseGravada: "100.00", igv: "18.00", total: "120.00" } }), ["CUADRE"]],
  ["IGV que no es 18 % ni 10 %", filaVenta({ montos: { baseGravada: "100.00", igv: "17.00" } }), ["IGV"]],
  ["USD sin tipo de cambio", ventaNum("01", "F002", "2", { moneda: "USD", montos: { baseGravada: "100.00", igv: "18.00" } }), ["USD_SIN_TC"]],
  ["tipo de cambio inválido", ventaNum("01", "F002", "3", { moneda: "USD", tipoCambio: "0", montos: { baseGravada: "100.00", igv: "18.00" } }), ["TC_INVALIDO"]],
  ["fecha inexistente", filaVenta({ fechaEmision: "2026-02-30" }), ["FECHA_INVALIDA"]],
  ["fecha posterior al periodo", filaVenta({ fechaEmision: "2026-11-01" }), ["FECHA_POSTERIOR_AL_PERIODO"]],
  ["descuadrada y con IGV malo a la vez", filaVenta({ montos: { baseGravada: "100.00", igv: "17.00", total: "120.00" } }), ["CUADRE", "IGV"]],
];

describe("erroresDeFilaVenta · coincide con prevalidar para esa fila", () => {
  it.each(CASOS)("%s", (_nombre, fila, codigos) => {
    const errores = deFila(fila);
    expect(errores.map((e) => e.codigo).sort()).toEqual([...codigos].sort());
    expect(errores).toEqual(dePrevalidar(fila));
    expect(errores.every((e) => e.filaId === fila.id)).toBe(true);
  });

  it.each([
    ["cuadrada", filaVenta()],
    ["nota de crédito", ventaNum("07", "F001", "1", { montos: { baseGravada: "-50.00", igv: "-9.00" } })],
    ["USD con tipo de cambio", ventaNum("01", "F002", "1", { moneda: "USD", tipoCambio: "3.300", montos: { baseGravada: "200.00", igv: "36.00" } })],
    ["exonerada", ventaNum("01", "F001", "12", { montos: { exonerada: "150.00" } })],
  ] as const)("una venta válida (%s) no tiene errores", (_nombre, fila) => {
    expect(deFila(fila)).toEqual([]);
    expect(dePrevalidar(fila)).toEqual([]);
  });
});

describe("erroresDeFilaVenta · solo lo de la fila", () => {
  it("con la cabecera con RUC inválido, una venta válida sigue sin errores (el RUC es de la cabecera, no de la fila)", () => {
    expect(deFila(filaVenta())).toEqual([]);
    expect(erroresDeFilaVenta({ ...CABECERA_VENTAS, rucDeclarante: "20700000001" }, filaVenta())).toEqual([]);
  });

  it("no da DUPLICADO ni SIN_FILAS: no mira otras filas", () => {
    const f = filaVenta({ montos: { baseGravada: "100.00", igv: "18.00", total: "120.00" } });
    expect(erroresDeFilaVenta(CABECERA_VENTAS, f).map((e) => e.codigo)).toEqual(["CUADRE"]);
  });

  it("es pura: no muta la fila y repite el resultado", () => {
    const f = filaVenta({ montos: { baseGravada: "100.00", igv: "18.00", total: "120.00" } });
    const copia = JSON.stringify(f);
    const a = deFila(f);
    expect(JSON.stringify(f)).toBe(copia);
    expect(deFila(f)).toEqual(a);
    expect(a).toHaveLength(1);
  });

  it("la CUADRE lleva la diferencia total − Σ y el filaId de la fila", () => {
    const e = erroresDeFilaVenta(CABECERA_VENTAS, filaVenta({ id: "v9", montos: { baseGravada: "100.00", igv: "18.00", total: "120.00" } }))[0];
    expect(e?.filaId).toBe("v9");
    expect(e?.diferencia?.toString()).toBe("2.00");
  });
});
