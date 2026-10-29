// T13 (backend): pruebas propias de las correcciones de la ronda adversarial 1 (R1b-1 a R1b-7).
// aplicarSugerencia no cree la sugerencia recibida: la contrasta con la regla, el destino y las
// lecturas; las lecturas de R-ISC con XML incluyen isc; la serie se compara en mayúsculas.
// T15b-1: las llamadas pasan el entorno de evaluación; con él, un hallazgo falsificado que conserva la
// forma válida se rechaza por la re-evaluación (SugerenciaObsoletaError / SUGERENCIA_OBSOLETA), no por
// las comprobaciones de coherencia de T13 (que solo corren sin entorno; el ataque no se debilita).
import { describe, expect, it } from "vitest";
import { COMPROBANTE, ctx, evaluar, fila, montos, pen, unico, usd, xml } from "../../tests/ayudas/filas-motor";
import type { FilaEvaluable, Hallazgo } from "./index";
import { aplicarMasivo, aplicarSugerencia, EntradaReglasInvalidaError, SugerenciaObsoletaError } from "./index";

const falso = (h: Hallazgo, over: Record<string, unknown>) => ({ ...h, ...over }) as unknown as Hallazgo;
const sugFalsa = (h: Hallazgo, over: Record<string, unknown>) => falso(h, { sugerencia: { ...h.sugerencia, ...over } });
const lectFalsas = (h: Hallazgo, over: Record<string, unknown>) => falso(h, { lecturas: { ...h.lecturas, ...over } });
/** Hallazgo con sus lecturas sin la columna `k`. */
const sinLectura = (h: Hallazgo, k: string) =>
  falso(h, { lecturas: Object.fromEntries(Object.entries(h.lecturas).filter(([c]) => c !== k)) });

// R-ISC con XML: BI 1000.00 con IGV 0; el XML indica ISC 300.00 → mover 300.00 a isc.
const conIsc = () => montos("PEN", { biDg: "1000.00", total: "1000.00" });
const xmlIsc = () => xml({ gravado: pen("700.00"), igv: pen("0.00"), isc: pen("300.00"), total: pen("1000.00") });
const fIscXml = () => fila({ montos: conIsc(), xml: xmlIsc() });
const hIscXml = () => unico(evaluar([fIscXml()]).hallazgos, "R-ISC");
const sanJuan = () => montos("PEN", { biDg: "770.00", total: "770.00" });
const fIsc = () => fila({ montos: sanJuan() });
const hIsc = () => unico(evaluar([fIsc()]).hallazgos, "R-ISC");
const mixta = () => montos("PEN", { biDg: "21.48", igvDg: "1.61", total: "23.09" });
const fMix = () => fila({ montos: mixta() });
const hMix = () => unico(evaluar([fMix()]).hallazgos, "R-MIX");
const fMixXml = () =>
  fila({ montos: mixta(), xml: xml({ gravado: pen("8.94"), igv: pen("1.61"), noGravado: pen("12.54"), total: pen("23.09") }) });
const hMixXml = () => unico(evaluar([fMixXml()]).hallazgos, "R-MIX");
/** Entorno con el que se evaluó el hallazgo (T15b-1): las filas y el contexto. */
const entorno = (...filas: FilaEvaluable[]) => ({ filas, contexto: ctx() });

describe("R1b-1: lecturas de R-ISC con el ISC del XML", () => {
  it("incluyen isc y las BI de los otros destinos; sin XML solo BI e IGV del destino", () => {
    expect(Object.keys(hIscXml().lecturas).sort()).toEqual(["biDg", "biDgng", "biDng", "igvDg", "isc"]);
    expect(Object.keys(hIsc().lecturas).sort()).toEqual(["biDg", "igvDg"]);
  });

  it("caso feliz: mueve el ISC del XML; si isc cambió, obsoleta", () => {
    const r = aplicarSugerencia(conIsc(), hIscXml(), undefined, entorno(fIscXml()));
    expect(r.montos.obtener("biDg").toString()).toBe("700.00");
    expect(r.montos.obtener("isc").toString()).toBe("300.00");
    const editados = montos("PEN", { biDg: "1000.00", isc: "300.00", total: "1300.00" });
    expect(() => aplicarSugerencia(editados, hIscXml(), undefined, entorno(fIscXml()))).toThrow(SugerenciaObsoletaError);
  });
});

