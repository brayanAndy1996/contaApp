// Casos reales de los videos aplicados al motor de reglas (spec 011: CA-1, CA-2, CA-3, CA-6, CA-12;
// docs/01-definiciones-base.md §7 puntos 9, 10, 11 y 15; HU-23 y HU-24).
// Solo API pública (plan 011, Contratos). Boleta 291: no va aquí (013).
import { describe, expect, it } from "vitest";
import {
  aplicarSugerencia,
  ConfirmacionInvalidaError,
  DICCIONARIO_GLOSAS_BASE,
  evaluarReglas,
  Money,
  MontosComprobante,
  ReglasError,
  type ContextoReglas,
  type FilaEvaluable,
  type Hallazgo,
  type ResumenXml,
} from "../../src/index";

const pen = (s: string): Money => Money.desde(s, "PEN");

// Datos sintéticos de identidad (no son RUC reales).
const PROVEEDOR = { tipo: "6", numero: "20100000001" } as const;
const COMPROBANTE = { tipo: "01", serie: "F001", numero: "290" } as const;

// Proveedor ya conocido del cliente: R-NEW no debe aparecer en estos casos.
const CTX: ContextoReglas = {
  proveedoresConocidos: [PROVEEDOR],
  proveedoresIsc: [],
  diccionario: DICCIONARIO_GLOSAS_BASE,
};

function xml(p: Partial<ResumenXml> = {}): ResumenXml {
  return {
    proveedor: PROVEEDOR,
    comprobante: COMPROBANTE,
    moneda: "PEN",
    gravado: pen("0.00"),
    igv: pen("0.00"),
    noGravado: pen("0.00"),
    isc: pen("0.00"),
    icbper: pen("0.00"),
    total: pen("0.00"),
    glosas: [],
    ...p,
  };
}

function fila(montos: MontosComprobante, resumen?: ResumenXml): FilaEvaluable {
  return {
    id: "F1",
    proveedor: PROVEEDOR,
    comprobante: COMPROBANTE,
    montos,
    ...(resumen ? { xml: resumen } : {}),
  };
}

function evaluar(f: FilaEvaluable): { hallazgos: readonly Hallazgo[]; avisos: readonly unknown[] } {
  return evaluarReglas([f], CTX);
}

function unico(hs: readonly Hallazgo[]): Hallazgo {
  expect(hs).toHaveLength(1);
  return hs[0]!;
}

describe("caso real: Cervecería San Juan, ISC en DG (BI DG 770.00, IGV DG 0.00) · CA-1 / HU-23", () => {
  const m = MontosComprobante.desde("PEN", { biDg: "770.00", igvDg: "0.00", total: "770.00" });

  it("sin XML: un solo hallazgo R-ISC en DG con la sugerencia exacta mover 770.00 de BI DG a ISC, con confirmación", () => {
    const r = evaluar(fila(m));
    const h = unico(r.hallazgos);
    expect(h.regla).toBe("R-ISC");
    expect(h.filaId).toBe("F1");
    expect(h.destino).toBe("DG");
    expect(h.requiereConfirmacion).toBe(true);
    expect(h.sugerencia?.tipo).toBe("mover");
    if (h.sugerencia?.tipo !== "mover") throw new Error("se esperaba mover");
    expect(h.sugerencia.origen).toBe("biDg");
    expect(h.sugerencia.destino).toBe("isc");
    expect(h.sugerencia.monto.toString()).toBe("770.00");
    expect(r.avisos).toHaveLength(0);
  });

  it("sin XML la explicación es textual y no afirma que el XML indique ISC", () => {
    const h = unico(evaluar(fila(m)).hallazgos);
    expect(h.explicacion.length).toBeGreaterThan(0);
    expect(h.explicacion).not.toContain("el XML indica ISC");
  });

  it("con XML que trae ISC 770.00: misma sugerencia, sin confirmación y la explicación del XML", () => {
    const x = xml({ isc: pen("770.00"), total: pen("770.00"), glosas: ["CERVEZA PILSEN 620 ML"] });
    const h = unico(evaluar(fila(m, x)).hallazgos);
    expect(h.regla).toBe("R-ISC");
    expect(h.explicacion).toBe("Base gravada con IGV 0: el XML indica ISC");
    expect(h.requiereConfirmacion).toBe(false);
    if (h.sugerencia?.tipo !== "mover") throw new Error("se esperaba mover");
    expect(h.sugerencia.origen).toBe("biDg");
    expect(h.sugerencia.destino).toBe("isc");
    expect(h.sugerencia.monto.toString()).toBe("770.00");
  });

  it("aplicar la sugerencia deja ISC 770.00, BI DG 0.00, IGV DG 0.00 y el total igual", () => {
    const h = unico(evaluar(fila(m)).hallazgos);
    const r = aplicarSugerencia(m, h);
    expect(r.excluir).toBe(false);
    expect(r.montos.obtener("isc").toString()).toBe("770.00");
    expect(r.montos.obtener("biDg").toString()).toBe("0.00");
    expect(r.montos.obtener("igvDg").toString()).toBe("0.00");
    expect(r.montos.total.toString()).toBe("770.00");
  });

  it("aplicar no toca los montos originales (RNF-052)", () => {
    const h = unico(evaluar(fila(m)).hallazgos);
    aplicarSugerencia(m, h);
    expect(m.obtener("biDg").toString()).toBe("770.00");
    expect(m.obtener("isc").toString()).toBe("0.00");
  });
});

