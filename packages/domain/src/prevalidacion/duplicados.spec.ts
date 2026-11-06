// Spec 012 (T4, rojo): duplicados (D11; CA-6). La clave es tipo de comprobante + serie en mayúsculas
// + número sin ceros a la izquierda + documento del proveedor (tipo y número). Cuando hay un
// duplicado entre filas no excluidas, el error DUPLICADO va en TODAS las copias.
import { describe, expect, it } from "vitest";
import { prevalidar } from "../index";
import type { FilaReemplazo } from "../index";
import { CABECERA, filaReemplazo } from "../../tests/ayudas/filas-reemplazo";

const compro = (id: string, serie: string, numero: string, over: Partial<FilaReemplazo> = {}): FilaReemplazo =>
  filaReemplazo(undefined, { id, comprobante: { tipo: "01", serie, numero }, ...over });

const dup = (filas: FilaReemplazo[]) =>
  prevalidar(filas, { cabecera: CABECERA }).errores.filter((e) => e.codigo === "DUPLICADO");

describe("CA-6 · el mismo comprobante dos veces", () => {
  it("error en ambas copias", () => {
    const e = dup([compro("a", "F001", "123"), compro("b", "F001", "123")]);
    expect(e.map((x) => x.filaId)).toEqual(["a", "b"]);
    expect(e.every((x) => typeof x.explicacion === "string" && x.explicacion.length > 0)).toBe(true);
    expect(prevalidar([compro("a", "F001", "123"), compro("b", "F001", "123")], { cabecera: CABECERA }).apto).toBe(false);
  });

  it("tres copias: error en las tres", () => {
    expect(dup([compro("a", "F001", "7"), compro("b", "F001", "7"), compro("c", "F001", "7")]).map((x) => x.filaId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("con ceros a la izquierda en el número es el mismo comprobante", () => {
    expect(dup([compro("a", "F001", "123"), compro("b", "F001", "00123")]).map((x) => x.filaId)).toEqual(["a", "b"]);
  });

  it("con la serie en minúsculas es el mismo comprobante", () => {
    expect(dup([compro("a", "F001", "123"), compro("b", "f001", "123")]).map((x) => x.filaId)).toEqual(["a", "b"]);
  });

  it("ceros y minúsculas a la vez, y sin importar el orden de las filas", () => {
    const filas = [compro("b", "f001", "000123"), compro("a", "F001", "123")];
    expect(dup(filas).map((x) => x.filaId)).toEqual(["a", "b"]);
  });

  it("dos duplicados distintos dan error en las cuatro filas", () => {
    const filas = [compro("a", "F001", "1"), compro("b", "F001", "1"), compro("c", "F001", "2"), compro("d", "F001", "2")];
    expect(dup(filas).map((x) => x.filaId)).toEqual(["a", "b", "c", "d"]);
  });

  it("estados distintos (original, modificada, agregada) cuentan igual", () => {
    const filas = [
      compro("a", "F001", "5", { estado: "original" }),
      compro("b", "F001", "5", { estado: "agregada" }),
      compro("c", "F001", "5", { estado: "modificada" }),
    ];
    expect(dup(filas).map((x) => x.filaId)).toEqual(["a", "b", "c"]);
  });
});

describe("CA-6 · lo que no es duplicado", () => {
  it("otro proveedor, otro tipo de documento del proveedor, otro tipo de comprobante o otra serie", () => {
    const base = compro("a", "F001", "123");
    expect(dup([base, compro("b", "F001", "123", { proveedor: { tipo: "6", numero: "20700000011" } })])).toEqual([]);
    expect(dup([base, compro("b", "F001", "123", { proveedor: { tipo: "7", numero: "20100070970" } })])).toEqual([]);
    expect(
      dup([base, filaReemplazo(undefined, { id: "b", comprobante: { tipo: "03", serie: "F001", numero: "123" } })]),
    ).toEqual([]);
    expect(dup([base, compro("b", "F002", "123")])).toEqual([]);
  });

  it("números distintos: 123 y 1230 no son el mismo (solo cuentan los ceros a la izquierda)", () => {
    expect(dup([compro("a", "F001", "123"), compro("b", "F001", "1230")])).toEqual([]);
    expect(dup([compro("a", "F001", "10"), compro("b", "F001", "1")])).toEqual([]);
  });

  it("la fecha, los montos y la razón social no entran en la clave: mismo comprobante con otra fecha sigue duplicado", () => {
    const filas = [compro("a", "F001", "123"), compro("b", "F001", "123", { fechaEmision: "2026-10-06" })];
    expect(dup(filas).map((x) => x.filaId)).toEqual(["a", "b"]);
  });
});

describe("CA-6 · filas excluidas", () => {
  it("si una de las copias está excluida, no hay error en ninguna", () => {
    const r = prevalidar([compro("a", "F001", "123"), compro("b", "F001", "123", { estado: "excluida" })], { cabecera: CABECERA });
    expect(r.errores).toEqual([]);
    expect(r.apto).toBe(true);
  });

  it("dos copias excluidas y una no excluida: sin error", () => {
    const filas = [
      compro("a", "F001", "123", { estado: "excluida" }),
      compro("b", "F001", "123", { estado: "excluida" }),
      compro("c", "F001", "123"),
    ];
    expect(dup(filas)).toEqual([]);
  });

  it("tres copias con una excluida: error solo en las dos no excluidas", () => {
    const filas = [
      compro("a", "F001", "123"),
      compro("b", "F001", "123", { estado: "excluida" }),
      compro("c", "F001", "00123"),
    ];
    expect(dup(filas).map((x) => x.filaId)).toEqual(["a", "c"]);
  });
});
