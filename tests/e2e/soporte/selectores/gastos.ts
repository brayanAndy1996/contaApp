// Selectores y ayudantes de gastos no deducibles (spec 027, T21; HU-41, HU-42; CA-1, CA-9, CA-12). Los textos salen de
// `MENSAJES_GASTOS` en `apps/frontend/lib/gastos.ts`. Cambia solo añadiendo.
import type { Locator, Page } from "@playwright/test";
import type { Api } from "../api.js";
import { URL_BACKEND, URL_FRONTEND } from "../pila/entorno.js";
import { apiCompras, fila } from "./compras.js";

/** El chip «Posible gasto no deducible · n puntos» de la fila de un comprobante (columna de alertas). */
export const chipGasto = (page: Page, comprobante: string): Locator =>
  fila(page, comprobante).getByText(/^Posible gasto no deducible/);

/** La lista «Señales del puntaje» dentro de la lupa abierta. */
export const listaSenales = (lupa: Locator): Locator =>
  lupa.getByRole("list", { name: "Señales del puntaje" });

/** El diálogo «Aprender estas palabras» que se ofrece tras excluir. */
export const dialogoAprender = (page: Page): Locator =>
  page.getByRole("dialog", { name: "Aprender estas palabras" });

/** El botón «Volver a evaluar» del periodo. */
export const botonVolverAEvaluar = (page: Page): Locator =>
  page.getByRole("button", { name: "Volver a evaluar", exact: true });

/** Ruta de la API de gastos de un periodo (aprender). */
export const apiGastos = (clienteId: string, periodo: string): string =>
  `/clientes/${clienteId}/periodos/${periodo}/gastos`;

/**
 * Agrega una compra desde un XML (016, `POST …/compras/desde-xml?destino=`): el cuerpo es el XML crudo, que `Api.pedir`
 * (solo JSON) no envía. Devuelve el estado HTTP; el llamador exige 201.
 */
export async function agregarCompraDesdeXml(
  api: Api,
  clienteId: string,
  periodo: string,
  xml: string,
  destino: "DG" | "DGNG" | "DNG",
): Promise<number> {
  const r = await fetch(
    `${URL_BACKEND}${apiCompras(clienteId, periodo)}/desde-xml?destino=${destino}`,
    {
      method: "POST",
      headers: {
        Cookie: api.sesion.cookie,
        "X-Estudio": api.sesion.tenantId,
        "X-Forwarded-For": api.sesion.ip,
        "X-CSRF-Token": api.sesion.csrf,
        Origin: URL_FRONTEND,
        "Content-Type": "application/xml",
      },
      body: xml,
    },
  );
  await r.text();
  return r.status;
}
