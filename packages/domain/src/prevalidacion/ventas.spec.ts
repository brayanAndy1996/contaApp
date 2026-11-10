// Spec 012b (T1, rojo): `prevalidar` con ventas (D1, P-6, P-8; CA-10, CA-15). Contrato que fija la prueba (T7):
//  - `prevalidar(filas, { cabecera })` con `cabecera.libro = "ventas"` y `FilaReemplazoVenta[]` devuelve el mismo
//    `ResultadoPrevalidacion` que en compras; el formato es el RVIE provisional del registro (`oficial: false`).
//  - Ventas valida estructura, fecha, USD/TC, CUADRE (`cuadraVenta`), IGV 18 %/10 % sobre `baseGravada` (`destino: null`),
//    DUPLICADO (tipo, serie y número normalizados) y SIN_FILAS. Sin `reglas`: pasarlas lanza. Filas del otro libro lanzan.
//  - Una fila `excluida` no se prevalida (ni en el TXT) y, si todas lo están, es SIN_FILAS.
// Las pruebas de compras de 012 no se tocan. Todo lo de ventas falla hoy porque prevalidar solo acepta compras.
import { describe, expect, it } from "vitest";
import { EntradaPrevalidacionInvalidaError, prevalidar } from "../index";
import type { ErrorPrevalidacion, FilaReemplazoVenta, ResultadoPrevalidacion } from "../index";
import { CABECERA, filaReemplazo } from "../../tests/ayudas/filas-reemplazo";
import { CABECERA_VENTAS, comoExcluida, filaVenta, filasFixtureVentas, ventaNum } from "../../tests/ayudas/filas-venta";

const prev = (filas: FilaReemplazoVenta[]): ResultadoPrevalidacion => prevalidar(filas, { cabecera: CABECERA_VENTAS });
const resumen = (r: ResultadoPrevalidacion) => r.errores.map((e) => [e.filaId, e.codigo, e.campo]);
const unico = (r: ResultadoPrevalidacion, codigo: string): ErrorPrevalidacion => {
  const l = r.errores.filter((e) => e.codigo === codigo);
  expect(l, `un solo error ${codigo}`).toHaveLength(1);
  return l[0]!;
};

describe("ventas · venta cuadrada y formato", () => {
  it("una venta cuadrada es apta, sin errores ni avisos, con el formato RVIE provisional no oficial", () => {
    const r = prev([filaVenta()]);
    expect(r.errores).toEqual([]);
    expect(r.avisos).toEqual([]);
    expect(r.apto).toBe(true);
    expect(r.formato).toEqual({ id: "RVIE-REEMPLAZO", version: "0-provisional", oficial: false });
  });

  it("la nota de crédito con montos negativos (F001-1) es apta", () => {
    const nc = ventaNum("07", "F001", "1", { montos: { baseGravada: "-50.00", igv: "-9.00" } });
    expect(prev([nc]).apto).toBe(true);
  });

  it("una exonerada sin IGV (F001-12) y una USD con tipo de cambio son aptas", () => {
    const exo = ventaNum("01", "F001", "12", { montos: { exonerada: "150.00" } });
    const usd = ventaNum("01", "F002", "1", { moneda: "USD", tipoCambio: "3.300", montos: { baseGravada: "200.00", igv: "36.00" } });
    expect(prev([exo, usd]).errores).toEqual([]);
  });

  it("el fixture completo de ventas solo falla por la USD sin tipo de cambio (F002-2)", () => {
    const r = prev(filasFixtureVentas());
    expect(resumen(r)).toEqual([["01-F002-2", "USD_SIN_TC", "tipoCambio"]]);
    expect(r.apto).toBe(false);
  });

  it("no muta ni congela lo recibido y es determinista", () => {
    const filas = [filaVenta()];
    const copia = JSON.stringify(filas);
    const a = prev(filas);
    expect(JSON.stringify(filas)).toBe(copia);
    expect(Object.isFrozen(filas[0])).toBe(false);
    expect(prev(filas)).toEqual(a);
  });
});

describe("ventas · CUADRE (P-6)", () => {
  const descuadrada = filaVenta({ id: "v-desc", montos: { baseGravada: "100.00", igv: "18.00", total: "120.00" } });

  it("una venta descuadrada bloquea con CUADRE en `total`, su filaId, la diferencia total − Σ y las cifras en la explicación", () => {
    const r = prev([descuadrada]);
    expect(r.apto).toBe(false);
    const e = unico(r, "CUADRE");
    expect(e.filaId).toBe("v-desc");
    expect(e.campo).toBe("total");
    expect(e.diferencia?.toString()).toBe("2.00");
    for (const cifra of ["118.00", "120.00", "2.00"]) expect(e.explicacion).toContain(cifra);
  });

  it("la tolerancia es 0.00: un centavo de diferencia ya es CUADRE", () => {
    const r = prev([filaVenta({ montos: { baseGravada: "100.00", igv: "18.00", total: "118.01" } })]);
    expect(unico(r, "CUADRE").diferencia?.toString()).toBe("0.01");
  });

  it("una suma que excede NUMERIC(14,2) es CUADRE, no una excepción", () => {
    const enorme = filaVenta({ montos: { baseGravada: "900000000000.00", exonerada: "900000000000.00", total: "1.00" } });
    expect(unico(prev([enorme]), "CUADRE").filaId).toBe("03-B001-290");
  });
});

