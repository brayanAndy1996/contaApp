// Selectores de la campana, la página de notificaciones y la auditoría (spec 018, T5).
import type { Locator, Page } from "@playwright/test";

/** El botón de la campana; su nombre trae el conteo («Notificaciones, 2 sin leer»). */
export const campana = (page: Page): Locator =>
  page.getByRole("button", { name: /^Notificaciones/ });

export const panel = (page: Page): Locator =>
  page.getByRole("dialog", { name: "Panel de notificaciones" });

/** Una notificación de la lista (en el panel o en la página): un botón con su texto. */
export const notificacion = (
  raiz: Locator | Page,
  texto: string | RegExp,
): Locator => raiz.getByRole("button").filter({ hasText: texto });

export const marcarTodas = (raiz: Locator | Page): Locator =>
  raiz.getByRole("button", { name: "Marcar todas como leídas" });

export const tablaAuditoria = (page: Page): Locator =>
  page.getByRole("table", { name: "Registros de auditoría" });

export const filaAuditoria = (page: Page, texto: string | RegExp): Locator =>
  tablaAuditoria(page).getByRole("row").filter({ hasText: texto });
