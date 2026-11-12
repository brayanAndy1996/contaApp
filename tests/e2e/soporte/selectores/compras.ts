// Selectores de la pantalla de compras (spec 018, D-6, T6). Los controles se buscan por rol, etiqueta y texto de
// `apps/frontend/lib/compras.ts`; aquí solo viven los que no tienen nombre accesible: las celdas de la grilla
// (`role="gridcell"` sin nombre; se ubican por `data-col`) y el orden de columnas para recorrerlas con el teclado.
// T9 (volumen) lee de aquí; cambia solo añadiendo.
import type { Locator, Page } from "@playwright/test";
import type { Api } from "../api.js";

/** Ruta de la pantalla de compras de un cliente en un periodo. */
export const rutaCompras = (clienteId: string, periodo: string): string =>
  `/clientes/${clienteId}/compras?periodo=${periodo}`;

/** Prefijo de la API de compras que ve el navegador (`/api/clientes/:id/periodos/:periodo/compras`). */
export const apiCompras = (clienteId: string, periodo: string): string =>
  `/clientes/${clienteId}/periodos/${periodo}/compras`;

/** La grilla de compras (`role="grid"`). */
export const grilla = (page: Page): Locator =>
  page.getByRole("grid", { name: "Compras del periodo" });

/** La fila de un comprobante («F001-3064») en la grilla. */
export const fila = (page: Page, comprobante: string): Locator =>
  grilla(page).getByRole("row").filter({ hasText: comprobante });

/** Todas las filas de compras (no los separadores de sección ni los encabezados). */
export const filasDeCompras = (page: Page): Locator =>
  grilla(page).locator("[data-fila]");

/** Id de columna (`data-col`) de la grilla, de izquierda a derecha. */
export type ColumnaGrilla =
  | "seleccionar"
  | "tipo"
  | "comprobante"
  | "proveedor"
  | "fecha"
  | "moneda"
  | "destino"
  | "alertas"
  | "biDg"
  | "igvDg"
  | "biDgng"
  | "igvDgng"
  | "biDng"
  | "igvDng"
  | "noGravado"
  | "isc"
  | "icbper"
  | "otrosTributos"
  | "total"
  | "lupa"
  | "acciones";

export const ORDEN_COLUMNAS: readonly ColumnaGrilla[] = [
  "seleccionar",
  "tipo",
  "comprobante",
  "proveedor",
  "fecha",
  "moneda",
  "destino",
  "alertas",
  "biDg",
  "igvDg",
  "biDgng",
  "igvDgng",
  "biDng",
  "igvDng",
  "noGravado",
  "isc",
  "icbper",
  "otrosTributos",
  "total",
  "lupa",
  "acciones",
];

/** Una celda de una fila de la grilla por su columna. */
export const celda = (
  page: Page,
  comprobante: string,
  columna: ColumnaGrilla,
): Locator => fila(page, comprobante).locator(`[data-col="${columna}"]`);

/**
 * Lleva el foco del teclado a una celda: clic en la celda del comprobante y flechas hacia la derecha hasta la
 * columna pedida. Con teclado no hay otra forma de llegar a una columna fuera de la ventana horizontal.
 */
export async function irACelda(
  page: Page,
  comprobante: string,
  columna: ColumnaGrilla,
): Promise<void> {
  const desde = ORDEN_COLUMNAS.indexOf("comprobante");
  const hasta = ORDEN_COLUMNAS.indexOf(columna);
  await celda(page, comprobante, "comprobante").focus();
  for (let i = desde; i < hasta; i += 1) await page.keyboard.press("ArrowRight");
}

/** Los textos de la fila pertenecen a una sección: el separador «Con IGV (n)», «Sin IGV (n)» o «Excluidas (n)». */
export const separador = (page: Page, titulo: RegExp | string): Locator =>
  grilla(page).locator("[data-seccion-titulo]").filter({ hasText: titulo });

/**
 * Graba, desde que carga la página, cada texto distinto que tuvieron las regiones `role="status"` y `role="alert"`.
 * Los trabajos de la cola pasan por «En cola» y «Descargando…» en milisegundos: una aserción que sondea puede no
 * ver el estado intermedio, pero el historial sí lo guarda. Llamar antes de `page.goto`.
 */
export async function grabarAvisos(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __avisos: string[] };
    w.__avisos = [];
    const leer = (): string =>
      [...document.querySelectorAll('[role="status"],[role="alert"]')]
        .map((e) => e.textContent ?? "")
        .join(" | ");
    new MutationObserver(() => {
      const ahora = leer();
      if (w.__avisos[w.__avisos.length - 1] !== ahora) w.__avisos.push(ahora);
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  return () =>
    page.evaluate(() => (window as unknown as { __avisos: string[] }).__avisos);
}

/** Una compra tal como la devuelve el listado de la API (solo lo que usan los flujos). */
export interface CompraApi {
  readonly id: string;
  readonly serie: string;
  readonly numero: string;
  readonly version: number;
  readonly excluida: boolean;
}

/**
 * La compra de un comprobante («F001-3064») por la API de una sesión: sirve para que una segunda sesión actúe sobre
 * la misma fila que ve la primera en pantalla. Mira las vigentes y las excluidas.
 */
export async function compraPorComprobante(
  api: Api,
  clienteId: string,
  periodo: string,
  comprobante: string,
): Promise<CompraApi> {
  for (const vista of ["con_igv", "sin_igv", "excluidas"]) {
    const lista = await api.exigir<{ filas: CompraApi[] }>(
      "GET",
      `${apiCompras(clienteId, periodo)}?vista=${vista}&limite=100`,
    );
    const hallada = lista.filas.find(
      (f) => `${f.serie}-${f.numero}` === comprobante,
    );
    if (hallada !== undefined) return hallada;
  }
  throw new Error(`No hay una compra ${comprobante} en el periodo.`);
}

/** Las tres celdas de un casillero del resumen del periodo (original, vigente, diferencia), p. ej. «Base DNG». */
export const casilleroDelResumen = (page: Page, casillero: string): Locator =>
  page
    .getByRole("region", { name: "Resumen del periodo" })
    .getByRole("row", { name: new RegExp(`^${casillero}`) })
    .first()
    .getByRole("cell");

/** Las tres celdas de la fila «Total» del resumen del periodo. */
export const totalDelResumen = (page: Page): Locator =>
  casilleroDelResumen(page, "Total");

/**
 * Abre el menú «Acciones» de una fila y devuelve el menú. Antes de pulsar se lleva el botón a la vista y se deja
 * pasar un cuadro de animación: el menú se cierra con cualquier evento `scroll`, y el desplazamiento que haría el
 * propio clic de Playwright llegaría justo después de abrirlo (un usuario no desplaza y pulsa en el mismo cuadro).
 */
export async function abrirMenuAcciones(
  page: Page,
  comprobante: string,
): Promise<Locator> {
  const boton = page.getByRole("button", { name: `Acciones ${comprobante}` });
  await boton.scrollIntoViewIfNeeded();
  await page.evaluate(
    () =>
      new Promise<void>((resolver) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolver())),
      ),
  );
  await boton.click();
  const menu = page.getByRole("menu", { name: `Acciones ${comprobante}` });
  await menu.waitFor();
  return menu;
}
