import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  MENSAJES_COMPRAS as M,
  TEXTO_HOSTIL,
} from "../../pruebas/compras";
import { DiferenciasCompras } from "./diferencias-compras";

// Diferencias de la última descarga (spec 015, T3; D-14; 014 D-18): avisan, no cambian nada.

afterEach(cleanup);

const diferencia = (parcial: Record<string, unknown> = {}) => ({
  clave: "01|F001|3064",
  tipo: "01",
  serie: "F001",
  numero: "3064",
  origenExistente: "sire" as const,
  campos: ["biDg", "total"],
  valoresSire: { biDg: "1234.50", total: "1457.00" },
  ...parcial,
});

describe("DiferenciasCompras (spec 015 T3, D-14)", () => {
  it("feliz: comprobante, origen y valores del SIRE con etiqueta de casillero", () => {
    render(<DiferenciasCompras diferencias={[diferencia()]} />);
    const fila = screen
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("F001-3064"))!;
    expect(within(fila).getByText("SIRE")).toBeTruthy();
    expect(within(fila).getByText(`${M.casilleros.biDg}: 1,234.50`)).toBeTruthy();
    expect(within(fila).getByText(`${M.casilleros.total}: 1,457.00`)).toBeTruthy();
  });

  it("sin diferencias lo dice", () => {
    render(<DiferenciasCompras diferencias={[]} />);
    expect(screen.getByText(M.sinDiferencias)).toBeTruthy();
  });

  it("error: texto hostil del SIRE y campos no monetarios se ven como texto, sin formato de monto", () => {
    render(
      <DiferenciasCompras
        diferencias={[
          diferencia({
            origenExistente: "manual",
            campos: ["documento", "razonSocial", "campo_nuevo"],
            valoresSire: {
              documento: "20100070970",
              razonSocial: TEXTO_HOSTIL,
              campo_nuevo: "x",
            },
          }),
        ]}
      />,
    );
    expect(screen.getByText("Manual")).toBeTruthy();
    // El documento no se formatea como monto.
    expect(
      screen.getByText(`${M.campos.documento}: 20100070970`),
    ).toBeTruthy();
    expect(
      screen.getByText(`${M.campos.razonSocial}: ${TEXTO_HOSTIL}`),
    ).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    // Un campo sin etiqueta se muestra con su nombre.
    expect(screen.getByText("campo_nuevo: x")).toBeTruthy();
  });
});
