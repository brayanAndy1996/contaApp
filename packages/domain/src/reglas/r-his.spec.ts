// R-HIS (spec 021, RF-086, D-7, P-6; CA-2, CA-4, CA-11, CA-12). Rojo: planificarHistorial sin implementación (T7).
import { describe, expect, it } from "vitest";
import { congelarProfundo, ctx, de, evaluar, fila, montos, pen, ser, tc, unico, usd } from "../../tests/ayudas/filas-motor";
import { cambiarDestino } from "../comprobante/index";
import type { Destino } from "../comprobante/index";
import { planificarHistorial } from "./r-his";
import { aplicarSugerencia } from "./index";
import type { FilaEvaluable, ReglaAprendidaEvaluable } from "./index";

const PROVEEDOR = { tipo: "6", numero: "20100000001" };
const regla = (destino: Destino, over: Partial<ReglaAprendidaEvaluable> = {}): ReglaAprendidaEvaluable => ({
  id: "regla-1",
  proveedor: { ...PROVEEDOR },
  destino,
  ...over,
});
const ACTIVA = { rHisActiva: true };
const plan = (filas: FilaEvaluable[], reglas: ReglaAprendidaEvaluable[], op = ACTIVA) => planificarHistorial(filas, reglas, op);

// Fixture de 01 §7 regla 3: cliente con ventas exoneradas, proveedor recurrente → DNG.
const gravadaDg = () => montos("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });

describe("planificarHistorial: lo que sí se mueve", () => {
  it("proveedor con regla DNG: los montos son los de cambiarDestino(DNG) y el total no cambia (01 §7 regla 3)", () => {
    const f = fila({ id: "c1", montos: gravadaDg() });
    const r = plan([f], [regla("DNG")]);
    expect(r).toHaveLength(1);
    expect(r[0]!.filaId).toBe("c1");
    expect(r[0]!.reglaId).toBe("regla-1");
    expect(r[0]!.destino).toBe("DNG");
    expect(ser(r[0]!.montos)).toBe(ser(cambiarDestino(gravadaDg(), "DNG").montos));
    expect(r[0]!.montos.obtener("biDng").toString()).toBe("100.00");
    expect(r[0]!.montos.obtener("igvDng").toString()).toBe("18.00");
    expect(r[0]!.montos.obtener("biDg").toString()).toBe("0.00");
    expect(r[0]!.montos.obtener("igvDg").toString()).toBe("0.00");
    expect(r[0]!.montos.total.toString()).toBe("118.00");
  });

  it("el documento se compara normalizado: espacios y minúsculas, de ambos lados", () => {
    const f = fila({ proveedor: { tipo: "1", numero: " ab- 123 " }, montos: gravadaDg() });
    expect(plan([f], [regla("DNG", { proveedor: { tipo: "1", numero: "AB-123" } })])).toHaveLength(1);
    const g = fila({ proveedor: { tipo: "1", numero: "AB-123" }, montos: gravadaDg() });
    expect(plan([g], [regla("DNG", { proveedor: { tipo: "1", numero: "ab -123 " } })])).toHaveLength(1);
  });

  it("mezcla DG + DGNG: se consolida en el destino de la regla (BI e IGV sumados)", () => {
    const m = montos("PEN", { biDg: "60.00", igvDg: "10.80", biDgng: "40.00", igvDgng: "7.20", total: "118.00" });
    const r = plan([fila({ montos: m })], [regla("DG")]);
    expect(r).toHaveLength(1);
    expect(r[0]!.montos.obtener("biDg").toString()).toBe("100.00");
    expect(r[0]!.montos.obtener("igvDg").toString()).toBe("18.00");
    expect(r[0]!.montos.obtener("biDgng").toString()).toBe("0.00");
    expect(r[0]!.montos.obtener("igvDgng").toString()).toBe("0.00");
    expect(r[0]!.montos.total.toString()).toBe("118.00");
  });

  it("mezcla DG + DGNG hacia DNG: ambos pares terminan en DNG", () => {
    const m = montos("PEN", { biDg: "60.00", igvDg: "10.80", biDgng: "40.00", igvDgng: "7.20", total: "118.00" });
    const r = plan([fila({ montos: m })], [regla("DNG")]);
    expect(r[0]!.montos.obtener("biDng").toString()).toBe("100.00");
    expect(r[0]!.montos.obtener("igvDng").toString()).toBe("18.00");
    expect(r[0]!.montos.obtener("biDg").toString()).toBe("0.00");
  });

  it("nota de crédito (montos negativos): se mueve conservando el signo", () => {
    const m = montos("PEN", { biDg: "-100.00", igvDg: "-18.00", total: "-118.00" });
    const r = plan([fila({ montos: m })], [regla("DNG")]);
    expect(r).toHaveLength(1);
    expect(r[0]!.montos.obtener("biDng").toString()).toBe("-100.00");
    expect(r[0]!.montos.obtener("igvDng").toString()).toBe("-18.00");
    expect(r[0]!.montos.total.toString()).toBe("-118.00");
  });

  it("USD: se mueve en USD sin redondear de más (centavos de la mezcla se conservan)", () => {
    const m = montos("USD", { biDg: "10.05", igvDg: "1.81", biDgng: "0.10", igvDgng: "0.02", total: "11.98" });
    const r = plan([fila({ montos: m })], [regla("DGNG")]);
    expect(r).toHaveLength(1);
    expect(r[0]!.montos.moneda).toBe("USD");
    expect(r[0]!.montos.obtener("biDgng").toString()).toBe("10.15");
    expect(r[0]!.montos.obtener("igvDgng").toString()).toBe("1.83");
    expect(r[0]!.montos.total.toString()).toBe("11.98");
  });

  it("fila en PEN con origen USD y tipo de cambio: se mueven los montos en PEN y no lanza", () => {
    const origen = { montos: montos("USD", { biDg: "26.50", igvDg: "4.77", total: "31.27" }), tipoCambio: tc("3.775") };
    const m = montos("PEN", { biDg: "100.04", igvDg: "18.01", total: "118.05" });
    const r = plan([fila({ montos: m, origenUsd: origen })], [regla("DNG")]);
    expect(r).toHaveLength(1);
    expect(r[0]!.montos.moneda).toBe("PEN");
    expect(r[0]!.montos.obtener("biDng").toString()).toBe("100.04");
    expect(r[0]!.montos.obtener("igvDng").toString()).toBe("18.01");
    expect(r[0]!.montos.total.toString()).toBe("118.05");
  });

  it("varias filas: solo las del proveedor con regla, en el orden recibido y cada una con su filaId", () => {
    const otro = { tipo: "6", numero: "20999999999" };
    const filas = [
      fila({ id: "a", montos: gravadaDg() }),
      fila({ id: "b", proveedor: otro, montos: gravadaDg() }),
      fila({ id: "c", montos: gravadaDg() }),
    ];
    expect(plan(filas, [regla("DNG")]).map((p) => p.filaId)).toEqual(["a", "c"]);
  });

  it("dos reglas de proveedores distintos: cada fila recibe la suya", () => {
    const otro = { tipo: "6", numero: "20999999999" };
    const filas = [fila({ id: "a", montos: gravadaDg() }), fila({ id: "b", proveedor: otro, montos: gravadaDg() })];
    const r = plan(filas, [regla("DNG", { id: "r1" }), regla("DGNG", { id: "r2", proveedor: otro })]);
    expect(r.map((p) => [p.filaId, p.reglaId, p.destino])).toEqual([
      ["a", "r1", "DNG"],
      ["b", "r2", "DGNG"],
    ]);
  });

  it("no muta lo recibido (entradas congeladas) y el resultado no comparte montos con la entrada", () => {
    const f = congelarProfundo(fila({ montos: gravadaDg() }));
    const reglas = congelarProfundo([regla("DNG")]);
    const antes = ser(f);
    const r = plan([f], reglas);
    expect(ser(f)).toBe(antes);
    expect(r[0]!.montos).not.toBe(f.montos);
  });
});

describe("planificarHistorial: lo que no se mueve (CA-4)", () => {
  it("proveedor distinto: nada", () => {
    expect(plan([fila({ proveedor: { tipo: "6", numero: "20999999999" }, montos: gravadaDg() })], [regla("DNG")])).toEqual([]);
  });

  it("mismo número con otro tipo de documento: nada", () => {
    expect(plan([fila({ proveedor: { tipo: "1", numero: PROVEEDOR.numero }, montos: gravadaDg() })], [regla("DNG")])).toEqual([]);
  });

  it("sin reglas: nada", () => {
    expect(plan([fila({ montos: gravadaDg() })], [])).toEqual([]);
  });

  it("sin filas: nada", () => {
    expect(plan([], [regla("DNG")])).toEqual([]);
  });

  it("base gravada total 0 (San Juan: solo ISC 770.00): nada", () => {
    const m = montos("PEN", { isc: "770.00", total: "770.00" });
    expect(plan([fila({ montos: m })], [regla("DNG")])).toEqual([]);
  });

  it("base gravada 0 aunque haya IGV o no gravado: nada", () => {
    const m = montos("PEN", { igvDg: "1.00", noGravado: "10.00", total: "11.00" });
    expect(plan([fila({ montos: m })], [regla("DNG")])).toEqual([]);
  });

  it("el destino ya es el de la regla: nada", () => {
    expect(plan([fila({ montos: gravadaDg() })], [regla("DG")])).toEqual([]);
    const dng = montos("PEN", { biDng: "100.00", igvDng: "18.00", total: "118.00" });
    expect(plan([fila({ montos: dng })], [regla("DNG")])).toEqual([]);
  });

  it("R-HIS apagado en el estudio: nada", () => {
    expect(plan([fila({ montos: gravadaDg() })], [regla("DNG")], { rHisActiva: false })).toEqual([]);
  });
});

// CA-11 (P-6): la regla se aplica igual a una fila con R-ISC o R-MIX y las demás reglas se evalúan
// sobre la versión movida; aceptar da lo mismo que clasificar a mano en el destino de la regla.
describe("P-6 · R-HIS y otros hallazgos en la misma fila (CA-11)", () => {
  const entorno = (f: FilaEvaluable) => ({ filas: [f], contexto: ctx() });

  it("San Juan (ISC 770.00) en DNG movida a DG: R-ISC sobre la versión movida y mismos montos que a mano", () => {
    const original = montos("PEN", { biDng: "770.00", total: "770.00" });
    const movida = plan([fila({ montos: original })], [regla("DG")])[0]!.montos;
    const aMano = montos("PEN", { biDg: "770.00", total: "770.00" });
    expect(ser(movida)).toBe(ser(aMano));

    const hMovida = unico(evaluar([fila({ montos: movida })]).hallazgos, "R-ISC");
    const hMano = unico(evaluar([fila({ montos: aMano })]).hallazgos, "R-ISC");
    expect(hMovida.destino).toBe("DG");
    expect(ser(hMovida)).toBe(ser(hMano));

    const rMovida = aplicarSugerencia(movida, hMovida, undefined, entorno(fila({ montos: movida })));
    const rMano = aplicarSugerencia(aMano, hMano, undefined, entorno(fila({ montos: aMano })));
    expect(ser(rMovida.montos)).toBe(ser(rMano.montos));
    expect(rMovida.montos.obtener("isc").toString()).toBe("770.00");
    expect(rMovida.montos.obtener("biDg").toString()).toBe("0.00");
    expect(rMovida.montos.total.toString()).toBe("770.00");
  });

  it("mixta 21.48 / 1.61 en DNG movida a DG: R-MIX sobre la versión movida y mismos montos que a mano", () => {
    const original = montos("PEN", { biDng: "21.48", igvDng: "1.61", total: "23.09" });
    const movida = plan([fila({ montos: original })], [regla("DG")])[0]!.montos;
    const aMano = montos("PEN", { biDg: "21.48", igvDg: "1.61", total: "23.09" });
    expect(ser(movida)).toBe(ser(aMano));

    const hMovida = unico(evaluar([fila({ montos: movida })]).hallazgos, "R-MIX");
    const hMano = unico(evaluar([fila({ montos: aMano })]).hallazgos, "R-MIX");
    expect(hMovida.destino).toBe("DG");
    expect(ser(hMovida)).toBe(ser(hMano));
    expect(de(evaluar([fila({ montos: movida })]).hallazgos, "R-ISC")).toEqual([]);

    const rMovida = aplicarSugerencia(movida, hMovida, { gravado: pen("8.94") }, entorno(fila({ montos: movida })));
    const rMano = aplicarSugerencia(aMano, hMano, { gravado: pen("8.94") }, entorno(fila({ montos: aMano })));
    expect(ser(rMovida.montos)).toBe(ser(rMano.montos));
    expect(rMovida.montos.obtener("biDg").toString()).toBe("8.94");
    expect(rMovida.montos.obtener("noGravado").toString()).toBe("12.54");
    expect(rMovida.montos.total.toString()).toBe("23.09");
  });

  it("la mixta en USD movida a DG conserva el total y mantiene R-MIX en la versión movida", () => {
    const original = montos("USD", { biDng: "21.48", igvDng: "1.61", total: "23.09" });
    const movida = plan([fila({ montos: original })], [regla("DG")])[0]!.montos;
    expect(movida.moneda).toBe("USD");
    expect(movida.total.toString()).toBe("23.09");
    expect(unico(evaluar([fila({ montos: movida })]).hallazgos, "R-MIX").destino).toBe("DG");
    expect(usd("0.00").moneda).toBe("USD");
  });
});

// CA-12 (P-3): R-HIS no es hallazgo de fila; no aparece en la evaluación y no se vuelve a sugerir.
describe("P-3 · R-HIS no es un hallazgo del motor (CA-12)", () => {
  it("evaluarReglas no produce hallazgos R-HIS ni cambia por que exista una regla aprendida", () => {
    const f = fila({ montos: gravadaDg() });
    const r = evaluar([f]);
    expect(r.hallazgos.map((h) => h.regla)).not.toContain("R-HIS");
    expect(r.hallazgos).toEqual([]);
  });
});
