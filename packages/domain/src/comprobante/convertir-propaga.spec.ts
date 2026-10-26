// convertirAPen solo traduce MontoFueraDeRangoError del cuadre a "no cuadra"; cualquier
// otro error de verificarCuadre se propaga (revisión final T16 de la spec 010).
import { describe, expect, it, vi } from "vitest";
import { TipoCambio } from "../dinero/index";
import { convertirAPen } from "./convertir";
import { MontosComprobante } from "./montos-comprobante";

class ErrorInesperado extends Error {}

vi.mock("../dinero/index", async (importOriginal) => {
  const real = await importOriginal<typeof import("../dinero/index")>();
  return {
    ...real,
    verificarCuadre: () => {
      throw new ErrorInesperado("fallo ajeno al rango");
    },
  };
});

describe("convertirAPen: errores del cuadre que no son de rango", () => {
  it("propaga el error original en lugar de reportarlo como descuadre", () => {
    const usd = MontosComprobante.desde("USD", { biDg: "100.00", igvDg: "18.00", total: "118.00" });
    expect(() => convertirAPen(usd, TipoCambio.desde("3.300"))).toThrow(ErrorInesperado);
  });
});
