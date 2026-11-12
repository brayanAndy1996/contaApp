// Selectores y ayudantes del panel «Generar archivo» de compras (spec 018, E-08). Solo roles y textos de
// `apps/frontend/lib/archivos.ts`: el panel es un `<aside aria-label="Generar archivo">` que se abre con un botón.
import { expect, type Locator, type Page } from "@playwright/test";
import type { Api } from "../api.js";

/** El panel lateral (rol `complementary` por su `aria-label`). */
export const panelArchivo = (page: Page): Locator =>
  page.getByRole("complementary", { name: "Generar archivo" });

/** Abre el panel con el botón de la página y espera a que el previo cargue. */
export async function abrirPanelArchivo(page: Page): Promise<Locator> {
  await page
    .getByRole("button", { name: "Generar archivo", exact: true })
    .click();
  const panel = panelArchivo(page);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "Cerrar" })).toBeVisible();
  return panel;
}

export const botonGenerar = (panel: Locator): Locator =>
  panel.getByRole("button", { name: "Generar", exact: true });

/** La sección «Errores» del previo (los avisos tienen la suya, con los mismos comprobantes). */
export const erroresDe = (panel: Locator): Locator =>
  panel.getByRole("region", { name: "Errores", exact: true });

/** Las versiones generadas que lista el panel. */
export const versiones = (panel: Locator): Locator =>
  panel.getByRole("region", { name: "Versiones generadas" });

interface FilaMinima {
  readonly id: string;
  readonly version: number;
  readonly serie: string;
  readonly numero: string;
}

/**
 * Corrige por API lo único que bloquea el previo de las fixtures: la mixta F001-2056 (IGV 1.61 de 21.48) se acepta
 * con su XML (R-MIX exacto 8.97). Devuelve el id de la compra.
 */
export async function corregirMixtaPorApi(
  api: Api,
  clienteId: string,
  periodo: string,
): Promise<string> {
  const lista = await api.exigir<{ filas: FilaMinima[] }>(
    "GET",
    `/clientes/${clienteId}/periodos/${periodo}/compras`,
  );
  const fila = lista.filas.find(
    (f) => f.serie === "F001" && f.numero === "2056",
  );
  if (fila === undefined) throw new Error("No está la compra F001-2056.");
  await api.exigir(
    "POST",
    `/clientes/${clienteId}/periodos/${periodo}/compras/${fila.id}/sugerencias/aceptar`,
    { versionBase: fila.version, regla: "R-MIX" },
  );
  return fila.id;
}
