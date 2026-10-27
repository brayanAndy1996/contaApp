// R-RED (spec 011, CA-6, D-6, CA-11): redondeo / descuadre del total. Rojo: sin implementación.
import { describe, expect, it } from "vitest";
import {
  ctx,
  de,
  evaluar,
  fila,
  montos,
  pen,
  tc,
  unico,
  usd,
  xml,
} from "../../tests/ayudas/filas-motor";
import { EntradaReglasInvalidaError } from "./index";

const SOLO_NG = (total: string) =>
  fila({ montos: montos("PEN", { noGravado: "100.00", total }) });

describe("R-RED: umbral 0.01 × componentes distintos de cero (D-6)", () => {
  it("una fila que cuadra no dispara R-RED", () => {
    expect(de(evaluar([fila()]).hallazgos, "R-RED")).toEqual([]);
  });

  it("diferencia 0.01 con 2 componentes: hallazgo con la diferencia y ajustar total = Σ", () => {
    const f = fila({
      montos: montos("PEN", {
        biDg: "100.00",
        igvDg: "18.00",
        total: "118.01",
      }),
    });
    const h = unico(evaluar([f]).hallazgos, "R-RED");
    expect(h.filaId).toBe("f1");
    expect(h.destino).toBeNull();
    expect(h.explicacion).toContain("0.01");
    expect(h.sugerencia).toEqual({
      tipo: "ajustar",
      valores: { total: pen("118.00") },
    });
    expect(h.lecturas.total?.toString()).toBe("118.01");
    expect(h.lecturas.biDg?.toString()).toBe("100.00");
  });

  it("diferencia negativa (total < Σ) lleva signo en la explicación y ajusta total", () => {
    const f = fila({
      montos: montos("PEN", {
        biDg: "100.00",
        igvDg: "18.00",
        total: "117.99",
      }),
    });
    const h = unico(evaluar([f]).hallazgos, "R-RED");
    expect(h.explicacion).toContain("-0.01");
    expect(h.sugerencia).toEqual({
      tipo: "ajustar",
      valores: { total: pen("118.00") },
    });
  });

  it("diferencia 0.02 con 2 componentes (umbral 0.02): todavía sugiere", () => {
    const f = fila({
      montos: montos("PEN", {
        biDg: "100.00",
        igvDg: "18.00",
        total: "118.02",
      }),
    });
    expect(unico(evaluar([f]).hallazgos, "R-RED").sugerencia).not.toBeNull();
  });

  it("diferencia 0.03 con 2 componentes (umbral 0.02): hallazgo sin sugerencia", () => {
    const f = fila({
      montos: montos("PEN", {
        biDg: "100.00",
        igvDg: "18.00",
        total: "118.03",
      }),
    });
    const h = unico(evaluar([f]).hallazgos, "R-RED");
    expect(h.sugerencia).toBeNull();
    expect(h.explicacion).toContain("0.03");
  });

  it("1 componente: 0.01 sugiere y 0.02 no", () => {
    expect(
      unico(evaluar([SOLO_NG("100.01")]).hallazgos, "R-RED").sugerencia,
    ).toEqual({
      tipo: "ajustar",
      valores: { total: pen("100.00") },
    });
    expect(
      unico(evaluar([SOLO_NG("100.02")]).hallazgos, "R-RED").sugerencia,
    ).toBeNull();
  });

  it("3 componentes: umbral 0.03", () => {
    const f = (total: string) =>
      fila({
        montos: montos("PEN", {
          noGravado: "10.00",
          isc: "5.00",
          icbper: "0.50",
          total,
        }),
      });
    expect(unico(evaluar([f("15.53")]).hallazgos, "R-RED").sugerencia).toEqual({
      tipo: "ajustar",
      valores: { total: pen("15.50") },
    });
    expect(
      unico(evaluar([f("15.54")]).hallazgos, "R-RED").sugerencia,
    ).toBeNull();
  });

  it("descuadre grande: sin sugerencia", () => {
    const f = fila({
      montos: montos("PEN", {
        biDg: "100.00",
        igvDg: "18.00",
        total: "118.50",
      }),
    });
    expect(unico(evaluar([f]).hallazgos, "R-RED").sugerencia).toBeNull();
  });

  it("nota de crédito (negativos) descuadrada por 0.01 ajusta con el mismo signo", () => {
    const f = fila({
      montos: montos("PEN", {
        biDg: "-100.00",
        igvDg: "-18.00",
        total: "-118.01",
      }),
    });
    expect(unico(evaluar([f]).hallazgos, "R-RED").sugerencia).toEqual({
      tipo: "ajustar",
      valores: { total: pen("-118.00") },
    });
  });

  it("fila en USD se evalúa en USD", () => {
    const f = fila({
      montos: montos("USD", {
        biDg: "100.00",
        igvDg: "18.00",
        total: "118.01",
      }),
    });
    expect(unico(evaluar([f]).hallazgos, "R-RED").sugerencia).toEqual({
      tipo: "ajustar",
      valores: { total: usd("118.00") },
    });
  });

  it("montos al borde del rango NUMERIC(14,2): R-RED sin sugerencia y no lanza", () => {
    const M = "999999999999.99";
    const f = fila({ montos: montos("PEN", { biDg: M, igvDg: M, total: M }) });
    const h = unico(evaluar([f]).hallazgos, "R-RED");
    expect(h.sugerencia).toBeNull();
  });
});

