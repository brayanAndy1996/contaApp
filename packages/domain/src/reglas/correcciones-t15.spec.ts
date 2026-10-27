// T15 (backend): pruebas propias de las correcciones de la ronda adversarial 2 (R2a-1 a R2a-5,
// R2b-1 a R2b-5). Con el entorno de evaluarReglas, aplicar re-evalúa la fila y solo aplica el
// mismo hallazgo; sin él, contrasta además explicación y `ajustar`. Identidad del XML fuera de
// gramática = XML_AJENO sin abortar el lote.
// T15b-1: todas las llamadas pasan el entorno (el entorno pasará a ser obligatorio). Los casos que
// antes ejercitaban las comprobaciones sin entorno (coherencia de explicación y `ajustar`) ahora
// pasan el entorno real de la fila y se rechazan por la re-evaluación (SugerenciaObsoletaError).
import { describe, expect, it } from "vitest";
import { COMPROBANTE, PROVEEDOR, ctx, evaluar, fila, montos, pen, tc, unico, usd, xml } from "../../tests/ayudas/filas-motor";
import type { EntornoEvaluacion, FilaEvaluable, Hallazgo } from "./index";
import {
  aplicarMasivo,
  aplicarSugerencia,
  EntradaReglasInvalidaError,
  SugerenciaObsoletaError,
} from "./index";

const falso = (h: Hallazgo, over: Record<string, unknown>) => ({ ...h, ...over }) as unknown as Hallazgo;
const entorno = (...filas: FilaEvaluable[]): EntornoEvaluacion => ({ filas, contexto: ctx() });

const sanJuan = () => montos("PEN", { biDg: "770.00", total: "770.00" });
const mixta = () => montos("PEN", { biDg: "21.48", igvDg: "1.61", total: "23.09" });
const xmlMixta = () => xml({ gravado: pen("8.94"), igv: pen("1.61"), noGravado: pen("12.54"), total: pen("23.09") });
const descuadrada = () => montos("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.01" });

