// R-NEW (spec 011, CA-7, RF-085): proveedor nuevo. Rojo: sin implementación.
import { describe, expect, it } from "vitest";
import {
  ctx,
  de,
  evaluar,
  fila,
  montos,
  pen,
  unico,
} from "../../tests/ayudas/filas-motor";
import { aplicarSugerencia, ConfirmacionInvalidaError } from "./index";

const DESCONOCIDO = { tipo: "6", numero: "20999999999" };

describe("R-NEW", () => {
  it("proveedor fuera de los conocidos: hallazgo 'Proveedor nuevo' sin montos, destino pendiente", () => {
    const h = unico(
      evaluar([fila({ proveedor: DESCONOCIDO })]).hallazgos,
      "R-NEW",
    );
    expect(h.filaId).toBe("f1");
    expect(h.destino).toBeNull();
    expect(h.explicacion).toContain("Proveedor nuevo");
    expect(h.sugerencia).toEqual({ tipo: "clasificar" });
    expect(h.dato).toBe("destino");
    expect(h.lecturas).toEqual({});
  });

  it("proveedor conocido no dispara", () => {
    expect(de(evaluar([fila()]).hallazgos, "R-NEW")).toEqual([]);
  });

  it("marca todas las filas del proveedor nuevo", () => {
    const r = evaluar([
      fila({ id: "a", proveedor: DESCONOCIDO }),
      fila({ id: "b", proveedor: DESCONOCIDO }),
      fila({ id: "c" }),
    ]);
    expect(de(r.hallazgos, "R-NEW").map((h) => h.filaId)).toEqual(["a", "b"]);
  });

  it("el documento se compara normalizado: sin espacios y en mayúsculas", () => {
    const c = ctx({ proveedoresConocidos: [{ tipo: "1", numero: "AB-123" }] });
    const f = fila({ proveedor: { tipo: "1", numero: " ab- 123 " } });
    expect(de(evaluar([f], c).hallazgos, "R-NEW")).toEqual([]);
  });

  it("el conocido también se normaliza", () => {
    const c = ctx({
      proveedoresConocidos: [{ tipo: "6", numero: "2010 0000 001" }],
    });
    expect(de(evaluar([fila()], c).hallazgos, "R-NEW")).toEqual([]);
  });

  it("mismo número con otro tipo de documento es un proveedor nuevo", () => {
    const f = fila({ proveedor: { tipo: "1", numero: "20100000001" } });
    expect(unico(evaluar([f]).hallazgos, "R-NEW").filaId).toBe("f1");
  });

  it("sin proveedores conocidos todos son nuevos", () => {
    const c = ctx({ proveedoresConocidos: [] });
    expect(de(evaluar([fila()], c).hallazgos, "R-NEW")).toHaveLength(1);
  });

  it("documentos con nombre de propiedad de Object (CONSTRUCTOR) se tratan como cualquier otro", () => {
    const f = fila({ proveedor: { tipo: "1", numero: "CONSTRUCTOR" } });
    expect(unico(evaluar([f]).hallazgos, "R-NEW").filaId).toBe("f1");
    const c = ctx({
      proveedoresConocidos: [{ tipo: "1", numero: "TOSTRING" }],
    });
    expect(unico(evaluar([f], c).hallazgos, "R-NEW").filaId).toBe("f1");
    const conocido = ctx({
      proveedoresConocidos: [{ tipo: "1", numero: "CONSTRUCTOR" }],
    });
    expect(de(evaluar([f], conocido).hallazgos, "R-NEW")).toEqual([]);
  });

  it("la sugerencia no trae importes", () => {
    const h = unico(
      evaluar([fila({ proveedor: DESCONOCIDO })]).hallazgos,
      "R-NEW",
    );
    expect(Object.keys(h.sugerencia ?? {})).toEqual(["tipo"]);
  });
});

describe("R-NEW: aplicar", () => {
  const m = montos("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
  const f = fila({ proveedor: DESCONOCIDO, montos: m });
  const h = () => unico(evaluar([f]).hallazgos, "R-NEW");
  /** Entorno con el que se evaluó el hallazgo (T15b-1). */
  const ent = { filas: [f], contexto: ctx() };

  it("con destino elegido consolida en ese destino y conserva el total", () => {
    const r = aplicarSugerencia(m, h(), { destino: "DNG" }, ent);
    expect(r.excluir).toBe(false);
    expect(r.montos.obtener("biDng").toString()).toBe("100.00");
    expect(r.montos.obtener("igvDng").toString()).toBe("18.00");
    expect(r.montos.obtener("biDg").toString()).toBe("0.00");
    expect(r.montos.total.toString()).toBe("118.00");
  });

  it("sin confirmación, con confirmación de otro tipo o con destino inexistente: ConfirmacionInvalidaError", () => {
    expect(() => aplicarSugerencia(m, h(), undefined, ent)).toThrow(ConfirmacionInvalidaError);
    expect(() => aplicarSugerencia(m, h(), { gravado: pen("1.00") }, ent)).toThrow(
      ConfirmacionInvalidaError,
    );
    expect(() =>
      aplicarSugerencia(m, h(), { destino: "XX" as unknown as "DG" }, ent),
    ).toThrow(ConfirmacionInvalidaError);
  });
});
