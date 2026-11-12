// E-09 Ventas (spec 018): descarga RVIE mock, «Falta B001-291», excluir la venta descuadrada con motivo,
// generar ventas sin las excluidas · motivo vacío rechazado, USD sin tipo de cambio que bloquea, motivo canario.
// Cada aviso aparece una sola vez en el árbol de accesibilidad (CA-10); el canario no ejecuta nada (CA-6).
import { execFileSync } from "node:child_process";
import {
  PERIODO,
  RUCS,
  alerta,
  expect,
  estado,
  test,
} from "../soporte/fixtures.js";
import {
  boleta,
  descuadrada,
  sembrarVentas,
} from "../soporte/siembra-ventas.js";
import {
  abrirPanel,
  botonDescargar,
  botonGenerar,
  campoMotivo,
  confirmar,
  dialogoExcluir,
  filaDeVenta,
  imagenInyectada,
  panelGenerar,
  regionCorrelatividad,
  regionResumen,
  rutaVentas,
} from "../soporte/selectores/ventas.js";

const MOTIVO = "Llegó descuadrada del SIRE: se corrige en facturación";
const MOTIVO_CANARIO = '<img src=x onerror="window.__pwn=1">';
const MENSAJE_MOTIVO_INVALIDO =
  "Escribe un motivo de 1 a 200 caracteres en una sola línea.";

