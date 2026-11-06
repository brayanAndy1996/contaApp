// Spec 014 · T1 (rojo). Edición de montos con total y cuadre (D-5, D-16; CA-4, CA-5, CA-6, CA-19).
// Contrato fijado por estas pruebas (plan 014, Contratos: Dominio), en packages/domain/src/compras/edicion.ts,
// exportado por compras/index.ts:
//   type CambiosMontos = Partial<Record<ColumnaCompra, string>>      // cadenas decimales, nunca number
//   interface CeldaCuadre { columna: ColumnaCompra; cuadra: boolean; explicacion: string | null }
//   interface CuadreEdicion { cuadra: boolean; celdas: readonly CeldaCuadre[] }
//   aplicarEdicion(montos: MontosComprobante, cambios: CambiosMontos):
//       { montos: MontosComprobante; total: Money; cuadre: CuadreEdicion }
// - Los cambios sustituyen solo las columnas nombradas; el total de la salida es Σ de las 10 componentes
//   (D2 de 010), no el total de entrada. `montos.total` y `total` son el mismo valor. La moneda se conserva.
// - `cuadre.celdas` trae una celda por cada columna de IGV (igvDg, igvDgng, igvDng). Una celda cuadra si su
//   IGV es exactamente 0.00 o, con base distinta de cero y del mismo signo, es 18 % o 10 % de su BI con
//   ±0.01 (la misma regla de IGV de la prevalidación 012). `explicacion` es null si cuadra y, si no, el
//   texto con las cifras («1.61 no es 18 % ni 10 % de 21.48»). `cuadre.cuadra` = todas las celdas cuadran.
// - Un IGV descuadrado NO lanza (HU-16): se devuelve señalado. Lanzan (DineroError) un monto con más de 2
//   decimales, un valor que no es cadena, una clave que no es una de las 10 columnas, un monto fuera de
//   NUMERIC(14,2) o un total (Σ) fuera de NUMERIC(14,2). Los montos negativos se admiten.
import { describe, expect, it } from "vitest";
import { MontosComprobante } from "../comprobante/index";
import type { ColumnaCompra } from "../comprobante/index";
import { DineroError, Money } from "../dinero/index";
import { montosDe } from "../../tests/ayudas/filas";
import { aplicarEdicion } from "./index";

const base = () => montosDe("PEN", { biDg: "100.00", igvDg: "18.00" });
const celda = (r: ReturnType<typeof aplicarEdicion>, columna: ColumnaCompra) => {
  const c = r.cuadre.celdas.find((x) => x.columna === columna);
  if (c === undefined) throw new Error(`falta la celda ${columna}`);
  return c;
};

describe("aplicarEdicion: total = Σ componentes (D-5)", () => {
  it("editar la BI recalcula el total como la suma de las 10 columnas", () => {
    const r = aplicarEdicion(base(), { biDg: "200.00" });
    expect(r.total.toString()).toBe("218.00");
    expect(r.montos.total.toString()).toBe("218.00");
    expect(r.montos.obtener("biDg").toString()).toBe("200.00");
    expect(r.montos.obtener("igvDg").toString()).toBe("18.00");
  });

  it("devuelve Money y MontosComprobante, nunca number", () => {
    const r = aplicarEdicion(base(), { biDg: "200.00" });
    expect(r.total).toBeInstanceOf(Money);
    expect(r.montos).toBeInstanceOf(MontosComprobante);
    expect(typeof r.total).not.toBe("number");
  });

  it("el total de entrada no cuenta: un original descuadrado se recalcula como Σ", () => {
    const descuadrado = MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "120.00" });
    const r = aplicarEdicion(descuadrado, { noGravado: "5.00" });
    expect(r.total.toString()).toBe("123.00");
  });

  it("suma las 10 columnas, no solo BI e IGV", () => {
    const r = aplicarEdicion(montosDe("PEN", {}), {
      biDg: "1.00",
      igvDg: "0.18",
      biDgng: "2.00",
      igvDgng: "0.36",
      biDng: "3.00",
      igvDng: "0.00",
      noGravado: "4.00",
      isc: "5.00",
      icbper: "0.50",
      otrosTributos: "0.25",
    });
    expect(r.total.toString()).toBe("16.29");
  });

  it("las columnas no nombradas se conservan; el original no se muta", () => {
    const m = base();
    const r = aplicarEdicion(m, { isc: "770.00" });
    expect(r.montos.obtener("biDg").toString()).toBe("100.00");
    expect(r.montos.obtener("isc").toString()).toBe("770.00");
    expect(m.obtener("isc").toString()).toBe("0.00");
    expect(m.total.toString()).toBe("118.00");
  });

  it("conserva la moneda USD", () => {
    const r = aplicarEdicion(montosDe("USD", { biDg: "0.15", igvDg: "0.03" }), { biDg: "0.20" });
    expect(r.montos.moneda).toBe("USD");
    expect(r.total.moneda).toBe("USD");
    expect(r.total.toString()).toBe("0.23");
  });

  it("San Juan: mover la BI a ISC deja el total igual (CA-6)", () => {
    const sanJuan = montosDe("PEN", { biDg: "770.00", igvDg: "0.00" });
    const r = aplicarEdicion(sanJuan, { biDg: "0.00", isc: "770.00" });
    expect(r.total.toString()).toBe("770.00");
    expect(r.montos.obtener("isc").toString()).toBe("770.00");
    expect(r.cuadre.cuadra).toBe(true);
  });
});

