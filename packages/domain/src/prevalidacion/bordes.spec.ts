// Spec 012 (T9): bordes de prevalidar que no fijan los specs de T4 (rango de NUMERIC(14,2), PATRON,
// forma del XML y del contexto, formatos que incluyen excluidas). Solo API pública.
import { describe, expect, it } from "vitest";
import {
  EntradaPrevalidacionInvalidaError,
  EntradaReglasInvalidaError,
  MontosComprobante,
  RegistroFormatos,
  prevalidar,
  seleccionarFormato,
} from "../index";
import type { FilaReemplazo } from "../index";
import { CABECERA, ctxBase, filaReemplazo, montosDe, xmlDe } from "../../tests/ayudas/filas-reemplazo";

const MAX = "999999999999.99";
const prev = (filas: readonly FilaReemplazo[], extra: Record<string, unknown> = {}) =>
  prevalidar(filas, { cabecera: CABECERA, ...extra } as Parameters<typeof prevalidar>[1]);
const lanza = (filas: unknown, extra: Record<string, unknown> = {}) =>
  expect(() => prev(filas as FilaReemplazo[], extra)).toThrow(EntradaPrevalidacionInvalidaError);

describe("montos al borde de NUMERIC(14,2)", () => {
  it("una suma de componentes fuera de rango es CUADRE sin diferencia y sin cifras", () => {
    const montos = MontosComprobante.desde("PEN", { biDg: MAX, noGravado: MAX, total: "0.00" });
    const [e, ...resto] = prev([filaReemplazo(undefined, { montos })]).errores;
    expect(resto).toEqual([]);
    expect(e).toMatchObject({ codigo: "CUADRE", campo: "total", diferencia: null });
    expect(e?.explicacion).toBe("La suma de componentes no es igual al total y excede el rango de montos");
  });

  it("origenUsd cuya conversión sale de rango es CONVERSION_USD y no lanza", () => {
    const origenUsd = { montos: montosDe("USD", { noGravado: MAX }), tipoCambio: "3.300" };
    const e = prev([filaReemplazo({ noGravado: "1.00" }, { origenUsd })]).errores;
    expect(e).toEqual([expect.objectContaining({ codigo: "CONVERSION_USD", campo: "origenUsd" })]);
    expect(e[0]?.explicacion).toBe("La conversión de origenUsd a PEN excede el rango de montos");
  });

  it("origenUsd cuya suma USD sale de rango cuenta como descuadrado", () => {
    const origenUsd = {
      montos: MontosComprobante.desde("USD", { biDng: MAX, noGravado: MAX, total: "1.00" }),
      tipoCambio: "3.300",
    };
    const e = prev([filaReemplazo({ noGravado: "1.00" }, { origenUsd })]).errores;
    expect(e.map((x) => [x.codigo, x.explicacion])).toEqual([
      ["CONVERSION_USD", "Los montos en USD de origenUsd no cuadran: no se pueden convertir"],
    ]);
  });

  it("si solo difiere el total de la conversión, CONVERSION_USD nombra el total con la cifra esperada", () => {
    const origenUsd = { montos: montosDe("USD", { biDg: "100.00", igvDg: "18.00" }), tipoCambio: "3.300" };
    const montos = MontosComprobante.desde("PEN", { biDg: "330.00", igvDg: "59.40", total: "389.41" });
    const conv = prev([filaReemplazo(undefined, { montos, origenUsd })]).errores.find((x) => x.codigo === "CONVERSION_USD");
    expect(conv?.explicacion).toBe("El campo total no coincide con la conversión por componente de origenUsd (389.40)");
  });
});