describe("R-RED con XML (D-6)", () => {
  // SIRE: noGravado 4.00 pero el XML dice 5.00; el total del SIRE (123.00) coincide con el del XML.
  const sire = montos("PEN", {
    biDg: "100.00",
    igvDg: "18.00",
    noGravado: "4.00",
    total: "123.00",
  });
  const xmlOk = xml({ noGravado: pen("5.00"), total: pen("123.00") });

  it("total del XML = total SIRE y un solo grupo difiere en la diferencia: ajusta esa columna", () => {
    const h = unico(
      evaluar([fila({ montos: sire, xml: xmlOk })]).hallazgos,
      "R-RED",
    );
    expect(h.sugerencia).toEqual({
      tipo: "ajustar",
      valores: { noGravado: pen("5.00") },
    });
  });

  it("el grupo BI (ΣBI ↔ gravado) que cae en una sola columna se ajusta", () => {
    const m = montos("PEN", { biDg: "99.00", igvDg: "18.00", total: "118.00" });
    const x = xml({ gravado: pen("100.00"), total: pen("118.00") });
    const h = unico(evaluar([fila({ montos: m, xml: x })]).hallazgos, "R-RED");
    expect(h.sugerencia).toEqual({
      tipo: "ajustar",
      valores: { biDg: pen("100.00") },
    });
  });

  it("el total del XML no coincide con el del SIRE: sin sugerencia", () => {
    const x = xml({ noGravado: pen("5.00"), total: pen("124.00") });
    expect(
      unico(evaluar([fila({ montos: sire, xml: x })]).hallazgos, "R-RED")
        .sugerencia,
    ).toBeNull();
  });

  it("más de un grupo difiere del XML: sin sugerencia", () => {
    const x = xml({
      gravado: pen("101.00"),
      noGravado: pen("5.00"),
      total: pen("123.00"),
    });
    expect(
      unico(evaluar([fila({ montos: sire, xml: x })]).hallazgos, "R-RED")
        .sugerencia,
    ).toBeNull();
  });

  it("XML en otra moneda se ignora (XML_MONEDA) y no hay sugerencia por XML", () => {
    const x = xml({
      moneda: "USD",
      gravado: usd("100.00"),
      igv: usd("18.00"),
      noGravado: usd("5.00"),
      total: usd("123.00"),
    });
    const r = evaluar([fila({ montos: sire, xml: x })]);
    expect(r.avisos.map((a) => a.codigo)).toEqual(["XML_MONEDA"]);
    expect(unico(r.hallazgos, "R-RED").sugerencia).toBeNull();
  });

  it("XML de otro comprobante se ignora (XML_AJENO) y no hay sugerencia por XML", () => {
    const x = xml({
      comprobante: { tipo: "01", serie: "F001", numero: "999" },
      noGravado: pen("5.00"),
      total: pen("123.00"),
    });
    const r = evaluar([fila({ montos: sire, xml: x })]);
    expect(r.avisos.map((a) => a.codigo)).toEqual(["XML_AJENO"]);
    expect(unico(r.hallazgos, "R-RED").sugerencia).toBeNull();
  });
});

describe("R-RED con origenUsd (CA-6, D7 de 010; valores sintéticos)", () => {
  // USD 100.00 + 18.00 = 118.00; TC 3.750 → PEN 375.00 + 67.50 = 442.50.
  const origen = montos("USD", {
    biDg: "100.00",
    igvDg: "18.00",
    total: "118.00",
  });
  const tipoCambio = tc("3.750");

  it("PEN que coincide con la conversión por componente: sin R-RED", () => {
    const m = montos("PEN", {
      biDg: "375.00",
      igvDg: "67.50",
      total: "442.50",
    });
    const r = evaluar([
      fila({ montos: m, origenUsd: { montos: origen, tipoCambio } }),
    ]);
    expect(de(r.hallazgos, "R-RED")).toEqual([]);
  });

  it("PEN que no coincide (aunque cuadre solo): sugerencia exacta con las columnas que difieren, sin confirmación", () => {
    const m = montos("PEN", {
      biDg: "375.00",
      igvDg: "67.51",
      total: "442.51",
    });
    const r = evaluar([
      fila({ montos: m, origenUsd: { montos: origen, tipoCambio } }),
    ]);
    const h = unico(r.hallazgos, "R-RED");
    expect(h.sugerencia).toEqual({
      tipo: "ajustar",
      valores: { igvDg: pen("67.50"), total: pen("442.50") },
    });
    expect(h.requiereConfirmacion).toBe(false);
    expect(h.lecturas.igvDg?.toString()).toBe("67.51");
  });

  it("origen USD descuadrado: R-RED sin sugerencia (no lanza)", () => {
    const malo = montos("USD", {
      biDg: "100.00",
      igvDg: "18.00",
      total: "119.00",
    });
    const m = montos("PEN", {
      biDg: "375.00",
      igvDg: "67.50",
      total: "442.50",
    });
    const r = evaluar([
      fila({ montos: m, origenUsd: { montos: malo, tipoCambio } }),
    ]);
    expect(unico(r.hallazgos, "R-RED").sugerencia).toBeNull();
  });

  it("origenUsd con montos en PEN: entrada inválida", () => {
    const m = montos("PEN", {
      biDg: "375.00",
      igvDg: "67.50",
      total: "442.50",
    });
    const f = fila({ montos: m, origenUsd: { montos: m, tipoCambio } });
    expect(() => evaluar([f])).toThrow(EntradaReglasInvalidaError);
  });

  it("origenUsd en una fila cuyos montos están en USD: entrada inválida", () => {
    const f = fila({
      montos: origen,
      origenUsd: { montos: origen, tipoCambio },
    });
    expect(() => evaluar([f], ctx())).toThrow(EntradaReglasInvalidaError);
  });
});

