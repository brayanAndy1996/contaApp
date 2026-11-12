// Selectores de las pantallas de clientes (spec 018, T5): listado, alta, importación y credenciales.
// Todo por rol o etiqueta de `apps/frontend`; aquí solo se agrupan para que los flujos no repitan literales.
import type { Locator, Page } from "@playwright/test";

/** La fila del listado de clientes que contiene el texto (RUC o razón social). */
export const filaCliente = (page: Page, texto: string | RegExp): Locator =>
  page.getByRole("row").filter({ hasText: texto });

/** La región «Credenciales» de la ficha del cliente. */
export const credenciales = (page: Page): Locator =>
  page.getByRole("region", { name: "Credenciales" });

export const grupoSol = (page: Page): Locator =>
  credenciales(page).getByRole("group", { name: "Credencial SOL" });

export const grupoSire = (page: Page): Locator =>
  credenciales(page).getByRole("group", { name: "Credencial SIRE" });

/** El campo de un grupo de credencial (por su etiqueta exacta). */
export const campo = (grupo: Locator, etiqueta: string): Locator =>
  grupo.getByLabel(etiqueta, { exact: true });

/** El archivo de la importación de clientes. */
export const archivoImportacion = (page: Page): Locator =>
  page.getByLabel("Archivo (.xlsx o .csv)");

export const vistaPrevia = (page: Page): Locator =>
  page.getByRole("region", { name: "Vista previa" });

export const resultadoImportacion = (page: Page): Locator =>
  page.getByRole("region", { name: "Resultado" });