describe("T15 · con entorno: re-evaluación de la fila (R2a-1, R2a-2, R2a-3 = R2b-1)", () => {
  it("caso feliz: R-ISC del XML, R-MIX exacto, R-RED, R-NEW y R-GP se aplican", () => {
    const fIsc = fila({ montos: sanJuan(), xml: xml({ gravado: pen("0.00"), igv: pen("0.00"), isc: pen("770.00"), total: pen("770.00") }) });
    const hIsc = unico(evaluar([fIsc]).hallazgos, "R-ISC");
    expect(aplicarSugerencia(sanJuan(), hIsc, undefined, entorno(fIsc)).montos.obtener("isc").toString()).toBe("770.00");

    const fMix = fila({ montos: mixta(), xml: xmlMixta() });
    const hMix = unico(evaluar([fMix]).hallazgos, "R-MIX");
    expect(aplicarSugerencia(mixta(), hMix, undefined, entorno(fMix)).montos.obtener("biDg").toString()).toBe("8.94");

    const fRed = fila({ montos: descuadrada() });
    const hRed = unico(evaluar([fRed]).hallazgos, "R-RED");
    expect(aplicarSugerencia(descuadrada(), hRed, undefined, entorno(fRed)).montos.total.toString()).toBe("118.00");

    const fNew = fila({ proveedor: { tipo: "6", numero: "20999999999" } });
    const hNew = unico(evaluar([fNew]).hallazgos, "R-NEW");
    expect(aplicarSugerencia(fNew.montos, hNew, { destino: "DGNG" }, entorno(fNew)).montos.obtener("biDgng").toString()).toBe("100.00");

    const fGp = fila({ xml: xml({ glosas: ["zapatillas"] }) });
    const hGp = unico(evaluar([fGp]).hallazgos, "R-GP");
    expect(aplicarSugerencia(fGp.montos, hGp, undefined, entorno(fGp)).excluir).toBe(true);
  });

  it("R-ISC sin XML falsificado del todo como 'con XML' (explicación incluida): con entorno, obsoleta", () => {
    const f = fila({ montos: sanJuan() });
    const h = unico(evaluar([f]).hallazgos, "R-ISC");
    const forjado = falso(h, {
      explicacion: "Base gravada con IGV 0: el XML indica ISC",
      requiereConfirmacion: false,
      lecturas: { ...h.lecturas, isc: pen("0.00"), biDgng: pen("0.00"), biDng: pen("0.00") },
      sugerencia: { tipo: "mover", origen: "biDg", destino: "isc", monto: pen("100.00") },
    });
    // T15b-1: aquí había una aserción de que SIN entorno el falso se aplicaba (límite declarado de
    // T15). Con el entorno opcional aún no se puede esperar un error por omitirlo; cuando el backend lo
    // haga obligatorio, añadir: llamar sin entorno lanza EntradaReglasInvalidaError.
    expect(() => aplicarSugerencia(sanJuan(), forjado, undefined, entorno(f))).toThrow(SugerenciaObsoletaError);
  });

  it("R-MIX con exacto inventado y explicación coherente: con entorno sin XML, obsoleta", () => {
    const f = fila({ montos: mixta() });
    const h = unico(evaluar([fila({ montos: mixta(), xml: xmlMixta() })]).hallazgos, "R-MIX");
    expect(() => aplicarSugerencia(mixta(), h, undefined, entorno(f))).toThrow(SugerenciaObsoletaError);
  });

  it("R-MIX exacto sobre una fila con otra BI agregada: obsoleta en masivo con entorno", () => {
    const f = fila({ montos: mixta(), xml: xmlMixta() });
    const h = unico(evaluar([f]).hallazgos, "R-MIX");
    const editados = montos("PEN", { biDg: "21.48", igvDg: "1.61", biDng: "100.00", total: "123.09" });
    const r = aplicarMasivo([{ montos: editados, hallazgo: h }], entorno(f));
    expect(r.rechazadas).toEqual([{ filaId: "f1", regla: "R-MIX", codigo: "SUGERENCIA_OBSOLETA" }]);
  });

  it("masivo con entorno encadena: R-RED con XML y luego R-ISC (obsoleta: el isc ya cambió)", () => {
    const m = montos("PEN", { biDg: "770.00", total: "1540.00" });
    const f = fila({ montos: m, xml: xml({ gravado: pen("770.00"), igv: pen("0.00"), isc: pen("770.00"), total: pen("1540.00") }) });
    const hs = evaluar([f]).hallazgos;
    const r = aplicarMasivo(
      [
        { montos: m, hallazgo: unico(hs, "R-RED") },
        { montos: m, hallazgo: unico(hs, "R-ISC") },
      ],
      entorno(f),
    );
    expect(r.aplicadas).toHaveLength(1);
    expect(r.rechazadas).toEqual([{ filaId: "f1", regla: "R-ISC", codigo: "SUGERENCIA_OBSOLETA" }]);
  });

  it("R-MIX sin XML: la confirmación se valida contra el rango recalculado", () => {
    const f = fila({ montos: mixta() });
    const h = unico(evaluar([f]).hallazgos, "R-MIX");
    const r = aplicarMasivo(
      [
        { montos: mixta(), hallazgo: h, confirmacion: { gravado: pen("8.94") } },
        { montos: mixta(), hallazgo: falso(h, { filaId: "f2" }), confirmacion: { gravado: pen("1.00") } },
      ],
      entorno(f, fila({ id: "f2", montos: mixta() })),
    );
    expect(r.aplicadas.map((a) => a.montos.obtener("biDg").toString())).toEqual(["8.94"]);
    expect(r.rechazadas).toEqual([{ filaId: "f2", regla: "R-MIX", codigo: "CONFIRMACION_INVALIDA" }]);
  });

  it("errores: fila ausente del entorno, moneda distinta, entorno inválido", () => {
    const f = fila({ montos: sanJuan() });
    const h = unico(evaluar([f]).hallazgos, "R-ISC");
    expect(() => aplicarSugerencia(sanJuan(), h, undefined, entorno(fila({ id: "otra" })))).toThrow(EntradaReglasInvalidaError);
    const usdM = montos("USD", { biDg: "770.00", total: "770.00" });
    expect(() => aplicarSugerencia(usdM, h, undefined, entorno(f))).toThrow(SugerenciaObsoletaError);
    const malo = { ...entorno(f), extra: 1 } as unknown as EntornoEvaluacion;
    expect(() => aplicarSugerencia(sanJuan(), h, undefined, malo)).toThrow(EntradaReglasInvalidaError);
    expect(() => aplicarMasivo([{ montos: sanJuan(), hallazgo: h }], malo)).toThrow(EntradaReglasInvalidaError);
  });
});

