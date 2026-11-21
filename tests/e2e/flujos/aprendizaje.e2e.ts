// E-13 · Aprendizaje de arranque (spec 025, T21; HU-29, HU-30, RF-112, RF-113; CA-1, CA-3, CA-9, CA-14). Dos casos con el
// mock del SIRE y una pasada a 390 × 844.
//  1. Cliente con credencial SIRE → «Importar historial» (6) → el trabajo termina → candidatas con frecuencia → nada se
//     aplica solo → cambiar el destino de una y activarla → «Activar todas» con confirmación → reglas con origen «Importado
//     del historial» → descarga del periodo siguiente → filas «Según historial».
//  2. Cliente de Huánuco del fixture (zona Amazonía, ventas exoneradas, sin mixtas) → descarga → sugerencia «DNG por perfil
//     del cliente» → filtro R-STD → «Aceptar R-STD» en masa → montos en DNG.
// El registro presentado de un RUC sin fixture propio es `generico-registro-compras.json` (el mismo en cada periodo).
import { PERIODO, estado, expect, test, type Api } from "../soporte/fixtures.js";
import {
  casilleroDelResumen,
  celda,
  compraPorComprobante,
  fila,
  filasDeCompras,
  rutaCompras,
} from "../soporte/selectores/compras.js";
import {
  apiCandidatas,
  apiImportaciones,
  apiReglas,
  botonImportarHistorial,
  candidataDe,
  dialogoActivarTodas,
  dialogoImportar,
  etiquetaSegunHistorial,
  filaDeRegla,
  filtroSegunHistorial,
  filtroStd,
  listaCandidatas,
  pestanaCandidatas,
  resumenImportacion,
  rutaReglas,
} from "../soporte/selectores/reglas.js";

test.setTimeout(120_000);

/** Cliente de Huánuco (`fixtures/rucs-prueba.json`; su compras de 202610 está en `fixtures/sire/20700000100-compras-202610.json`). */
const RUC_HUANUCO = "20700000100";
/** Cliente sin fixture propio: registro presentado genérico y compras genéricas (dos facturas del proveedor 20700000096). */
const RUC_CLIENTE = "20700000045";
const PROVEEDOR_GENERICO = "20700000096";
const COMPRAS_GENERICAS = ["F001-6010", "F001-6012"] as const;

/** AAAAMM siguiente a otro. */
function despuesDe(periodo: string): string {
  const anio = Number(periodo.slice(0, 4));
  const mes = Number(periodo.slice(4));
  return mes === 12 ? `${anio + 1}01` : `${anio}${String(mes + 1).padStart(2, "0")}`;
}

interface ImportacionApi {
  readonly estado: string;
  readonly periodos: string[];
  readonly resumen: { periodosLeidos: number; candidatas: number; sinCriterio: number } | null;
}

interface CandidataApi {
  readonly proveedor: { readonly numero: string };
  readonly destinoPropuesto: string | null;
}

interface ReglaApi {
  readonly destino: string;
  readonly activa: boolean;
  readonly origen: string;
  readonly proveedor: { readonly numero: string };
}

/** Importa por API y espera a que la importación quede completada (para la pasada móvil). */
async function importarPorApi(llamadas: Api, clienteId: string, periodos: number): Promise<ImportacionApi> {
  const { trabajoId } = await llamadas.exigir<{ trabajoId: string }>("POST", apiImportaciones(clienteId), {
    periodos,
  });
  const trabajo = await llamadas.esperarTrabajo(clienteId, trabajoId);
  expect(trabajo.estado).toBe("completado");
  const { importacion } = await llamadas.exigir<{ importacion: ImportacionApi }>(
    "GET",
    `${apiImportaciones(clienteId)}/ultima`,
  );
  return importacion;
}

