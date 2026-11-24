import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilaCompraVista } from "@contapp/shared";
import { reiniciarSesion } from "../../lib/sesion";
import { anchosFijosMayoresA390 } from "../../pruebas/aprendizaje";
import { C_1040_ISC, C_5070_ZAPATILLAS, filaDe, instalarFetchCompras } from "../../pruebas/compras";
import {
  HALLAZGO_GASTO_VIEJO,
  MENSAJES_GASTOS as M,
  SENALES_CA1,
  SENALES_S4_S5_S6,
  SENALES_S7,
  hallazgoGastoDe,
} from "../../pruebas/gastos";
import { GrillaCompras } from "../compras/grilla-compras";
import { ChipGasto } from "./chip-gasto";
import { Senales } from "./senales";

// Spec 027 · T7 (rojo; CA-1, D-1, R-3, R-5). Señales del puntaje y chip «Posible gasto no deducible».
// Contrato (T13):
//   - `components/gastos/senales.tsx`: <Senales puntaje={n} senales={Senal[]} /> → lista (role list, nombre M.listaSenales) con una
//     fila (listitem) por señal, EN EL ORDEN RECIBIDO, con el texto fijo de M.senales[código] (S1 con la palabra y «n de m ítems»;
//     S3 con el código de la categoría) y sus puntos (M.puntos: «+3», «-4»), más el total M.puntajeTotal(puntaje) fuera de la lista.
//     Solo texto fijo: nunca glosas, montos, RUC ni razón social (R-5). Sin señales: no pinta la lista.
//   - `components/gastos/chip-gasto.tsx`: <ChipGasto hallazgos={HallazgoVista[]} /> → una insignia con M.chip(puntaje) si hay un
//     hallazgo R-GP con puntaje; M.chipSinPuntaje si el R-GP es de la forma vieja de 011 (sin puntaje); nada si no hay R-GP.
//   - `GrillaCompras` pinta ese chip en la celda del comprobante de la fila con R-GP (junto a la insignia de alertas, que no cambia).

beforeEach(() => reiniciarSesion());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Hallazgos = FilaCompraVista["hallazgos"];
const hallazgos = (...h: unknown[]) => h as unknown as Hallazgos;
const gp = (puntaje = 8, senales = SENALES_CA1) => hallazgoGastoDe(puntaje, senales);

