// Selectores del buzón SOL (spec 023, T22; CA-2, CA-4, CA-6, CA-8). Los textos salen de `apps/frontend/lib/buzon.ts`.
// Cambia solo añadiendo.
import type { Locator, Page } from "@playwright/test";

/** El botón «Revisar buzón ahora» de la ficha del cliente. */
export const revisarAhora = (page: Page): Locator =>
  page.getByRole("button", { name: "Revisar buzón ahora" });

/** Enlace de la ficha a la vista mínima de mensajes. */
export const enlaceBuzon = (page: Page): Locator =>
  page.getByRole("link", { name: "Buzón SOL" });

/** «Revisión encolada.» o «Ya hay una revisión en curso.» (`role="status"`). */
export const avisoRevision = (page: Page): Locator =>
  page
    .getByRole("status")
    .filter({ hasText: /Revisión encolada\.|Ya hay una revisión en curso\./ });

/** Una fila del panel de trabajos por nombre del tipo y estado. */
export const filaTrabajo = (
  page: Page,
  tipo: string,
  estado: string,
): Locator =>
  page.getByRole("row").filter({ hasText: tipo }).filter({ hasText: estado });

/** La tabla de mensajes de la vista mínima y una fila por asunto. */
export const tablaMensajes = (page: Page): Locator =>
  page.getByRole("table", { name: "Mensajes del buzón SOL" });

export const filaMensaje = (page: Page, asunto: string | RegExp): Locator =>
  tablaMensajes(page).getByRole("row").filter({ hasText: asunto });

/** El botón «Abrir en SUNAT» del detalle y su diálogo de confirmación. */
export const abrirEnSunat = (page: Page): Locator =>
  page.getByRole("button", { name: "Abrir en SUNAT" });

export const dialogoAbrir = (page: Page): Locator =>
  page.getByRole("dialog", { name: "¿Abrir este mensaje en SUNAT?" });

/** La tarjeta de adjuntos del detalle y el enlace de descarga de uno por nombre. */
export const adjuntos = (page: Page): Locator =>
  page.getByLabel("Adjuntos", { exact: true });

export const enlaceAdjunto = (page: Page, nombre: string): Locator =>
  adjuntos(page).getByRole("link", { name: nombre, exact: true });