test("importar 6 periodos → revisar → activar → descarga siguiente «Según historial»", async ({
  siembra,
  sesiones,
  api,
}) => {
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId, { ruc: RUC_CLIENTE });
  const { page, sesion } = await sesiones.paginaDe(estudio.dueno);
  const llamadas = api(sesion);
  await llamadas.cargarCredenciales(cliente.id);

  // CA-1 · Importar 6 periodos desde la pantalla de reglas (6 por omisión).
  await page.goto(rutaReglas(cliente.id));
  await expect(page.getByText("Aún no has importado el historial de este cliente.")).toBeVisible();
  await botonImportarHistorial(page).click();
  const dialogo = dialogoImportar(page);
  await expect(dialogo).toContainText("No se aplica nada hasta que actives las reglas que se propongan.");
  await expect(dialogo.getByLabel("Periodos")).toHaveValue("6");
  await dialogo.getByRole("button", { name: "Importar", exact: true }).click();
  await expect(dialogo).toHaveCount(0);

  // El trabajo termina: el resumen cuenta solo (periodos leídos, candidatas, sin criterio), nunca montos ni RUC.
  await expect(resumenImportacion(page)).toBeVisible({ timeout: 30_000 });
  await expect(resumenImportacion(page)).toContainText("6 periodos leídos · 7 candidatas · 3 sin criterio claro");
  const { importacion } = await llamadas.exigir<{ importacion: ImportacionApi }>(
    "GET",
    `${apiImportaciones(cliente.id)}/ultima`,
  );
  expect(importacion.estado).toBe("completada");
  expect(importacion.periodos).toHaveLength(6);
  const ultimoImportado = [...importacion.periodos].sort().at(-1) as string;
  const siguiente = despuesDe(ultimoImportado);

  // Candidatas con frecuencia por comprobantes y por periodos, con destino propuesto (U-2).
  await expect(listaCandidatas(page).locator("[data-candidata]")).toHaveCount(4);
  await expect(candidataDe(page, "20700000011")).toContainText("18 de 18 comprobantes en DNG · en 6 de 6 periodos");
  await expect(candidataDe(page, "20700000070")).toContainText("18 de 18 comprobantes en DG · en 6 de 6 periodos");
  await expect(candidataDe(page, PROVEEDOR_GENERICO)).toContainText(
    "24 de 24 comprobantes en DG · en 6 de 6 periodos",
  );
  await expect(candidataDe(page, "45678912")).toContainText("12 de 12 comprobantes en DNG · en 6 de 6 periodos");
  await expect(candidataDe(page, "20700000045")).toHaveCount(0);

  // «Sin criterio claro»: el mixto, el empate y la de 75 %; se listan aparte con sus conteos.
  await pestanaCandidatas(page, "Sin criterio claro").click();
  await expect(listaCandidatas(page).locator("[data-candidata]")).toHaveCount(3);
  await expect(candidataDe(page, "20700000045")).toContainText("18 en DG, 6 en DNG de 24 comprobantes");
  await expect(candidataDe(page, "20700000061")).toContainText("6 en DG, 6 en DNG de 12 comprobantes");
  await pestanaCandidatas(page, "Propuestas").click();
  await expect(listaCandidatas(page).locator("[data-candidata]")).toHaveCount(4);

  // Nada se aplica solo: importar no crea reglas (la descarga siguiente, que ocurre una sola vez tras activar, no tendría
  // con qué moverse). El «periodo siguiente» al último importado es el mes en curso; el siguiente a ese ya es futuro.
  expect(await llamadas.exigir<ReglaApi[]>("GET", apiReglas(cliente.id))).toHaveLength(0);

  // CA-3 · Cambiar el destino de una (DG → DNG) y activarla sola; «Activar todas» pide confirmación con el total.
  await page.goto(rutaReglas(cliente.id));
  await expect(listaCandidatas(page).locator("[data-candidata]")).toHaveCount(4);
  const candidata = candidataDe(page, PROVEEDOR_GENERICO);
  await candidata.getByLabel(`Destino de ${PROVEEDOR_GENERICO}`).selectOption("DNG");
  await candidata.getByRole("checkbox", { name: `Seleccionar candidata de ${PROVEEDOR_GENERICO}` }).check();
  await page.getByRole("button", { name: "Activar seleccionadas" }).click();
  await expect(estado(page, "1 regla activada.")).toHaveCount(1);
  expect(await llamadas.exigir<ReglaApi[]>("GET", apiReglas(cliente.id))).toEqual([
    expect.objectContaining({ destino: "DNG", activa: true, origen: "importacion" }),
  ]);

  await page.getByRole("button", { name: "Activar todas" }).click();
  const confirmar = dialogoActivarTodas(page);
  await expect(confirmar).toContainText("Se activarán 3 reglas. Se omitirán 3 con conflicto o sin criterio claro.");
  await confirmar.getByRole("button", { name: "Confirmar" }).click();
  await expect(confirmar).toHaveCount(0);
  await expect(estado(page, "3 reglas activadas.")).toHaveCount(1);
  await expect(
    page.getByText(
      "Las reglas rigen desde la próxima descarga. Para el periodo que ya está cargado, usa la corrección masiva filtrando por proveedor.",
    ).first(),
  ).toBeVisible();

  // Reglas de 021 activas con origen «Importado del historial»; las de «sin criterio» no se activaron.
  const reglas = await llamadas.exigir<ReglaApi[]>("GET", apiReglas(cliente.id));
  expect(reglas.map((r) => `${r.proveedor.numero}:${r.destino}`).sort()).toEqual([
    "20700000011:DNG",
    "20700000070:DG",
    "20700000096:DNG",
    "45678912:DNG",
  ]);
  for (const r of reglas) expect(r).toMatchObject({ activa: true, origen: "importacion" });
  await expect(filaDeRegla(page, PROVEEDOR_GENERICO)).toContainText("Importado del historial");
  await expect(filaDeRegla(page, PROVEEDOR_GENERICO)).toContainText("DNG");
  await expect(filaDeRegla(page, "20700000011")).toContainText("Importado del historial");
  await expect(page.getByText("Importado del historial", { exact: true })).toHaveCount(4);
  await pestanaCandidatas(page, "Sin criterio claro").click();
  await expect(listaCandidatas(page).locator("[data-candidata]")).toHaveCount(3);
  await pestanaCandidatas(page, "Resueltas").click();
  await expect(listaCandidatas(page).locator("[data-candidata]")).toHaveCount(4);

  // La descarga del periodo siguiente aplica la regla del proveedor: DNG, «Según historial», versión 2.
  await llamadas.descargar(cliente.id, siguiente);
  await page.goto(rutaCompras(cliente.id, siguiente));
  await expect(filasDeCompras(page)).toHaveCount(2);
  for (const c of COMPRAS_GENERICAS) {
    await expect(celda(page, c, "destino")).toContainText("DNG");
    await expect(etiquetaSegunHistorial(page, c)).toBeVisible();
    expect((await compraPorComprobante(llamadas, cliente.id, siguiente, c)).version).toBe(2);
  }
  await expect(casilleroDelResumen(page, "Base DNG")).toHaveText(["0.00", "280.00", "+280.00 (aumenta)"]);
  await filtroSegunHistorial(page).check();
  await expect(filasDeCompras(page)).toHaveCount(2);
});

