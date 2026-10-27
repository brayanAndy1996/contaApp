// T10 (backend): validación de hallazgos falsificados en aplicarSugerencia/aplicarMasivo
// (plan, "Ratificación de contratos", Aplicar) y bordes de separar/ajustar.
import { describe, expect, it } from "vitest";
import { evaluar, fila, montos, pen, unico, usd, xml } from "../../tests/ayudas/filas-motor";
import type { Hallazgo } from "./index";
import { aplicarMasivo, aplicarSugerencia, ConfirmacionInvalidaError, EntradaReglasInvalidaError } from "./index";

const sanJuan = () => montos("PEN", { biDg: "770.00", total: "770.00" });
const mixta = () => montos("PEN", { biDg: "21.48", igvDg: "1.61", total: "23.09" });
const hIsc = () => unico(evaluar([fila({ montos: sanJuan() })]).hallazgos, "R-ISC");
const hMix = () => unico(evaluar([fila({ montos: mixta() })]).hallazgos, "R-MIX");
const falso = (h: Hallazgo, over: Record<string, unknown>) => ({ ...h, ...over }) as unknown as Hallazgo;
const sugFalsa = (h: Hallazgo, over: Record<string, unknown>) => falso(h, { sugerencia: { ...h.sugerencia, ...over } });

describe("aplicarSugerencia: hallazgo falsificado → EntradaReglasInvalidaError", () => {
  it("campos del hallazgo fuera de forma", () => {
    const h = hIsc();
    const malos = [
      falso(h, { filaId: "a b" }),
      falso(h, { regla: "R-XXX" }),
      falso(h, { destino: "XX" }),
      falso(h, { explicacion: 1 }),
      falso(h, { requiereConfirmacion: "no" }),
      falso(h, { dato: "otro" }),
      falso(h, { lecturas: { biDg: "770.00" } }),
      falso(h, { lecturas: { otra: pen("1.00") } }),
      falso(h, { sugerencia: "mover" }),
      falso(h, { sugerencia: { tipo: "excluir", palabra: "x", categoria: "y" } }),
      sugFalsa(h, { monto: "770.00" }),
      sugFalsa(h, { origen: "xx" }),
      sugFalsa(h, { extra: 1 }),
    ];
    for (const m of malos) expect(() => aplicarSugerencia(sanJuan(), m)).toThrow(EntradaReglasInvalidaError);
  });

  it("separar con min > max o monedas distintas", () => {
    const h = hMix();
    for (const over of [
      { min: pen("8.97"), max: pen("8.92") },
      { min: usd("8.92") },
      { columnaBi: "noGravado" },
    ]) {
      expect(() => aplicarSugerencia(mixta(), sugFalsa(h, over), { gravado: pen("8.94") })).toThrow(EntradaReglasInvalidaError);
    }
  });

  it("ajustar sin valores, excluir sin palabra y clasificar con claves extra", () => {
    const descuadrada = montos("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.01" });
    const red = unico(evaluar([fila({ montos: descuadrada })]).hallazgos, "R-RED");
    expect(() => aplicarSugerencia(descuadrada, sugFalsa(red, { valores: {} }))).toThrow(EntradaReglasInvalidaError);
    const gp = unico(evaluar([fila({ xml: xml({ glosas: ["zapatillas"] }) })]).hallazgos, "R-GP");
    expect(() => aplicarSugerencia(fila().montos, sugFalsa(gp, { palabra: 1 }))).toThrow(EntradaReglasInvalidaError);
    const nuevo = unico(evaluar([fila({ proveedor: { tipo: "6", numero: "20999999999" } })]).hallazgos, "R-NEW");
    expect(() => aplicarSugerencia(fila().montos, sugFalsa(nuevo, { extra: 1 }), { destino: "DG" })).toThrow(
      EntradaReglasInvalidaError,
    );
  });

  it("montos que no son un MontosComprobante real", () => {
    expect(() => aplicarSugerencia(JSON.parse(JSON.stringify(sanJuan())), hIsc())).toThrow(EntradaReglasInvalidaError);
  });
});

describe("aplicarSugerencia: bordes de separar y ajustar", () => {
  it("R-MIX con exacto del 10 % fuera de [min, max]: sin confirmación aplica el exacto y confirmarlo también vale", () => {
    const m = montos("PEN", { biDg: "80.00", igvDg: "5.00", total: "85.00" });
    const h = unico(evaluar([fila({ montos: m, xml: xml({ gravado: pen("50.00"), igv: pen("5.00"), noGravado: pen("30.00"), total: pen("85.00") }) })]).hallazgos, "R-MIX");
    expect(aplicarSugerencia(m, h).montos.obtener("biDg").toString()).toBe("50.00");
    expect(aplicarSugerencia(m, h, { gravado: pen("50.00") }).montos.obtener("noGravado").toString()).toBe("30.00");
    expect(() => aplicarSugerencia(m, h, { gravado: pen("49.99") })).toThrow(ConfirmacionInvalidaError);
  });

  // T13: antes se aceptaba un `max` ensanchado hasta toda la BI (montos sin cambio); desde la
  // ronda adversarial 1 (R1b-5) el rango debe ser el que sale de las lecturas.
  it("separar con max ensanchado hasta toda la BI: EntradaReglasInvalidaError", () => {
    const h = sugFalsa(hMix(), { max: pen("21.48") });
    expect(() => aplicarSugerencia(mixta(), h, { gravado: pen("21.48") })).toThrow(EntradaReglasInvalidaError);
  });

  it("ajustar una columna respaldada por el XML conserva el resto", () => {
    const m = montos("PEN", { biDg: "100.00", igvDg: "18.00", noGravado: "4.00", total: "123.00" });
    const h = unico(evaluar([fila({ montos: m, xml: xml({ noGravado: pen("5.00"), total: pen("123.00") }) })]).hallazgos, "R-RED");
    const r = aplicarSugerencia(m, h);
    expect(r.montos.obtener("noGravado").toString()).toBe("5.00");
    expect(r.montos.total.toString()).toBe("123.00");
  });
});

describe("aplicarMasivo: entradas falsas y defectos", () => {
  it("hallazgo que no es objeto o sin regla válida: EntradaReglasInvalidaError", () => {
    expect(() => aplicarMasivo([{ montos: sanJuan(), hallazgo: null as unknown as Hallazgo }])).toThrow(EntradaReglasInvalidaError);
    expect(() => aplicarMasivo([{ montos: sanJuan(), hallazgo: falso(hIsc(), { regla: "R-XXX" }) }])).toThrow(
      EntradaReglasInvalidaError,
    );
  });

  it("un error que no es de reglas ni de dinero se propaga (defecto, no rechazo)", () => {
    const h = { ...hIsc() } as Record<string, unknown>;
    Object.defineProperty(h, "explicacion", {
      enumerable: true,
      get() {
        throw new RangeError("defecto");
      },
    });
    expect(() => aplicarMasivo([{ montos: sanJuan(), hallazgo: h as unknown as Hallazgo }])).toThrow(RangeError);
  });

  it("confirmación con un Money de otra moneda: rechazo con el código de 010", () => {
    const h = falso(hMix(), { filaId: "m" });
    const r = aplicarMasivo([{ montos: mixta(), hallazgo: h, confirmacion: { gravado: usd("8.94") } }]);
    expect(r.rechazadas).toEqual([{ filaId: "m", regla: "R-MIX", codigo: "MONEDA_DISTINTA" }]);
  });
});
