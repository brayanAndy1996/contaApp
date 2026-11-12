// Selectores de la pantalla de ventas y su panel «Generar archivo» (spec 018, T8). Solo localizadores por rol,
// etiqueta o texto de `apps/frontend/lib/ventas.ts` y `lib/archivos.ts`; el único CSS es el de la comprobación
// de que el motivo canario no se interpretó como HTML.
import type { Locator, Page } from "@playwright/test";

export const rutaVentas = (clienteId: string, periodo: string): string =>
  `/clientes/${clienteId}/ventas?periodo=${periodo}`;

export const botonDescargar = (page: Page): Locator =>
  page.getByRole("region", { name: "Descarga" }).getByRole("button", {
    name: "Descargar",
    exact: true,
  });

export const regionCorrelatividad = (page: Page): Locator =>
  page.getByRole("region", { name: "Correlatividad" });

export const regionResumen = (page: Page): Locator =>
  page.getByRole("region", { name: "Resumen" });

export const grilla = (page: Page): Locator =>
  page.getByRole("table", { name: "Ventas del periodo" });

export const filaDeVenta = (page: Page, comprobante: string): Locator =>
  grilla(page).getByRole("row").filter({ hasText: comprobante });

export const abrirPanel = (page: Page): Locator =>
  page.getByRole("button", { name: "Generar archivo", exact: true });

export const panelGenerar = (page: Page): Locator =>
  page.getByRole("complementary", { name: "Generar archivo" });

export const botonGenerar = (page: Page): Locator =>
  panelGenerar(page).getByRole("button", { name: "Generar", exact: true });

export const dialogoExcluir = (page: Page, comprobante: string): Locator =>
  page.getByRole("alertdialog", { name: `Excluir venta ${comprobante}` });

export const campoMotivo = (dialogo: Locator): Locator =>
  dialogo.getByLabel("Motivo (obligatorio, hasta 200 caracteres)");

export const confirmar = (dialogo: Locator): Locator =>
  dialogo.getByRole("button", { name: "Confirmar" });

/** Un `<img src="x">` en la página: el motivo canario `<img src=x onerror=…>` no debe llegar a ser uno. */
export const imagenInyectada = (page: Page): Locator =>
  page.locator('img[src="x"]');