test("cliente de Huánuco: «DNG por perfil del cliente» → filtro R-STD → aceptar en masa → montos en DNG", async ({
  siembra,
  sesiones,
  api,
}) => {
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId, { ruc: RUC_HUANUCO });
  const { page, sesion } = await sesiones.paginaDe(estudio.dueno);
  const llamadas = api(sesion);
  await llamadas.cargarCredenciales(cliente.id);
  // Perfil de la selva (RF-036; U-4): zona Amazonía, ventas exoneradas y sin ventas mixtas.
  await llamadas.exigir("PATCH", `/clientes/${cliente.id}`, {
    perfil: { regimen: null, zona: "amazonia", ventasExoneradas: true, ventasMixtas: false, monedaHabitual: "PEN" },
  });
  await llamadas.descargar(cliente.id, PERIODO);
  await page.goto(rutaCompras(cliente.id, PERIODO));
  await expect(filasDeCompras(page)).toHaveCount(5);

  // CA-9 · Las compras con base gravada fuera de DNG llevan la sugerencia; la ya clasificada en DNG, no.
  const CON_STD = ["F001-8001", "F001-8002", "F002-8003", "F004-8005"] as const;
  for (const c of CON_STD) {
    await expect(celda(page, c, "alertas")).toContainText("R-STD: DNG por perfil del cliente");
  }
  await expect(celda(page, "F003-8004", "alertas")).not.toContainText("R-STD");
  const antes = {
    dg: await casilleroDelResumen(page, "Base DG").allTextContents(),
    dng: await casilleroDelResumen(page, "Base DNG").allTextContents(),
  };
  expect(antes.dg[0]).toBe("1,005.00");
  expect(antes.dng[0]).toBe("200.00");

  // El filtro deja solo las cuatro; se seleccionan y se aceptan en masa.
  await filtroStd(page).check();
  await expect(filasDeCompras(page)).toHaveCount(4);
  await expect(fila(page, "F003-8004")).toHaveCount(0);
  for (const c of CON_STD) {
    await page.getByRole("checkbox", { name: `Seleccionar ${c}` }).check();
  }
  const barra = page.getByRole("toolbar", { name: "Acciones sobre la selección" });
  await expect(barra.getByText("4 seleccionadas")).toBeVisible();
  await barra.getByRole("button", { name: "Aceptar R-STD", exact: true }).click();
  const informe = page.getByRole("dialog", { name: "Resultado de la acción masiva" });
  await expect(informe).toContainText("4 aplicadas");
  await informe.getByRole("button", { name: "Cerrar" }).click();
  await expect(informe).toHaveCount(0);

  // Sin el filtro: las cuatro en DNG con los mismos montos que clasificar a mano (todo el gravado pasa a DNG).
  await filtroStd(page).uncheck();
  await expect(filasDeCompras(page)).toHaveCount(5);
  for (const c of CON_STD) {
    await expect(celda(page, c, "destino")).toContainText("DNG");
    await expect(celda(page, c, "alertas")).not.toContainText("R-STD");
    expect((await compraPorComprobante(llamadas, cliente.id, PERIODO, c)).version).toBe(2);
  }
  expect((await compraPorComprobante(llamadas, cliente.id, PERIODO, "F003-8004")).version).toBe(1);
  await expect(casilleroDelResumen(page, "Base DG")).toHaveText(["1,005.00", "0.00", "-1,005.00 (disminuye)"]);
  await expect(casilleroDelResumen(page, "Base DGNG")).toHaveText(["150.00", "0.00", "-150.00 (disminuye)"]);
  await expect(casilleroDelResumen(page, "Base DNG")).toHaveText(["200.00", "1,355.00", "+1,155.00 (aumenta)"]);
  await filtroStd(page).check();
  await expect(filasDeCompras(page)).toHaveCount(0);
});