describe("T15 · lecturas de R-MIX con XML y explicación incoherente (R2a-2, R2a-3)", () => {
  it("R-MIX con XML lee las BI de los otros destinos; sin XML solo BI e IGV del destino", () => {
    const conXml = unico(evaluar([fila({ montos: mixta(), xml: xmlMixta() })]).hallazgos, "R-MIX");
    expect(Object.keys(conXml.lecturas).sort()).toEqual(["biDg", "biDgng", "biDng", "igvDg"]);
    const sinXml = unico(evaluar([fila({ montos: mixta() })]).hallazgos, "R-MIX");
    expect(Object.keys(sinXml.lecturas).sort()).toEqual(["biDg", "igvDg"]);
  });

  it.each([
    [
      "R-ISC con XML con explicación de otro caso",
      () => {
        const m = montos("PEN", { biDg: "1000.00", total: "1000.00" });
        const f = fila({ montos: m, xml: xml({ gravado: pen("700.00"), igv: pen("0.00"), isc: pen("300.00"), total: pen("1000.00") }) });
        const h = unico(evaluar([f]).hallazgos, "R-ISC");
        return aplicarSugerencia(m, falso(h, { explicacion: "Proveedor emisor de ISC: el XML indica ISC 300.00" }), undefined, entorno(f));
      },
    ],
    [
      "R-ISC sin XML con explicación de otra BI",
      () =>
        aplicarSugerencia(
          sanJuan(),
          falso(unico(evaluar([fila({ montos: sanJuan() })]).hallazgos, "R-ISC"), { explicacion: "x" }),
          undefined,
          entorno(fila({ montos: sanJuan() })),
        ),
    ],
    [
      "R-MIX con explicación ajena",
      () =>
        aplicarSugerencia(
          mixta(),
          falso(unico(evaluar([fila({ montos: mixta() })]).hallazgos, "R-MIX"), { explicacion: "x" }),
          { gravado: pen("8.94") },
          entorno(fila({ montos: mixta() })),
        ),
    ],
    [
      "R-MIX exacto con otra BI ≠ 0 en lecturas y montos",
      () => {
        const f = fila({ montos: mixta(), xml: xmlMixta() });
        const h = unico(evaluar([f]).hallazgos, "R-MIX");
        const m = montos("PEN", { biDg: "21.48", igvDg: "1.61", biDgng: "5.00", total: "28.09" });
        return aplicarSugerencia(m, falso(h, { lecturas: { ...h.lecturas, biDgng: pen("5.00") } }), undefined, entorno(f));
      },
    ],
  ])("%s → SugerenciaObsoletaError", (_n, aplicar) => {
    expect(aplicar).toThrow(SugerenciaObsoletaError);
  });
});

