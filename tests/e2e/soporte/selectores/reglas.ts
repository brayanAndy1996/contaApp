// Selectores del flujo de reglas aprendidas (spec 021, T22; CA-1 a CA-3). Los controles se buscan por rol y texto
// de `apps/frontend/lib/reglas.ts`; aquí solo viven los que no tienen nombre propio. Cambia solo añadiendo.
import type { Locator, Page } from "@playwright/test";
import { fila } from "./compras.js";

/** El aviso «¿Recordar para este proveedor en este cliente?» (`role="status"`, sin foco, Alt+R lo acepta). */
export const avisoRecordar = (page: Page): Locator =>
  page
    .getByRole("status")
    .filter({ hasText: "¿Recordar para este proveedor en este cliente?" });

/** Su botón «Recordar» (declara `aria-keyshortcuts="Alt+R"`). */
export const botonRecordar = (page: Page): Locator =>
  avisoRecordar(page).getByRole("button", { name: "Recordar", exact: true });

/** La etiqueta «Según historial» de una fila de la grilla. */
export const etiquetaSegunHistorial = (page: Page, comprobante: string): Locator =>
  fila(page, comprobante).getByText("Según historial", { exact: true });

/** El filtro «Según historial» de la barra de filtros. */
export const filtroSegunHistorial = (page: Page): Locator =>
  page.getByRole("checkbox", { name: "Según historial" });

/** Prefijo de la API de reglas del cliente que ve el navegador. */
export const apiReglas = (clienteId: string): string => `/clientes/${clienteId}/reglas`;

// ---------------------------------------------------------------------------------------------
// Aprendizaje de arranque (spec 025, T21; CA-1, CA-3, CA-9, CA-14). Textos de `apps/frontend/lib/aprendizaje.ts`.
// ---------------------------------------------------------------------------------------------

/** Ruta de la pantalla de reglas del cliente (importar, candidatas y tabla de reglas). */
export const rutaReglas = (clienteId: string): string => `/clientes/${clienteId}/reglas`;

/** Prefijo de la API de importaciones del historial del cliente. */
export const apiImportaciones = (clienteId: string): string =>
  `/clientes/${clienteId}/reglas/importaciones`;

/** Prefijo de la API de candidatas del cliente. */
export const apiCandidatas = (clienteId: string): string =>
  `/clientes/${clienteId}/reglas/candidatas`;

/** El botón «Importar historial» de la pantalla de reglas. */
export const botonImportarHistorial = (page: Page): Locator =>
  page.getByRole("button", { name: "Importar historial", exact: true });

/** El diálogo de importar (título «Importar historial del cliente»). */
export const dialogoImportar = (page: Page): Locator =>
  page.getByRole("dialog", { name: "Importar historial del cliente" });

/** La línea de resumen de la última importación: «6 periodos leídos · 4 candidatas · 3 sin criterio claro». */
export const resumenImportacion = (page: Page): Locator =>
  page.getByText(/periodos leídos · \d+ candidatas · \d+ sin criterio claro/);

/** La sección de candidatas del historial. */
export const seccionCandidatas = (page: Page): Locator =>
  page.getByRole("region", { name: "Candidatas del historial" });

/** Una pestaña de la revisión de candidatas («Propuestas», «Sin criterio claro», «Con conflicto», «Resueltas»). */
export const pestanaCandidatas = (page: Page, nombre: string): Locator =>
  seccionCandidatas(page).getByRole("tab", { name: nombre });

/** La lista de candidatas de la pestaña abierta. */
export const listaCandidatas = (page: Page): Locator =>
  seccionCandidatas(page).getByRole("list", { name: "Candidatas del historial" });

/** La fila de una candidata por el número del proveedor. */
export const candidataDe = (page: Page, numero: string): Locator =>
  listaCandidatas(page).locator("[data-candidata]").filter({ hasText: numero });

/** El diálogo de confirmación de «Activar todas». */
export const dialogoActivarTodas = (page: Page): Locator =>
  page.getByRole("dialog", { name: "Activar todas" });

/** La fila de la tabla de reglas del cliente por el número del proveedor. */
export const filaDeRegla = (page: Page, numero: string): Locator =>
  page
    .getByRole("table", { name: "Reglas aprendidas del cliente" })
    .getByRole("row")
    .filter({ hasText: numero });

/** El filtro «DNG por perfil del cliente» (R-STD) de la barra de filtros de compras. */
export const filtroStd = (page: Page): Locator =>
  page.getByRole("checkbox", { name: "DNG por perfil del cliente" });
