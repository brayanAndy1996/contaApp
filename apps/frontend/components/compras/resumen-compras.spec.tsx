import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  C_4062_USD,
  FILAS_014,
  MENSAJES_COMPRAS as M,
  montosDe,
  resumenDe,
} from "../../pruebas/compras";
import { ResumenCompras, diferenciaConTexto } from "./resumen-compras";

// Resumen por casillero (spec 015, T3; D-12; CA-15): original / vigente / diferencia con signo y texto, partición
// «con IGV» / «sin IGV», rótulo «periodo entero» y aviso de USD sin convertir. Todo cadenas del servidor.

afterEach(cleanup);

const fila = (nombre: string): HTMLElement => {
  const f = screen
    .getAllByRole("row")
    .find((r) => within(r).queryByRole("rowheader", { name: nombre }));
  if (!f) throw new Error(`no hay fila ${nombre}`);
  return f;
};

describe("ResumenCompras (spec 015 T3, D-12, CA-15)", () => {
  it("feliz: casilleros con miles, diferencia con signo y texto, partición y rótulo de periodo entero", () => {
    const base = resumenDe(FILAS_014.filter((f) => f.id !== C_4062_USD.id));
    const resumen = {
      ...base,
      casilleros: {
        original: montosDe({ biDg: "1234.50", igvDg: "222.21" }),
        vigente: montosDe({ biDg: "1230.50", igvDg: "225.00", isc: "770.00" }),
        diferencia: {
          ...montosDe(),
          biDg: "-4.00",
          igvDg: "2.79",
          isc: "770.00",
        },
      },
    };
    render(<ResumenCompras resumen={resumen} />);

    expect(screen.getByRole("heading", { name: M.tituloResumen })).toBeTruthy();
    expect(screen.getByText(M.periodoEntero)).toBeTruthy();

    const baseDg = fila(M.casilleros.biDg);
    const celdas = within(baseDg).getAllByRole("cell").map((c) => c.textContent);
    expect(celdas).toEqual(["1,234.50", "1,230.50", "-4.00 (disminuye)"]);
    expect(within(fila(M.casilleros.igvDg)).getAllByRole("cell")[2]!.textContent).toBe(
      "+2.79 (aumenta)",
    );
    // Sin cambio: dice el texto, no solo el cero.
    expect(within(fila(M.casilleros.noGravado)).getAllByRole("cell")[2]!.textContent).toBe(
      "0.00 (sin cambio)",
    );

    // Partición con IGV / sin IGV con sus cantidades.
    expect(
      screen.getByRole("columnheader", { name: M.filasConIgv(resumen.conIgv.n) }),
    ).toBeTruthy();
    expect(
      screen.getByRole("columnheader", { name: M.filasSinIgv(resumen.sinIgv.n) }),
    ).toBeTruthy();
    expect(screen.queryByText(/no se incluyen en el resumen/)).toBeNull();
  });

  it("USD sin tipo de cambio: avisa cuántas compras no entran en el resumen", () => {
    const resumen = resumenDe(FILAS_014, { filasSinConvertir: [C_4062_USD.id] });
    render(<ResumenCompras resumen={resumen} />);
    const aviso = screen.getByRole("status");
    expect(aviso.textContent).toBe(M.avisoSinConvertir(1));
  });

  it("el rótulo de alcance dice «Periodo entero» una sola vez (T11: salía «Periodo entero. Periodo entero: …»)", () => {
    render(<ResumenCompras resumen={resumenDe(FILAS_014)} />);
    const parrafo = screen.getByText(M.periodoEntero).closest("p")!;
    expect(parrafo.textContent!.match(/periodo entero/gi)).toHaveLength(1);
    expect(parrafo.textContent).toBe("Periodo entero: no cambia con los filtros de la grilla.");
  });

  it("una sola compra en USD sin tipo de cambio se dice «1 compra», no «1 compras»", () => {
    const resumen = resumenDe(FILAS_014, { filasSinConvertir: [C_4062_USD.id] });
    render(<ResumenCompras resumen={resumen} />);
    expect(screen.getByRole("status").textContent).toMatch(/^1 compra en USD /);
  });

  it("cargando (sin resumen) solo muestra el título y el rótulo, sin cifras", () => {
    render(<ResumenCompras resumen={null} />);
    expect(screen.getByRole("heading", { name: M.tituloResumen })).toBeTruthy();
    expect(screen.queryAllByRole("row")).toHaveLength(0);
  });

  it.each([
    ["0.00", "0.00 (sin cambio)"],
    ["-0.00", "0.00 (sin cambio)"],
    ["12.30", "+12.30 (aumenta)"],
    ["-1234567.89", "-1,234,567.89 (disminuye)"],
  ])("diferenciaConTexto(%s)", (entrada, esperado) => {
    expect(diferenciaConTexto(entrada)).toBe(esperado);
  });
});
