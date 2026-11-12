// Selectores y ayudantes de la lupa del comprobante (spec 018, E-07). Solo roles y textos de
// `apps/frontend/lib/{compras,lupa-compras}.ts`: la lupa es un diálogo con el título «Comprobante <serie-número>».
import { expect, type Locator, type Page } from "@playwright/test";
import type { Api, TrabajoApi } from "../api.js";

export const rutaCompras = (clienteId: string, periodo: string): string =>
  `/clientes/${clienteId}/compras?periodo=${periodo}`;

/** La fila de la grilla de compras con ese comprobante («F001-2056»). */
export const filaDe = (page: Page, comprobante: string): Locator =>
  page.getByRole("row").filter({ hasText: comprobante });

/** El botón de la columna «Ver comprobante» de esa fila. */
export const botonLupa = (page: Page, comprobante: string): Locator =>
  page.getByRole("button", { name: `Ver comprobante ${comprobante}` });

/** El diálogo de la lupa de ese comprobante. */
export const lupaDe = (page: Page, comprobante: string): Locator =>
  page.getByRole("dialog", { name: `Comprobante ${comprobante}`, exact: true });

/** Cualquier lupa abierta (para ← → que cambian de compra). */
export const lupaAbierta = (page: Page): Locator =>
  page.getByRole("dialog", { name: /^Comprobante / });

export const COLUMNAS = {
  bi: "Base imponible (DG + DGNG + DNG)",
  igv: "IGV",
  noGravado: "No gravado",
  isc: "ISC",
  total: "Total",
} as const;

/** La fila de la comparación SIRE y XML de una columna: celdas 0 = SIRE, 1 = XML, 2 = resultado. */
export const filaComparacion = (
  lupa: Locator,
  columna: (typeof COLUMNAS)[keyof typeof COLUMNAS],
): Locator =>
  lupa
    .getByRole("table", {
      name: "Comparación por columna entre el SIRE y el XML",
    })
    .getByRole("row")
    .filter({
      has: lupa.page().getByRole("rowheader", { name: columna, exact: true }),
    });

/** Afirma SIRE, XML y resultado de una columna de la comparación. */
export async function comprobarComparacion(
  lupa: Locator,
  columna: (typeof COLUMNAS)[keyof typeof COLUMNAS],
  sire: string,
  xml: string,
  resultado: "Coincide" | "Difiere",
): Promise<void> {
  const fila = filaComparacion(lupa, columna);
  const celdas = fila.getByRole("cell");
  await expect(celdas.nth(0)).toHaveText(sire);
  await expect(celdas.nth(1)).toHaveText(xml);
  await expect(celdas.nth(2)).toContainText(resultado);
}

/** Abre la lupa como lo haría el teclado: foco en el botón de la fila y Enter. */
export async function abrirLupaConEnter(
  page: Page,
  comprobante: string,
): Promise<Locator> {
  const boton = botonLupa(page, comprobante);
  await expect(boton).toBeVisible();
  await boton.focus();
  await page.keyboard.press("Enter");
  const lupa = lupaDe(page, comprobante);
  await expect(lupa).toBeVisible();
  return lupa;
}

/**
 * Espera (hasta 30 s) a que terminen los trabajos `xml.obtener` del cliente que dejó la descarga: sin ellos las
 * reglas que dependen del XML (R-MIX, R-ISC exactos) todavía no están en la fila.
 */
export async function esperarXmlDescargados(
  api: Api,
  clienteId: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const lista = await api.exigir<TrabajoApi[]>(
          "GET",
          `/trabajos?clienteId=${clienteId}`,
        );
        const xml = lista.filter((t) => t.tipo === "xml.obtener");
        return (
          xml.length > 0 &&
          xml.every((t) =>
            ["completado", "error", "cancelado"].includes(t.estado),
          )
        );
      },
      {
        message: "Los trabajos xml.obtener no terminaron a tiempo",
        timeout: 30_000,
        intervals: [100, 250, 500, 1_000],
      },
    )
    .toBe(true);
}

/**
 * Abre el menú «Acciones» de una fila desde la lupa. El menú se cierra con cualquier `scroll` de la página y la
 * lupa se desplaza para mostrar el botón: se lleva el botón a la vista y se deja pasar el cuadro en el que el
 * navegador reparte ese `scroll` ANTES de pulsar, como haría una persona que ya lo tiene a la vista.
 */
export async function abrirMenuAcciones(
  lupa: Locator,
  comprobante: string,
): Promise<void> {
  const boton = lupa.getByRole("button", { name: `Acciones ${comprobante}` });
  await boton.scrollIntoViewIfNeeded();
  await lupa.page().evaluate(
    () =>
      new Promise<void>((listo) => {
        requestAnimationFrame(() => requestAnimationFrame(() => listo()));
      }),
  );
  await boton.click();
  await expect(lupa.page().getByRole("menu")).toBeVisible();
}