describe("R1b-3/R1b-4: R-ISC contrastado con su destino y sus lecturas", () => {
  it.each([
    ["sin XML con requiereConfirmacion false", () => aplicarSugerencia(sanJuan(), falso(hIsc(), { requiereConfirmacion: false }), undefined, entorno(fIsc()))],
    ["sin XML con dato", () => aplicarSugerencia(sanJuan(), falso(hIsc(), { dato: "gravado" }), undefined, entorno(fIsc()))],
    ["con XML: monto mayor que la BI", () => aplicarSugerencia(conIsc(), sugFalsa(hIscXml(), { monto: pen("1000.01") }), undefined, entorno(fIscXml()))],
    ["con XML: monto de signo distinto", () => aplicarSugerencia(conIsc(), sugFalsa(hIscXml(), { monto: pen("-300.00") }), undefined, entorno(fIscXml()))],
    ["con XML: monto en otra moneda", () => aplicarSugerencia(conIsc(), sugFalsa(hIscXml(), { monto: usd("300.00") }), undefined, entorno(fIscXml()))],
    ["con XML: requiereConfirmacion true", () => aplicarSugerencia(conIsc(), falso(hIscXml(), { requiereConfirmacion: true }), undefined, entorno(fIscXml()))],
    [
      "con XML sin la lectura isc: se trata como sin XML y el monto no es toda la BI",
      () => aplicarSugerencia(conIsc(), sinLectura(hIscXml(), "isc"), undefined, entorno(fIscXml())),
    ],
    [
      "con XML y otra BI ≠ 0 en lecturas y montos",
      () =>
        aplicarSugerencia(
          montos("PEN", { biDg: "1000.00", biDgng: "5.00", total: "1005.00" }),
          lectFalsas(hIscXml(), { biDgng: pen("5.00") }),
          undefined,
          entorno(fIscXml()),
        ),
    ],
    ["destino nulo", () => aplicarSugerencia(sanJuan(), falso(hIsc(), { destino: null }), undefined, entorno(fIsc()))],
  ])("%s → SugerenciaObsoletaError", (_n, aplicar) => {
    expect(aplicar).toThrow(SugerenciaObsoletaError);
  });

  it("con XML sin la BI de otro destino en lecturas → SugerenciaObsoletaError", () => {
    expect(() => aplicarSugerencia(conIsc(), sinLectura(hIscXml(), "biDng"), undefined, entorno(fIscXml()))).toThrow(SugerenciaObsoletaError);
  });
});

describe("R1b-5: R-MIX contrastado con el rango de sus lecturas", () => {
  it("caso feliz: el exacto del XML se aplica sin confirmación", () => {
    const r = aplicarSugerencia(mixta(), hMixXml(), undefined, entorno(fMixXml()));
    expect(r.montos.obtener("biDg").toString()).toBe("8.94");
    expect(r.montos.obtener("noGravado").toString()).toBe("12.54");
  });

  it.each([
    ["estimado distinto", () => aplicarSugerencia(mixta(), sugFalsa(hMix(), { estimado: pen("8.92") }), { gravado: pen("8.94") }, entorno(fMix()))],
    ["exacto con dato gravado", () => aplicarSugerencia(mixta(), falso(hMixXml(), { dato: "gravado" }), undefined, entorno(fMixXml()))],
    ["exacto con requiereConfirmacion", () => aplicarSugerencia(mixta(), falso(hMixXml(), { requiereConfirmacion: true }), undefined, entorno(fMixXml()))],
    ["exacto en otra moneda", () => aplicarSugerencia(mixta(), sugFalsa(hMixXml(), { exacto: usd("8.94") }), undefined, entorno(fMixXml()))],
    ["sin exacto y sin dato", () => aplicarSugerencia(mixta(), falso(hMix(), { dato: null }), { gravado: pen("8.94") }, entorno(fMix()))],
    ["sin exacto y sin confirmación requerida", () => aplicarSugerencia(mixta(), falso(hMix(), { requiereConfirmacion: false }), { gravado: pen("8.94") }, entorno(fMix()))],
    [
      "lecturas cuyo IGV cuadra (rango vacío)",
      () =>
        aplicarSugerencia(
          montos("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" }),
          falso(hMix(), { lecturas: { biDg: pen("100.00"), igvDg: pen("18.00") } }),
          { gravado: pen("8.94") },
          entorno(fMix()),
        ),
    ],
    [
      "exacto fuera del rango a 18 % sin rango a 10 %",
      () => {
        const m = montos("PEN", { biDg: "10.00", igvDg: "1.50", total: "11.50" });
        const f = fila({ montos: m });
        const h = unico(evaluar([f]).hallazgos, "R-MIX");
        return aplicarSugerencia(
          m,
          falso(h, { dato: null, requiereConfirmacion: false, sugerencia: { ...h.sugerencia, exacto: pen("5.00") } }),
          undefined,
          entorno(f),
        );
      },
    ],
  ])("%s → SugerenciaObsoletaError", (_n, aplicar) => {
    expect(aplicar).toThrow(SugerenciaObsoletaError);
  });

  it("masivo: sin exacto y con dato null se rechaza con SUGERENCIA_OBSOLETA", () => {
    const r = aplicarMasivo([{ montos: mixta(), hallazgo: falso(hMix(), { dato: null }) }], entorno(fMix()));
    expect(r.rechazadas).toEqual([{ filaId: "f1", regla: "R-MIX", codigo: "SUGERENCIA_OBSOLETA" }]);
  });
});

