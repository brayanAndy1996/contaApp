import { describe, expect, it } from "vitest";
import { EntornoInvalidoError } from "../../config/entorno.js";
import { crearCorreo } from "./fabrica.js";

// Spec 028 (T14): un error de la fábrica que no es de configuración no se disfraza de EntornoInvalidoError.
describe("crearCorreo del backend: errores ajenos a la configuración", () => {
  it("se propaga tal cual, sin traducirlo", () => {
    const config = {
      get provider(): never {
        throw new RangeError("falla interna de prueba");
      },
    };
    let capturado: unknown;
    try {
      crearCorreo(config as never);
    } catch (e) {
      capturado = e;
    }
    expect(capturado).toBeInstanceOf(RangeError);
    expect(capturado).not.toBeInstanceOf(EntornoInvalidoError);
  });
});
