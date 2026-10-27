// aplicarSugerencia y aplicarMasivo (spec 011, CA-9, D-4). Rojo: sin implementación.
import { describe, expect, it } from "vitest";
import {
  congelarProfundo,
  evaluar,
  fila,
  montos,
  pen,
  ser,
  unico,
  xml,
} from "../../tests/ayudas/filas-motor";
import type { Hallazgo } from "./index";
import {
  aplicarMasivo,
  aplicarSugerencia,
  ConfirmacionInvalidaError,
  ReglasError,
  SugerenciaObsoletaError,
} from "./index";

const sanJuan = () => montos("PEN", { biDg: "770.00", total: "770.00" });
const mixta = () =>
  montos("PEN", { biDg: "21.48", igvDg: "1.61", total: "23.09" });
const dosDestinos = () =>
  montos("PEN", { biDg: "100.00", biDgng: "50.00", total: "150.00" });
const unTotal = (m: ReturnType<typeof montos>) => m.total.toString();

function hallazgosDe(m: ReturnType<typeof montos>, id = "f1"): Hallazgo[] {
  return [...evaluar([fila({ id, montos: m })]).hallazgos];
}
const codigoDe = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as ReglasError).codigo;
  }
  return "no lanzó";
};

describe("aplicarSugerencia: conservación del total (CA-9)", () => {
  it("R-ISC: mueve toda la BI a ISC y conserva el total", () => {
    const m = sanJuan();
    const h = unico(hallazgosDe(m), "R-ISC");
    const r = aplicarSugerencia(m, h);
    expect(r.excluir).toBe(false);
    expect(r.montos.obtener("isc").toString()).toBe("770.00");
    expect(r.montos.obtener("biDg").toString()).toBe("0.00");
    expect(unTotal(r.montos)).toBe("770.00");
  });

  it("R-MIX con el gravado confirmado conserva el total", () => {
    const m = mixta();
    const h = unico(hallazgosDe(m), "R-MIX");
    expect(h.dato).toBe("gravado");
    const r = aplicarSugerencia(m, h, { gravado: pen("8.94") });
    expect(r.montos.obtener("biDg").toString()).toBe("8.94");
    expect(r.montos.obtener("noGravado").toString()).toBe("12.54");
    expect(unTotal(r.montos)).toBe("23.09");
  });

  it("R-NEW con destino conserva el total", () => {
    const m = dosDestinos();
    const f = fila({
      montos: m,
      proveedor: { tipo: "6", numero: "20999999999" },
    });
    const h = unico(evaluar([f]).hallazgos, "R-NEW");
    expect(unTotal(aplicarSugerencia(m, h, { destino: "DG" }).montos)).toBe(
      "150.00",
    );
  });

  it("R-GP conserva el total y marca excluir", () => {
    const m = montos("PEN", {
      biDg: "100.00",
      igvDg: "18.00",
      total: "118.00",
    });
    const f = fila({ montos: m, xml: xml({ glosas: ["zapatillas"] }) });
    const r = aplicarSugerencia(m, unico(evaluar([f]).hallazgos, "R-GP"));
    expect(r.excluir).toBe(true);
    expect(unTotal(r.montos)).toBe("118.00");
  });

  it("R-RED es la excepción: el total pasa a Σ componentes", () => {
    const m = montos("PEN", {
      biDg: "100.00",
      igvDg: "18.00",
      total: "118.01",
    });
    const h = unico(hallazgosDe(m), "R-RED");
    const r = aplicarSugerencia(m, h);
    expect(r.montos.total.toString()).toBe("118.00");
    expect(r.montos.obtener("biDg").toString()).toBe("100.00");
    expect(r.excluir).toBe(false);
  });

  it("no modifica los montos de entrada (que quedan intactos y congelados)", () => {
    const m = sanJuan();
    const antes = ser(m);
    aplicarSugerencia(m, unico(hallazgosDe(m), "R-ISC"));
    expect(ser(m)).toBe(antes);
    expect(Object.isFrozen(m)).toBe(true);
  });

  it("acepta un hallazgo congelado", () => {
    const m = sanJuan();
    const h = congelarProfundo(unico(hallazgosDe(m), "R-ISC"));
    expect(() => aplicarSugerencia(m, h)).not.toThrow();
  });

  it("hallazgo sin sugerencia: error de reglas", () => {
    const m = montos("PEN", {
      biDg: "100.00",
      igvDg: "18.00",
      total: "118.50",
    });
    const h = unico(hallazgosDe(m), "R-RED");
    expect(h.sugerencia).toBeNull();
    expect(() => aplicarSugerencia(m, h)).toThrow(ReglasError);
  });
});