describe("<Senales /> (D-1, R-3)", () => {
  it("feliz CA-1: S1 «zapatilla (1 de 1 ítems)», S2 y S3 «calzado-ropa» con sus puntos y el puntaje 8", () => {
    render(<Senales puntaje={8} senales={[...SENALES_CA1]} />);

    const lista = screen.getByRole("list", { name: M.listaSenales });
    const filas = within(lista).getAllByRole("listitem");
    expect(filas).toHaveLength(3);
    expect(filas[0]!.textContent).toContain(M.senales.S1("zapatilla", 1, 1));
    expect(filas[0]!.textContent).toContain(M.puntos(3));
    expect(filas[1]!.textContent).toContain(M.senales.S2);
    expect(filas[1]!.textContent).toContain(M.puntos(3));
    expect(filas[2]!.textContent).toContain(M.senales.S3("calzado-ropa"));
    expect(filas[2]!.textContent).toContain(M.puntos(2));
    expect(screen.getByText(M.puntajeTotal(8))).toBeTruthy();
    expect(within(lista).queryByText(M.puntajeTotal(8))).toBeNull();
  });

  it("S4, S5 y S6 llevan su texto fijo y sus puntos; mantiene el orden recibido", () => {
    render(<Senales puntaje={6} senales={[...SENALES_S4_S5_S6]} />);

    const filas = screen.getAllByRole("listitem");
    expect(filas.map((f) => f.textContent)).toEqual([
      expect.stringContaining(M.senales.S4),
      expect.stringContaining(M.senales.S5),
      expect.stringContaining(M.senales.S6),
    ]);
    expect(filas[0]!.textContent).toContain("+1");
    expect(filas[2]!.textContent).toContain("+4");
  });

  it("S7 resta: «-4», y «1 de 2 ítems» cuando solo coincide uno de dos", () => {
    render(<Senales puntaje={-1} senales={[...SENALES_S7]} />);

    const filas = screen.getAllByRole("listitem");
    expect(filas[0]!.textContent).toContain(M.senales.S1("zapatilla", 1, 2));
    expect(filas[1]!.textContent).toContain(M.senales.S7);
    expect(filas[1]!.textContent).toContain("-4");
    expect(screen.getByText(M.puntajeTotal(-1))).toBeTruthy();
  });

  it("sin señales no pinta la lista", () => {
    render(<Senales puntaje={0} senales={[]} />);
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("no pinta nada que no sea texto fijo: ningún elemento de más, ni siquiera con una palabra que parece HTML", () => {
    const { container } = render(
      <Senales puntaje={3} senales={[{ codigo: "S1", puntos: 3, palabra: "<img src=x onerror=alert(1)>", categoria: "calzado-ropa", items: { coinciden: 1, total: 1 } }]} />,
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("390 px: sin anchos fijos ni scroll interior", () => {
    const { container } = render(<Senales puntaje={8} senales={[...SENALES_CA1]} />);
    expect(anchosFijosMayoresA390(container)).toEqual([]);
  });
});

describe("<ChipGasto /> (D-1)", () => {
  it("con puntaje: «Posible gasto no deducible · 8 puntos»", () => {
    render(<ChipGasto hallazgos={hallazgos(gp(8))} />);
    expect(screen.getByText(M.chip(8))).toBeTruthy();
  });

  it("el puntaje sale del hallazgo R-GP aunque haya otros hallazgos", () => {
    render(<ChipGasto hallazgos={hallazgos(C_1040_ISC.hallazgos[0], gp(5))} />);
    expect(screen.getByText(M.chip(5))).toBeTruthy();
  });

  it("R-GP de la forma vieja de 011 (sin puntaje): solo «Posible gasto no deducible»", () => {
    render(<ChipGasto hallazgos={hallazgos(HALLAZGO_GASTO_VIEJO)} />);
    expect(screen.getByText(M.chipSinPuntaje)).toBeTruthy();
    expect(screen.queryByText(/puntos/)).toBeNull();
  });

  it("sin R-GP no pinta nada (ni con otros hallazgos)", () => {
    const { container } = render(<ChipGasto hallazgos={hallazgos(C_1040_ISC.hallazgos[0])} />);
    expect(container.textContent).toBe("");
    cleanup();
    const vacio = render(<ChipGasto hallazgos={hallazgos()} />);
    expect(vacio.container.textContent).toBe("");
  });
});

describe("Grilla · chip de gasto no deducible (CA-1)", () => {
  const ANCHO = 1400;
  const ALTO = 480;
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(ANCHO);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(ALTO);
  });
  const filaDeComprobante = (numero: string): HTMLElement =>
    [...document.querySelectorAll<HTMLElement>("[data-fila]")].find((x) => x.textContent?.includes(`F001-${numero}`))!;

  function montar(filas: readonly FilaCompraVista[]) {
    instalarFetchCompras();
    return render(
      <GrillaCompras
        filas={filas}
        cargando={false}
        seleccion={new Set<string>()}
        alCambiarSeleccion={vi.fn()}
        alAbrirHistorial={vi.fn()}
        renderAcciones={() => null}
      />,
    );
  }

  it("la fila con R-GP muestra el chip con su puntaje y las demás filas no", () => {
    const zapatilla = filaDe({ ...C_5070_ZAPATILLAS, hallazgos: hallazgos(gp(8)) });
    montar([zapatilla, C_1040_ISC]);

    expect(within(filaDeComprobante("5070")).getByText(M.chip(8))).toBeTruthy();
    expect(within(filaDeComprobante("1040")).queryByText(/Posible gasto no deducible/)).toBeNull();
  });

  it("una fila con el R-GP viejo de 011 muestra el chip sin puntaje (los hallazgos guardados se siguen leyendo)", () => {
    montar([C_5070_ZAPATILLAS]);
    expect(within(filaDeComprobante("5070")).getByText(M.chipSinPuntaje)).toBeTruthy();
  });
});