// T6b: ratificación del arquitecto (plan, "Ratificación de contratos").
describe("R-RED: precedencia del XML y confirmación (ratificación)", () => {
  const DESCUADRADA = montos("PEN", {
    biDg: "100.00",
    igvDg: "18.00",
    total: "118.01",
  });

  it("XML válido con xml.total ≠ total y Σ = xml.total: ajusta el total al del XML, sin confirmación", () => {
    const x = xml({ total: pen("118.00") });
    const h = unico(
      evaluar([fila({ montos: DESCUADRADA, xml: x })]).hallazgos,
      "R-RED",
    );
    expect(h.sugerencia).toEqual({
      tipo: "ajustar",
      valores: { total: pen("118.00") },
    });
    expect(h.requiereConfirmacion).toBe(false);
  });

  it("XML válido con xml.total = total, diferencia 0.01 y ningún grupo que la explique: sin sugerencia (el umbral no aplica con XML)", () => {
    const x = xml({ total: pen("118.01") });
    const h = unico(
      evaluar([fila({ montos: DESCUADRADA, xml: x })]).hallazgos,
      "R-RED",
    );
    expect(h.sugerencia).toBeNull();
  });

  it("ajuste por umbral sin XML: requiere confirmación", () => {
    const h = unico(evaluar([fila({ montos: DESCUADRADA })]).hallazgos, "R-RED");
    expect(h.sugerencia).not.toBeNull();
    expect(h.requiereConfirmacion).toBe(true);
  });

  it("XML que respalda una columna: no requiere confirmación", () => {
    const sire = montos("PEN", {
      biDg: "100.00",
      igvDg: "18.00",
      noGravado: "4.00",
      total: "123.00",
    });
    const x = xml({ noGravado: pen("5.00"), total: pen("123.00") });
    const h = unico(
      evaluar([fila({ montos: sire, xml: x })]).hallazgos,
      "R-RED",
    );
    expect(h.sugerencia).toEqual({
      tipo: "ajustar",
      valores: { noGravado: pen("5.00") },
    });
    expect(h.requiereConfirmacion).toBe(false);
  });
});

describe("Explicaciones exactas del catálogo (ratificación)", () => {
  it("R-RED sin respaldo: suma, total y diferencia con signo", () => {
    const f = fila({
      montos: montos("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.01" }),
    });
    expect(unico(evaluar([f]).hallazgos, "R-RED").explicacion).toBe(
      "La suma de componentes (118.00) no es igual al total (118.01): diferencia 0.01",
    );
  });

  it("R-RED con diferencia negativa", () => {
    const f = fila({
      montos: montos("PEN", { biDg: "100.00", igvDg: "18.00", total: "117.99" }),
    });
    expect(unico(evaluar([f]).hallazgos, "R-RED").explicacion).toBe(
      "La suma de componentes (118.00) no es igual al total (117.99): diferencia -0.01",
    );
  });

  it("R-RED respaldado por el XML agrega el sufijo", () => {
    const f = fila({
      montos: montos("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.01" }),
      xml: xml({ total: pen("118.00") }),
    });
    expect(unico(evaluar([f]).hallazgos, "R-RED").explicacion).toBe(
      "La suma de componentes (118.00) no es igual al total (118.01): diferencia 0.01; el XML indica el monto correcto",
    );
  });

  it("R-ISC sin XML", () => {
    const f = fila({
      montos: montos("PEN", { biDg: "100.00", igvDg: "0.00", total: "100.00" }),
    });
    expect(unico(evaluar([f]).hallazgos, "R-ISC").explicacion).toBe(
      "Base gravada 100.00 con IGV 0: posible ISC",
    );
  });

  it("R-MIX con rango vacío", () => {
    const f = fila({
      montos: montos("PEN", { biDg: "10.00", igvDg: "3.00", total: "13.00" }),
    });
    expect(unico(evaluar([f]).hallazgos, "R-MIX").explicacion).toBe(
      "3.00 no es 18 % ni 10 % de 10.00 y no se puede separar: revisar",
    );
  });
});