describe("aplicarSugerencia: confirmación de R-MIX (gravado dentro de [min, max])", () => {
  const m = mixta();
  const h = () => unico(hallazgosDe(m), "R-MIX");

  it("sin confirmar: ConfirmacionInvalidaError", () => {
    expect(() => aplicarSugerencia(m, h())).toThrow(ConfirmacionInvalidaError);
  });

  it("confirmación del tipo equivocado ({ destino }): ConfirmacionInvalidaError", () => {
    expect(() => aplicarSugerencia(m, h(), { destino: "DG" })).toThrow(
      ConfirmacionInvalidaError,
    );
  });

  it("en los bordes 8.92 y 8.97 aplica; 8.91 y 8.98 lanzan", () => {
    expect(
      aplicarSugerencia(m, h(), { gravado: pen("8.92") })
        .montos.obtener("noGravado")
        .toString(),
    ).toBe("12.56");
    const r = aplicarSugerencia(m, h(), { gravado: pen("8.97") });
    expect(r.montos.obtener("biDg").toString()).toBe("8.97");
    expect(r.montos.obtener("noGravado").toString()).toBe("12.51");
    expect(r.montos.obtener("igvDg").toString()).toBe("1.61");
    expect(r.montos.total.toString()).toBe("23.09");
    expect(() => aplicarSugerencia(m, h(), { gravado: pen("8.91") })).toThrow(
      ConfirmacionInvalidaError,
    );
    expect(() => aplicarSugerencia(m, h(), { gravado: pen("8.98") })).toThrow(
      ConfirmacionInvalidaError,
    );
  });

  it("gravado cero, negativo o mayor que la BI: ConfirmacionInvalidaError", () => {
    for (const g of ["0.00", "-8.94", "21.49"]) {
      expect(() => aplicarSugerencia(m, h(), { gravado: pen(g) })).toThrow(
        ConfirmacionInvalidaError,
      );
    }
  });

  it("confirmación que no es un Money real: ConfirmacionInvalidaError", () => {
    expect(() =>
      aplicarSugerencia(m, h(), {
        gravado: "8.94" as unknown as ReturnType<typeof pen>,
      }),
    ).toThrow(ConfirmacionInvalidaError);
  });
});

describe("aplicarSugerencia: obsolescencia (SugerenciaObsoletaError)", () => {
  it("aplicar sobre montos distintos de los evaluados lanza", () => {
    const h = unico(hallazgosDe(sanJuan()), "R-ISC");
    const otros = montos("PEN", { biDg: "770.01", total: "770.01" });
    expect(() => aplicarSugerencia(otros, h)).toThrow(SugerenciaObsoletaError);
  });

  it("aplicar dos veces la misma sugerencia: la segunda lanza", () => {
    const m = sanJuan();
    const h = unico(hallazgosDe(m), "R-ISC");
    const una = aplicarSugerencia(m, h).montos;
    expect(() => aplicarSugerencia(una, h)).toThrow(SugerenciaObsoletaError);
  });

  it("R-ISC solo lee BI e IGV de su destino: cambios en otras columnas no la vuelven obsoleta", () => {
    const h = unico(hallazgosDe(sanJuan()), "R-ISC");
    const otro = montos("PEN", {
      biDg: "770.00",
      noGravado: "5.00",
      total: "775.00",
    });
    const r = aplicarSugerencia(otro, h);
    expect(r.montos.obtener("isc").toString()).toBe("770.00");
    expect(r.montos.obtener("noGravado").toString()).toBe("5.00");
    expect(r.montos.total.toString()).toBe("775.00");
  });

  it("R-RED lee todas las columnas y el total: cualquier cambio la vuelve obsoleta", () => {
    const h = unico(
      hallazgosDe(
        montos("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.01" }),
      ),
      "R-RED",
    );
    const otro = montos("PEN", {
      biDg: "100.00",
      igvDg: "18.00",
      noGravado: "1.00",
      total: "119.01",
    });
    expect(() => aplicarSugerencia(otro, h)).toThrow(SugerenciaObsoletaError);
  });

  it("R-MIX queda obsoleta si cambia el IGV del destino", () => {
    const h = unico(hallazgosDe(mixta()), "R-MIX");
    const otro = montos("PEN", {
      biDg: "21.48",
      igvDg: "1.62",
      total: "23.10",
    });
    expect(() => aplicarSugerencia(otro, h, { gravado: pen("8.94") })).toThrow(
      SugerenciaObsoletaError,
    );
  });
});

