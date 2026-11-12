// E-08 · Generar archivo (spec 018; HU-25, 26; CA-2, CA-8, CA-10). Caso feliz: el previo con error bloquea y su enlace
// lleva a la fila -> se corrige -> apto -> generar -> seguir el trabajo -> bajar el ZIP (TXT con N líneas y SHA-256
// igual al de la API) -> reabrir y versión 2. Casos de error: el asistente no ve «Generar» y un periodo `generado`
// bloquea la edición. Defectos de 012b T23a visibles en el navegador (el previo dice de qué comprobante es cada error
// y «Ubicar en la grilla» lleva la fila a la vista).
import { readFileSync } from "node:fs";
import {
  PERIODO,
  alerta,
  estado,
  expect,
  test,
  type Api,
  type Cliente,
  type Estudio,
  type Sesion,
  type Sesiones,
} from "../soporte/fixtures.js";
import type { Siembra } from "../soporte/siembra.js";
import { lineasDe, primeraEntradaZip, sha256 } from "../soporte/zip.js";
import {
  abrirPanelArchivo,
  botonGenerar,
  corregirMixtaPorApi,
  erroresDe,
  versiones,
} from "../soporte/selectores/archivo.js";
import {
  abrirLupaConEnter,
  abrirMenuAcciones,
  esperarXmlDescargados,
  filaDe,
  rutaCompras,
} from "../soporte/selectores/lupa.js";

test.setTimeout(90_000);

/** Cliente de fixtures con las compras de 202610 descargadas y sus XML simulados guardados. */
async function prepararCompras(
  siembra: Siembra,
  sesiones: Sesiones,
  api: (s: Sesion) => Api,
): Promise<{ estudio: Estudio; cliente: Cliente; llamadas: Api }> {
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId);
  const llamadas = api(await sesiones.entrar(estudio.dueno));
  await llamadas.cargarCredenciales(cliente.id);
  await llamadas.descargar(cliente.id, PERIODO);
  await esperarXmlDescargados(llamadas, cliente.id);
  return { estudio, cliente, llamadas };
}

