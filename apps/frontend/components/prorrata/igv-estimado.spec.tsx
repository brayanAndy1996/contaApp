import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MENSAJES_PRORRATA as M, anchosFijosMayoresA390, igvDe, valorDe } from "../../pruebas/prorrata";
import { IgvEstimado } from "./igv-estimado";

// Spec 026 · T7 (rojo; CA-5, R-7, U-8, D-8). IGV estimado del mes.
// Contrato (T13), `components/prorrata/igv-estimado.tsx`: <IgvEstimado igv={IgvEstimadoVista} />.
//   - Título M.tituloIgv. `calculado`: lista de definiciones (<dl>, cada <dt> seguido de su <dd>) con los componentes
//     M.componentes.{igvVentas, creditoDg, igvDgng, creditoDgng, igvDng} y sus montos tal como llegan; más el resultado:
//     un <dt> con M.situacion[situacion] («A pagar», «Saldo a favor», «Cero») y su <dd> con el monto. El «saldo a favor» se
//     muestra en valor absoluto (sin signo); «cero», «0.00».
//   - Estado del periodo de compras (M.estadoCompras[estado]) y la nota fija M.notaEstimado (U-8), como texto.
//   - `no_estimable`: M.noEstimable[motivo] (qué falta) y ningún monto ni resultado; sin la nota de «Estimado».

afterEach(() => cleanup());

describe("<IgvEstimado /> · calculado (CA-5)", () => {
  it("muestra cada componente con su monto y el resultado «A pagar»", () => {
    render(<IgvEstimado igv={igvDe()} />);
    expect(screen.getByRole("heading", { name: M.tituloIgv })).toBeTruthy();
    expect(valorDe(M.componentes.igvVentas)).toBe("18,000.00");
    expect(valorDe(M.componentes.creditoDg)).toBe("9,000.00");
    expect(valorDe(M.componentes.igvDgng)).toBe("3,600.00");
    expect(valorDe(M.componentes.creditoDgng)).toBe("3,000.00");
    expect(valorDe(M.componentes.igvDng)).toBe("180.00");
    expect(valorDe(M.situacion.a_pagar)).toBe("6,000.00");
  });

  it("saldo a favor: la etiqueta lo dice y el monto va sin signo", () => {
    render(<IgvEstimado igv={igvDe({ igvVentas: "1000.00", creditoDg: "2500.00", creditoDgng: "0.00", resultado: "-1500.00", situacion: "saldo_a_favor" })} />);
    expect(valorDe(M.situacion.saldo_a_favor)).toBe("1,500.00");
    expect(screen.queryByText(M.situacion.a_pagar)).toBeNull();
    expect(document.body.textContent).not.toContain("-1500.00");
  });

  it("cero: «Cero» con 0.00", () => {
    render(<IgvEstimado igv={igvDe({ igvVentas: "500.00", creditoDg: "500.00", creditoDgng: "0.00", resultado: "0.00", situacion: "cero" })} />);
    expect(valorDe(M.situacion.cero)).toBe("0.00");
  });

  it.each(["abierto", "revisado", "generado"] as const)("muestra el estado del periodo de compras: %s", (estado) => {
    render(<IgvEstimado igv={igvDe({ estadoPeriodoCompras: estado })} />);
    expect(screen.getByText(M.estadoCompras[estado])).toBeTruthy();
  });

  it("incluye la nota fija de U-8: no incluye saldo anterior, percepciones ni retenciones", () => {
    render(<IgvEstimado igv={igvDe()} />);
    expect(screen.getByText(M.notaEstimado)).toBeTruthy();
  });

  it("DNG se muestra como informativo: no entra en el resultado ni como crédito", () => {
    render(<IgvEstimado igv={igvDe({ igvDng: "180.00" })} />);
    expect(valorDe(M.componentes.igvDng)).toBe("180.00");
    expect(screen.queryByText(/crédito.*DNG/i)).toBeNull();
  });
});

describe("<IgvEstimado /> · no estimable (R-7)", () => {
  it.each(["coeficiente", "sin_ventas", "sin_compras"] as const)(
    "motivo %s: dice qué falta, sin montos ni resultado",
    (motivo) => {
      render(<IgvEstimado igv={{ estado: "no_estimable", motivo }} />);
      expect(screen.getByText(M.noEstimable[motivo])).toBeTruthy();
      expect(document.querySelector("dl")).toBeNull();
      for (const s of Object.values(M.situacion)) expect(screen.queryByText(s)).toBeNull();
      expect(screen.queryByText(M.notaEstimado)).toBeNull();
      expect(document.body.textContent).not.toMatch(/sin_ventas|sin_compras|no_estimable/);
    },
  );
});

describe("<IgvEstimado /> · 390 px", () => {
  it("sin anchos fijos mayores a la pantalla", () => {
    const { container } = render(<IgvEstimado igv={igvDe()} />);
    expect(anchosFijosMayoresA390(container)).toEqual([]);
  });
});