describe("R-RED, R-NEW y R-GP: destino, dato y lecturas", () => {
  const descuadrada = () => montos("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.01" });
  const fRed = () => fila({ montos: descuadrada() });
  const hRed = () => unico(evaluar([fRed()]).hallazgos, "R-RED");

  it("caso feliz: R-RED con todas sus lecturas se aplica", () => {
    expect(aplicarSugerencia(descuadrada(), hRed(), undefined, entorno(fRed())).montos.total.toString()).toBe("118.00");
  });

  it("R-RED sin la lectura total → SugerenciaObsoletaError", () => {
    expect(() => aplicarSugerencia(descuadrada(), sinLectura(hRed(), "total"), undefined, entorno(fRed()))).toThrow(SugerenciaObsoletaError);
  });

  it("R-RED con destino, R-NEW sin dato y R-GP con destino → SugerenciaObsoletaError", () => {
    expect(() => aplicarSugerencia(descuadrada(), falso(hRed(), { destino: "DG" }), undefined, entorno(fRed()))).toThrow(SugerenciaObsoletaError);
    const fNuevo = fila({ proveedor: { tipo: "6", numero: "20999999999" } });
    const nuevo = unico(evaluar([fNuevo]).hallazgos, "R-NEW");
    expect(() => aplicarSugerencia(fila().montos, falso(nuevo, { dato: null }), { destino: "DG" }, entorno(fNuevo))).toThrow(
      SugerenciaObsoletaError,
    );
    const fGp = fila({ xml: xml({ glosas: ["zapatillas"] }) });
    const gp = unico(evaluar([fGp]).hallazgos, "R-GP");
    expect(() => aplicarSugerencia(fila().montos, falso(gp, { destino: "DG" }), undefined, entorno(fGp))).toThrow(
      SugerenciaObsoletaError,
    );
  });
});

describe("R1b-6: serie del comprobante en mayúsculas; serie del XML inválida = XML_AJENO", () => {
  it("caso feliz: fila con serie en minúsculas y XML en mayúsculas usan el XML", () => {
    const r = evaluar([fila({ comprobante: { ...COMPROBANTE, serie: "f001" }, xml: xml() })]);
    expect(r.avisos).toEqual([]);
  });

  it("serie del XML fuera de gramática: XML_AJENO sin abortar el lote", () => {
    const r = evaluar([
      fila({ xml: xml({ comprobante: { ...COMPROBANTE, serie: "F-01" } }) }),
      fila({ id: "f2", montos: mixta() }),
    ]);
    expect(r.avisos.map((a) => [a.filaId, a.codigo])).toEqual([["f1", "XML_AJENO"]]);
    expect(r.hallazgos.some((h) => h.filaId === "f2" && h.regla === "R-MIX")).toBe(true);
  });

  it("serie de la fila fuera de gramática (o no ASCII) sigue siendo EntradaReglasInvalidaError", () => {
    expect(() => evaluar([fila({ comprobante: { ...COMPROBANTE, serie: "F-01" } })])).toThrow(EntradaReglasInvalidaError);
    expect(() => evaluar([fila({ comprobante: { ...COMPROBANTE, serie: "fıo1" } })])).toThrow(EntradaReglasInvalidaError);
  });
});
