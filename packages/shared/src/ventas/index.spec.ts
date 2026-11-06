import { describe, expect, it } from "vitest";
import * as shared from "../index.js";

// Spec 013 (plan: `packages/shared/src/ventas/*`; D14: el frontend solo depende de `@contapp/shared`).
// Los esquemas de ventas salen por la entrada del paquete.
describe("@contapp/shared exporta los esquemas de ventas", () => {
  it.each([
    "filtrosVentasSchema",
    "ventaAgregarSchema",
    "saltoJustificarSchema",
    "vistaPreviaVentasSchema",
    "informeImportacionVentasSchema",
  ])("%s", (nombre) => {
    const esquema = (shared as unknown as Record<string, { safeParse?: unknown } | undefined>)[nombre];
    expect(typeof esquema?.safeParse).toBe("function");
  });

  it("no pisa los esquemas previos (clientes e importación de 007)", () => {
    expect(typeof shared.clienteCrearSchema.safeParse).toBe("function");
    expect(typeof shared.vistaPreviaSchema.safeParse).toBe("function");
    expect(typeof shared.informeImportacionSchema.safeParse).toBe("function");
  });
});
