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
