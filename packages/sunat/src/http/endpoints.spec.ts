import { describe, expect, it } from "vitest";
import * as endpoints from "./endpoints.js";

// Plan 041, «P-3 · Registro presentado» (T15g, evidencia de la corrida real de 2 RUC): `codMoneda` NO FILTRA en 5.51, así que hay UNA
// solicitud por periodo con `codProceso=70` y `codMoneda=PEN` (obligatorio, sin efecto). `COD_PROCESO_REGISTRO = "70"`,
// `MONEDA_SOLICITUD_REGISTRO = "PEN"`, `COD_SIN_DATOS_REGISTRO = ["1070"]` y `parametrosRegistro(per)` con la moneda fija; ya no
// existe `MONEDAS_REGISTRO`. Se leen por nombre desde el módulo para que la prueba compile mientras `endpoints.ts` aún tiene la
// firma de dos monedas (rojo por «no implementado», no por el compilador).
function exportado<T>(nombre: string): T {
  const v = (endpoints as unknown as Record<string, unknown>)[nombre];
  if (v === undefined) throw new Error(`no implementado: endpoints.${nombre}`);
  return v as T;
}

describe("endpoints · registro presentado (5.51)", () => {
  it("codProceso 70 fijo, moneda de la solicitud PEN y códigos de «sin datos»", () => {
    expect(exportado<unknown>("COD_PROCESO_REGISTRO")).toBe("70");
    expect(exportado<unknown>("MONEDA_SOLICITUD_REGISTRO")).toBe("PEN");
    expect(exportado<unknown>("COD_SIN_DATOS_REGISTRO")).toEqual(["1070"]);
  });

  it("MONEDAS_REGISTRO desaparece: ya no hay una solicitud por moneda", () => {
    expect((endpoints as unknown as Record<string, unknown>)["MONEDAS_REGISTRO"]).toBeUndefined();
  });

  it("parametrosRegistro(per) → codTipoArchivo=0, codProceso=70, codOrigen=2, lisPeriodos=per, codMoneda=PEN (fijo)", () => {
    const parametros = exportado<(per: string, ...resto: unknown[]) => Record<string, string>>("parametrosRegistro");
    expect(parametros("202610")).toEqual({
      codTipoArchivo: "0",
      codProceso: "70",
      codOrigen: "2",
      lisPeriodos: "202610",
      codMoneda: "PEN",
    });
    // Otro periodo cambia solo lisPeriodos.
    expect(parametros("202506")).toEqual({ codTipoArchivo: "0", codProceso: "70", codOrigen: "2", lisPeriodos: "202506", codMoneda: "PEN" });
  });

  it("el nombre del parámetro de origen es codOrigen, no codOrigenEnvio (solo la exportación de la propuesta usa ese)", () => {
    const parametros = exportado<(per: string) => Record<string, string>>("parametrosRegistro");
    expect(Object.keys(parametros("202610"))).not.toContain("codOrigenEnvio");
  });

  it("la ruta 5.51 lleva el periodo (perTributario) y no cambia", () => {
    expect(endpoints.rutaRegistroPresentado("202610")).toBe(
      "/v1/contribuyente/migeigv/libros/rce/ajustesposteriores/web/ajustesposteriores/202610/solicitardescarga",
    );
  });
});
