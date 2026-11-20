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

// ---- Bandeja de buzones (spec 024, T14; CA-3, CA-4, CA-8, CA-12). Los textos salen de `MENSAJES_BANDEJA`.

/** La entrada «Buzones» del menú principal (barra inferior en celular, menú lateral desde 1024 px). */
export const entradaBuzones = (page: Page): Locator =>
  page.getByRole("navigation").getByRole("link", { name: "Buzones" });

/** Los chips de la bandeja («Pendientes» y «Críticos pendientes»); `aria-pressed` dice cuál está activo. */
export const chipPendientes = (page: Page): Locator =>
  page.getByRole("button", { name: "Pendientes", exact: true });

export const chipCriticosPendientes = (page: Page): Locator =>
  page.getByRole("button", { name: "Críticos pendientes", exact: true });

/** El enlace del asunto de un mensaje en la lista de la bandeja. */
export const enlaceMensaje = (page: Page, asunto: string | RegExp): Locator =>
  tablaMensajes(page).getByRole("link", { name: asunto });

/** El bloque «Atención del mensaje» del detalle y sus partes. */
export const atencion = (page: Page): Locator =>
  page.getByRole("region", { name: "Atención del mensaje" });

export const campoComentario = (page: Page): Locator =>
  atencion(page).getByLabel("Comentario", { exact: true });

export const botonMarcar = (page: Page): Locator =>
  atencion(page).getByRole("button", { name: "Marcar como atendido" });

export const botonDeshacer = (page: Page): Locator =>
  atencion(page).getByRole("button", { name: "Deshacer", exact: true });

export const historialAtencion = (page: Page): Locator =>
  atencion(page).getByRole("list", { name: "Historial de atención" });

/** El botón «Filtros» (solo a 390 px) y su diálogo. */
export const botonFiltros = (page: Page): Locator =>
  page.getByRole("button", { name: "Filtros", exact: true });

export const dialogoFiltros = (page: Page): Locator =>
  page.getByRole("dialog", { name: "Filtros del buzón" });

/** El indicador del listado de clientes: el enlace de la fila con «N nuevos» y, aparte, «M críticos». */
export const indicadorCliente = (fila: Locator): Locator =>
  fila.getByRole("link", { name: /nuev[oa]s?|crític/i });

/** Los textos del indicador (singular y plural como `MENSAJES_BANDEJA`). */
export const textoNuevos = (n: number): string =>
  n === 1 ? "1 nuevo" : `${n} nuevos`;
export const textoCriticos = (n: number): string =>
  n === 1 ? "1 crítico" : `${n} críticos`;