test.describe("E-08 · generar archivo", () => {
  test("el previo con error bloquea, se corrige, se genera y se baja el ZIP", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const { estudio, cliente, llamadas } = await prepararCompras(
      siembra,
      sesiones,
      api,
    );
    const { page } = await sesiones.paginaDe(estudio.dueno);
    await page.goto(rutaCompras(cliente.id, PERIODO));
    await expect(filaDe(page, "F001-2056")).toBeVisible();

    // 1. El previo: la mixta tiene un IGV que no es 18 % ni 10 %. Bloquea y dice de qué comprobante es.
    const panel = await abrirPanelArchivo(page);
    await expect(
      estado(page, /^El archivo no se puede generar todavía\./),
    ).toBeVisible();
    await expect(
      panel.getByText("Provisional: no subir a SUNAT"),
    ).toBeVisible();
    await expect(botonGenerar(panel)).toBeDisabled();
    await expect(erroresDe(panel).getByText("F001-2056 ·")).toBeVisible();
    await expect(
      erroresDe(panel).getByText("1.61 no es 18 % ni 10 % de 21.48"),
    ).toBeVisible();

    // 2. El enlace del error lleva la fila a la vista (012b T23a P-1).
    await erroresDe(panel)
      .getByRole("button", {
        name: "Ubicar en la grilla el comprobante F001-2056",
      })
      .click();
    await expect(filaDe(page, "F001-2056")).toBeInViewport();

    // 3. Se corrige desde la lupa (el panel tapa las columnas de la derecha de la grilla): aceptar R-MIX.
    //    El previo se recarga solo y queda apto.
    const lupa = await abrirLupaConEnter(page, "F001-2056");
    await lupa.getByRole("button", { name: "Aceptar sugerencias" }).click();
    await page
      .getByRole("dialog", { name: "Aceptar sugerencias F001-2056" })
      .getByRole("button", { name: "Aceptar R-MIX" })
      .click();
    await expect(estado(page, "Sugerencia aceptada.")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(lupa).toBeHidden();
    await expect(
      estado(page, "El archivo está listo para generarse."),
    ).toBeVisible();
    await expect(botonGenerar(panel)).toBeEnabled();

    // 4. Generar y seguir el trabajo hasta «Archivo generado.».
    await botonGenerar(panel).click();
    await expect(estado(page, "Archivo generado.")).toHaveCount(1);
    await expect(alerta(page, /./)).toHaveCount(0);
    await expect(
      versiones(panel).getByText("Versión 1", { exact: true }),
    ).toBeVisible();

    // 5. El ZIP: el TXT tiene las N líneas que dice la versión y los SHA-256 coinciden con los de la API.
    const lista = await llamadas.versionesArchivo(cliente.id, PERIODO);
    expect(lista).toHaveLength(1);
    const v1 = lista[0]!;
    await expect(
      versiones(panel).getByText(`${v1.nombreZip} · ${v1.lineas} líneas`),
    ).toBeVisible();
    const [descarga] = await Promise.all([
      page.waitForEvent("download"),
      versiones(panel)
        .getByRole("button", { name: "Descargar la versión 1" })
        .click(),
    ]);
    expect(descarga.suggestedFilename()).toBe(v1.nombreZip);
    const zip = readFileSync(await descarga.path());
    expect(sha256(zip)).toBe(v1.sha256Zip);
    const entrada = primeraEntradaZip(zip);
    expect(sha256(entrada.bytes)).toBe(v1.sha256Txt);
    expect(lineasDe(entrada.bytes)).toHaveLength(v1.lineas);
    // La zapatilla (R-GP) no va en el archivo; la mixta ya corregida sí.
    expect(entrada.bytes.toString("latin1")).toContain("F001|2056");
  });

  test("reabrir un periodo generado: el panel lo avisa y, tras corregir, sale la versión 2 sin perder la 1", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const { estudio, cliente, llamadas } = await prepararCompras(
      siembra,
      sesiones,
      api,
    );
    await corregirMixtaPorApi(llamadas, cliente.id, PERIODO);
    const v1 = await llamadas.generarArchivo(cliente.id, PERIODO);
    const { page } = await sesiones.paginaDe(estudio.dueno);
    await page.goto(rutaCompras(cliente.id, PERIODO));
    await expect(filaDe(page, "F001-3064")).toBeVisible();

    const panel = await abrirPanelArchivo(page);
    await expect(
      versiones(panel).getByText("Versión 1", { exact: true }),
    ).toBeVisible();
    await expect(botonGenerar(panel)).toBeDisabled();

    // Reabrir pide confirmación y deja el periodo abierto; el panel avisa que hay cambios posibles sobre la versión 1.
    await page.getByRole("button", { name: "Reabrir", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Confirmar" })
      .click();
    await expect(estado(page, "Periodo reabierto.")).toHaveCount(1);
    await expect(
      versiones(panel).getByText("Reabierto después de la última versión"),
    ).toBeVisible();

    // Un cambio real (3064 como DNG) desde la lupa y se genera de nuevo.
    const lupa = await abrirLupaConEnter(page, "F001-3064");
    await abrirMenuAcciones(lupa, "F001-3064");
    await page.getByRole("menuitem", { name: "Clasificar como DNG" }).click();
    await expect(estado(page, "Compra clasificada.")).toHaveCount(1);
    await lupa.getByRole("button", { name: "Cerrar comprobante" }).click();
    await expect(lupa).toBeHidden();
    await expect(botonGenerar(panel)).toBeEnabled();
    await botonGenerar(panel).click();
    await expect(
      versiones(panel).getByText("Versión 2", { exact: true }),
    ).toBeVisible();
    await expect(estado(page, "Archivo generado.")).toHaveCount(1);

    const lista = await llamadas.versionesArchivo(cliente.id, PERIODO);
    expect(lista).toHaveLength(2);
    const v2 = lista.find((v) => v.version === 2)!;
    expect(v2.sha256Txt).not.toBe(v1.sha256Txt);

    // La versión 1 se sigue bajando, intacta.
    const [descarga] = await Promise.all([
      page.waitForEvent("download"),
      versiones(panel)
        .getByRole("button", { name: "Descargar la versión 1" })
        .click(),
    ]);
    const zip = readFileSync(await descarga.path());
    expect(sha256(zip)).toBe(v1.sha256Zip);
    expect(sha256(primeraEntradaZip(zip).bytes)).toBe(v1.sha256Txt);
  });

  test("el asistente ve el previo y baja el ZIP, pero no tiene «Generar»", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const { estudio, cliente, llamadas } = await prepararCompras(
      siembra,
      sesiones,
      api,
    );
    await corregirMixtaPorApi(llamadas, cliente.id, PERIODO);
    await llamadas.generarArchivo(cliente.id, PERIODO);
    const asistente = await siembra.miembro(estudio.tenantId, "asistente");
    await siembra.asignar(cliente, asistente);

    const { page } = await sesiones.paginaDe(asistente);
    await page.goto(rutaCompras(cliente.id, PERIODO));
    await expect(filaDe(page, "F001-2056")).toBeVisible();
    const panel = await abrirPanelArchivo(page);

    await expect(
      panel.getByText("No tienes permiso para generar el archivo."),
    ).toBeVisible();
    await expect(botonGenerar(panel)).toHaveCount(0);
    await expect(
      versiones(panel).getByRole("button", { name: "Descargar la versión 1" }),
    ).toBeEnabled();
  });

  test("con el periodo generado la edición queda bloqueada", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const { estudio, cliente, llamadas } = await prepararCompras(
      siembra,
      sesiones,
      api,
    );
    await corregirMixtaPorApi(llamadas, cliente.id, PERIODO);
    await llamadas.generarArchivo(cliente.id, PERIODO);

    const { page } = await sesiones.paginaDe(estudio.dueno);
    await page.goto(rutaCompras(cliente.id, PERIODO));
    await expect(filaDe(page, "F001-3064")).toBeVisible();

    await expect(
      estado(page, "El periodo ya está generado: reábrelo para modificarlo."),
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Acciones F001-3064" }),
    ).toBeDisabled();
    const lupa = await abrirLupaConEnter(page, "F001-3064");
    await expect(lupa.getByRole("button", { name: "Editar" })).toBeDisabled();
    await expect(
      lupa.getByRole("button", { name: "Acciones F001-3064" }),
    ).toBeDisabled();
  });
});