describe("ventas · IGV 18 % / 10 % sobre baseGravada", () => {
  const conIgv = (base: string, igv: string) => filaVenta({ montos: { baseGravada: base, igv } });

  it("18 % y 10 % cuadran (la tolerancia de igvCuadra es ±0.01)", () => {
    expect(prev([conIgv("100.00", "18.00")]).errores).toEqual([]);
    expect(prev([conIgv("100.00", "10.00")]).errores).toEqual([]);
    expect(prev([conIgv("100.00", "18.01")]).errores).toEqual([]);
  });

  it("un IGV que no es 18 % ni 10 % da IGV en `igv`, sin destino, con el texto de 011", () => {
    const r = prev([conIgv("100.00", "17.00")]);
    const e = unico(r, "IGV");
    expect(e).toMatchObject({ filaId: "03-B001-290", campo: "igv", destino: null });
    expect(e.explicacion).toBe("17.00 no es 18 % ni 10 % de 100.00");
    expect(r.apto).toBe(false);
  });

  it("un IGV sin base, o de signo contrario a la base, es error", () => {
    expect(unico(prev([conIgv("0.00", "5.00")]), "IGV").campo).toBe("igv");
    expect(unico(prev([conIgv("100.00", "-18.00")]), "IGV").campo).toBe("igv");
  });

  it("IGV exactamente 0.00 con base distinta de cero no es error (D18)", () => {
    expect(prev([conIgv("100.00", "0.00")]).errores).toEqual([]);
  });
});

describe("ventas · USD y tipo de cambio", () => {
  const usd = (tipoCambio: string | null) =>
    ventaNum("01", "F002", "2", { moneda: "USD", tipoCambio, montos: { baseGravada: "100.00", igv: "18.00" } });

  it("USD sin tipo de cambio: USD_SIN_TC en `tipoCambio` con el filaId", () => {
    const r = prev([usd(null)]);
    expect(unico(r, "USD_SIN_TC")).toMatchObject({ filaId: "01-F002-2", campo: "tipoCambio" });
    expect(r.apto).toBe(false);
  });

  it("tipo de cambio inválido o presente en una venta PEN: TC_INVALIDO", () => {
    expect(unico(prev([usd("0")]), "TC_INVALIDO").campo).toBe("tipoCambio");
    expect(unico(prev([filaVenta({ tipoCambio: "3.300" })]), "TC_INVALIDO").campo).toBe("tipoCambio");
  });

  it("USD con tipo de cambio de hasta 3 decimales es apta", () => {
    expect(prev([usd("3.300")]).errores).toEqual([]);
    expect(prev([usd("3.3")]).errores).toEqual([]);
  });
});

describe("ventas · estructura y fecha", () => {
  it("fecha inexistente o posterior al periodo", () => {
    expect(unico(prev([filaVenta({ fechaEmision: "2026-02-30" })]), "FECHA_INVALIDA").campo).toBe("fechaEmision");
    expect(unico(prev([filaVenta({ fechaEmision: "2026-11-02" })]), "FECHA_POSTERIOR_AL_PERIODO").campo).toBe("fechaEmision");
    expect(prev([filaVenta({ fechaEmision: "2026-10-31" })]).errores).toEqual([]);
  });

  it("serie de 5 caracteres o con el separador `|`: error en `serie`", () => {
    for (const serie of ["B0011", "B0|1"]) {
      const r = prev([filaVenta({ comprobante: { tipo: "03", serie, numero: "290" } })]);
      expect(r.errores.map((e) => e.campo), serie).toContain("serie");
      expect(r.apto).toBe(false);
    }
  });

  it("documento de la contraparte con símbolos de fórmula (=, +, @): error en el campo del documento", () => {
    const r = prev([filaVenta({ contraparte: { tipo: "6", numero: "=CMD()" } })]);
    expect(r.apto).toBe(false);
    expect(r.errores.every((e) => e.filaId === "03-B001-290")).toBe(true);
  });

  it("el consumidor final («-», sin tipo de documento) es válido", () => {
    expect(prev([filaVenta({ contraparte: { numero: "-" } })]).errores).toEqual([]);
  });

  it("los errores salen ordenados: filaId, código y campo", () => {
    const a = ventaNum("01", "F001", "2", { montos: { baseGravada: "100.00", igv: "18.00", total: "119.00" } });
    const b = ventaNum("01", "F001", "1", { montos: { baseGravada: "100.00", igv: "17.00" } });
    expect(resumen(prev([a, b]))).toEqual([
      ["01-F001-1", "IGV", "igv"],
      ["01-F001-2", "CUADRE", "total"],
    ]);
  });
});