describe("dos R-ISC seguidas en la misma fila (DG y DGNG)", () => {
  it("la segunda no queda obsoleta por la primera y el total se conserva", () => {
    const m = dosDestinos();
    const [h1, h2] = hallazgosDe(m).filter((h) => h.regla === "R-ISC");
    expect([h1?.destino, h2?.destino]).toEqual(["DG", "DGNG"]);
    const r1 = aplicarSugerencia(m, h1!).montos;
    const r2 = aplicarSugerencia(r1, h2!).montos;
    expect(r2.obtener("isc").toString()).toBe("150.00");
    expect(r2.obtener("biDg").toString()).toBe("0.00");
    expect(r2.obtener("biDgng").toString()).toBe("0.00");
    expect(r2.total.toString()).toBe("150.00");
  });

  it("en orden inverso también", () => {
    const m = dosDestinos();
    const [h1, h2] = hallazgosDe(m).filter((h) => h.regla === "R-ISC");
    const r = aplicarSugerencia(aplicarSugerencia(m, h2!).montos, h1!).montos;
    expect(r.obtener("isc").toString()).toBe("150.00");
  });
});

describe("aplicarMasivo", () => {
  it("lote vacío: sin aplicadas ni rechazadas", () => {
    expect(aplicarMasivo([])).toEqual({ aplicadas: [], rechazadas: [] });
  });

  it("aplica fila por fila en el orden recibido y conserva el total", () => {
    const a = sanJuan();
    const b = montos("PEN", { biDg: "300.00", total: "300.00" });
    const r = aplicarMasivo([
      { montos: b, hallazgo: unico(hallazgosDe(b, "b"), "R-ISC") },
      { montos: a, hallazgo: unico(hallazgosDe(a, "a"), "R-ISC") },
    ]);
    expect(r.rechazadas).toEqual([]);
    expect(r.aplicadas.map((x) => x.filaId)).toEqual(["b", "a"]);
    expect(r.aplicadas.map((x) => x.montos.obtener("isc").toString())).toEqual([
      "300.00",
      "770.00",
    ]);
    expect(r.aplicadas.map((x) => x.montos.total.toString())).toEqual([
      "300.00",
      "770.00",
    ]);
    expect(r.aplicadas.map((x) => x.excluir)).toEqual([false, false]);
  });

  it("R-MIX sin confirmación se rechaza con requiere_dato y no detiene el lote", () => {
    const a = sanJuan();
    const m = mixta();
    const r = aplicarMasivo([
      { montos: m, hallazgo: unico(hallazgosDe(m, "m"), "R-MIX") },
      { montos: a, hallazgo: unico(hallazgosDe(a, "a"), "R-ISC") },
    ]);
    expect(r.rechazadas).toEqual([
      { filaId: "m", regla: "R-MIX", codigo: "requiere_dato" },
    ]);
    expect(r.aplicadas.map((x) => x.filaId)).toEqual(["a"]);
  });

  it("R-MIX con confirmación dentro del rango se aplica; fuera del rango se rechaza", () => {
    const m = mixta();
    const h = unico(hallazgosDe(m, "m"), "R-MIX");
    const fuera = codigoDe(() =>
      aplicarSugerencia(m, h, { gravado: pen("8.98") }),
    );
    const r = aplicarMasivo([
      { montos: m, hallazgo: h, confirmacion: { gravado: pen("8.97") } },
      {
        montos: m,
        hallazgo: { ...h, filaId: "m2" },
        confirmacion: { gravado: pen("8.98") },
      },
    ]);
    expect(r.aplicadas.map((x) => x.filaId)).toEqual(["m"]);
    expect(r.aplicadas[0]!.montos.obtener("noGravado").toString()).toBe(
      "12.51",
    );
    expect(r.rechazadas).toEqual([
      { filaId: "m2", regla: "R-MIX", codigo: fuera },
    ]);
  });

  it("sugerencia obsoleta: rechazada con el código del error, el resto sigue", () => {
    const a = sanJuan();
    const h = unico(hallazgosDe(a, "a"), "R-ISC");
    const viejo = montos("PEN", { biDg: "770.01", total: "770.01" });
    const esperado = codigoDe(() => aplicarSugerencia(viejo, h));
    expect(esperado).not.toBe("no lanzó");
    const b = montos("PEN", { biDg: "300.00", total: "300.00" });
    const r = aplicarMasivo([
      { montos: viejo, hallazgo: h },
      { montos: b, hallazgo: unico(hallazgosDe(b, "b"), "R-ISC") },
    ]);
    expect(r.rechazadas).toEqual([
      { filaId: "a", regla: "R-ISC", codigo: esperado },
    ]);
    expect(r.aplicadas.map((x) => x.filaId)).toEqual(["b"]);
  });

  it("encadena por fila: la segunda entrada de la misma fila parte de los montos de la primera", () => {
    const m = dosDestinos();
    const [h1, h2] = hallazgosDe(m, "f").filter((h) => h.regla === "R-ISC");
    const r = aplicarMasivo([
      { montos: m, hallazgo: h1! },
      { montos: m, hallazgo: h2! },
    ]);
    expect(r.rechazadas).toEqual([]);
    expect(r.aplicadas).toHaveLength(2);
    expect(r.aplicadas[0]!.montos.obtener("isc").toString()).toBe("100.00");
    expect(r.aplicadas[0]!.montos.obtener("biDgng").toString()).toBe("50.00");
    expect(r.aplicadas[1]!.montos.obtener("isc").toString()).toBe("150.00");
    expect(r.aplicadas[1]!.montos.obtener("biDgng").toString()).toBe("0.00");
    expect(r.aplicadas[1]!.montos.total.toString()).toBe("150.00");
  });

  it("filas distintas no se encadenan entre sí", () => {
    const a = sanJuan();
    const b = montos("PEN", { biDg: "300.00", total: "300.00" });
    const r = aplicarMasivo([
      { montos: a, hallazgo: unico(hallazgosDe(a, "a"), "R-ISC") },
      { montos: b, hallazgo: unico(hallazgosDe(b, "b"), "R-ISC") },
    ]);
    expect(r.aplicadas.map((x) => x.montos.obtener("isc").toString())).toEqual([
      "770.00",
      "300.00",
    ]);
  });

  it("R-RED masivo cambia el total (excepción) y R-GP masivo marca excluir", () => {
    const rojo = montos("PEN", {
      biDg: "100.00",
      igvDg: "18.00",
      total: "118.01",
    });
    const gp = montos("PEN", {
      biDg: "100.00",
      igvDg: "18.00",
      total: "118.00",
    });
    const hGp = unico(
      evaluar([
        fila({ id: "g", montos: gp, xml: xml({ glosas: ["zapatillas"] }) }),
      ]).hallazgos,
      "R-GP",
    );
    const r = aplicarMasivo([
      { montos: rojo, hallazgo: unico(hallazgosDe(rojo, "r"), "R-RED") },
      { montos: gp, hallazgo: hGp },
    ]);
    expect(
      r.aplicadas.map((x) => [x.filaId, x.montos.total.toString(), x.excluir]),
    ).toEqual([
      ["r", "118.00", false],
      ["g", "118.00", true],
    ]);
  });

  it("no modifica las entradas recibidas (aunque estén congeladas)", () => {
    const a = sanJuan();
    const entradas = congelarProfundo([
      { montos: a, hallazgo: unico(hallazgosDe(a, "a"), "R-ISC") },
    ]);
    const antes = ser(entradas);
    aplicarMasivo(entradas);
    expect(ser(entradas)).toBe(antes);
  });

  it("el resultado está congelado", () => {
    const a = sanJuan();
    const r = aplicarMasivo([
      { montos: a, hallazgo: unico(hallazgosDe(a, "a"), "R-ISC") },
    ]);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.aplicadas)).toBe(true);
    expect(Object.isFrozen(r.rechazadas)).toBe(true);
  });
});
