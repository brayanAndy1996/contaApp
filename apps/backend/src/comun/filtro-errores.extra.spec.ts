import type { ArgumentsHost } from "@nestjs/common";
import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { FiltroErrores } from "./filtro-errores.js";

// Ramas del filtro que filtro-errores.spec.ts no ejercita: errores del analizador de cuerpo.
function ejecutar(excepcion: unknown) {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res }),
  } as unknown as ArgumentsHost;
  new FiltroErrores(() => {}).catch(excepcion, host);
  return {
    estado: res.status.mock.calls[0]?.[0] as number,
    cuerpo: res.json.mock.calls[0]?.[0] as unknown,
  };
}

describe("errores del analizador de cuerpo (body-parser)", () => {
  it("JSON mal formado (status 400) -> 400 solicitud_invalida sin eco", () => {
    const e = Object.assign(new SyntaxError("Unexpected token CANARIO"), {
      status: 400,
      type: "entity.parse.failed",
    });
    expect(ejecutar(e)).toEqual({
      estado: 400,
      cuerpo: { codigo: "solicitud_invalida" },
    });
  });

  it("cuerpo demasiado grande (status 413) -> 413 solicitud_demasiado_grande", () => {
    const e = Object.assign(new Error("request entity too large"), {
      status: 413,
      type: "entity.too.large",
    });
    expect(ejecutar(e)).toEqual({
      estado: 413,
      cuerpo: { codigo: "solicitud_demasiado_grande" },
    });
  });

  // T16 (H-r1b-3): charset o Content-Encoding no soportados -> 415 con código, no 500.
  it.each([
    ["charset.unsupported", 'unsupported charset "CANARIO"'],
    ["encoding.unsupported", 'unsupported content encoding "CANARIO"'],
  ])("%s (status 415) -> 415 solicitud_invalida sin eco", (type, mensaje) => {
    const e = Object.assign(new Error(mensaje), { status: 415, type });
    const r = ejecutar(e);
    expect(r).toEqual({ estado: 415, cuerpo: { codigo: "solicitud_invalida" } });
    expect(JSON.stringify(r)).not.toContain("CANARIO");
  });

  it("un error con otro status (p. ej. 500 del analizador) sigue como 500 error_interno", () => {
    const e = Object.assign(new Error("stream error"), { status: 500, type: "stream.not.readable" });
    expect(ejecutar(e)).toEqual({ estado: 500, cuerpo: { codigo: "error_interno" } });
  });
});

describe("HttpException sin código conocido por estado", () => {
  it("un estado no mapeado da el código genérico `error`", () => {
    expect(ejecutar(new HttpException("x", 418))).toEqual({
      estado: 418,
      cuerpo: { codigo: "error" },
    });
  });

  it("contrasena_invalida con motivo desconocido descarta el motivo", () => {
    expect(
      ejecutar(
        new HttpException(
          { codigo: "contrasena_invalida", motivo: "otro" },
          400,
        ),
      ),
    ).toEqual({
      estado: 400,
      cuerpo: { codigo: "contrasena_invalida" },
    });
  });
});
