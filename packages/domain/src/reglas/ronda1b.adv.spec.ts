// T12b (adversario · opus): ronda adversarial 1b de 011, escenarios nuevos (caja blanca).
// Solo API pública de @contapp/domain. Deterministas: sin reloj ni azar.
import { describe, expect, it } from "vitest";
import {
  DICCIONARIO_GLOSAS_BASE,
  EntradaReglasInvalidaError,
  Money,
  MontosComprobante,
  ReglasError,
  SugerenciaObsoletaError,
  aplicarMasivo,
  aplicarSugerencia,
  evaluarReglas,
} from "../index";
import type { CodigoRegla, ContextoReglas, FilaEvaluable, Hallazgo, ResumenXml } from "../index";

const PROV = { tipo: "6", numero: "20100000001" };
const COMP = { tipo: "01", serie: "F001", numero: "123" };
const pen = (s: string): Money => Money.desde(s, "PEN");
type Valores = Parameters<typeof MontosComprobante.desde>[1];
const montos = (v: Valores): MontosComprobante => MontosComprobante.desde("PEN", v);

const ctx = (): ContextoReglas => ({
  proveedoresConocidos: [{ ...PROV }],
  proveedoresIsc: [],
  diccionario: DICCIONARIO_GLOSAS_BASE,
});

function xml(over: Partial<ResumenXml> = {}): ResumenXml {
  return {
    proveedor: { ...PROV },
    comprobante: { ...COMP },
    moneda: "PEN",
    gravado: pen("0.00"),
    igv: pen("0.00"),
    noGravado: pen("0.00"),
    isc: pen("0.00"),
    icbper: pen("0.00"),
    total: pen("0.00"),
    glosas: [],
    ...over,
  };
}

const fila = (m: MontosComprobante, over: Partial<FilaEvaluable> = {}): FilaEvaluable => ({
  id: "f1",
  proveedor: { ...PROV },
  comprobante: { ...COMP },
  montos: m,
  ...over,
});

function unico(hs: readonly Hallazgo[], regla: CodigoRegla): Hallazgo {
  const r = hs.filter((h) => h.regla === regla);
  expect(r).toHaveLength(1);
  return r[0] as Hallazgo;
}

const falso = (h: Hallazgo, over: Record<string, unknown>): Hallazgo => ({ ...h, ...over }) as unknown as Hallazgo;
const sugFalsa = (h: Hallazgo, over: Record<string, unknown>): Hallazgo =>
  falso(h, { sugerencia: { ...h.sugerencia, ...over } });

// Fila con ISC faltante en el SIRE pero incluido en el total; el XML trae gravado 770 e ISC 770.
// Dispara R-ISC (DG, IGV 0, XML con ISC: mover 770 a isc) y R-RED (XML: isc ← 770), ambas
// respaldadas por el XML (requiereConfirmacion = false).
const cruzada = () => montos({ biDg: "770.00", total: "1540.00" });
const xmlCruzado = () =>
  xml({ gravado: pen("770.00"), isc: pen("770.00"), total: pen("1540.00") });
function hallazgosCruzados() {
  const { hallazgos } = evaluarReglas([fila(cruzada(), { xml: xmlCruzado() })], ctx());
  return { isc: unico(hallazgos, "R-ISC"), red: unico(hallazgos, "R-RED") };
}

const sanJuan = () => montos({ biDg: "770.00", total: "770.00" });
const hIsc = () => unico(evaluarReglas([fila(sanJuan())], ctx()).hallazgos, "R-ISC");
const mixta = () => montos({ biDg: "21.48", igvDg: "1.61", total: "23.09" });
const hMix = () => unico(evaluarReglas([fila(mixta())], ctx()).hallazgos, "R-MIX");

describe("R1b-1 obsolescencia parcial: R-ISC con XML depende de la columna isc (CA-9)", () => {
  // CA-9: "aplicar una sugerencia sobre montos que ya no son los evaluados lanza
  // SugerenciaObsoletaError". El monto de R-ISC con XML es xml.isc − isc de la fila: si isc
  // cambió, el monto ya no es el del XML y aplicarlo duplica el ISC.
  it("si el contador corrige isc después de evaluar, la R-ISC del XML queda obsoleta", () => {
    const { isc } = hallazgosCruzados();
    expect(isc.sugerencia).toMatchObject({ tipo: "mover", destino: "isc" });
    expect(isc.requiereConfirmacion).toBe(false);
    const editados = montos({ biDg: "770.00", isc: "770.00", total: "1540.00" });
    expect(() => aplicarSugerencia(editados, isc)).toThrow(SugerenciaObsoletaError);
  });
});

describe("R1b-2 masivo con la misma fila repetida y reglas cruzadas (CA-9, plan Obsolescencia)", () => {
  // Plan: aplicarMasivo "encadena por filaId (la segunda usa los montos de la primera)".
  it("R-RED (XML), R-ISC (XML) y otra vez R-ISC de la misma fila: solo se aplica R-RED", () => {
    const { isc, red } = hallazgosCruzados();
    const r = aplicarMasivo([
      { montos: cruzada(), hallazgo: red },
      { montos: cruzada(), hallazgo: isc },
      { montos: cruzada(), hallazgo: isc },
    ]);
    // Si se aplicara también R-ISC: biDg 0 e isc 1540, cuando el XML dice gravado 770 e ISC 770.
    expect(r.aplicadas).toHaveLength(1);
    expect(r.rechazadas).toEqual([
      { filaId: "f1", regla: "R-ISC", codigo: "SUGERENCIA_OBSOLETA" },
      { filaId: "f1", regla: "R-ISC", codigo: "SUGERENCIA_OBSOLETA" },
    ]);
  });
});