describe("aplicarEdicion: montos negativos y bordes", () => {
  it("admite negativos (nota de crédito)", () => {
    const r = aplicarEdicion(base(), { biDg: "-100.00", igvDg: "-18.00" });
    expect(r.total.toString()).toBe("-118.00");
    expect(r.cuadre.cuadra).toBe(true);
  });

  it("admite el máximo de NUMERIC(14,2) en una columna", () => {
    const r = aplicarEdicion(montosDe("PEN", {}), { noGravado: "999999999999.99" });
    expect(r.total.toString()).toBe("999999999999.99");
  });

  it("admite el mínimo de NUMERIC(14,2)", () => {
    const r = aplicarEdicion(montosDe("PEN", {}), { noGravado: "-999999999999.99" });
    expect(r.total.toString()).toBe("-999999999999.99");
  });
});

describe("aplicarEdicion: entradas que lanzan (CA-5)", () => {
  it.each(["0.005", "0.015", "100.001", "1.234"])("un monto con más de 2 decimales (%s) lanza", (v) => {
    expect(() => aplicarEdicion(base(), { biDg: v })).toThrow(DineroError);
  });

  it.each(["1000000000000.00", "-1000000000000.00", "99999999999999.99"])("un monto fuera de NUMERIC(14,2) (%s) lanza", (v) => {
    expect(() => aplicarEdicion(base(), { biDg: v })).toThrow(DineroError);
  });

  it("columnas válidas cuya suma sale de NUMERIC(14,2) lanzan", () => {
    expect(() => aplicarEdicion(montosDe("PEN", {}), { biDg: "999999999999.99", biDng: "999999999999.99" })).toThrow(DineroError);
  });

  it.each(["", "abc", "1e3", "1,5", " 1.00", "NaN"])("un texto que no es monto (%j) lanza", (v) => {
    expect(() => aplicarEdicion(base(), { biDg: v })).toThrow(DineroError);
  });

  it("un valor que no es cadena (number) lanza: el dinero nunca viaja como number", () => {
    expect(() => aplicarEdicion(base(), { biDg: 100 } as never)).toThrow(DineroError);
  });

  it("una clave que no es columna (total, otra) lanza: el total no se edita", () => {
    expect(() => aplicarEdicion(base(), { total: "5.00" } as never)).toThrow(DineroError);
    expect(() => aplicarEdicion(base(), { desconocida: "5.00" } as never)).toThrow(DineroError);
  });

  it("una edición que lanza no deja efectos: el original sigue igual", () => {
    const m = base();
    expect(() => aplicarEdicion(m, { biDg: "0.005" })).toThrow();
    expect(m.toJSON()).toEqual(base().toJSON());
  });
});

