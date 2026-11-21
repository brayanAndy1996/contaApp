// Spec 025 · T19 (correcciones de la ronda 2, rojo): H-025-2-1. D-3/U-2 cuentan COMPROBANTES, no filas: un mismo comprobante
// (tipo de comprobante + serie + número, del mismo proveedor) repetido en un periodo o devuelto en dos periodos cuenta una vez.
//
// Contrato para T20 (`FilaHistorial` gana `serie?` y `numero?`, cadenas; el worker las pasa desde `FilaPropuestaSire.serie/numero`):
//  - Clave del comprobante = proveedor (tipo:número normalizado) + tipoComprobante + serie + numero, tras `trim` y mayúsculas ASCII.
//  - Una fila sin serie o sin número (ausentes o vacíos) no es identificable: cuenta como fila suelta (no se deduplica); así las
//    pruebas de T2 y T13, que no llevan serie ni número, siguen valiendo.
//  - Mismo comprobante con montos distintos: cuenta UNA fila, la del periodo más reciente (AAAAMM mayor). Si es el mismo periodo,
//    la de mayor `${biDg}|${biDgng}|${biDng}` por unidades de código (determinista; no depende del orden de las filas).
//  - Solo se deduplican `conteos` y `descartadas.sinBase` (se cuenta el comprobante elegido). `periodosConProveedor` y
//    `razonSocial` siguen saliendo de TODAS las filas (el proveedor aparece en esos periodos aunque el comprobante se repita).
//  - Un único comprobante repetido: queda la candidata con total 1 y `destino: null` (U-2: «al menos 2»; sin criterio claro).
import { describe, expect, it } from "vitest";
import { aprenderDeHistorial } from "./index";
import type { FilaHistorial } from "./index";

const RUC = "20100070970";
type Dest = "DG" | "DGNG" | "DNG";
/** `FilaHistorial` con los campos que T20 añade; asignable hoy y después a `FilaHistorial`. */
type FilaCmp = FilaHistorial & { serie?: string; numero?: string };

const fila = (destino: Dest, serie: string | undefined, numero: string | undefined, over: Partial<FilaCmp> = {}): FilaCmp => ({
  periodo: "202609",
  numeroDocProveedor: RUC,
  tipoComprobante: "01",
  ...(serie === undefined ? {} : { serie }),
  ...(numero === undefined ? {} : { numero }),
  biDg: destino === "DG" ? "100.00" : "0.00",
  biDgng: destino === "DGNG" ? "100.00" : "0.00",
  biDng: destino === "DNG" ? "100.00" : "0.00",
  ...over,
});

const unica = (filas: readonly FilaHistorial[]) => {
  const r = aprenderDeHistorial(filas);
  expect(r.candidatas).toHaveLength(1);
  return r.candidatas[0] as (typeof r.candidatas)[number];
};

