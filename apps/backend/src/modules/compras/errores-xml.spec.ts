// Spec 016 (T13): el error de las rutas con XML y su respuesta por el filtro global.
import type { ArgumentsHost } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { errorXmlSchema } from "@contapp/shared";
import { FiltroErrores } from "../../comun/filtro-errores.js";
import { XmlError } from "./errores-xml.js";

function responder(e: unknown): { estado: number; cuerpo: unknown } {
  let salida: { estado: number; cuerpo: unknown } = { estado: 0, cuerpo: null };
  const res = {
    status: (estado: number) => ({
      json: (cuerpo: unknown) => {
        salida = { estado, cuerpo };
      },
    }),
  };
  new FiltroErrores(() => undefined).catch(e, { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost);
  return salida;
}

describe("XmlError", () => {
  it("xml_existente es 409 y solo lleva el código", () => {
    const r = responder(new XmlError("xml_existente"));
    expect(r).toEqual({ estado: 409, cuerpo: { codigo: "xml_existente" } });
    expect(errorXmlSchema.safeParse(r.cuerpo).success).toBe(true);
  });

  it("xml_ajeno es 422 con los campos que difieren; xml_invalido y xml_incompleto, 422 sin más", () => {
    const ajeno = responder(new XmlError("xml_ajeno", ["ruc", "serie"]));
    expect(ajeno).toEqual({ estado: 422, cuerpo: { codigo: "xml_ajeno", campos: ["ruc", "serie"] } });
    expect(errorXmlSchema.safeParse(ajeno.cuerpo).success).toBe(true);
    expect(responder(new XmlError("xml_invalido"))).toEqual({ estado: 422, cuerpo: { codigo: "xml_invalido" } });
    expect(responder(new XmlError("xml_incompleto"))).toEqual({ estado: 422, cuerpo: { codigo: "xml_incompleto" } });
  });
});
