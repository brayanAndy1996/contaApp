// T4 (rojo): R-ISC (RF-081; CA-1, CA-5, CA-10; D-1, D-2) vía evaluarReglas/aplicarSugerencia.
import { describe, expect, it } from "vitest";
import { PROV, ctxBase, de, evaluar, fila, sug, unico, xmlDe } from "../../tests/ayudas/filas";
import { aplicarSugerencia } from "./index";
import type { FilaEvaluable } from "./index";

const SAN_JUAN = { biDg: "770.00" };
/** Entorno con el que se evaluó el hallazgo (T15b-1). */
const ent = (filas: FilaEvaluable[], contexto = ctxBase()) => ({ filas, contexto });

describe("R-ISC sin XML (CA-1, D-1)", () => {
  it("BI DG 770.00 con IGV 0.00: un hallazgo R-ISC con sugerencia exacta mover 770.00 de BI DG a ISC", () => {
    const { hallazgos, avisos } = evaluar([fila(SAN_JUAN)]);
    expect(avisos).toEqual([]);
    expect(hallazgos).toHaveLength(1);
    const h = unico(hallazgos, "R-ISC");
    expect(h.filaId).toBe("f1");
    expect(h.destino).toBe("DG");
    const s = sug(h, "mover");
    expect(s.origen).toBe("biDg");
    expect(s.destino).toBe("isc");
    expect(s.monto.toString()).toBe("770.00");
    expect(s.monto.moneda).toBe("PEN");
    expect(h.requiereConfirmacion).toBe(true);
    expect(h.dato).toBeNull();
    expect(h.explicacion).toContain("IGV 0");
    expect(h.explicacion).toContain("770.00");
  });

  it("lecturas: BI e IGV del destino evaluado (para detectar obsolescencia)", () => {
    const h = unico(evaluar([fila(SAN_JUAN)]).hallazgos, "R-ISC");
    expect(h.lecturas.biDg?.toString()).toBe("770.00");
    expect(h.lecturas.igvDg?.toString()).toBe("0.00");
  });

  it("aplicar: ISC 770.00, BI DG 0.00 y total igual (CA-1, CA-9)", () => {
    const f = fila(SAN_JUAN);
    const h = unico(evaluar([f]).hallazgos, "R-ISC");
    const r = aplicarSugerencia(f.montos, h, undefined, ent([f]));
    expect(r.excluir).toBe(false);
    expect(r.montos.obtener("isc").toString()).toBe("770.00");
    expect(r.montos.obtener("biDg").toString()).toBe("0.00");
    expect(r.montos.total.toString()).toBe("770.00");
    expect(f.montos.obtener("biDg").toString()).toBe("770.00");
  });

  it("con ISC previo en la fila: mueve solo la BI y el ISC previo se conserva", () => {
    const f = fila({ biDg: "770.00", isc: "30.00" });
    const h = unico(evaluar([f]).hallazgos, "R-ISC");
    expect(sug(h, "mover").monto.toString()).toBe("770.00");
    expect(aplicarSugerencia(f.montos, h, undefined, ent([f])).montos.obtener("isc").toString()).toBe("800.00");
  });

  it("destino en 0.00/0.00 se ignora y una fila que cuadra a 18 % no dispara R-ISC", () => {
    expect(evaluar([fila({ isc: "5.00" })]).hallazgos).toEqual([]);
    expect(evaluar([fila({ biDg: "100.00", igvDg: "18.00" })]).hallazgos).toEqual([]);
  });
});