describe("ventas · DUPLICADO y SIN_FILAS", () => {
  it("dos ventas con el mismo tipo, serie y número (los ceros a la izquierda y las minúsculas no las distinguen) dan DUPLICADO en las dos", () => {
    const a = ventaNum("03", "B001", "290", { id: "a" });
    const b = ventaNum("03", "b001", "00290", { id: "b", comprobante: { tipo: "03", serie: "b001", numero: "00290" } });
    const r = prev([a, b]);
    expect(r.errores.filter((e) => e.codigo === "DUPLICADO").map((e) => e.filaId)).toEqual(["a", "b"]);
    expect(r.apto).toBe(false);
  });

  it("el mismo número en otro tipo o en otra serie no es duplicado", () => {
    const r = prev([ventaNum("03", "B001", "1"), ventaNum("01", "F001", "1"), ventaNum("03", "B002", "1")]);
    expect(r.errores).toEqual([]);
  });

  it("sin filas: SIN_FILAS con filaId null", () => {
    const r = prev([]);
    expect(r.apto).toBe(false);
    expect(unico(r, "SIN_FILAS").filaId).toBeNull();
  });
});

describe("ventas · excluidas (P-8, D12; CA-15)", () => {
  const descuadrada = filaVenta({ id: "v-desc", montos: { baseGravada: "100.00", igv: "18.00", total: "120.00" } });
  const usdSinTc = ventaNum("01", "F002", "2", { moneda: "USD", montos: { baseGravada: "100.00", igv: "18.00" } });

  it("una descuadrada y una USD sin tipo de cambio, ambas bloquean mientras no se excluyan", () => {
    const r = prev([filaVenta({ id: "ok", comprobante: { tipo: "03", serie: "B001", numero: "1" } }), descuadrada, usdSinTc]);
    expect(r.errores.map((e) => e.codigo).sort()).toEqual(["CUADRE", "USD_SIN_TC"]);
  });

  it("excluidas, ya no se prevalidan: el periodo queda apto y sin errores", () => {
    const ok = filaVenta({ id: "ok", comprobante: { tipo: "03", serie: "B001", numero: "1" } });
    const r = prev([ok, comoExcluida(descuadrada), comoExcluida(usdSinTc)]);
    expect(r.errores).toEqual([]);
    expect(r.apto).toBe(true);
  });

  it("una excluida tampoco cuenta para DUPLICADO", () => {
    const a = ventaNum("03", "B001", "5", { id: "a" });
    const b = comoExcluida(ventaNum("03", "B001", "5", { id: "b" }));
    expect(prev([a, b]).errores).toEqual([]);
  });

  it("todas excluidas → SIN_FILAS", () => {
    const r = prev([comoExcluida(filaVenta())]);
    expect(r.apto).toBe(false);
    expect(unico(r, "SIN_FILAS").filaId).toBeNull();
  });
});

describe("ventas · entrada imposible lanza (no es un dato corregible)", () => {
  it("con `reglas` lanza EntradaPrevalidacionInvalidaError; sin ellas, la misma llamada funciona", () => {
    expect(prev([filaVenta()]).apto).toBe(true);
    const conReglas = { cabecera: CABECERA_VENTAS, reglas: { proveedoresConocidos: [], proveedoresIsc: [], diccionario: [] } };
    expect(() => prevalidar([filaVenta()], conReglas as never)).toThrow(EntradaPrevalidacionInvalidaError);
  });

  it("filas de compras con cabecera de ventas lanzan, y filas de ventas con cabecera de compras también", () => {
    expect(prev([filaVenta()]).apto).toBe(true);
    expect(() => prevalidar([filaReemplazo()] as never, { cabecera: CABECERA_VENTAS })).toThrow(EntradaPrevalidacionInvalidaError);
    expect(() => prevalidar([filaVenta()] as never, { cabecera: CABECERA })).toThrow(EntradaPrevalidacionInvalidaError);
  });

  it("un id repetido, un estado `modificada` o un monto en otra moneda que el total lanzan", () => {
    expect(prev([filaVenta()]).apto).toBe(true);
    expect(() => prev([filaVenta(), filaVenta()])).toThrow(EntradaPrevalidacionInvalidaError);
    expect(() => prev([{ ...filaVenta(), estado: "modificada" } as never])).toThrow(EntradaPrevalidacionInvalidaError);
    const mezcla = filaVenta();
    const usd = filaVenta({ moneda: "USD", tipoCambio: "3.300" });
    expect(() => prev([{ ...mezcla, montos: { ...mezcla.montos, igv: usd.montos.igv } }])).toThrow(EntradaPrevalidacionInvalidaError);
  });

  it("una clave de más en la fila o en la contraparte lanza", () => {
    expect(prev([filaVenta()]).apto).toBe(true);
    expect(() => prev([{ ...filaVenta(), extra: 1 } as never])).toThrow(EntradaPrevalidacionInvalidaError);
    expect(() => prev([filaVenta({ contraparte: { numero: "-", razonSocial: "X" } as never })])).toThrow(EntradaPrevalidacionInvalidaError);
  });
});