test("la descarga del RVIE mock trae las boletas y avisa «Falta B001-291»", async ({
  siembra,
  sesiones,
  api,
}) => {
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId, {
    ruc: RUCS.generico,
  });
  const { page, sesion } = await sesiones.paginaDe(estudio.dueno);
  await api(sesion).cargarCredenciales(cliente.id);

  await page.goto(rutaVentas(cliente.id, PERIODO));
  await expect(
    page.getByRole("heading", { name: "Ventas", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Aún no hay descargas de este periodo."),
  ).toBeVisible();

  await botonDescargar(page).click();

  // El trabajo pasa por la cola; al completar la pantalla recarga sola, sin recargar la página.
  await expect(page.getByText("2 nuevos, 0 difieren")).toBeVisible({
    timeout: 30_000,
  });
  await expect(filaDeVenta(page, "B001-290")).toBeVisible();
  await expect(filaDeVenta(page, "B001-292")).toBeVisible();
  await expect(filaDeVenta(page, "B001-291")).toHaveCount(0);

  const correlatividad = regionCorrelatividad(page);
  await expect(correlatividad.getByText("Falta B001-291")).toHaveCount(1);
  await expect(correlatividad.getByText("Saltos por revisar: 1")).toBeVisible();
  await expect(
    regionResumen(page).getByText("Importes en soles"),
  ).toBeVisible();
  await expect(
    regionResumen(page).getByRole("cell", { name: "177.00" }).first(),
  ).toBeVisible();

  // Sin errores ni avisos duplicados al terminar (CA-10).
  await expect(alerta(page, /./)).toHaveCount(0);
});

test("excluir la venta descuadrada con motivo deja generar las ventas sin ella", async ({
  siembra,
  sesiones,
  api,
}, testInfo) => {
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId, {
    ruc: RUCS.generico,
  });
  await sembrarVentas(cliente, PERIODO, [
    boleta("B001", 290),
    boleta("B001", 292),
    descuadrada("D001", 1),
  ]);
  const { page, sesion } = await sesiones.paginaDe(estudio.dueno);

  await page.goto(rutaVentas(cliente.id, PERIODO));
  await expect(filaDeVenta(page, "D001-1")).toContainText("No cuadra");
  await expect(
    regionCorrelatividad(page).getByText("Falta B001-291"),
  ).toHaveCount(1);

  // El previo bloquea por el error CUADRE de la descuadrada y deja excluirla desde el error.
  await abrirPanel(page).click();
  const panel = panelGenerar(page);
  await expect(
    panel.getByText("El archivo no se puede generar todavía."),
  ).toBeVisible();
  await expect(
    panel.getByText("Los montos no cuadran con el total"),
  ).toHaveCount(1);
  await expect(panel.getByText("CUADRE", { exact: true })).toHaveCount(0);
  await expect(botonGenerar(page)).toBeDisabled();
  await panel.getByRole("button", { name: "Excluir la venta D001-1" }).click();

  const dialogo = dialogoExcluir(page, "D001-1");
  await campoMotivo(dialogo).fill(MOTIVO);
  await confirmar(dialogo).click();

  await expect(estado(page, "Venta excluida del archivo.")).toHaveCount(1);
  await expect(dialogo).toHaveCount(0);
  await expect(filaDeVenta(page, "D001-1")).toContainText("Excluida");
  await expect(filaDeVenta(page, "D001-1")).toContainText(`Motivo: ${MOTIVO}`);
  await expect(
    regionResumen(page).getByText("1 venta excluida del archivo."),
  ).toBeVisible();

  // El previo se vuelve a pedir solo: ya es apto y lista la excluida con su motivo.
  await expect(
    panel.getByText("El archivo está listo para generarse."),
  ).toBeVisible();
  await expect(
    panel.getByRole("region", { name: "Ventas excluidas" }),
  ).toContainText(MOTIVO);
  await expect(botonGenerar(page)).toBeEnabled();

  await botonGenerar(page).click();
  await expect(estado(page, "Archivo generado.")).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(panel.getByText("Versión 1")).toBeVisible();
  await expect(panel.getByText("2 líneas")).toBeVisible();

  // Con el periodo generado nadie escribe, y el motivo se anuncia una sola vez (CA-10).
  await expect(
    estado(
      page,
      "El periodo ya está generado: reábrelo para modificar las ventas.",
    ),
  ).toHaveCount(1);
  await expect(botonDescargar(page)).toBeDisabled();

  // El TXT del ZIP trae las dos boletas y no la excluida.
  const descarga = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Descargar la versión 1" }).click();
  const ruta = testInfo.outputPath("ventas.zip");
  await (await descarga).saveAs(ruta);
  const txt = execFileSync("unzip", ["-p", ruta, "*.txt"]).toString("utf8");
  const lineas = txt.split(/\r?\n/).filter((l) => l !== "");
  expect(lineas).toHaveLength(2);
  expect(txt).toContain("290");
  expect(txt).toContain("292");
  expect(txt).not.toContain("D001");

  const versiones = await api(sesion).versionesArchivo(
    cliente.id,
    PERIODO,
    "ventas",
  );
  expect(versiones).toHaveLength(1);
  expect(versiones[0]?.lineas).toBe(2);
  await expect(alerta(page, /./)).toHaveCount(0);
});

test("un motivo vacío, de espacios o de más de 200 caracteres se rechaza y no excluye nada", async ({
  siembra,
  sesiones,
  api,
}) => {
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId, {
    ruc: RUCS.generico,
  });
  await sembrarVentas(cliente, PERIODO, [
    boleta("B001", 290),
    descuadrada("D001", 1),
  ]);
  const { page, sesion } = await sesiones.paginaDe(estudio.dueno);

  await page.goto(rutaVentas(cliente.id, PERIODO));
  await filaDeVenta(page, "D001-1")
    .getByRole("button", { name: "Excluir venta D001-1" })
    .click();
  const dialogo = dialogoExcluir(page, "D001-1");
  await expect(campoMotivo(dialogo)).toBeFocused();

  for (const motivo of ["", "     ", "x".repeat(201)]) {
    await campoMotivo(dialogo).fill(motivo);
    await confirmar(dialogo).click();
    await expect(alerta(page, MENSAJE_MOTIVO_INVALIDO)).toHaveCount(1);
    await expect(campoMotivo(dialogo)).toHaveAttribute("aria-invalid", "true");
    await expect(dialogo).toBeVisible();
  }

  // Escape cierra sin excluir; la venta sigue sin marca y el servidor no registró nada.
  await campoMotivo(dialogo).press("Escape");
  await expect(dialogo).toHaveCount(0);
  await expect(filaDeVenta(page, "D001-1")).not.toContainText("Excluida");
  const resumen = await api(sesion).exigir<{ excluidas?: number }>(
    "GET",
    `/clientes/${cliente.id}/periodos/${PERIODO}/ventas/resumen`,
  );
  expect(resumen.excluidas ?? 0).toBe(0);
});