describe("aplicarEdicion: cuadre por celda con explicación (D-5, HU-16)", () => {
  it("una fila que cuadra: ninguna celda marcada y explicación null", () => {
    const r = aplicarEdicion(base(), { noGravado: "5.00" });
    expect(r.cuadre.cuadra).toBe(true);
    expect(r.cuadre.celdas.map((c) => c.columna).sort()).toEqual(["igvDg", "igvDgng", "igvDng"]);
    for (const c of r.cuadre.celdas) {
      expect(c.cuadra).toBe(true);
      expect(c.explicacion).toBeNull();
    }
  });

  it("editar la BI de modo que el IGV deja de cuadrar: marca igvDg y aun así devuelve (no lanza)", () => {
    const r = aplicarEdicion(base(), { biDg: "200.00" });
    expect(r.cuadre.cuadra).toBe(false);
    const c = celda(r, "igvDg");
    expect(c.cuadra).toBe(false);
    expect(c.explicacion).toContain("18.00");
    expect(c.explicacion).toContain("200.00");
    expect(r.total.toString()).toBe("218.00");
  });

  it("mixta 21.48 / 1.61: la celda igvDg no cuadra y la explicación lleva las dos cifras", () => {
    const r = aplicarEdicion(montosDe("PEN", {}), { biDg: "21.48", igvDg: "1.61" });
    const c = celda(r, "igvDg");
    expect(c.cuadra).toBe(false);
    expect(c.explicacion).toContain("1.61");
    expect(c.explicacion).toContain("21.48");
    expect(r.total.toString()).toBe("23.09");
  });

  it("mixta tras separar (8.97 gravado + 12.51 no gravado): cuadra", () => {
    const r = aplicarEdicion(montosDe("PEN", { biDg: "21.48", igvDg: "1.61" }), { biDg: "8.97", noGravado: "12.51" });
    expect(r.cuadre.cuadra).toBe(true);
    expect(r.total.toString()).toBe("23.09");
  });

  it("IGV exactamente 0.00 con BI (San Juan) cuadra, como en 012", () => {
    const r = aplicarEdicion(montosDe("PEN", {}), { biDg: "770.00", igvDg: "0.00" });
    expect(celda(r, "igvDg").cuadra).toBe(true);
  });

  it("acepta el IGV al 10 % (restaurantes y hoteles)", () => {
    const r = aplicarEdicion(montosDe("PEN", {}), { biDg: "100.00", igvDg: "10.00" });
    expect(celda(r, "igvDg").cuadra).toBe(true);
  });

  it("tolera ±0.01 de redondeo y no más", () => {
    expect(celda(aplicarEdicion(montosDe("PEN", {}), { biDg: "100.00", igvDg: "18.01" }), "igvDg").cuadra).toBe(true);
    expect(celda(aplicarEdicion(montosDe("PEN", {}), { biDg: "100.00", igvDg: "17.99" }), "igvDg").cuadra).toBe(true);
    expect(celda(aplicarEdicion(montosDe("PEN", {}), { biDg: "100.00", igvDg: "18.02" }), "igvDg").cuadra).toBe(false);
  });

  it("IGV sin base no cuadra", () => {
    const r = aplicarEdicion(montosDe("PEN", {}), { igvDg: "5.00" });
    expect(celda(r, "igvDg").cuadra).toBe(false);
    expect(celda(r, "igvDg").explicacion).toContain("5.00");
  });

  it("IGV de signo contrario a la base no cuadra", () => {
    const r = aplicarEdicion(montosDe("PEN", {}), { biDg: "-100.00", igvDg: "18.00" });
    expect(celda(r, "igvDg").cuadra).toBe(false);
  });

  it("nota de crédito con base e IGV negativos cuadra", () => {
    const r = aplicarEdicion(montosDe("PEN", {}), { biDg: "-100.00", igvDg: "-18.00" });
    expect(celda(r, "igvDg").cuadra).toBe(true);
  });

  it("revisa cada destino por separado (DGNG y DNG)", () => {
    const r = aplicarEdicion(montosDe("PEN", {}), {
      biDg: "100.00",
      igvDg: "18.00",
      biDgng: "100.00",
      igvDgng: "7.00",
      biDng: "50.00",
      igvDng: "9.00",
    });
    expect(celda(r, "igvDg").cuadra).toBe(true);
    expect(celda(r, "igvDgng").cuadra).toBe(false);
    expect(celda(r, "igvDng").cuadra).toBe(true);
    expect(r.cuadre.cuadra).toBe(false);
  });

  it("clasificar a DNG no descuadra: BI e IGV juntos en las columnas 3 (CA-4)", () => {
    const r = aplicarEdicion(base(), { biDg: "0.00", igvDg: "0.00", biDng: "100.00", igvDng: "18.00" });
    expect(r.total.toString()).toBe("118.00");
    expect(r.cuadre.cuadra).toBe(true);
  });
});

describe("aplicarEdicion es determinista (D-16: calcular y editar dan lo mismo)", () => {
  it("dos llamadas con la misma entrada dan el mismo resultado", () => {
    const cambios = { biDg: "200.00", noGravado: "1.50" };
    const a = aplicarEdicion(base(), cambios);
    const b = aplicarEdicion(base(), cambios);
    expect(a.montos.toJSON()).toEqual(b.montos.toJSON());
    expect(a.total.toString()).toBe(b.total.toString());
    expect(a.cuadre).toEqual(b.cuadre);
  });

  it("no muta el objeto de cambios", () => {
    const cambios = Object.freeze({ biDg: "200.00" });
    expect(() => aplicarEdicion(base(), cambios)).not.toThrow();
  });
});
