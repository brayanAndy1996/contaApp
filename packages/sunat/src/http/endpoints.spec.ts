import { describe, expect, it } from "vitest";
import * as endpoints from "./endpoints.js";

// Plan 041, «P-3 · Registro presentado» (ronda 3): `COD_PROCESO_REGISTRO = "70"`, `MONEDAS_REGISTRO = ["PEN", "USD"]` (en ese orden),
// `COD_SIN_DATOS_REGISTRO = ["1070"]` y `parametrosRegistro(per, moneda)` con la moneda obligatoria. Se leen por nombre desde el módulo
// para que la prueba compile mientras `endpoints.ts` aún tiene la firma 01→02 (rojo por «no implementado», no por el compilador).
function exportado<T>(nombre: string): T {
  const v = (endpoints as unknown as Record<string, unknown>)[nombre];
  if (v === undefined) throw new Error(`no implementado: endpoints.${nombre}`);
  return v as T;
}

describe("endpoints · registro presentado (5.51)", () => {
  it("codProceso 70 fijo, monedas PEN y USD en ese orden y códigos de «sin datos»", () => {
    expect(exportado<unknown>("COD_PROCESO_REGISTRO")).toBe("70");
    expect(exportado<unknown>("MONEDAS_REGISTRO")).toEqual(["PEN", "USD"]);
    expect(exportado<unknown>("COD_SIN_DATOS_REGISTRO")).toEqual(["1070"]);
  });

  it.each(["PEN", "USD"])("parametrosRegistro(per, %s) → codTipoArchivo=0, codProceso=70, codOrigen=2, lisPeriodos=per, codMoneda", (moneda) => {
    const parametros = exportado<(per: string, moneda: string) => Record<string, string>>("parametrosRegistro");
    expect(parametros("202610", moneda)).toEqual({
      codTipoArchivo: "0",
      codProceso: "70",
      codOrigen: "2",
      lisPeriodos: "202610",
      codMoneda: moneda,
    });
  });

  it("el nombre del parámetro de origen es codOrigen, no codOrigenEnvio (solo la exportación de la propuesta usa ese)", () => {
    const parametros = exportado<(per: string, moneda: string) => Record<string, string>>("parametrosRegistro");
    expect(Object.keys(parametros("202610", "PEN"))).not.toContain("codOrigenEnvio");
  });

  it("la ruta 5.51 lleva el periodo (perTributario) y no cambia", () => {
    expect(endpoints.rutaRegistroPresentado("202610")).toBe(
      "/v1/contribuyente/migeigv/libros/rce/ajustesposteriores/web/ajustesposteriores/202610/solicitardescarga",
    );
  });
});
