// T14a (adversario · opus): ronda adversarial 2a de 011, regresión de las correcciones de T13
// (ff94d08) y variantes de cada hallazgo corregido. Solo API pública de @contapp/domain.
// Deterministas: sin reloj ni azar.
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
const usd = (s: string): Money => Money.desde(s, "USD");
type Valores = Parameters<typeof MontosComprobante.desde>[1];
const montos = (v: Valores): MontosComprobante => MontosComprobante.desde("PEN", v);

const ctx = (over: Partial<ContextoReglas> = {}): ContextoReglas => ({
  proveedoresConocidos: [{ ...PROV }],
  proveedoresIsc: [],
  diccionario: DICCIONARIO_GLOSAS_BASE,
  ...over,
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

function unico(hs: readonly Hallazgo[], regla: CodigoRegla, destino?: string): Hallazgo {
  const r = hs.filter((h) => h.regla === regla && (destino === undefined || h.destino === destino));
  expect(r).toHaveLength(1);
  return r[0] as Hallazgo;
}

const evaluar = (f: FilaEvaluable, c: ContextoReglas = ctx()) => evaluarReglas([f], c).hallazgos;
const falso = (h: Hallazgo, over: Record<string, unknown>): Hallazgo => ({ ...h, ...over }) as unknown as Hallazgo;
const sinLectura = (h: Hallazgo, k: string): Hallazgo => {
  const l: Record<string, unknown> = { ...h.lecturas };
  delete l[k];
  return falso(h, { lecturas: l });
};

// Fixtures del catálogo de la spec.
const sanJuan = () => montos({ biDg: "770.00", total: "770.00" });
const mixta = () => montos({ biDg: "21.48", igvDg: "1.61", total: "23.09" });
const mixtaNc = () => montos({ biDg: "-21.48", igvDg: "-1.61", total: "-23.09" });
// San Juan con XML que trae ISC 770.00 (CA-1): R-ISC exacto, sin confirmación.
const hIscXml = () => unico(evaluar(fila(sanJuan(), { xml: xml({ isc: pen("770.00"), total: pen("770.00") }) })), "R-ISC");
const hIscSinXml = () => unico(evaluar(fila(sanJuan())), "R-ISC");
// R-RED sin XML: diferencia −0.01 dentro del umbral (D-6) → total = Σ.
const descuadre = () => montos({ biDg: "100.00", igvDg: "18.00", total: "118.01" });
const hRed = () => unico(evaluar(fila(descuadre())), "R-RED");
// CA-3: XML de la mixta con gravado 8.97 → exacto, sin confirmación.
const xmlMixta = () =>
  xml({ gravado: pen("8.97"), igv: pen("1.61"), noGravado: pen("12.51"), total: pen("23.09") });

describe("R2a-1 regresión: hallazgos legítimos siguen aplicándose tras T13 (CA-1–CA-3, CA-6, CA-10, D-1, D-2, D-7)", () => {
  // T13 endureció aplicarSugerencia; ningún hallazgo producido por evaluarReglas debe rechazarse.
  it.each([
    [
      "NC R-ISC con XML (−770.00 a isc, CA-10 + D-1)",
      () => {
        const m = montos({ biDg: "-770.00", total: "-770.00" });
        const h = unico(evaluar(fila(m, { xml: xml({ isc: pen("-770.00"), total: pen("-770.00") }) })), "R-ISC");
        expect(h.requiereConfirmacion).toBe(false);
        return aplicarSugerencia(m, h).montos;
      },
      { biDg: "0.00", isc: "-770.00", total: "-770.00" },
    ],
    [
      "NC R-MIX sin XML confirmando −8.97 (CA-2 + CA-10)",
      () => aplicarSugerencia(mixtaNc(), unico(evaluar(fila(mixtaNc())), "R-MIX"), { gravado: pen("-8.97") }).montos,
      { biDg: "-8.97", noGravado: "-12.51", total: "-23.09" },
    ],
    [
      "R-MIX con XML exacto a 10 % (16.10, D-7)",
      () => {
        const x = xml({ gravado: pen("16.10"), igv: pen("1.61"), noGravado: pen("5.38"), total: pen("23.09") });
        const h = unico(evaluar(fila(mixta(), { xml: x })), "R-MIX");
        expect(h.requiereConfirmacion).toBe(false);
        return aplicarSugerencia(mixta(), h).montos;
      },
      { biDg: "16.10", noGravado: "5.38", total: "23.09" },
    ],
    [
      "R-MIX USD sin XML confirmando 8.94 (CA-10)",
      () => {
        const m = MontosComprobante.desde("USD", { biDg: "21.48", igvDg: "1.61", total: "23.09" });
        return aplicarSugerencia(m, unico(evaluar(fila(m)), "R-MIX"), { gravado: usd("8.94") }).montos;
      },
      { biDg: "8.94", noGravado: "12.54", total: "23.09" },
    ],
    [
      "R-ISC de proveedor marcado con XML de ISC 50.00 (D-2)",
      () => {
        const m = montos({ biDg: "1000.00", igvDg: "180.00", total: "1180.00" });
        const x = xml({ gravado: pen("1000.00"), igv: pen("180.00"), isc: pen("50.00"), total: pen("1180.00") });
        const h = unico(evaluar(fila(m, { xml: x }), ctx({ proveedoresIsc: [{ ...PROV }] })), "R-ISC");
        return aplicarSugerencia(m, h).montos;
      },
      { biDg: "950.00", isc: "50.00", total: "1180.00" },
    ],
    [
      "dos R-ISC sin XML seguidas, DG y DGNG, en masivo (plan, Cambios de T13)",
      () => {
        const m = montos({ biDg: "100.00", biDgng: "200.00", total: "300.00" });
        const hs = evaluar(fila(m));
        const r = aplicarMasivo([
          { montos: m, hallazgo: unico(hs, "R-ISC", "DG") },
          { montos: m, hallazgo: unico(hs, "R-ISC", "DGNG") },
        ]);
        expect(r.rechazadas).toEqual([]);
        return r.aplicadas[1]?.montos as MontosComprobante;
      },
      { biDg: "0.00", biDgng: "0.00", isc: "300.00", total: "300.00" },
    ],
    [
      "R-RED sin XML (total = Σ, D-6)",
      () => aplicarSugerencia(descuadre(), hRed()).montos,
      { biDg: "100.00", igvDg: "18.00", total: "118.00" },
    ],
  ])("%s", (_n, aplicar, esperado) => {
    const m = aplicar();
    for (const [k, v] of Object.entries(esperado)) {
      const actual = k === "total" ? m.total : m.obtener(k as Parameters<MontosComprobante["obtener"]>[0]);
      expect(actual.toString()).toBe(v);
    }
  });
});

describe("R2a-2 variante de R1b-1: el exacto de R-MIX con XML también depende de las otras BI (CA-9)", () => {
  // CA-9: aplicar sobre montos que ya no son los evaluados → SugerenciaObsoletaError. El exacto
  // del XML solo se da si el destino es el único con BI ≠ 0 (T10, decisión 1); T13 agregó por la
  // misma razón las otras BI a las lecturas de R-ISC con XML, pero no a R-MIX con XML. Si el
  // contador agrega después una BI en DNG, el gravado total del XML ya no es el de DG y el
  // exacto (sin confirmación ni dato) se aplicaría solo en el masivo.
  it("R-MIX exacto 8.97 sobre una fila a la que luego se le agregó BI DNG 100.00 → obsoleta", () => {
    const h = unico(evaluar(fila(mixta(), { xml: xmlMixta() })), "R-MIX");
    expect(h.requiereConfirmacion).toBe(false);
    expect(h.dato).toBeNull();
    const editados = montos({ biDg: "21.48", igvDg: "1.61", biDng: "100.00", total: "123.09" });
    expect(() => aplicarSugerencia(editados, h)).toThrow(SugerenciaObsoletaError);
    const r = aplicarMasivo([{ montos: editados, hallazgo: h }]);
    expect(r.aplicadas).toEqual([]);
  });
});

describe("R2a-3 variante de R1b-2: orden inverso en masivo, R-ISC (XML) antes que R-RED (CA-9)", () => {
  // Plan, Obsolescencia: encadena por filaId; R-RED lee todas las columnas y el total. Tras
  // aplicar R-ISC (isc cambia), R-RED de la misma fila queda obsoleta.
  it("R-ISC se aplica y las dos R-RED repetidas quedan obsoletas", () => {
    const m = montos({ biDg: "770.00", total: "1540.00" });
    const hs = evaluar(fila(m, { xml: xml({ gravado: pen("770.00"), isc: pen("770.00"), total: pen("1540.00") }) }));
    const isc = unico(hs, "R-ISC");
    const red = unico(hs, "R-RED");
    const r = aplicarMasivo([
      { montos: m, hallazgo: isc },
      { montos: m, hallazgo: red },
      { montos: m, hallazgo: red },
    ]);
    expect(r.aplicadas).toHaveLength(1);
    expect(r.rechazadas).toEqual([
      { filaId: "f1", regla: "R-RED", codigo: "SUGERENCIA_OBSOLETA" },
      { filaId: "f1", regla: "R-RED", codigo: "SUGERENCIA_OBSOLETA" },
    ]);
  });
});

describe("R2a-4 variante de R1b-3: quitar UNA lectura de las que la regla lee (plan, Cambios de T13)", () => {
  // "falta una lectura que la regla lee (R-ISC/R-MIX: BI e IGV del destino, más isc y las otras
  // BI con el ISC del XML; R-RED: todas y total) → SugerenciaObsoletaError" (o forma inválida).
  it.each([
    ["R-ISC con XML sin isc (sobre isc ya corregido a 770)", () => sinLectura(hIscXml(), "isc"), () => montos({ biDg: "770.00", isc: "770.00", total: "1540.00" })],
    ["R-ISC con XML sin biDng", () => sinLectura(hIscXml(), "biDng"), () => montos({ biDg: "770.00", biDng: "50.00", total: "820.00" })],
    ["R-ISC con XML sin biDgng", () => sinLectura(hIscXml(), "biDgng"), () => montos({ biDg: "770.00", biDgng: "50.00", total: "820.00" })],
    ["R-ISC con XML sin igvDg", () => sinLectura(hIscXml(), "igvDg"), () => montos({ biDg: "770.00", igvDg: "138.60", total: "908.60" })],
    ["R-RED sin total", () => sinLectura(hRed(), "total"), () => montos({ biDg: "100.00", igvDg: "18.00", total: "500.00" })],
    ["R-RED sin isc", () => sinLectura(hRed(), "isc"), () => montos({ biDg: "100.00", igvDg: "18.00", isc: "5.00", total: "118.01" })],
    ["R-MIX sin igvDg", () => sinLectura(unico(evaluar(fila(mixta())), "R-MIX"), "igvDg"), () => montos({ biDg: "21.48", igvDg: "1.62", total: "23.10" })],
  ])("%s → error de reglas", (_n, h, m) => {
    expect(() => aplicarSugerencia(m(), h(), { gravado: pen("8.94") })).toThrow(ReglasError);
  });
});

describe("R2a-5 variante de R1b-2: R-ISC sin XML disfrazado de 'con XML' agregando lecturas (D-1)", () => {
  // D-1: sin XML la sugerencia es toda la BI y requiere confirmación. T13 distingue "con XML"
  // solo porque `isc` está en las lecturas: agregarlo (con los valores reales de la fila) permite
  // un monto parcial sin confirmación. Mismo límite declarado por T13 para el exacto de R-MIX
  // (aplicar no recibe el XML): decide usuario/arquitecto.
  it("monto parcial 100.00, sin confirmación y con isc/otras BI agregadas → EntradaReglasInvalidaError", () => {
    const h = hIscSinXml();
    const forjado = falso(h, {
      requiereConfirmacion: false,
      lecturas: { ...h.lecturas, isc: pen("0.00"), biDgng: pen("0.00"), biDng: pen("0.00") },
      sugerencia: { ...h.sugerencia, monto: pen("100.00") },
    });
    expect(() => aplicarSugerencia(sanJuan(), forjado)).toThrow(EntradaReglasInvalidaError);
  });
});

describe("R2a-6 variante de R1b-2: R-RED (ajustar) falsificado con forma válida (D-6, Ratificación: Aplicar)", () => {
  // D-6: sin XML la única sugerencia es total = Σ componentes; con XML, una columna que deja la
  // fila cuadrada. "hallazgo falsificado → EntradaReglasInvalidaError". T13 contrasta mover y
  // separar con las lecturas, pero `ajustar` se aplica con cualquier valor.
  it.each([
    ["total 500.00 (deja la fila descuadrada)", { total: pen("500.00") }],
    ["biDg 9999.00 (columna inventada sin XML)", { biDg: pen("9999.00") }],
    ["biDg 0.00 y total 18.00 (cuadra, pero no es Σ de las lecturas)", { biDg: pen("0.00"), total: pen("18.00") }],
  ])("%s → EntradaReglasInvalidaError", (_n, valores) => {
    const h = hRed();
    const forjado = falso(h, { sugerencia: { tipo: "ajustar", valores } });
    expect(() => aplicarSugerencia(descuadre(), forjado)).toThrow(EntradaReglasInvalidaError);
  });
});

describe("R2a-7 variantes de R1b-5: identidad del XML parecida o fuera de gramática (CA-11, spec Alcance)", () => {
  // Decisión del usuario (R1b-5): serie normalizada a mayúsculas; si no coincide, XML_AJENO sin
  // abortar el lote. Spec, Alcance: "Si su identidad no coincide con la fila, se ignora y se
  // informa". Los campos distintos de la serie (numero, tipo, documento del proveedor) fuera de
  // gramática siguen abortando el lote: decide usuario (misma decisión, otro campo).
  const xmlIsc = (over: Partial<ResumenXml>) => xml({ isc: pen("770.00"), total: pen("770.00"), ...over });
  it.each([
    ["serie de la fila en minúsculas, XML en mayúsculas", { comprobante: { ...COMP, serie: "f001" } }, {}, "usa"],
    ["serie del XML con espacio final", {}, { comprobante: { ...COMP, serie: "F001 " } }, "ajeno"],
    ["serie del XML vacía", {}, { comprobante: { ...COMP, serie: "" } }, "ajeno"],
    ["serie del XML de 5 caracteres", {}, { comprobante: { ...COMP, serie: "F0001" } }, "ajeno"],
    ["serie del XML en ancho completo", {}, { comprobante: { ...COMP, serie: "Ｆ００１" } }, "ajeno"],
    ["numero del XML con serie pegada (decide usuario)", {}, { comprobante: { ...COMP, numero: "F001-123" } }, "ajeno"],
    ["numero del XML de 9 cifras (decide usuario)", {}, { comprobante: { ...COMP, numero: "123456789" } }, "ajeno"],
    ["tipo de comprobante del XML '1' (decide usuario)", {}, { comprobante: { ...COMP, tipo: "1" } }, "ajeno"],
    ["RUC del XML con un carácter extraño (decide usuario)", {}, { proveedor: { tipo: "6", numero: "20100000001/" } }, "ajeno"],
  ] as const)("%s: no aborta el lote", (_n, overFila, overXml, uso) => {
    const r = evaluarReglas(
      [fila(sanJuan(), { ...overFila, xml: xmlIsc(overXml as Partial<ResumenXml>) }), fila(mixta(), { id: "f2" })],
      ctx(),
    );
    expect(r.hallazgos.some((h) => h.filaId === "f2" && h.regla === "R-MIX")).toBe(true);
    const h = unico(r.hallazgos.filter((x) => x.filaId === "f1"), "R-ISC");
    if (uso === "usa") {
      expect(r.avisos).toEqual([]);
      expect(h.requiereConfirmacion).toBe(false);
    } else {
      expect(r.avisos.map((a) => a.codigo)).toEqual(["XML_AJENO"]);
      expect(h.requiereConfirmacion).toBe(true);
    }
  });
});

describe("R2a-8 variantes de R1b-6: punto pegado seguido de cifras o repetido (D-5, CA-12)", () => {
  // Decisión del usuario (R1b-6): "un punto al final de una palabra completa es separador; las
  // abreviaturas con punto siguen valiendo". T13 solo separa si después del punto viene una
  // letra (para conservar "1.50"); si viene una cifra u otro punto, el token queda pegado.
  it.each([
    ["plural pegado a una medida", "PERFUMES.100ML", "perfume"],
    ["abreviatura pegada a la talla", "ZAPAT.42 URBANA", "zapatilla"],
    ["plural pegado a un año", "ZAPATILLAS.2024", "zapatilla"],
    ["plural con puntos suspensivos", "COMPRA DE ZAPATILLAS...", "zapatilla"],
    ["control negativo (CA-12)", "ZAPATA.40", undefined],
    ["control negativo con decimal (CA-12)", "zapata de concreto 1.50", undefined],
  ])("%s → %s", (_n, glosa, palabra) => {
    expect(DICCIONARIO_GLOSAS_BASE.buscar([glosa])?.palabra).toBe(palabra);
  });
});