describe("R1b-3 R-ISC falsificado con forma válida (plan, Ratificación: Aplicar)", () => {
  // "hallazgo ... falsificado ... → EntradaReglasInvalidaError". R-ISC solo produce `mover`
  // desde la BI de su destino hacia `isc` (sin XML: toda la BI leída).
  it.each([
    ["destino igvDg en vez de isc", () => sugFalsa(hIsc(), { destino: "igvDg" })],
    ["destino noGravado en vez de isc", () => sugFalsa(hIsc(), { destino: "noGravado" })],
    ["monto parcial 100.00 sin XML (debe ser toda la BI leída)", () => sugFalsa(hIsc(), { monto: pen("100.00") })],
    ["hallazgo de destino DGNG con origen biDg", () => falso(hIsc(), { destino: "DGNG" })],
  ])("%s → EntradaReglasInvalidaError", (_n, h) => {
    expect(() => aplicarSugerencia(sanJuan(), h())).toThrow(EntradaReglasInvalidaError);
  });
});

describe("R1b-4 lecturas manipuladas evitan la obsolescencia (plan, Obsolescencia y Ratificación)", () => {
  // R-ISC y R-MIX leen BI e IGV del destino; un hallazgo sin esas lecturas no lo produce
  // evaluarReglas (falsificado) y no debe aplicarse sobre montos distintos de los evaluados.
  it.each([
    ["R-ISC sobre BI 1000.00", () => aplicarSugerencia(montos({ biDg: "1000.00", total: "1000.00" }), falso(hIsc(), { lecturas: {} }))],
    [
      "R-MIX sobre BI 500.00",
      () =>
        aplicarSugerencia(montos({ biDg: "500.00", igvDg: "1.61", total: "501.61" }), falso(hMix(), { lecturas: {} }), {
          gravado: pen("8.94"),
        }),
    ],
  ])("%s con lecturas vacías lanza", (_n, aplicar) => {
    expect(aplicar).toThrow(ReglasError);
  });
});

describe("R1b-5 R-MIX falsificado: rango o exacto que no salen de las lecturas (CA-2, D-3)", () => {
  // CA-2: gravado "fuera del rango lanza error". El rango de 21.48/1.61 es 8.92–8.97 (D-3).
  it.each([
    ["exacto inventado 1.00 sin confirmación", () => aplicarSugerencia(mixta(), sugFalsa(hMix(), { exacto: pen("1.00") }))],
    [
      "min ensanchado a 0.01 y confirmación 1.00",
      () => aplicarSugerencia(mixta(), sugFalsa(hMix(), { min: pen("0.01") }), { gravado: pen("1.00") }),
    ],
  ])("%s → error de reglas", (_n, aplicar) => {
    expect(aplicar).toThrow(ReglasError);
  });
});

describe("R1b-6 XML con identidad parecida (CA-11, plan IdComprobante/DocProveedor)", () => {
  // Plan: "ceros a la izquierda no cuentan"; documento "sin espacios" y en mayúsculas.
  // Spec, Alcance: "Si su identidad no coincide con la fila, se ignora y se informa".
  // La serie en minúsculas es `decide usuario`: el plan la declara inválida (^[0-9A-Z]{1,4}$),
  // pero hoy invalida todo el lote (la fila f2 pierde su R-MIX).
  const xmlIsc = (over: Partial<ResumenXml>) =>
    xml({ isc: pen("770.00"), total: pen("770.00"), ...over });
  it.each([
    ["número con ceros a la izquierda", { comprobante: { ...COMP, numero: "00000123" } }, true],
    ["RUC con espacios", { proveedor: { tipo: "6", numero: " 2010 0000 001 " } }, true],
    ["serie en minúsculas (decide usuario)", { comprobante: { ...COMP, serie: "f001" } }, false],
  ])("%s: no aborta el lote y el XML se usa o se avisa", (_n, over, seUsa) => {
    const r = evaluarReglas([fila(sanJuan(), { xml: xmlIsc(over) }), fila(mixta(), { id: "f2" })], ctx());
    expect(r.hallazgos.some((h) => h.filaId === "f2" && h.regla === "R-MIX")).toBe(true);
    const h = unico(r.hallazgos.filter((x) => x.filaId === "f1"), "R-ISC");
    if (seUsa) {
      expect(r.avisos).toEqual([]);
      expect(h.explicacion).toBe("Base gravada con IGV 0: el XML indica ISC");
      expect(h.requiereConfirmacion).toBe(false);
    } else {
      const usado = r.avisos.length === 0 && h.requiereConfirmacion === false;
      const avisado = r.avisos.length === 1 && r.avisos[0]?.codigo === "XML_AJENO";
      expect(usado || avisado).toBe(true);
    }
  });
});