describe("R-ISC con XML (D-1)", () => {
  it("XML con ISC 770.00: explicación 'Base gravada con IGV 0: el XML indica ISC', sin confirmación", () => {
    const f = fila(SAN_JUAN, { xml: xmlDe({ isc: "770.00" }) });
    const { hallazgos, avisos } = evaluar([f]);
    expect(avisos).toEqual([]);
    const h = unico(hallazgos, "R-ISC");
    expect(h.explicacion).toContain("Base gravada con IGV 0: el XML indica ISC");
    const s = sug(h, "mover");
    expect(s.origen).toBe("biDg");
    expect(s.destino).toBe("isc");
    expect(s.monto.toString()).toBe("770.00");
    expect(h.requiereConfirmacion).toBe(false);
    const r = aplicarSugerencia(f.montos, h, undefined, ent([f]));
    expect(r.montos.obtener("isc").toString()).toBe("770.00");
    expect(r.montos.obtener("biDg").toString()).toBe("0.00");
    expect(r.montos.total.toString()).toBe("770.00");
  });

  it("XML con ISC menor que la BI: mueve el ISC del XML, no toda la BI", () => {
    const f = fila(SAN_JUAN, { xml: xmlDe({ gravado: "470.00", isc: "300.00" }) });
    const h = unico(evaluar([f]).hallazgos, "R-ISC");
    expect(sug(h, "mover").monto.toString()).toBe("300.00");
    expect(h.requiereConfirmacion).toBe(false);
  });

  it("con ISC ya cargado en la fila mueve la diferencia (xml.isc - isc)", () => {
    const f = fila({ biDg: "770.00", isc: "100.00" }, { xml: xmlDe({ gravado: "470.00", isc: "400.00" }) });
    const h = unico(evaluar([f]).hallazgos, "R-ISC");
    expect(sug(h, "mover").monto.toString()).toBe("300.00");
  });

  it("XML con ISC mayor que la BI: no cabe, hallazgo sin sugerencia", () => {
    const f = fila(SAN_JUAN, { xml: xmlDe({ isc: "900.00" }) });
    const h = unico(evaluar([f]).hallazgos, "R-ISC");
    expect(h.sugerencia).toBeNull();
  });

  it("XML sin ISC (0.00): solo hallazgo 'XML sin ISC: revisar', sin sugerencia", () => {
    const f = fila(SAN_JUAN, { xml: xmlDe({ gravado: "770.00" }) });
    const h = unico(evaluar([f]).hallazgos, "R-ISC");
    expect(h.explicacion).toContain("XML sin ISC: revisar");
    expect(h.sugerencia).toBeNull();
  });
});

describe("R-ISC: proveedor marcado como emisor de ISC (D-2)", () => {
  const ctxIsc = ctxBase({ proveedoresIsc: [{ ...PROV }] });
  const cuadra = { biDg: "100.00", igvDg: "18.00" };

  it("con IGV distinto de 0 que cuadra y sin XML: hallazgo informativo sin montos", () => {
    const h = unico(evaluar([fila(cuadra)], ctxIsc).hallazgos, "R-ISC");
    expect(h.sugerencia).toBeNull();
    expect(h.explicacion.length).toBeGreaterThan(0);
  });

  it("con XML que trae ISC 20.00: sugerencia exacta mover 20.00 de BI DG a ISC, sin confirmación", () => {
    const f = fila(cuadra, { xml: xmlDe({ gravado: "80.00", igv: "18.00", isc: "20.00" }) });
    const h = unico(evaluar([f], ctxIsc).hallazgos, "R-ISC");
    const s = sug(h, "mover");
    expect(s.origen).toBe("biDg");
    expect(s.destino).toBe("isc");
    expect(s.monto.toString()).toBe("20.00");
    expect(h.requiereConfirmacion).toBe(false);
    const r = aplicarSugerencia(f.montos, h, undefined, ent([f], ctxIsc));
    expect(r.montos.obtener("biDg").toString()).toBe("80.00");
    expect(r.montos.obtener("isc").toString()).toBe("20.00");
    expect(r.montos.total.toString()).toBe("118.00");
  });

  it("proveedor marcado con IGV = 0: un solo hallazgo R-ISC (la marca no lo duplica)", () => {
    const { hallazgos } = evaluar([fila(SAN_JUAN)], ctxIsc);
    expect(de(hallazgos, "R-ISC")).toHaveLength(1);
    expect(sug(hallazgos[0]!, "mover").monto.toString()).toBe("770.00");
  });

  it("la marca compara el documento normalizado (espacios)", () => {
    const f = fila(cuadra, { proveedor: { tipo: "6", numero: " 20100070970 " } });
    expect(de(evaluar([f], ctxIsc).hallazgos, "R-ISC")).toHaveLength(1);
  });

  it("proveedor no marcado con IGV que cuadra: sin R-ISC", () => {
    expect(de(evaluar([fila(cuadra)]).hallazgos, "R-ISC")).toEqual([]);
  });
});

