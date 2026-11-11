// Spec 012b (T7, backend): bordes de forma de archivos/ y de erroresDeFilaVenta que las pruebas de T1 no
// recorren (cobertura ≥ 90 % por archivo). Un caso feliz y uno de error por cada comportamiento.
import { describe, expect, it } from "vitest";
import { EntradaPrevalidacionInvalidaError, canonHuella, erroresDeFilaVenta, prepararArchivo } from "../index";
import type { EntradaCanonHuella } from "../index";
import { CABECERA, filaReemplazo, filaSanJuan, montosDe } from "../../tests/ayudas/filas-reemplazo";
import { CABECERA_VENTAS, filaVenta, ventaNum } from "../../tests/ayudas/filas-venta";

const FORMATO = { id: "RCE-REEMPLAZO", version: "0-provisional", oficial: false };

describe("erroresDeFilaVenta · cabecera", () => {
  it("con la cabecera de ventas responde; con la de compras lanza", () => {
    expect(erroresDeFilaVenta(CABECERA_VENTAS, filaVenta())).toEqual([]);
    expect(() => erroresDeFilaVenta(CABECERA, filaVenta())).toThrow(EntradaPrevalidacionInvalidaError);
  });
});

describe("canonHuella · formato y origenUsd", () => {
  const compras = (over: Partial<EntradaCanonHuella> = {}): EntradaCanonHuella => ({
    cabecera: CABECERA,
    formato: FORMATO,
    original: [filaReemplazo()],
    vigente: [filaReemplazo()],
    ...over,
  });

  it("un formato con id, versión u oficial de otro tipo, o con claves de más, lanza", () => {
    expect(() => canonHuella(compras())).not.toThrow();
    for (const formato of [{ ...FORMATO, id: 1 }, { ...FORMATO, version: null }, { ...FORMATO, oficial: "no" }, { ...FORMATO, extra: true }]) {
      expect(() => canonHuella(compras({ formato: formato as never }))).toThrow(EntradaPrevalidacionInvalidaError);
    }
  });

  it("el origenUsd de una fila PEN entra en el texto: su tipo de cambio lo cambia", () => {
    const conOrigen = (tipoCambio: string) =>
      filaReemplazo(undefined, { origenUsd: { montos: montosDe("USD", { biDg: "30.30", igvDg: "5.45" }), tipoCambio } });
    const a = canonHuella(compras({ original: [conOrigen("3.300")], vigente: [conOrigen("3.300")] }));
    const b = canonHuella(compras({ original: [conOrigen("3.300")], vigente: [conOrigen("3.301")] }));
    expect(a).not.toBe(canonHuella(compras()));
    expect(b).not.toBe(a);
  });
});

describe("prepararArchivo · forma de la entrada", () => {
  const ventas = (saltos: unknown) =>
    prepararArchivo({
      libro: "ventas",
      cabecera: CABECERA_VENTAS,
      original: [ventaNum("03", "B001", "1"), ventaNum("03", "B001", "3")],
      vigente: [ventaNum("03", "B001", "1"), ventaNum("03", "B001", "3")],
      saltos: saltos as never,
      permitirProvisional: true,
    });

  it("un salto justificado sin comentario también quita el aviso; un rango sin justificar lo nombra entero", () => {
    expect(ventas([{ tipo: "03", serie: "B001", desde: 2, hasta: 2 }]).avisos).toEqual([]);
    const rango = prepararArchivo({
      libro: "ventas",
      cabecera: CABECERA_VENTAS,
      original: [ventaNum("03", "B001", "1"), ventaNum("03", "B001", "5")],
      vigente: [ventaNum("03", "B001", "1"), ventaNum("03", "B001", "5")],
      permitirProvisional: true,
    });
    expect(rango.avisos.map((a) => a.explicacion)).toEqual(["Faltan B001-2 a B001-4"]);
  });

  it("saltos que no son una lista, o con una entrada sin tipo o serie de texto, lanzan", () => {
    expect(ventas([]).avisos).toHaveLength(1);
    for (const s of [{}, [null], [{ tipo: 3, serie: "B001", desde: 2, hasta: 2 }], [{ tipo: "03", desde: 2, hasta: 2 }]]) {
      expect(() => ventas(s)).toThrow(EntradaPrevalidacionInvalidaError);
    }
  });

  it("compras con `reglas: null` o con `saltos`, o sin `permitirProvisional` booleano, lanzan", () => {
    const sj = filaSanJuan();
    const base = { libro: "compras", cabecera: CABECERA, original: [sj], vigente: [sj], permitirProvisional: true } as const;
    expect(prepararArchivo(base).generable).toBe(true);
    expect(() => prepararArchivo({ ...base, reglas: null } as never)).toThrow(EntradaPrevalidacionInvalidaError);
    expect(() => prepararArchivo({ ...base, saltos: [] } as never)).toThrow(EntradaPrevalidacionInvalidaError);
    expect(() => prepararArchivo({ ...base, permitirProvisional: "true" } as never)).toThrow(EntradaPrevalidacionInvalidaError);
  });
});
