// T14b (adversario · opus): ronda adversarial 2b de 011, escenarios nuevos contra las correcciones
// de T13 (ff94d08; plan.md, "Cambios de T13"). Solo API pública de @contapp/domain. Deterministas.
import { describe, expect, it } from "vitest";
import {
  DICCIONARIO_GLOSAS_BASE,
  Money,
  MontosComprobante,
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

function unico(hs: readonly Hallazgo[], regla: CodigoRegla, filaId = "f1"): Hallazgo {
  const r = hs.filter((h) => h.regla === regla && h.filaId === filaId);
  expect(r).toHaveLength(1);
  return r[0] as Hallazgo;
}

// R-MIX con XML exacto: BI 21.48, IGV 1.61 (no cuadra); el XML trae gravado 8.94 e IGV 1.61, que
// cae en el rango a 18 % → exacto 8.94, sin confirmación ni dato (D-7).
const mixta = () => montos({ biDg: "21.48", igvDg: "1.61", total: "23.09" });
const xmlMixto = () =>
  xml({ gravado: pen("8.94"), igv: pen("1.61"), noGravado: pen("12.54"), total: pen("23.09") });
const fMixExacto = () => fila(mixta(), { xml: xmlMixto() });
const hMixExacto = () => unico(evaluarReglas([fMixExacto()], ctx()).hallazgos, "R-MIX");
/** Entorno con el que se evaluó el hallazgo (T15b-1): las filas y el contexto. */
const ent = (filas: FilaEvaluable[]) => ({ filas, contexto: ctx() });
// El contador agrega una BI en DGNG después de evaluar: la fila ya no tiene "único destino con BI".
const editadaConDgng = () => montos({ biDg: "21.48", igvDg: "1.61", biDgng: "100.00", total: "123.09" });

describe("R2b-1 R-MIX exacto del XML depende del 'único destino con BI' (CA-9, como R1b-1)", () => {
  // CA-9: "aplicar una sugerencia sobre montos que ya no son los evaluados lanza
  // SugerenciaObsoletaError". r-mix.ts usa el exacto del XML solo si d.unicoConBi (lee las BI de
  // los otros destinos), pero sus lecturas son solo BI e IGV del destino: T13 lo corrigió en R-ISC
  // (Cambios de T13, Lecturas de R-ISC) y no en R-MIX.
  it("con otra BI ≠ 0 la reevaluación ya no da exacto, y la sugerencia vieja debe ser obsoleta", () => {
    const h = hMixExacto();
    expect(h.sugerencia).toMatchObject({ tipo: "separar", exacto: pen("8.94") });
    expect(h.requiereConfirmacion).toBe(false);
    const re = evaluarReglas([fila(editadaConDgng(), { xml: xmlMixto() })], ctx()).hallazgos;
    expect(unico(re, "R-MIX").sugerencia).toMatchObject({ exacto: null });
    expect(() => aplicarSugerencia(editadaConDgng(), h, undefined, ent([fMixExacto()]))).toThrow(SugerenciaObsoletaError);
  });

  it("en masivo (dato null, sin confirmación) la R-MIX vieja no se aplica en silencio", () => {
    const r = aplicarMasivo([{ montos: editadaConDgng(), hallazgo: hMixExacto() }], ent([fMixExacto()]));
    expect(r.aplicadas).toHaveLength(0);
    expect(r.rechazadas).toEqual([{ filaId: "f1", regla: "R-MIX", codigo: "SUGERENCIA_OBSOLETA" }]);
  });
});

// Otra fila del lote, sana para comparar: R-ISC sin XML.
const otraFila = (): FilaEvaluable => fila(montos({ biDg: "770.00", total: "770.00" }), { id: "f2" });
const conXmlDeComprobante = (comprobante: Record<string, unknown>, proveedor: Record<string, unknown> = { ...PROV }) =>
  fila(mixta(), { xml: xml({ comprobante, proveedor } as unknown as Partial<ResumenXml>) });

function loteSinAbortar(f1: FilaEvaluable): void {
  const r = evaluarReglas([f1, otraFila()], ctx());
  expect(r.avisos).toEqual([expect.objectContaining({ filaId: "f1", codigo: "XML_AJENO" })]);
  unico(r.hallazgos, "R-ISC", "f2");
}

describe("R2b-2 serie del XML fuera de gramática → XML_AJENO sin abortar (Cambios de T13, Serie)", () => {
  // Decisión del usuario (R1b-6): "si no coincide, XML_AJENO sin abortar el lote". La corrección
  // cubre "F0011" o "F 01", pero una serie larga corta antes en textoId (> 64 → inválida).
  it.each([
    ["5 caracteres", "F0011"],
    ["con espacio", "F 01"],
    ["65 caracteres", "F".repeat(65)],
  ])("serie %s en el XML → XML_AJENO y la otra fila conserva sus hallazgos", (_n, serie) => {
    loteSinAbortar(conXmlDeComprobante({ ...COMP, serie }));
  });
});

describe("R2b-3 tipo, número o RUC del XML fuera de gramática (CA-11) · decide usuario", () => {
  // CA-11: "un XML con otro RUC, serie o número se ignora y genera el aviso". T13 dejó de abortar
  // solo por la serie; un número o RUC del XML fuera de gramática sigue abortando todo el lote.
  it.each([
    ["número de 9 dígitos", () => conXmlDeComprobante({ ...COMP, numero: "123456789" })],
    ["número con guion", () => conXmlDeComprobante({ ...COMP, numero: "F001-123" })],
    ["tipo de un dígito", () => conXmlDeComprobante({ ...COMP, tipo: "1" })],
    ["RUC con puntos", () => conXmlDeComprobante({ ...COMP }, { tipo: "6", numero: "20.100.000.001" })],
  ])("%s → XML_AJENO sin abortar", (_n, f1) => {
    loteSinAbortar(f1());
  });
});

const gp = (glosa: string) =>
  evaluarReglas(
    [fila(montos({ biDg: "100.00", igvDg: "18.00", total: "118.00" }), { xml: xml({ glosas: [glosa] }) })],
    ctx(),
  ).hallazgos.filter((h) => h.regla === "R-GP");

describe("R2b-4 puntos suspensivos tras palabra o abreviatura (D-5, decisión R1b-7)", () => {
  // Decisión del usuario: "un punto al final de una palabra completa es separador; las
  // abreviaturas con punto siguen valiendo". "…" (U+2026) en NFKD es "...".
  it.each([
    ["ZAPATILLAS. (control de T13)", "ZAPATILLAS URBANAS."],
    ["ZAPATILLAS...", "ZAPATILLAS..."],
    ["PERFUMES… (U+2026)", "PERFUMES… IMPORTADOS"],
    ["abreviatura truncada ZAPAT...", "ZAPAT... DEP"],
  ])("%s dispara R-GP", (_n, glosa) => {
    expect(gp(glosa)).toHaveLength(1);
  });
});

describe("R2b-5 punto al final de una palabra completa seguido de un dígito (decisión R1b-7)", () => {
  // T13 separa solo si al punto le sigue una letra (para conservar "1.50"); "ZAPATILLAS.38" (talla)
  // tiene el punto al final de la palabra completa "ZAPATILLAS", que según la decisión separa.
  it.each([
    ["ZAPATILLAS.38", "ZAPATILLAS.38 NEGRAS"],
    ["PERFUME.100ML", "PERFUME.100ML"],
  ])("%s dispara R-GP", (_n, glosa) => {
    expect(gp(glosa)).toHaveLength(1);
  });
});

describe("R2b-6 sin rechazos falsos en notas de crédito (Cambios de T13, Aplicar)", () => {
  // La validación de T13 no debe rechazar lo que evaluarReglas produce (CA-10: mismo signo en NC).
  it("R-MIX exacto en NC y R-ISC con ISC del XML en NC se aplican en masivo", () => {
    const ncMix = montos({ biDg: "-21.48", igvDg: "-1.61", total: "-23.09" });
    const xmlNcMix = xml({ gravado: pen("-8.94"), igv: pen("-1.61"), noGravado: pen("-12.54"), total: pen("-23.09") });
    const ncIsc = montos({ biDg: "-770.00", total: "-770.00" });
    const xmlNcIsc = xml({ gravado: pen("-700.00"), isc: pen("-70.00"), total: pen("-770.00") });
    const filasNc = [fila(ncMix, { xml: xmlNcMix }), fila(ncIsc, { id: "f2", xml: xmlNcIsc })];
    const hs = evaluarReglas(filasNc, ctx()).hallazgos;
    const mix = unico(hs, "R-MIX");
    const isc = unico(hs, "R-ISC", "f2");
    const r = aplicarMasivo(
      [
        { montos: ncMix, hallazgo: mix },
        { montos: ncIsc, hallazgo: isc },
      ],
      ent(filasNc),
    );
    expect(r.rechazadas).toEqual([]);
    expect(r.aplicadas[0]?.montos.obtener("biDg").toString()).toBe("-8.94");
    expect(r.aplicadas[1]?.montos.obtener("isc").toString()).toBe("-70.00");
  });

});