describe("R-ISC con varios destinos (D-1, CA-5)", () => {
  it("DG y DGNG con IGV 0: dos hallazgos, cada uno mueve la BI de su destino, en orden DG, DGNG", () => {
    const f = fila({ biDg: "770.00", biDgng: "100.00" });
    const hs = de(evaluar([f]).hallazgos, "R-ISC");
    expect(hs.map((h) => h.destino)).toEqual(["DG", "DGNG"]);
    const a = sug(hs[0]!, "mover");
    const b = sug(hs[1]!, "mover");
    expect([a.origen, a.monto.toString()]).toEqual(["biDg", "770.00"]);
    expect([b.origen, b.monto.toString()]).toEqual(["biDgng", "100.00"]);
    expect(hs[1]!.lecturas.biDgng?.toString()).toBe("100.00");
  });

  it("solo el destino con IGV 0 dispara: DG con IGV 0 y DNG que cuadra a 18 %", () => {
    const f = fila({ biDg: "770.00", biDng: "50.00", igvDng: "9.00" });
    const hs = evaluar([f]).hallazgos;
    expect(hs).toHaveLength(1);
    expect(hs[0]!.destino).toBe("DG");
  });

  it("con XML y varios destinos con BI no cero no cabe el ISC del XML: sin sugerencia", () => {
    const f = fila({ biDg: "770.00", biDgng: "100.00" }, { xml: xmlDe({ isc: "300.00", gravado: "570.00" }) });
    const hs = de(evaluar([f]).hallazgos, "R-ISC");
    expect(hs).toHaveLength(2);
    expect(hs.every((h) => h.sugerencia === null)).toBe(true);
  });

  it("filas distintas se evalúan por separado y salen ordenadas por id", () => {
    const a = fila(SAN_JUAN, { id: "b2" });
    const b = fila({ biDg: "50.00" }, { id: "a1" });
    expect(de(evaluar([a, b]).hallazgos, "R-ISC").map((h) => h.filaId)).toEqual(["a1", "b2"]);
  });
});

describe("R-ISC: signos y moneda (CA-10)", () => {
  it("nota de crédito (montos negativos): mueve -770.00 con el mismo signo y conserva el total", () => {
    const f = fila({ biDg: "-770.00" });
    const h = unico(evaluar([f]).hallazgos, "R-ISC");
    expect(sug(h, "mover").monto.toString()).toBe("-770.00");
    const r = aplicarSugerencia(f.montos, h, undefined, ent([f]));
    expect(r.montos.obtener("isc").toString()).toBe("-770.00");
    expect(r.montos.obtener("biDg").toString()).toBe("0.00");
    expect(r.montos.total.toString()).toBe("-770.00");
  });

  it("nota de crédito con XML: el ISC del XML debe tener el mismo signo de la BI", () => {
    const igual = fila({ biDg: "-770.00" }, { xml: xmlDe({ gravado: "-470.00", isc: "-300.00" }) });
    expect(sug(unico(evaluar([igual]).hallazgos, "R-ISC"), "mover").monto.toString()).toBe("-300.00");
    const opuesto = fila({ biDg: "-770.00" }, { xml: xmlDe({ gravado: "470.00", isc: "300.00" }) });
    expect(unico(evaluar([opuesto]).hallazgos, "R-ISC").sugerencia).toBeNull();
  });

  it("fila USD: se evalúa en USD y la sugerencia no mezcla monedas", () => {
    const f = fila({ biDg: "770.00" }, { moneda: "USD" });
    const h = unico(evaluar([f]).hallazgos, "R-ISC");
    const s = sug(h, "mover");
    expect(s.monto.moneda).toBe("USD");
    expect(s.monto.toString()).toBe("770.00");
    expect(h.lecturas.biDg?.moneda).toBe("USD");
    const r = aplicarSugerencia(f.montos, h, undefined, ent([f]));
    expect(r.montos.moneda).toBe("USD");
    expect(r.montos.obtener("isc").toString()).toBe("770.00");
  });

  it("fila USD con XML en USD: ISC del XML en USD, sin confirmación", () => {
    const f = fila({ biDg: "770.00" }, { moneda: "USD", xml: xmlDe({ moneda: "USD", isc: "770.00" }) });
    const h = unico(evaluar([f]).hallazgos, "R-ISC");
    expect(sug(h, "mover").monto.moneda).toBe("USD");
    expect(h.requiereConfirmacion).toBe(false);
  });
});