describe("explicaciones de estructura", () => {
  it("PATRON nombra el campo; LONGITUD da el máximo del formato; el carácter da posición y U+XXXX", () => {
    const patron = prev([filaReemplazo(undefined, { comprobante: { tipo: "0A", serie: "F001", numero: "1" } })]).errores;
    expect(patron).toEqual([
      expect.objectContaining({ codigo: "PATRON", campo: "tipoComprobante", explicacion: "El campo tipoComprobante no tiene el formato esperado" }),
    ]);
    const largo = prev([filaReemplazo(undefined, { comprobante: { tipo: "01", serie: "F0011", numero: "1" } })]).errores;
    expect(largo[0]?.explicacion).toBe("El campo serie supera el máximo de 4 caracteres");
    const car = prev([filaReemplazo(undefined, { proveedor: { tipo: "6", numero: "20100070970", razonSocial: "AB \u{1F600}" } })]).errores;
    expect(car[0]?.explicacion).toBe("El campo razonSocial tiene un carácter no permitido (U+1F600) en la posición 3");
  });

  it("DUPLICADO da los ids de las otras copias, ordenados", () => {
    const f = (id: string) => filaReemplazo(undefined, { id });
    const e = prev([f("c"), f("a"), f("b")]).errores;
    expect(e.map((x) => [x.filaId, x.explicacion])).toEqual([
      ["a", "El comprobante se repite en las filas b, c"],
      ["b", "El comprobante se repite en las filas a, c"],
      ["c", "El comprobante se repite en las filas a, b"],
    ]);
  });
});

describe("forma del XML y del contexto", () => {
  const conXml = (xml: unknown) => ({ ...filaReemplazo(), xml });

  it("un XML bien formado no cambia nada sin reglas; `xml: undefined` cuenta como ausente", () => {
    expect(prev([conXml(xmlDe({ gravado: "100.00", igv: "18.00" })) as FilaReemplazo]).errores).toEqual([]);
    expect(prev([conXml(undefined) as FilaReemplazo]).errores).toEqual([]);
  });

  it("un XML con forma imposible lanza aunque no se pasen reglas", () => {
    const xml = xmlDe();
    lanza([conXml(null)]);
    lanza([conXml({ ...xml, moneda: "EUR" })]);
    lanza([conXml({ ...xml, gravado: { monto: "1.00", moneda: "PEN" } })]);
    lanza([conXml({ ...xml, glosas: "zapatillas" })]);
    lanza([conXml({ ...xml, glosas: [1] })]);
    lanza([conXml({ ...xml, proveedor: { ...xml.proveedor, x: 1 } })]);
    lanza([conXml({ ...xml, comprobante: { tipo: "01", serie: "F001" } })]);
    lanza([conXml({ ...xml, extra: 1 })]);
  });

  it("una clave símbolo en la fila lanza", () => {
    lanza([{ ...filaReemplazo(), [Symbol("x")]: 1 }]);
  });

  it("razonSocial: undefined cuenta como ausente", () => {
    const f = filaReemplazo(undefined, { proveedor: { tipo: "6", numero: "20100070970", razonSocial: undefined } as never });
    expect(prev([f]).errores).toEqual([]);
  });

  it("contexto que no es objeto, sin cabecera o con claves extra lanza; reglas inválidas las rechaza 011", () => {
    const f = [filaReemplazo()];
    expect(() => prevalidar(f, null as never)).toThrow(EntradaPrevalidacionInvalidaError);
    expect(() => prevalidar(f, {} as never)).toThrow(EntradaPrevalidacionInvalidaError);
    expect(() => prevalidar(f, { cabecera: CABECERA, extra: 1 } as never)).toThrow(EntradaPrevalidacionInvalidaError);
    expect(() => prevalidar(f, { cabecera: CABECERA, reglas: { ...ctxBase(), x: 1 } } as never)).toThrow(EntradaReglasInvalidaError);
    expect(prevalidar(f, { cabecera: CABECERA, reglas: undefined, registro: undefined }).apto).toBe(true);
  });
});

describe("formato que incluye las excluidas (D14, desvío de T9)", () => {
  const provisional = seleccionarFormato("compras", "202610");
  const registro = RegistroFormatos.desde([{ ...provisional, oficial: true, version: "1", incluyeExcluidas: true }]);
  const excluida = (over: Partial<FilaReemplazo> = {}) =>
    filaReemplazo(undefined, { id: "x", estado: "excluida", comprobante: { tipo: "01", serie: "F009", numero: "9" }, ...over });

  it("las excluidas van al TXT, así que se prevalidan como las demás y cuentan para SIN_FILAS", () => {
    expect(prev([excluida()], { registro }).apto).toBe(true);
    const rota = excluida({ proveedor: { tipo: "6", numero: "20100070970", razonSocial: "A|B" } });
    expect(prev([filaReemplazo(), rota], { registro }).errores).toEqual([
      expect.objectContaining({ filaId: "x", codigo: "CARACTER_NO_PERMITIDO", campo: "razonSocial" }),
    ]);
  });
});
