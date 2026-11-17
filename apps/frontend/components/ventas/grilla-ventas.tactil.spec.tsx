import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VentaDto } from "@contapp/shared";
import { GrillaVentas } from "./grilla-ventas";

// Spec 038 T18 (5): «Quitar», «Excluir» y «Restaurar» miden 28 px en una fila de 36 px (P-2). Bajo 1024 px un
// pseudo-elemento les da 44 px de área táctil sin cambiar su tamaño visual ni el alto de la fila.

const base = {
  tipo: "01",
  serie: "F001",
  numero: "000001",
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
};
const venta = (id: string, extra: Record<string, unknown> = {}) =>
  ({ ...base, id, origen: "sire", exclusion: null, ...extra }) as unknown as VentaDto;

afterEach(cleanup);

describe("GrillaVentas · área táctil de los botones de fila", () => {
  it("Quitar, Excluir y Restaurar llevan el pseudo-elemento táctil bajo 1024 px y la fila sigue en 36 px", () => {
    render(
      <GrillaVentas
        filas={[
          venta("v1", { origen: "manual" }),
          venta("v2", { numero: "000002", exclusion: { motivo: "duplicado" } }),
        ]}
        alQuitar={vi.fn()}
        alExcluir={vi.fn()}
        alRestaurar={vi.fn()}
      />,
    );
    const botones = [
      screen.getByRole("button", { name: "Quitar" }),
      screen.getByRole("button", { name: /^Excluir / }),
      screen.getByRole("button", { name: /^Restaurar / }),
    ];
    for (const b of botones) {
      expect(b.className).toContain("max-lg:before:-inset-y-2");
      expect(b.className).toContain("max-lg:before:absolute");
      expect(b.className).toContain("relative");
      expect(b.className).toContain("h-7");
    }
    expect(botones[0]!.closest("tr")!.style.height).toBe("36px");
  });

  it("el pseudo-elemento táctil llega a 44 px: el borde de 1 px no lo deja en 42 (038 T-final-g)", () => {
    render(<GrillaVentas filas={[venta("v1", { origen: "manual" })]} alQuitar={vi.fn()} />);
    const b = screen.getByRole("button", { name: "Quitar" });
    expect(b.className).toContain("max-lg:before:min-h-11");
    expect(b.className).toContain("max-lg:before:-translate-y-px");
  });
});
