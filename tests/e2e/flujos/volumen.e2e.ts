// E-06 · Volumen (spec 018, T9; RNF-031, CA-9; P-3, P-5). Etiqueta `@volumen`: la suite normal (`pnpm e2e`) no la
// corre; `pnpm e2e:volumen` corre solo esta. Mide con tope (primeras filas < 2 s; Ctrl+Z de la masiva ≤ 10 s) y
// deja los tiempos como anotaciones del reporte (`tiempo-primeras-filas` y, del Ctrl+Z de la masiva, por separado,
// `tiempo-deshacer-llamada`, `tiempo-deshacer-recarga` y `tiempo-deshacer-total`; spec 022, T1).
// Acelerar el Ctrl+Z de la masiva (recarga el listado entero) queda para una spec de rendimiento (P-3).
import type { Page, TestInfo } from "@playwright/test";
import {
  PERIODO,
  estado,
  expect,
  test,
  type Api,
  type Cliente,
  type Estudio,
  type Sesion,
  type Sesiones,
} from "../soporte/fixtures.js";
import {
  apiCompras,
  celda,
  filasDeCompras,
  grilla,
  rutaCompras,
} from "../soporte/selectores/compras.js";
import type { Siembra } from "../soporte/siembra.js";

const TOTAL = 5_000;
const EXCLUIDAS = 150;
const MASIVA = TOTAL - EXCLUIDAS; // 4.850, como en 015 T11
const TOPE_PRIMERAS_FILAS_MS = 2_000;
const TOPE_DESHACER_MS = 10_000;
/** Carga completa del listado y la masiva de 4.850 filas, con holgura: no es la medida, es el tope de la espera. */
const ESPERA_TRABAJO_MS = 30_000;

interface FilaListada {
  readonly id: string;
  readonly serie: string;
  readonly numero: string;
  readonly version: number;
}

const comprobante = (f: FilaListada): string => `${f.serie}-${f.numero}`;

const barraMasiva = (page: Page) =>
  page.getByRole("toolbar", { name: "Acciones sobre la selección" });

const milisegundos = (desde: number): number => Math.round(performance.now() - desde);

function anotar(testInfo: TestInfo, tipo: string, ms: number): void {
  testInfo.annotations.push({ type: tipo, description: `${ms} ms` });
}

interface Entorno {
  siembra: Siembra;
  sesiones: Sesiones;
  api: (sesion: Sesion) => Api;
}

/** Un estudio, un cliente y `n` compras del 202610 sembradas por SQL, con el Dueño dentro del navegador. */
async function conCompras({ siembra, sesiones, api }: Entorno, n: number) {
  const estudio: Estudio = await siembra.estudio();
  const cliente: Cliente = await siembra.cliente(estudio.tenantId);
  await siembra.comprasPorSql(cliente.id, PERIODO, n);
  const abierta = await sesiones.paginaDe(estudio.dueno);
  return { cliente, page: abierta.page, apiDueno: api(abierta.sesion) };
}

