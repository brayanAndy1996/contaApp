import { describe, expect, expectTypeOf, it } from "vitest";
import type { VentaDto } from "./esquemas.js";

// Spec 013 (T22b, D26; decisión del usuario 2026-11-07 a Q-1, opción (a)): `VentaDto` lleva `cuadra: boolean`, que el
// backend calcula al leer con el dominio (sin migración ni columna). `VentaDto` es solo un tipo: la prueba es de tipos
// y queda en rojo en `pnpm --filter @contapp/shared typecheck` (y en `vitest --typecheck`) hasta que se agregue el campo.
describe("VentaDto.cuadra (T22b, D26)", () => {
  it("`cuadra` es un booleano obligatorio de la venta", () => {
    expectTypeOf<VentaDto>().toHaveProperty("cuadra");
    expectTypeOf<VentaDto["cuadra"]>().toEqualTypeOf<boolean>();
  });

  it("una venta literal con `cuadra` compila como VentaDto", () => {
    const v: VentaDto = {
      id: "01920000-0000-7000-8000-0000000000a1",
      origen: "sire",
      tipo: "01",
      serie: "F001",
      numero: "1",
      fechaEmision: "2026-10-05",
      tipoDocContraparte: "6",
      docContraparte: "20100000001",
      moneda: "PEN",
      tipoCambio: null,
      baseGravada: "100.00",
      igv: "18.00",
      exonerada: "0.00",
      inafecta: "0.00",
      isc: "0.00",
      icbper: "0.00",
      otros: "0.00",
      total: "118.00",
      cuadra: true,
      exclusion: null,
    };
    expect(v.cuadra).toBe(true);
  });
});