describe("caso real: factura mixta BI 21.48 / IGV 1.61 sin XML · CA-2 / HU-24", () => {
  const m = MontosComprobante.desde("PEN", { biDg: "21.48", igvDg: "1.61", total: "23.09" });

  function hallazgoMix(): Hallazgo {
    return unico(evaluar(fila(m)).hallazgos);
  }

  it("R-MIX sugiere rango 8.92–8.97 con estimado 8.94, sin exacto y con confirmación", () => {
    const h = hallazgoMix();
    expect(h.regla).toBe("R-MIX");
    expect(h.destino).toBe("DG");
    expect(h.requiereConfirmacion).toBe(true);
    expect(h.dato).toBe("gravado");
    if (h.sugerencia?.tipo !== "separar") throw new Error("se esperaba separar");
    expect(h.sugerencia.columnaBi).toBe("biDg");
    expect(h.sugerencia.min.toString()).toBe("8.92");
    expect(h.sugerencia.max.toString()).toBe("8.97");
    expect(h.sugerencia.estimado.toString()).toBe("8.94");
    expect(h.sugerencia.exacto).toBeNull();
  });

  it('la explicación dice "1.61 no es 18 % ni 10 % de 21.48"', () => {
    expect(hallazgoMix().explicacion).toContain("1.61 no es 18 % ni 10 % de 21.48");
  });

  it("aplicar sin gravado confirmado lanza error de confirmación", () => {
    const h = hallazgoMix();
    expect(() => aplicarSugerencia(m, h)).toThrow(ConfirmacionInvalidaError);
    expect(() => aplicarSugerencia(m, h)).toThrow(ReglasError);
  });

  it("aplicar con gravado fuera del rango (8.91 y 8.98) lanza error de confirmación", () => {
    const h = hallazgoMix();
    expect(() => aplicarSugerencia(m, h, { gravado: pen("8.91") })).toThrow(ConfirmacionInvalidaError);
    expect(() => aplicarSugerencia(m, h, { gravado: pen("8.98") })).toThrow(ConfirmacionInvalidaError);
  });

  it("aplicar con 8.97 deja BI DG 8.97, no gravado 12.51, IGV 1.61 y el total igual", () => {
    const r = aplicarSugerencia(m, hallazgoMix(), { gravado: pen("8.97") });
    expect(r.excluir).toBe(false);
    expect(r.montos.obtener("biDg").toString()).toBe("8.97");
    expect(r.montos.obtener("noGravado").toString()).toBe("12.51");
    expect(r.montos.obtener("igvDg").toString()).toBe("1.61");
    expect(r.montos.total.toString()).toBe("23.09");
  });

  it("aplicar con el extremo inferior del rango (8.92) también conserva el total", () => {
    const r = aplicarSugerencia(m, hallazgoMix(), { gravado: pen("8.92") });
    expect(r.montos.obtener("biDg").toString()).toBe("8.92");
    expect(r.montos.obtener("noGravado").toString()).toBe("12.56");
    expect(r.montos.total.toString()).toBe("23.09");
  });
});