test.describe("E-06 volumen", { tag: "@volumen" }, () => {
  test("5.000 compras: primeras filas < 2 s, desplazamiento, masiva sobre 4.850 y Ctrl+Z ≤ 10 s", async ({
    siembra,
    sesiones,
    api,
  }, testInfo) => {
    test.setTimeout(180_000);
    const { cliente, page, apiDueno } = await conCompras(
      { siembra, sesiones, api },
      TOTAL,
    );

    // 150 compras excluidas por la API dejan 4.850 en «Con IGV», como la medición de 015 T11.
    const listado = await apiDueno.exigir<{ filas: FilaListada[] }>(
      "GET",
      `${apiCompras(cliente.id, PERIODO)}?vista=con_igv&limite=${TOTAL}`,
    );
    expect(listado.filas).toHaveLength(TOTAL);
    const informeApi = await apiDueno.exigir<{ aplicadas: number }>(
      "POST",
      `${apiCompras(cliente.id, PERIODO)}/masivas/excluir`,
      {
        items: listado.filas
          .slice(0, EXCLUIDAS)
          .map((f) => ({ compraId: f.id, versionBase: f.version })),
        motivo: "Volumen: filas fuera de la masiva",
      },
    );
    expect(informeApi.aplicadas).toBe(EXCLUIDAS);
    const primera = listado.filas[EXCLUIDAS];
    const ultima = listado.filas[TOTAL - 1];
    if (primera === undefined || ultima === undefined) throw new Error("Listado incompleto.");

    // Primeras filas: desde pedir la página hasta la primera fila pintada (RNF-031, CA-9).
    const inicio = performance.now();
    await page.goto(rutaCompras(cliente.id, PERIODO));
    await expect(filasDeCompras(page).first()).toBeVisible({
      timeout: TOPE_PRIMERAS_FILAS_MS,
    });
    const primerasFilasMs = milisegundos(inicio);
    anotar(testInfo, "tiempo-primeras-filas", primerasFilasMs);
    expect(primerasFilasMs).toBeLessThan(TOPE_PRIMERAS_FILAS_MS);

    // La carga por cursor termina: el botón del filtro cuenta las 4.850.
    const seleccionarTodas = page.getByRole("button", {
      name: `Seleccionar las ${MASIVA} del filtro`,
    });
    await expect(seleccionarTodas).toBeEnabled({ timeout: ESPERA_TRABAJO_MS });

    // Virtualizada: el DOM solo lleva las filas visibles más un margen, no las 4.850.
    expect(await filasDeCompras(page).count()).toBeLessThan(100);

    // Desplazamiento: Ctrl+Fin lleva al final y la última fila aparece; Ctrl+Inicio vuelve a la primera.
    await celda(page, comprobante(primera), "comprobante").focus();
    await page.keyboard.press("Control+End");
    await expect(celda(page, comprobante(ultima), "comprobante")).toBeVisible();
    await expect(celda(page, comprobante(primera), "comprobante")).toHaveCount(0);
    expect(await filasDeCompras(page).count()).toBeLessThan(100);
    await page.keyboard.press("Control+Home");
    await expect(celda(page, comprobante(primera), "comprobante")).toBeVisible();

    // Masiva sobre las 4.850: una sola petición, informe sin rechazadas.
    const masivas: number[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/masivas/clasificar")) {
        masivas.push((r.postDataJSON() as { items: unknown[] }).items.length);
      }
    });
    await seleccionarTodas.click();
    await expect(barraMasiva(page).getByText(`${MASIVA} seleccionadas`)).toBeVisible();
    await barraMasiva(page).getByRole("button", { name: "Clasificar como DNG" }).click();
    const informe = page.getByRole("dialog", { name: "Resultado de la acción masiva" });
    await expect(informe).toContainText(`${MASIVA} aplicadas`, {
      timeout: ESPERA_TRABAJO_MS,
    });
    expect(masivas).toEqual([MASIVA]);
    await expect(estado(page, `${MASIVA} aplicadas · 0 rechazadas`)).toHaveCount(1);
    await informe.getByRole("button", { name: "Cerrar" }).click();
    await expect(informe).toHaveCount(0);
    await expect(celda(page, comprobante(primera), "destino")).toContainText("DNG");

    // Ctrl+Z con el foco en la grilla: desde la tecla hasta el aviso y la fila ya revertida.
    await celda(page, comprobante(primera), "comprobante").focus();
    // Fases del Ctrl+Z (spec 022, T1): la llamada `POST …/deshacer` y la recarga del listado que la sigue.
    const marcas = { llamadaInicio: 0, llamadaFin: 0, listadoFin: 0 };
    const rutaApi = apiCompras(cliente.id, PERIODO);
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith(`${rutaApi}/deshacer`)) {
        marcas.llamadaInicio = performance.now();
      }
    });
    page.on("requestfinished", (r) => {
      if (r.method() === "POST" && r.url().endsWith(`${rutaApi}/deshacer`)) {
        marcas.llamadaFin = performance.now();
      } else if (
        marcas.llamadaFin > 0 &&
        r.method() === "GET" &&
        r.url().includes(`${rutaApi}?`)
      ) {
        marcas.listadoFin = performance.now();
      }
    });
    const antesDeDeshacer = performance.now();
    await page.keyboard.press("Control+z");
    await expect(estado(page, `Se deshizo la operación (${MASIVA} compras).`)).toHaveCount(1, {
      timeout: TOPE_DESHACER_MS,
    });
    await expect(celda(page, comprobante(primera), "destino")).toContainText(
      "Por clasificar",
      { timeout: TOPE_DESHACER_MS },
    );
    const deshacerMs = milisegundos(antesDeDeshacer);
    anotar(testInfo, "tiempo-deshacer-llamada", Math.round(marcas.llamadaFin - marcas.llamadaInicio));
    anotar(testInfo, "tiempo-deshacer-recarga", Math.round(marcas.listadoFin - marcas.llamadaFin));
    anotar(testInfo, "tiempo-deshacer-total", deshacerMs);
    expect(deshacerMs).toBeLessThanOrEqual(TOPE_DESHACER_MS);
    await expect(grilla(page)).toBeVisible();
  });

  test("error: con más de 5.000 compras en el filtro no se selecciona todo y pide filtrar", async ({
    siembra,
    sesiones,
    api,
  }) => {
    test.setTimeout(120_000);
    const { cliente, page } = await conCompras({ siembra, sesiones, api }, TOTAL + 250);
    await page.goto(rutaCompras(cliente.id, PERIODO));
    await expect(filasDeCompras(page).first()).toBeVisible();

    await expect(
      page.getByRole("button", { name: `Seleccionar las ${TOTAL + 250} del filtro` }),
    ).toBeDisabled({ timeout: ESPERA_TRABAJO_MS });
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Hay más de 5000 compras en el filtro: filtra más para seleccionarlas." }),
    ).toHaveCount(1);
  });
});
