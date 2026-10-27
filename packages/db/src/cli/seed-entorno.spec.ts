import { describe, expect, it } from "vitest";
import { ErrorCli, mensajeSeguro } from "./comun";
import { exigirEntornoNoProduccion } from "./seed";

// H-r2b-3: el seed de desarrollo se niega con NODE_ENV=production (mensaje fijo, sin valores de conexión).
describe("db:seed · entorno", () => {
  it("permite el seed fuera de producción (desarrollo, test o sin NODE_ENV)", () => {
    for (const NODE_ENV of ["development", "test", undefined]) {
      expect(() => exigirEntornoNoProduccion({ NODE_ENV })).not.toThrow();
    }
  });

  it("con NODE_ENV=production (y variantes de escritura, como D11) lanza un ErrorCli con mensaje fijo", () => {
    for (const NODE_ENV of ["production", "Production", " production ", "PRODUCTION\n"]) {
      let error: unknown;
      try {
        exigirEntornoNoProduccion({ NODE_ENV });
      } catch (e) {
        error = e;
      }
      expect(error, JSON.stringify(NODE_ENV)).toBeInstanceOf(ErrorCli);
      expect(mensajeSeguro(error)).toBe("el seed de desarrollo no se ejecuta con NODE_ENV=production");
    }
  });

  it("permite valores parecidos que no son producción (preproduction, prod)", () => {
    for (const NODE_ENV of ["preproduction", "prod", ""]) {
      expect(() => exigirEntornoNoProduccion({ NODE_ENV })).not.toThrow();
    }
  });
});
