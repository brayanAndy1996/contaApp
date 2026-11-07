// Spec 013 T18 · H-013-6 (rojo hasta T19): la descarga guarda la serie en mayúsculas, como la importación y el agregar
// (D7 y D17: una sola serie para la correlatividad). Si el SIRE trae «b001», `datos.serie` (lo que se inserta en `venta.serie`)
// es «B001»; la clave ya era «03|B001|290». Sin BD: la inserción real la cubre `descargar-propuesta.adv.int.spec.ts` (adv-w2).
import { describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (importarOriginal) => ({
  ...(await importarOriginal<typeof import("@contapp/db")>()),
  leerExistentes: vi.fn(),
  insertarVentas: vi.fn(async () => undefined),
}));

import { ErrorPropuesta } from "./errores.js";
import { persistidorVentas } from "./ventas.js";

const cruda = (extra: Record<string, unknown> = {}) => ({
  tipo: "03",
  serie: "B001",
  numero: "290",
  docContraparte: "-",
  fechaEmision: "2026-10-03",
  moneda: "PEN",
  baseGravada: "100.00",
  igv: "18.00",
  exonerada: "0.00",
  inafecta: "0.00",
  isc: "0.00",
  icbper: "0.00",
  otros: "0.00",
  total: "118.00",
  ...extra,
});
const preparar = (extra: Record<string, unknown>) => persistidorVentas.preparar([cruda(extra)])[0]!;

describe("H-013-6 · la serie de la descarga se guarda en mayúsculas", () => {
  it.each([
    ["b001", "B001"],
    ["b0a1", "B0A1"],
    ["f001", "F001"],
    ["Ab9z", "AB9Z"],
  ])("«%s» se inserta como «%s» y la clave lleva la misma serie", (llega, queda) => {
    const f = preparar({ serie: llega });
    expect(f.serie).toBe(queda);
    expect(f.datos).toMatchObject({ serie: queda });
    expect(f.clave).toBe(`03|${queda}|290`);
  });

  it("caso feliz: una serie ya en mayúsculas no cambia, y lo demás de la fila tampoco", () => {
    const f = preparar({ serie: "B001", numero: "00290" });
    expect(f.datos).toMatchObject({ serie: "B001", numero: "00290", tipo: "03", total: "118.00" });
    expect(f.clave).toBe("03|B001|290");
    expect(f.campos).toMatchObject({ total: "118.00", fechaEmision: "2026-10-03" });
  });

  it("«b001» y «B001» del mismo número son el mismo comprobante: misma clave y misma serie guardada", () => {
    const [a, b] = persistidorVentas.preparar([cruda({ serie: "b001" }), cruda({ serie: "B001" })]);
    expect(a!.clave).toBe(b!.clave);
    expect(a!.datos).toMatchObject({ serie: (b!.datos as { serie: string }).serie });
  });

  it("error: una serie inválida sigue siendo fila_invalida (sin eco), también con minúsculas", () => {
    for (const serie of ["b01", "b0011", "b 01", "ñ001"]) {
      const e = (() => {
        try {
          preparar({ serie });
        } catch (x) {
          return x;
        }
        return null;
      })();
      expect(e, serie).toBeInstanceOf(ErrorPropuesta);
      expect(e, serie).toMatchObject({ detalle: "fila_invalida" });
    }
  });
});