describe("T19 · H-025-2-1: se cuentan comprobantes, no filas", () => {
  it("una sola factura DG repetida en el mismo periodo: total 1, sin destino propuesto (U-2: al menos 2)", () => {
    const c = unica([fila("DG", "F001", "1"), fila("DG", "F001", "1")]);
    expect(c.conteos).toEqual({ DG: 1, DGNG: 0, DNG: 0, mixto: 0, total: 1 });
    expect(c.destino).toBeNull();
  });

  it("una sola factura DG devuelta en dos periodos: total 1, sin destino; el proveedor aparece en 2 periodos", () => {
    const c = unica([fila("DG", "F001", "1", { periodo: "202609" }), fila("DG", "F001", "1", { periodo: "202610" })]);
    expect(c.conteos.total).toBe(1);
    expect(c.conteos.DG).toBe(1);
    expect(c.destino).toBeNull();
    expect(c.periodosConProveedor).toBe(2);
  });

  it("dos comprobantes distintos DG siguen proponiendo DG; el repetido no suma", () => {
    const c = unica([fila("DG", "F001", "1"), fila("DG", "F001", "1"), fila("DG", "F001", "2")]);
    expect(c.conteos).toEqual({ DG: 2, DGNG: 0, DNG: 0, mixto: 0, total: 2 });
    expect(c.destino).toBe("DG");
  });

  it("la repetición no empuja al 80 %: 4 DG distintos + 1 DNG repetido 3 veces = 4 de 5, propone DG; si fuera por filas serían 4 de 7", () => {
    const c = unica([
      ...[1, 2, 3, 4].map((i) => fila("DG", "F001", String(i))),
      fila("DNG", "F002", "9"),
      fila("DNG", "F002", "9"),
      fila("DNG", "F002", "9"),
    ]);
    expect(c.conteos).toEqual({ DG: 4, DGNG: 0, DNG: 1, mixto: 0, total: 5 });
    expect(c.destino).toBe("DG");
  });

  it("la repetición no fabrica el 80 %: 3 DG distintos (uno repetido) + 1 DNG = 3 de 4, sin destino; por filas serían 4 de 5 y propondría DG", () => {
    const c = unica([
      fila("DG", "F001", "1"),
      fila("DG", "F001", "2"),
      fila("DG", "F001", "3"),
      fila("DG", "F001", "3"),
      fila("DNG", "F002", "1"),
    ]);
    expect(c.conteos.total).toBe(4);
    expect(c.destino).toBeNull();
  });

  it("no depende del orden de las filas ni de que el duplicado esté junto", () => {
    const base = [fila("DG", "F001", "1"), fila("DG", "F001", "2"), fila("DG", "F001", "1", { periodo: "202610" }), fila("DNG", "F002", "1")];
    const esperado = aprenderDeHistorial(base);
    expect(esperado.candidatas[0]?.conteos).toEqual({ DG: 2, DGNG: 0, DNG: 1, mixto: 0, total: 3 });
    expect(aprenderDeHistorial([...base].reverse())).toEqual(esperado);
    expect(aprenderDeHistorial([base[2], base[3], base[0], base[1]] as FilaCmp[])).toEqual(esperado);
  });

  it("mismo comprobante con montos distintos: cuenta la fila del periodo más reciente", () => {
    const reciente = aprenderDeHistorial([
      fila("DG", "F001", "1", { periodo: "202609" }),
      fila("DNG", "F001", "1", { periodo: "202610" }),
    ]);
    expect(reciente.candidatas[0]?.conteos).toEqual({ DG: 0, DGNG: 0, DNG: 1, mixto: 0, total: 1 });
    // Con el orden de entrada invertido, el mismo resultado.
    const inverso = aprenderDeHistorial([
      fila("DNG", "F001", "1", { periodo: "202610" }),
      fila("DG", "F001", "1", { periodo: "202609" }),
    ]);
    expect(inverso).toEqual(reciente);
  });

  it("mismo comprobante, mismo periodo y montos distintos: una sola fila, siempre la misma sea cual sea el orden", () => {
    const a = fila("DG", "F001", "1");
    const b = fila("DNG", "F001", "1");
    const ab = aprenderDeHistorial([a, b]);
    const ba = aprenderDeHistorial([b, a]);
    expect(ab.candidatas[0]?.conteos.total).toBe(1);
    expect(ba).toEqual(ab);
    // Mayor `${biDg}|${biDgng}|${biDng}` por unidades de código: «100.00|…» > «0.00|…», gana la DG.
    expect(ab.candidatas[0]?.conteos.DG).toBe(1);
  });

  it("un comprobante repetido sin base cuenta una vez en descartadas.sinBase", () => {
    const r = aprenderDeHistorial([
      fila("DG", "F001", "1", { biDg: "0.00" }),
      fila("DG", "F001", "1", { biDg: "0.00" }),
      fila("DG", "F001", "2"),
    ]);
    expect(r.descartadas.sinBase).toBe(1);
    expect(r.candidatas[0]?.conteos.total).toBe(1);
  });

  it("mixto repetido cuenta una vez como mixto", () => {
    const m = (): FilaCmp => fila("DG", "F001", "1", { biDng: "50.00" });
    const c = unica([m(), m()]);
    expect(c.conteos).toEqual({ DG: 0, DGNG: 0, DNG: 0, mixto: 1, total: 1 });
  });

  it("la serie y el número se comparan sin espacios ni minúsculas ASCII", () => {
    const c = unica([fila("DG", "F001", "1"), fila("DG", " f001 ", " 1 ")]);
    expect(c.conteos.total).toBe(1);
  });

  describe("controles: lo que NO es el mismo comprobante sigue contando por separado", () => {
    it("distinta serie, distinto número o distinto tipo de comprobante", () => {
      const c = unica([
        fila("DG", "F001", "1"),
        fila("DG", "F002", "1"),
        fila("DG", "F001", "2"),
        fila("DG", "E001", "1", { tipoComprobante: "03" }),
        fila("DG", "F001", "1", { tipoComprobante: "07" }),
      ]);
      expect(c.conteos.total).toBe(5);
    });

    it("la misma serie y número de otro proveedor es otro comprobante", () => {
      const r = aprenderDeHistorial([fila("DG", "F001", "1"), fila("DG", "F001", "1", { numeroDocProveedor: "20555555551" })]);
      expect(r.candidatas.map((c) => c.conteos.total)).toEqual([1, 1]);
    });

    it("filas sin serie o sin número no se deduplican (no son identificables)", () => {
      const c = unica([fila("DG", undefined, undefined), fila("DG", undefined, undefined), fila("DG", "F001", ""), fila("DG", "F001", "")]);
      expect(c.conteos.total).toBe(4);
    });
  });
});