describe("caso real: factura mixta BI 21.48 / IGV 1.61 con XML · CA-3 / HU-24", () => {
  const m = MontosComprobante.desde("PEN", { biDg: "21.48", igvDg: "1.61", total: "23.09" });
  const xmlOk = (): ResumenXml =>
    xml({
      gravado: pen("8.97"),
      igv: pen("1.61"),
      noGravado: pen("12.51"),
      total: pen("23.09"),
      glosas: ["SERVICIO MIXTO"],
    });

  it("con gravado 8.97 en el XML la sugerencia es exacta, sin confirmación", () => {
    const h = unico(evaluar(fila(m, xmlOk())).hallazgos);
    expect(h.regla).toBe("R-MIX");
    expect(h.requiereConfirmacion).toBe(false);
    if (h.sugerencia?.tipo !== "separar") throw new Error("se esperaba separar");
    expect(h.sugerencia.exacto?.toString()).toBe("8.97");
    expect(h.sugerencia.min.toString()).toBe("8.92");
    expect(h.sugerencia.max.toString()).toBe("8.97");
  });

  it("aplicar sin confirmación deja exactamente 8.97 + 12.51 y el total igual", () => {
    const h = unico(evaluar(fila(m, xmlOk())).hallazgos);
    const r = aplicarSugerencia(m, h);
    expect(r.montos.obtener("biDg").toString()).toBe("8.97");
    expect(r.montos.obtener("noGravado").toString()).toBe("12.51");
    expect(r.montos.obtener("igvDg").toString()).toBe("1.61");
    expect(r.montos.total.toString()).toBe("23.09");
  });

  it("si el gravado del XML queda fuera del rango no hay sugerencia exacta y se pide confirmación", () => {
    const x = xml({ gravado: pen("9.50"), igv: pen("1.61"), noGravado: pen("11.98"), total: pen("23.09") });
    const h = unico(evaluar(fila(m, x)).hallazgos);
    expect(h.regla).toBe("R-MIX");
    expect(h.requiereConfirmacion).toBe(true);
    if (h.sugerencia?.tipo === "separar") expect(h.sugerencia.exacto).toBeNull();
  });

  it("si el IGV del XML difiere del SIRE no hay sugerencia exacta", () => {
    const x = xml({ gravado: pen("8.97"), igv: pen("1.62"), noGravado: pen("12.51"), total: pen("23.10") });
    const h = unico(evaluar(fila(m, x)).hallazgos);
    expect(h.regla).toBe("R-MIX");
    expect(h.requiereConfirmacion).toBe(true);
    if (h.sugerencia?.tipo === "separar") expect(h.sugerencia.exacto).toBeNull();
  });
});

describe("caso real: gasto personal, glosa 'zapatilla' · CA-12 / D-5", () => {
  const m = MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" });

  const conGlosa = (g: string): FilaEvaluable =>
    fila(m, xml({ gravado: pen("100.00"), igv: pen("18.00"), total: pen("118.00"), glosas: [g] }));

  it.each(["ZAPATILLAS URBANAS T-42", "zapat. dep."])(
    "la glosa %j dispara R-GP con la palabra 'zapatilla' en la explicación",
    (g) => {
      const h = unico(evaluar(conGlosa(g)).hallazgos);
      expect(h.regla).toBe("R-GP");
      expect(h.filaId).toBe("F1");
      expect(h.explicacion.toLowerCase()).toContain("zapatilla");
      expect(h.sugerencia).toEqual({ tipo: "excluir", palabra: "zapatilla", categoria: "calzado-ropa" });
    },
  );

  it("la glosa 'zapata de concreto' no dispara R-GP", () => {
    expect(evaluar(conGlosa("zapata de concreto")).hallazgos).toHaveLength(0);
  });

  it("aplicar la sugerencia marca excluir y deja los montos sin cambios", () => {
    const h = unico(evaluar(conGlosa("ZAPATILLAS URBANAS T-42")).hallazgos);
    const r = aplicarSugerencia(m, h);
    expect(r.excluir).toBe(true);
    expect(r.montos.toJSON()).toEqual(m.toJSON());
  });
});

describe("caso real: redondeo de facturas en USD · CA-6 / punto 11", () => {
  it.todo("redondeo USD: caso real diferido, sin cifras");
});
