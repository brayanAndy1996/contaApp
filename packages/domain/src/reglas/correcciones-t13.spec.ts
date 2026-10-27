// T13 (backend): pruebas propias de las correcciones de la ronda adversarial 1 (R1b-1 a R1b-7).
// aplicarSugerencia no cree la sugerencia recibida: la contrasta con la regla, el destino y las
// lecturas; las lecturas de R-ISC con XML incluyen isc; la serie se compara en mayúsculas.
import { describe, expect, it } from "vitest";
import { COMPROBANTE, evaluar, fila, montos, pen, unico, usd, xml } from "../../tests/ayudas/filas-motor";
import type { Hallazgo } from "./index";
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
const hIscXml = () => unico(evaluar([fila({ montos: conIsc(), xml: xmlIsc() })]).hallazgos, "R-ISC");
const sanJuan = () => montos("PEN", { biDg: "770.00", total: "770.00" });
const hIsc = () => unico(evaluar([fila({ montos: sanJuan() })]).hallazgos, "R-ISC");
const mixta = () => montos("PEN", { biDg: "21.48", igvDg: "1.61", total: "23.09" });
const hMix = () => unico(evaluar([fila({ montos: mixta() })]).hallazgos, "R-MIX");
const hMixXml = () =>
  unico(
    evaluar([fila({ montos: mixta(), xml: xml({ gravado: pen("8.94"), igv: pen("1.61"), noGravado: pen("12.54"), total: pen("23.09") }) })])
      .hallazgos,
    "R-MIX",
  );

describe("R1b-1: lecturas de R-ISC con el ISC del XML", () => {
  it("incluyen isc y las BI de los otros destinos; sin XML solo BI e IGV del destino", () => {
    expect(Object.keys(hIscXml().lecturas).sort()).toEqual(["biDg", "biDgng", "biDng", "igvDg", "isc"]);
    expect(Object.keys(hIsc().lecturas).sort()).toEqual(["biDg", "igvDg"]);
  });

  it("caso feliz: mueve el ISC del XML; si isc cambió, obsoleta", () => {
    const r = aplicarSugerencia(conIsc(), hIscXml());
    expect(r.montos.obtener("biDg").toString()).toBe("700.00");
    expect(r.montos.obtener("isc").toString()).toBe("300.00");
    const editados = montos("PEN", { biDg: "1000.00", isc: "300.00", total: "1300.00" });
    expect(() => aplicarSugerencia(editados, hIscXml())).toThrow(SugerenciaObsoletaError);
  });
});

describe("R1b-3/R1b-4: R-ISC contrastado con su destino y sus lecturas", () => {
  it.each([
    ["sin XML con requiereConfirmacion false", () => aplicarSugerencia(sanJuan(), falso(hIsc(), { requiereConfirmacion: false }))],
    ["sin XML con dato", () => aplicarSugerencia(sanJuan(), falso(hIsc(), { dato: "gravado" }))],
    ["con XML: monto mayor que la BI", () => aplicarSugerencia(conIsc(), sugFalsa(hIscXml(), { monto: pen("1000.01") }))],
    ["con XML: monto de signo distinto", () => aplicarSugerencia(conIsc(), sugFalsa(hIscXml(), { monto: pen("-300.00") }))],
    ["con XML: monto en otra moneda", () => aplicarSugerencia(conIsc(), sugFalsa(hIscXml(), { monto: usd("300.00") }))],
    ["con XML: requiereConfirmacion true", () => aplicarSugerencia(conIsc(), falso(hIscXml(), { requiereConfirmacion: true }))],
    [
      "con XML sin la lectura isc: se trata como sin XML y el monto no es toda la BI",
      () => aplicarSugerencia(conIsc(), sinLectura(hIscXml(), "isc")),
    ],
    [
      "con XML y otra BI ≠ 0 en lecturas y montos",
      () =>
        aplicarSugerencia(
          montos("PEN", { biDg: "1000.00", biDgng: "5.00", total: "1005.00" }),
          lectFalsas(hIscXml(), { biDgng: pen("5.00") }),
        ),
    ],
    ["destino nulo", () => aplicarSugerencia(sanJuan(), falso(hIsc(), { destino: null }))],
  ])("%s → EntradaReglasInvalidaError", (_n, aplicar) => {
    expect(aplicar).toThrow(EntradaReglasInvalidaError);
  });

  it("con XML sin la BI de otro destino en lecturas → SugerenciaObsoletaError", () => {
    expect(() => aplicarSugerencia(conIsc(), sinLectura(hIscXml(), "biDng"))).toThrow(SugerenciaObsoletaError);
  });
});

