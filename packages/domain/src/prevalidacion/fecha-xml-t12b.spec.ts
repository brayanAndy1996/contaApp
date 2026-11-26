// Spec 027 · T12b. `prevalidar` (012) acepta `ResumenXml.fechaEmision` (desde T8): opcional, validada como en `reglas/entrada.ts`
// (no texto → forma inválida; texto que no es AAAA-MM-DD válida → se omite). Con ella S4 (día no laborable) suma en el previo.
import { describe, expect, it } from "vitest";
import { EntradaPrevalidacionInvalidaError, prevalidar } from "../index";
import type { FilaReemplazo, ResultadoPrevalidacion } from "../index";
import { CABECERA, PROV, ctxBase, filaReemplazo, xmlDe } from "../../tests/ayudas/filas-reemplazo";
import { FECHA_HABIL, FECHA_SABADO, contextoNeutro } from "../../tests/ayudas/gastos";
import type { ContextoReglas } from "../index";

/** Proveedor minorista (4771), cliente sin CIIU: S1 (3) + S4 (1) = 4 alcanza el umbral 4 solo en día no laborable. */
const reglas = (): ContextoReglas =>
  ctxBase({ gastos: contextoNeutro({ umbral: 4, ciiuProveedores: [{ proveedor: { ...PROV }, ciiu: "4771" }] }) } as Partial<ContextoReglas>);
const filaCon = (fechaEmision?: unknown): FilaReemplazo =>
  filaReemplazo({ biDg: "100.00", igvDg: "18.00" }, {
    xml: { ...xmlDe({ gravado: "100.00", igv: "18.00", total: "118.00", glosas: ["ZAPATILLA URBANA T42"] }), fechaEmision } as never,
  });
const prev = (f: FilaReemplazo): ResultadoPrevalidacion =>
  prevalidar([f], { cabecera: CABECERA, reglas: reglas() } as Parameters<typeof prevalidar>[1]);
const codigosGp = (r: ResultadoPrevalidacion): string[] => {
  const a = r.avisos.find((x) => x.codigo === "R-GP") as unknown as { hallazgo: { sugerencia: { senales: { codigo: string }[] } } } | undefined;
  return a === undefined ? [] : a.hallazgo.sugerencia.senales.map((s) => s.codigo);
};

describe("T12b · fechaEmision del XML en prevalidar", () => {
  it("con fecha de sábado: S4 suma y R-GP alcanza el umbral (S1 + S4)", () => {
    const r = prev(filaCon(FECHA_SABADO));
    expect(r.apto).toBe(true);
    expect(codigosGp(r)).toEqual(["S1", "S4"]);
  });

  it("con fecha hábil, sin fecha o con `undefined`: sin S4 y bajo el umbral", () => {
    expect(codigosGp(prev(filaCon(FECHA_HABIL)))).toEqual([]);
    expect(codigosGp(prev(filaCon(undefined)))).toEqual([]);
    const sinClave = filaReemplazo({ biDg: "100.00", igvDg: "18.00" }, {
      xml: xmlDe({ gravado: "100.00", igv: "18.00", total: "118.00", glosas: ["ZAPATILLA URBANA T42"] }),
    });
    expect(codigosGp(prev(sinClave))).toEqual([]);
  });

  it("un texto que no es fecha válida se omite (sin S4) y no lanza", () => {
    for (const f of ["2026-02-30", "14/03/2026", "", "2026-03-14T00:00:00"]) {
      expect(() => prev(filaCon(f))).not.toThrow();
      expect(codigosGp(prev(filaCon(f)))).toEqual([]);
    }
  });

  it("una fecha que no es texto es forma inválida", () => {
    for (const f of [null, 20260314, new Date("2026-03-14"), ["2026-03-14"]]) {
      expect(() => prev(filaCon(f))).toThrow(EntradaPrevalidacionInvalidaError);
    }
  });

  it("otras claves extra del XML siguen siendo forma inválida", () => {
    const f = filaReemplazo(undefined, { xml: { ...xmlDe(), fecha: "2026-03-14" } as never });
    expect(() => prev(f)).toThrow(EntradaPrevalidacionInvalidaError);
  });
});