test("a 390 × 844 la revisión de candidatas se lee y la página no se desplaza en horizontal", async ({
  siembra,
  sesiones,
  api,
}) => {
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId, { ruc: RUC_CLIENTE });
  const { page, sesion } = await sesiones.paginaDe(estudio.dueno);
  const llamadas = api(sesion);
  await llamadas.cargarCredenciales(cliente.id);
  await importarPorApi(llamadas, cliente.id, 6);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(rutaReglas(cliente.id));
  await expect(listaCandidatas(page).locator("[data-candidata]")).toHaveCount(4);
  await expect(botonImportarHistorial(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Activar todas" })).toBeVisible();
  await expect(candidataDe(page, PROVEEDOR_GENERICO).getByLabel(`Destino de ${PROVEEDOR_GENERICO}`)).toBeVisible();
  await candidataDe(page, PROVEEDOR_GENERICO)
    .getByRole("checkbox", { name: `Seleccionar candidata de ${PROVEEDOR_GENERICO}` })
    .check();
  await expect(page.getByRole("button", { name: "Activar seleccionadas" })).toBeEnabled();
  await page.getByRole("button", { name: "Activar todas" }).click();
  await expect(dialogoActivarTodas(page)).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await dialogoActivarTodas(page).getByRole("button", { name: "Cancelar" }).click();
  await expect(dialogoActivarTodas(page)).toHaveCount(0);
  // Cancelar no activa nada.
  expect(await llamadas.exigir<ReglaApi[]>("GET", apiReglas(cliente.id))).toHaveLength(0);
  // Se lee la lista de candidatas por API solo para comprobar que la pasada no cambió nada.
  const lista = await llamadas.exigir<{ candidatas: CandidataApi[] }>(
    "GET",
    `${apiCandidatas(cliente.id)}?grupo=propuestas&limite=50`,
  );
  expect(lista.candidatas).toHaveLength(4);
});
