import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import * as errores from "./errores.js";

// Spec 041, plan «P-3 · Registro presentado»: `ErrorPortalSire` gana el detalle `solicitud_rechazada` y `codigosSunat`
// (`readonly string[]`, solo códigos `^\d{1,6}$`, tope 5, nunca el `msg` de SUNAT). Se asume el constructor
// `new ErrorPortalSire(detalle, codigosSunat?)`: los códigos se filtran al construir. Mensaje fijo por clase.
type ErrorPortalSireConCodigos = Error & { detalle: string; codigosSunat: readonly string[]; codigo: string };
const ErrorPortalSireX = errores.ErrorPortalSire as unknown as new (detalle: string, codigosSunat?: readonly string[]) => ErrorPortalSireConCodigos;

describe("ErrorPortalSire solicitud_rechazada: mensaje fijo y codigosSunat filtrados", () => {
  it("lleva el detalle, los códigos y es un ErrorPortal con el mismo mensaje fijo que los demás detalles", () => {
    const e = new ErrorPortalSireX("solicitud_rechazada", ["1061", "1026"]);
    expect(e).toBeInstanceOf(errores.ErrorPortalSire);
    expect(e).toBeInstanceOf(errores.ErrorPortal);
    expect(e.detalle).toBe("solicitud_rechazada");
    expect(e.codigosSunat).toEqual(["1061", "1026"]);
    expect(e.codigo).toBe("portal_cambio");
    expect(e.message).toBe(new ErrorPortalSireX("encabezado").message);
    expect(e.message).not.toContain("1061");
    expect(errores.clasificarError(e).clase).toBe("portal");
  });

  it("filtra a ^\\d{1,6}$ y corta en 5 (después de filtrar, en orden)", () => {
    const e = new ErrorPortalSireX("solicitud_rechazada", ["1061", "12a", "1234567", "-1", " 1070", "1026\n", "", "9", "8", "7", "6", "5"]);
    expect(e.codigosSunat).toEqual(["1061", "9", "8", "7", "6"]);
  });

  it("sin códigos o con un valor que no es texto queda vacío; los demás detalles no llevan códigos", () => {
    expect(new ErrorPortalSireX("solicitud_rechazada").codigosSunat).toEqual([]);
    expect(new ErrorPortalSireX("solicitud_rechazada", [1061 as unknown as string, null as unknown as string, "1026"]).codigosSunat).toEqual(["1026"]);
    for (const detalle of ["encabezado", "zip_invalido", "respuesta_inesperada"]) {
      expect(new ErrorPortalSireX(detalle).codigosSunat).toEqual([]);
    }
  });

  it("no publica el msg de SUNAT: ni en message, ni en String, JSON, stack o inspect (solo viajan códigos numéricos)", () => {
    const msg = "CANARIO-MSG-SUNAT El campo 'codMoneda' es nulo o vacio";
    const e = new ErrorPortalSireX("solicitud_rechazada", [msg, "1061"]);
    expect(e.codigosSunat).toEqual(["1061"]);
    for (const visto of [e.message, String(e), JSON.stringify(e), String(e.stack), inspect(e, { depth: 8, showHidden: true })]) {
      expect(visto).not.toContain("CANARIO-MSG-SUNAT");
      expect(visto).not.toContain("codMoneda");
    }
    expect((e as { cause?: unknown }).cause).toBeUndefined();
  });

  it("los códigos del error no se pueden alterar desde fuera (copia, no la lista recibida)", () => {
    const entrada = ["1061", "1026"];
    const e = new ErrorPortalSireX("solicitud_rechazada", entrada);
    entrada.push("9999");
    expect(e.codigosSunat).toEqual(["1061", "1026"]);
  });
});