test("una venta en USD sin tipo de cambio bloquea el archivo hasta excluirla con un motivo canario", async ({
  siembra,
  sesiones,
  api,
}) => {
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId);
  const { page, sesion } = await sesiones.paginaDe(estudio.dueno);
  await api(sesion).cargarCredenciales(cliente.id);

  await page.goto(rutaVentas(cliente.id, PERIODO));
  await botonDescargar(page).click();
  await expect(page.getByText("11 nuevos, 0 difieren")).toBeVisible({
    timeout: 30_000,
  });
  await expect(filaDeVenta(page, "F002-2")).toBeVisible();
  await expect(
    estado(
      page,
      "Hay ventas en USD sin tipo de cambio: no se incluyen en el resumen.",
    ),
  ).toHaveCount(1);

  await abrirPanel(page).click();
  const panel = panelGenerar(page);
  await expect(
    panel.getByText("El archivo no se puede generar todavía."),
  ).toBeVisible();
  await expect(panel.getByText("F002-2 ·")).toHaveCount(1);
  await expect(botonGenerar(page)).toBeDisabled();

  await panel.getByRole("button", { name: "Excluir la venta F002-2" }).click();
  const dialogo = dialogoExcluir(page, "F002-2");
  await campoMotivo(dialogo).fill(MOTIVO_CANARIO);
  await confirmar(dialogo).click();

  await expect(estado(page, "Venta excluida del archivo.")).toHaveCount(1);
  // El motivo se pinta como texto: ni imagen inyectada ni código ejecutado (CA-6).
  await expect(filaDeVenta(page, "F002-2")).toContainText(
    `Motivo: ${MOTIVO_CANARIO}`,
  );
  await expect(imagenInyectada(page)).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { __pwn?: unknown }).__pwn),
  ).toBeUndefined();

  await expect(
    panel.getByText("El archivo está listo para generarse."),
  ).toBeVisible();
  await expect(botonGenerar(page)).toBeEnabled();
  await expect(alerta(page, /./)).toHaveCount(0);
});

test("lectura ve el previo y la grilla, pero sin botones de excluir ni de generar", async ({
  siembra,
  sesiones,
}) => {
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId, {
    ruc: RUCS.generico,
  });
  await sembrarVentas(cliente, PERIODO, [
    boleta("B001", 290),
    descuadrada("D001", 1),
  ]);
  const lectura = await siembra.miembro(estudio.tenantId, "lectura");
  await siembra.asignar(cliente, lectura);
  const { page } = await sesiones.paginaDe(lectura);

  await page.goto(rutaVentas(cliente.id, PERIODO));
  await expect(filaDeVenta(page, "D001-1")).toContainText("No cuadra");
  await expect(page.getByRole("button", { name: /^Excluir/ })).toHaveCount(0);
  await expect(botonDescargar(page)).toHaveCount(0);

  await abrirPanel(page).click();
  const panel = panelGenerar(page);
  await expect(
    panel.getByText("Los montos no cuadran con el total"),
  ).toHaveCount(1);
  await expect(panel.getByText("CUADRE", { exact: true })).toHaveCount(0);
  await expect(
    panel.getByText("No tienes permiso para generar el archivo."),
  ).toHaveCount(1);
  await expect(panel.getByRole("button", { name: /^Excluir/ })).toHaveCount(0);
  await expect(botonGenerar(page)).toHaveCount(0);
});