describe("T15 · `ajustar` de R-RED contrastado con su explicación (R2a-1)", () => {
  // XML que respalda biDg 100.01 (gravado del XML 100.01, total 118.01).
  const conXml = () => montos("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.01" });
  const fXml = () => fila({ montos: conXml(), xml: xml({ gravado: pen("100.01"), total: pen("118.01") }) });
  const hXml = () => unico(evaluar([fXml()]).hallazgos, "R-RED");
  const red = (h: Hallazgo, valores: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    falso(h, { sugerencia: { tipo: "ajustar", valores }, ...over });

  it("caso feliz: columna del XML; total = Σ con XML (otra sugerencia distinta de la evaluada) es obsoleta", () => {
    expect(aplicarSugerencia(conXml(), hXml(), undefined, entorno(fXml())).montos.obtener("biDg").toString()).toBe("100.01");
    // T15b-1: antes (sin entorno) se aceptaba `total = Σ`; con entorno solo se aplica el hallazgo idéntico.
    expect(() => aplicarSugerencia(conXml(), red(hXml(), { total: pen("118.00") }), undefined, entorno(fXml()))).toThrow(
      SugerenciaObsoletaError,
    );
  });

  it("caso feliz: origenUsd con varias columnas deja la fila convertida", () => {
    const origen = montos("USD", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    const m = montos("PEN", { biDg: "375.00", igvDg: "67.51", total: "442.51" });
    const f = fila({ montos: m, origenUsd: { montos: origen, tipoCambio: tc("3.750") } });
    const h = unico(evaluar([f]).hallazgos, "R-RED");
    expect(aplicarSugerencia(m, h, undefined, entorno(f)).montos.total.toString()).toBe("442.50");
  });

  it.each([
    ["XML: otrosTributos no es una columna del XML", () => red(hXml(), { otrosTributos: pen("0.01") })],
    ["XML: columna con otro valor", () => red(hXml(), { biDg: pen("100.02") })],
    ["XML: dos columnas", () => red(hXml(), { biDg: pen("100.01"), igvDg: pen("18.00") })],
    ["XML: con confirmación", () => falso(hXml(), { requiereConfirmacion: true })],
    ["sin XML: sin confirmación", () => falso(hXml(), { explicacion: hXml().explicacion.split(";")[0] })],
    ["USD: explicación de conversión sobre una fila que no queda cuadrada", () => red(hXml(), { biDg: pen("5.00") }, { explicacion: "Los montos en PEN no coinciden con la conversión por componente con TC 3.750" })],
    ["explicación ajena", () => falso(hXml(), { explicacion: "x" })],
  ])("%s → SugerenciaObsoletaError", (_n, h) => {
    expect(() => aplicarSugerencia(conXml(), h(), undefined, entorno(fXml()))).toThrow(SugerenciaObsoletaError);
  });

  it("sin XML fuera del umbral: total = Σ no es una sugerencia de R-RED", () => {
    const m = montos("PEN", { biDg: "100.00", igvDg: "18.00", total: "200.00" });
    const f = fila({ montos: m });
    const h = unico(evaluar([f]).hallazgos, "R-RED");
    expect(h.sugerencia).toBeNull();
    expect(() =>
      aplicarSugerencia(m, falso(h, { sugerencia: { tipo: "ajustar", valores: { total: pen("118.00") } } }), undefined, entorno(f)),
    ).toThrow(SugerenciaObsoletaError);
  });

  it("USD: explicación de conversión en una fila USD → SugerenciaObsoletaError", () => {
    const m = montos("USD", { biDg: "100.00", igvDg: "18.00", total: "118.01" });
    const f = fila({ montos: m });
    const h = unico(evaluar([f]).hallazgos, "R-RED");
    const forjado = falso(h, { requiereConfirmacion: false, explicacion: "Los montos en PEN no coinciden con la conversión por componente con TC 3.750" });
    expect(() => aplicarSugerencia(m, forjado, undefined, entorno(f))).toThrow(SugerenciaObsoletaError);
  });

  it("fila fuera de NUMERIC(14,2) al sumar: cualquier ajustar es falso", () => {
    const m = montos("PEN", { biDg: "999999999999.99", igvDg: "999999999999.99", total: "1.00" });
    const f = fila({ montos: m });
    const h = unico(evaluar([f]).hallazgos, "R-RED");
    expect(h.sugerencia).toBeNull();
    expect(() =>
      aplicarSugerencia(m, falso(h, { sugerencia: { tipo: "ajustar", valores: { total: pen("2.00") } } }), undefined, entorno(f)),
    ).toThrow(SugerenciaObsoletaError);
  });
});

describe("T15 · identidad del XML fuera de gramática o de longitud = XML_AJENO (R2a-4 = R2b-3, R2b-2)", () => {
  const larga = "1".repeat(65);
  it.each([
    ["tipo de 65 caracteres", { comprobante: { ...COMPROBANTE, tipo: larga } }],
    ["número de 65 caracteres", { comprobante: { ...COMPROBANTE, numero: larga } }],
    ["número de 9 cifras significativas", { comprobante: { ...COMPROBANTE, numero: "000123456789" } }],
    ["tipo de documento inválido", { proveedor: { tipo: "66", numero: PROVEEDOR.numero } }],
    ["RUC de 65 caracteres", { proveedor: { tipo: "6", numero: larga } }],
  ])("%s → XML_AJENO y el lote sigue", (_n, over) => {
    const r = evaluar([fila({ xml: xml(over) }), fila({ id: "f2", montos: mixta() })]);
    expect(r.avisos.map((a) => [a.filaId, a.codigo])).toEqual([["f1", "XML_AJENO"]]);
    expect(r.hallazgos.some((h) => h.filaId === "f2" && h.regla === "R-MIX")).toBe(true);
  });

  it("en la fila siguen siendo EntradaReglasInvalidaError; un campo que no es string también en el XML", () => {
    expect(() => evaluar([fila({ comprobante: { ...COMPROBANTE, numero: "123456789" } })])).toThrow(EntradaReglasInvalidaError);
    expect(() => evaluar([fila({ proveedor: { tipo: "6", numero: "1".repeat(65) } })])).toThrow(EntradaReglasInvalidaError);
    const xmlNumero = xml({ comprobante: { ...COMPROBANTE, numero: 123 as unknown as string } });
    expect(() => evaluar([fila({ xml: xmlNumero })])).toThrow(EntradaReglasInvalidaError);
  });

  it("caso feliz: con identidad válida el XML se sigue leyendo (moneda distinta → XML_MONEDA, no XML_AJENO)", () => {
    const r = evaluar([fila({ xml: xml({ moneda: "USD", gravado: usd("100.00") }) })]);
    expect(r.avisos.map((a) => a.codigo)).toEqual(["XML_MONEDA"]);
  });
});
