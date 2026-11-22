// Selectores de la prorrata y el IGV estimado (spec 026, T21; CA-1, CA-4 a CA-6, CA-12). Los textos salen de
// `MENSAJES_PRORRATA` en `apps/frontend/lib/prorrata.ts`. Cambia solo añadiendo.
import type { Locator, Page } from "@playwright/test";

/** Pantalla de prorrata de un cliente. */
export const rutaProrrata = (clienteId: string): string =>
  `/clientes/${clienteId}/prorrata`;

/** Ruta de la API de prorrata de un cliente (lectura con `?periodo=AAAAMM`). */
export const apiProrrata = (clienteId: string): string =>
  `/clientes/${clienteId}/prorrata`;

/** El selector «Mes de cálculo» (ofrece el mes en curso y los 23 anteriores). */
export const selectorMes = (page: Page): Locator =>
  page.getByLabel("Mes de cálculo");

/** El botón «Obtener declaraciones» (solo con `prorrata.gestionar`). */
export const botonObtener = (page: Page): Locator =>
  page.getByRole("button", { name: "Obtener declaraciones", exact: true });

/** La tabla de los 12 meses de la ventana. */
export const tablaMeses = (page: Page): Locator =>
  page.getByRole("table", { name: "Meses de la ventana de prorrata" });

/** La fila de un mes («202606»); el id de la fila es `mes-AAAAMM`. */
export const filaMes = (page: Page, periodo: string): Locator =>
  tablaMeses(page).locator(`#mes-${periodo}`);

/** El botón «Ingresar a mano» de un mes («202510»). */
export const ingresarAMano = (page: Page, periodo: string): Locator =>
  page.getByRole("button", {
    name: `Ingresar a mano ${periodo.slice(0, 4)}-${periodo.slice(4)}`,
  });

/** Las tarjetas de la pantalla. */
export const tarjetaCoeficiente = (page: Page): Locator =>
  page.getByRole("region", { name: "Coeficiente de prorrata" });

export const tarjetaIgv = (page: Page): Locator =>
  page.getByRole("region", { name: "IGV estimado del mes" });

export const tarjetaUsada = (page: Page): Locator =>
  page.getByRole("region", { name: "Prorrata usada en la declaración" });

/** El diálogo de «Ingresar mes AAAA-MM a mano». */
export const dialogoManual = (page: Page, periodo: string): Locator =>
  page.getByRole("dialog", {
    name: `Ingresar mes ${periodo.slice(0, 4)}-${periodo.slice(4)} a mano`,
  });

/** Un componente del IGV estimado: la línea de la lista de definiciones por su etiqueta; el valor es el `dd` hermano. */
export const valorIgv = (page: Page, etiqueta: string): Locator =>
  tarjetaIgv(page)
    .locator("dt", {
      hasText: new RegExp(
        `^${etiqueta.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      ),
    })
    .locator("xpath=following-sibling::dd[1]");

/** `scrollWidth <= innerWidth` del documento: la página no se desplaza en horizontal. */
export const sinDesplazamientoHorizontal = (page: Page): Promise<boolean> =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