describe("R1b-5: R-MIX contrastado con el rango de sus lecturas", () => {
  it("caso feliz: el exacto del XML se aplica sin confirmación", () => {
    const r = aplicarSugerencia(mixta(), hMixXml());
    expect(r.montos.obtener("biDg").toString()).toBe("8.94");
    expect(r.montos.obtener("noGravado").toString()).toBe("12.54");
  });

  it.each([
    ["estimado distinto", () => aplicarSugerencia(mixta(), sugFalsa(hMix(), { estimado: pen("8.92") }), { gravado: pen("8.94") })],
    ["exacto con dato gravado", () => aplicarSugerencia(mixta(), falso(hMixXml(), { dato: "gravado" }))],
    ["exacto con requiereConfirmacion", () => aplicarSugerencia(mixta(), falso(hMixXml(), { requiereConfirmacion: true }))],
    ["exacto en otra moneda", () => aplicarSugerencia(mixta(), sugFalsa(hMixXml(), { exacto: usd("8.94") }))],
    ["sin exacto y sin dato", () => aplicarSugerencia(mixta(), falso(hMix(), { dato: null }), { gravado: pen("8.94") })],
    ["sin exacto y sin confirmación requerida", () => aplicarSugerencia(mixta(), falso(hMix(), { requiereConfirmacion: false }), { gravado: pen("8.94") })],
    [
      "lecturas cuyo IGV cuadra (rango vacío)",
      () =>
        aplicarSugerencia(
          montos("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" }),
          falso(hMix(), { lecturas: { biDg: pen("100.00"), igvDg: pen("18.00") } }),
          { gravado: pen("8.94") },
        ),
    ],
    [
      "exacto fuera del rango a 18 % sin rango a 10 %",
      () => {
        const m = montos("PEN", { biDg: "10.00", igvDg: "1.50", total: "11.50" });
        const h = unico(evaluar([fila({ montos: m })]).hallazgos, "R-MIX");
        return aplicarSugerencia(m, falso(h, { dato: null, requiereConfirmacion: false, sugerencia: { ...h.sugerencia, exacto: pen("5.00") } }));
      },
    ],
  ])("%s → EntradaReglasInvalidaError", (_n, aplicar) => {
    expect(aplicar).toThrow(EntradaReglasInvalidaError);
  });

  it("masivo: sin exacto y con dato null se rechaza con ENTRADA_INVALIDA", () => {
    const r = aplicarMasivo([{ montos: mixta(), hallazgo: falso(hMix(), { dato: null }) }]);
    expect(r.rechazadas).toEqual([{ filaId: "f1", regla: "R-MIX", codigo: "ENTRADA_INVALIDA" }]);
  });
});

describe("R-RED, R-NEW y R-GP: destino, dato y lecturas", () => {
  const descuadrada = () => montos("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.01" });
  const hRed = () => unico(evaluar([fila({ montos: descuadrada() })]).hallazgos, "R-RED");

  it("caso feliz: R-RED con todas sus lecturas se aplica", () => {
    expect(aplicarSugerencia(descuadrada(), hRed()).montos.total.toString()).toBe("118.00");
  });

  it("R-RED sin la lectura total → SugerenciaObsoletaError", () => {
    expect(() => aplicarSugerencia(descuadrada(), sinLectura(hRed(), "total"))).toThrow(SugerenciaObsoletaError);
  });

  it("R-RED con destino, R-NEW sin dato y R-GP con destino → EntradaReglasInvalidaError", () => {
    expect(() => aplicarSugerencia(descuadrada(), falso(hRed(), { destino: "DG" }))).toThrow(EntradaReglasInvalidaError);
    const nuevo = unico(evaluar([fila({ proveedor: { tipo: "6", numero: "20999999999" } })]).hallazgos, "R-NEW");
    expect(() => aplicarSugerencia(fila().montos, falso(nuevo, { dato: null }), { destino: "DG" })).toThrow(EntradaReglasInvalidaError);
    const gp = unico(evaluar([fila({ xml: xml({ glosas: ["zapatillas"] }) })]).hallazgos, "R-GP");
    expect(() => aplicarSugerencia(fila().montos, falso(gp, { destino: "DG" }))).toThrow(EntradaReglasInvalidaError);
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
