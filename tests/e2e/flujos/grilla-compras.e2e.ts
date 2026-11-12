// E-05 · Grilla de compras (spec 018, T6; HU-14 a 18, RNF-072; CA-2, CA-6, CA-8, CA-10). Cada prueba crea su
// estudio, su cliente con las 5 compras de fixture (descarga por API del 202610) y su sesión. Los casos reales:
// F001-3064 (ICBPER, edición con teclado), F001-5070 (zapatilla), F001-1040 (San Juan, «Sin IGV») y F001-2056 (mixta).
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import {
  PERIODO,
  RUCS,
  alerta,
  estado,
  expect,
  test,
  type Api,
  type Cliente,
  type Estudio,
  type Sesion,
  type Sesiones,
  type Usuario,
} from "../soporte/fixtures.js";
import {
  abrirMenuAcciones,
  apiCompras,
  casilleroDelResumen,
  celda,
  compraPorComprobante,
  fila,
  filasDeCompras,
  irACelda,
  rutaCompras,
  separador,
  totalDelResumen,
} from "../soporte/selectores/compras.js";
import type { Siembra } from "../soporte/siembra.js";

interface Entorno {
  siembra: Siembra;
  sesiones: Sesiones;
  api: (sesion: Sesion) => Api;
}

/** Un estudio con las 5 compras del 202610 descargadas y la pantalla de compras abierta como Dueño. */
async function conCompras({ siembra, sesiones, api }: Entorno) {
  const estudio: Estudio = await siembra.estudio();
  const cliente: Cliente = await siembra.cliente(estudio.tenantId, {
    ruc: RUCS.contribuyente,
  });
  const abierta = await sesiones.paginaDe(estudio.dueno);
  const apiDueno = api(abierta.sesion);
  await apiDueno.cargarCredenciales(cliente.id);
  await apiDueno.descargar(cliente.id, PERIODO);
  await abierta.page.goto(rutaCompras(cliente.id, PERIODO));
  await expect(abierta.page.getByRole("grid", { name: "Compras del periodo" })).toBeVisible();
  await expect(filasDeCompras(abierta.page)).toHaveCount(4);
  return { estudio, cliente, apiDueno, ...abierta };
}

/** Otra sesión del mismo usuario (otra pestaña u otra persona con el mismo rol) que actúa por la API. */
async function segundaSesion(
  { sesiones, api }: Entorno,
  estudio: Estudio,
  usuario: Usuario = estudio.dueno,
): Promise<Api> {
  return api(await sesiones.entrar(usuario));
}

const rutaAccion = (clienteId: string, compraId: string, accion: string): string =>
  `${apiCompras(clienteId, PERIODO)}/${compraId}/${accion}`;

test("filtros y búsqueda: vistas, alertas, proveedor nuevo y texto libre", async ({
  siembra,
  sesiones,
  api,
}) => {
  const { page, cliente, apiDueno } = await conCompras({ siembra, sesiones, api });
  // Una compra clasificada deja de ser «proveedor nuevo» y pierde su alerta R-NEW: así los filtros distinguen filas.
  const bolsas = await compraPorComprobante(apiDueno, cliente.id, PERIODO, "F001-3064");
  await apiDueno.exigir("POST", rutaAccion(cliente.id, bolsas.id, "clasificar"), {
    versionBase: bolsas.version,
    destino: "DNG",
  });
  await page.reload();
  await expect(filasDeCompras(page)).toHaveCount(4);

  // Vistas: «Con IGV» es la de entrada; «Sin IGV» trae solo San Juan; «Excluidas» está vacía.
  await expect(separador(page, "Con IGV (4)")).toBeVisible();
  await page.getByRole("radio", { name: "Sin IGV" }).check();
  await expect(filasDeCompras(page)).toHaveCount(1);
  await expect(fila(page, "F001-1040")).toBeVisible();
  await expect(fila(page, "F001-1040")).toContainText("Con alerta: R-ISC");
  await page.getByRole("radio", { name: "Excluidas" }).check();
  await expect(filasDeCompras(page)).toHaveCount(0);
  await expect(estado(page, "Ninguna compra coincide con los filtros.")).toBeVisible();
  await page.getByRole("radio", { name: "Con IGV" }).check();
  await expect(filasDeCompras(page)).toHaveCount(4);

  // «Con alertas» y «Proveedor nuevo» dejan fuera a la clasificada.
  await page.getByRole("checkbox", { name: "Con alertas" }).check();
  await expect(filasDeCompras(page)).toHaveCount(3);
  await expect(fila(page, "F001-3064")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Con alertas" }).uncheck();
  await page.getByRole("checkbox", { name: "Proveedor nuevo" }).check();
  await expect(filasDeCompras(page)).toHaveCount(3);
  await expect(fila(page, "F001-3064")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Proveedor nuevo" }).uncheck();
  await expect(filasDeCompras(page)).toHaveCount(4);

  // Búsqueda por razón social, RUC y serie-número; sin resultados; y se limpia.
  const buscar = page.getByRole("searchbox", {
    name: "Buscar por RUC, razón social o serie-número",
  });
  await buscar.fill("CALZADO");
  await expect(filasDeCompras(page)).toHaveCount(1);
  await expect(fila(page, "F001-5070")).toBeVisible();
  await buscar.fill("20700000061");
  await expect(filasDeCompras(page)).toHaveCount(1);
  await expect(fila(page, "F001-4062")).toBeVisible();
  await buscar.fill("F001-2056");
  await expect(filasDeCompras(page)).toHaveCount(1);
  await expect(fila(page, "F001-2056")).toBeVisible();
  await buscar.fill("zzz");
  await expect(filasDeCompras(page)).toHaveCount(0);
  await expect(estado(page, "Ninguna compra coincide con los filtros.")).toBeVisible();
  await buscar.fill("");
  await expect(filasDeCompras(page)).toHaveCount(4);
  await expect(estado(page, "4 compras cargadas")).toHaveCount(1);

  // Un texto con HTML se busca como texto: no ejecuta nada (CA-6; la vigilancia revisa `window.__pwn` al final).
  await buscar.fill("<img src=x onerror=window.__pwn=1>");
  await expect(filasDeCompras(page)).toHaveCount(0);
  await expect(page.getByRole("img")).toHaveCount(0);
});

test("edición con teclado de F001-3064: cuadre en vivo, un solo «editar» y Esc descarta", async ({
  siembra,
  sesiones,
  api,
}) => {
  const { page, cliente, apiDueno } = await conCompras({ siembra, sesiones, api });
  const editar: unknown[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/compras\/[^/]+\/editar$/.test(r.url())) {
      editar.push(r.postDataJSON());
    }
  });

  await irACelda(page, "F001-3064", "biDg");
  await page.keyboard.press("Enter");
  const baseDg = page.getByLabel("Base DG de F001-3064");
  await expect(baseDg).toBeFocused();
  await page.keyboard.type("200.00");

  // Tab pasa a la celda vecina ya en edición, sin guardar; el total se recalcula al instante.
  await page.keyboard.press("Tab");
  const igvDg = page.getByLabel("IGV DG de F001-3064");
  await expect(igvDg).toBeFocused();
  const panel = page.getByRole("region", { name: "Editando F001-3064" });
  await expect(panel).toContainText("Editando F001-3064 · Total 219.50");
  expect(editar).toHaveLength(0);

  // El servidor dice que 18.00 ya no es el IGV de 200.00: la celda se marca y se explica con texto.
  await expect(panel).toContainText(
    /IGV DG: 18\.00 no es 18 % ni 10 % de 200\.00.*\(No cuadra\)/,
  );
  await expect(igvDg).toHaveAttribute("aria-invalid", "true");

  // Con 36.00 cuadra: la marca se va y el total se actualiza.
  await page.keyboard.type("36.00");
  await expect(panel).toContainText("Editando F001-3064 · Total 237.50");
  await expect(panel).not.toContainText("No cuadra");
  await expect(igvDg).not.toHaveAttribute("aria-invalid", "true");

  // Enter guarda la fila con UNA sola petición que lleva solo las celdas cambiadas.
  await page.keyboard.press("Enter");
  await expect(estado(page, "Cambios guardados.")).toHaveCount(1);
  await expect(panel).toHaveCount(0);
  expect(editar).toEqual([
    { versionBase: 1, cambios: { biDg: "200.00", igvDg: "36.00" } },
  ]);
  await expect(celda(page, "F001-3064", "biDg")).toHaveText("200.00");
  await expect(celda(page, "F001-3064", "igvDg")).toHaveText("36.00");
  await expect(celda(page, "F001-3064", "total")).toHaveText("237.50");
  await expect(totalDelResumen(page)).toHaveText([
    "1,090.19",
    "1,208.19",
    "+118.00 (aumenta)",
  ]);
  const guardada = await compraPorComprobante(apiDueno, cliente.id, PERIODO, "F001-3064");
  expect(guardada.version).toBe(2);

  // Esc descarta lo tecleado y no pide nada al servidor.
  await irACelda(page, "F001-3064", "biDg");
  await page.keyboard.press("Enter");
  await expect(baseDg).toBeFocused();
  await page.keyboard.type("999.00");
  await expect(panel).toContainText("Total 1,036.50");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(celda(page, "F001-3064", "biDg")).toHaveText("200.00");
  expect(editar).toHaveLength(1);
});

test("un monto con 3 decimales no se envía y Esc lo descarta", async ({
  siembra,
  sesiones,
  api,
}) => {
  const { page } = await conCompras({ siembra, sesiones, api });
  const editar: unknown[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/compras\/[^/]+\/editar$/.test(r.url())) {
      editar.push(r.postDataJSON());
    }
  });

  await irACelda(page, "F001-3064", "igvDg");
  await page.keyboard.press("Enter");
  const igvDg = page.getByLabel("IGV DG de F001-3064");
  await expect(igvDg).toBeFocused();
  await page.keyboard.type("36.001");
  const panel = page.getByRole("region", { name: "Editando F001-3064" });
  await expect(panel).toContainText("El monto admite como máximo 2 decimales");
  await expect(igvDg).toHaveAttribute("aria-invalid", "true");

  // Enter no envía nada y deja el cursor en la celda a corregir.
  await page.keyboard.press("Enter");
  await expect(igvDg).toBeFocused();
  expect(editar).toHaveLength(0);

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(celda(page, "F001-3064", "igvDg")).toHaveText("18.00");
  expect(editar).toHaveLength(0);
});

test("clasificar F001-3064 de DG a DNG desde el menú de acciones", async ({
  siembra,
  sesiones,
  api,
}) => {
  const { page, cliente, apiDueno } = await conCompras({ siembra, sesiones, api });
  await expect(celda(page, "F001-3064", "destino")).toContainText("DG");
  await expect(celda(page, "F001-3064", "destino")).toContainText("Por clasificar");

  const menu = await abrirMenuAcciones(page, "F001-3064");
  await menu.getByRole("menuitem", { name: "Clasificar como DNG" }).click();

  // El servidor mueve la base y el IGV al casillero DNG; la alerta de proveedor nuevo desaparece.
  await expect(estado(page, "Compra clasificada.")).toHaveCount(1);
  await expect(celda(page, "F001-3064", "destino")).toContainText("DNG");
  await expect(celda(page, "F001-3064", "destino")).toContainText("Clasificada");
  await expect(celda(page, "F001-3064", "biDg")).toHaveText("0.00");
  await expect(casilleroDelResumen(page, "Base DNG")).toHaveText([
    "0.00",
    "100.00",
    "+100.00 (aumenta)",
  ]);
  await expect(casilleroDelResumen(page, "IGV DNG")).toHaveText([
    "0.00",
    "18.00",
    "+18.00 (aumenta)",
  ]);
  await expect(fila(page, "F001-3064")).not.toContainText("Con alerta");
  await expect(alerta(page, /./)).toHaveCount(0);
  const clasificada = await compraPorComprobante(apiDueno, cliente.id, PERIODO, "F001-3064");
  expect(clasificada.version).toBe(2);
});

test("excluir y restaurar la zapatilla F001-5070 con su motivo", async ({
  siembra,
  sesiones,
  api,
}) => {
  const { page } = await conCompras({ siembra, sesiones, api });
  await expect(totalDelResumen(page)).toHaveText([
    "1,090.19",
    "1,090.19",
    "0.00 (sin cambio)",
  ]);

  const menuExcluir = await abrirMenuAcciones(page, "F001-5070");
  await menuExcluir.getByRole("menuitem", { name: "Excluir", exact: true }).click();
  const dialogo = page.getByRole("dialog", { name: "Excluir F001-5070" });
  await dialogo.getByLabel("Motivo (opcional)").fill("Gasto personal: zapatillas");
  await dialogo.getByRole("button", { name: "Excluir", exact: true }).click();

  // Sale de la lista principal y del total del periodo; aparece en «Excluidas» con su motivo.
  await expect(estado(page, "Compra excluida.")).toHaveCount(1);
  await expect(dialogo).toHaveCount(0);
  await expect(fila(page, "F001-5070")).toHaveCount(0);
  await expect(filasDeCompras(page)).toHaveCount(3);
  await expect(totalDelResumen(page)).toHaveText([
    "1,090.19",
    "913.19",
    "-177.00 (disminuye)",
  ]);
  await page.getByRole("radio", { name: "Excluidas" }).check();
  await expect(filasDeCompras(page)).toHaveCount(1);
  await expect(fila(page, "F001-5070")).toContainText("Excluida");
  await page.getByRole("button", { name: "Historial de F001-5070" }).click();
  await expect(
    page.getByRole("complementary", { name: "Historial de la compra" }).getByText("Gasto personal: zapatillas").first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cerrar", exact: true }).click();

  // Restaurar la devuelve a la lista y al total.
  const menuRestaurar = await abrirMenuAcciones(page, "F001-5070");
  await menuRestaurar.getByRole("menuitem", { name: "Restaurar" }).click();
  await expect(estado(page, "Compra restaurada.")).toHaveCount(1);
  await expect(filasDeCompras(page)).toHaveCount(0);
  await expect(totalDelResumen(page)).toHaveText([
    "1,090.19",
    "1,090.19",
    "0.00 (sin cambio)",
  ]);
  await page.getByRole("radio", { name: "Con IGV" }).check();
  await expect(fila(page, "F001-5070")).toBeVisible();
  await expect(fila(page, "F001-5070")).not.toContainText("Excluida");
});

test("agregar una compra a mano y el duplicado ofrece «Ubicar la compra existente»", async ({
  siembra,
  sesiones,
  api,
  vigilancia,
}) => {
  vigilancia.permitirError(/409/);
  const { page } = await conCompras({ siembra, sesiones, api });

  async function abrirFormulario() {
    await page.getByRole("button", { name: "Agregar compra" }).click();
    return page.getByRole("dialog", { name: "Agregar compra" });
  }

  const dialogo = await abrirFormulario();
  await dialogo.getByLabel("Serie").fill("F002");
  await dialogo.getByLabel("Número").fill("1234");
  await dialogo.getByLabel("Fecha de emisión").fill("2026-10-20");
  await dialogo.getByLabel("Documento del proveedor", { exact: true }).fill(RUCS.generico);
  await dialogo.getByLabel("Razón social").fill("=1+1 PRUEBA AGREGADA E2E");
  await dialogo.getByLabel("Base DG", { exact: true }).fill("100.00");
  await dialogo.getByLabel("IGV DG", { exact: true }).fill("18.00");
  await expect(dialogo.getByRole("status", { name: "Total" })).toHaveText("118.00");
  await dialogo.getByRole("button", { name: "Agregar", exact: true }).click();

  await expect(estado(page, "Compra agregada.")).toHaveCount(1);
  await expect(dialogo).toHaveCount(0);
  await expect(fila(page, "F002-1234")).toBeVisible();
  await expect(fila(page, "F002-1234")).toContainText("Agregada");
  // La razón social es texto, aunque empiece con «=».
  await expect(fila(page, "F002-1234")).toContainText("=1+1 PRUEBA AGREGADA E2E");
  await expect(celda(page, "F002-1234", "total")).toHaveText("118.00");

  // El resalte de la fila recién agregada se apaga solo; así el siguiente se debe al enlace «Ubicar».
  await expect(fila(page, "F002-1234")).not.toContainText("Actualizada", {
    timeout: 15_000,
  });

  // La misma clave otra vez: 409, aviso único y enlace que ubica la fila existente.
  const otra = await abrirFormulario();
  await otra.getByLabel("Serie").fill("F002");
  await otra.getByLabel("Número").fill("1234");
  await otra.getByLabel("Fecha de emisión").fill("2026-10-21");
  await otra.getByLabel("Documento del proveedor", { exact: true }).fill(RUCS.generico);
  await otra.getByLabel("Razón social").fill("OTRA RAZON");
  await otra.getByLabel("Base DG", { exact: true }).fill("10.00");
  await otra.getByLabel("IGV DG", { exact: true }).fill("1.80");
  await otra.getByRole("button", { name: "Agregar", exact: true }).click();
  const duplicado = alerta(page, "Ya existe en la propuesta");
  await expect(duplicado).toHaveCount(1);
  await duplicado.getByRole("button", { name: "Ubicar la compra existente" }).click();
  await expect(otra).toHaveCount(0);
  await expect(fila(page, "F002-1234")).toContainText("Actualizada");
  await expect(filasDeCompras(page)).toHaveCount(5);
});

/** Marca las filas con su casilla («Seleccionar F001-3064») y espera a que la barra masiva cuente todas. */
async function seleccionar(page: Page, comprobantes: string[]): Promise<void> {
  for (const c of comprobantes) {
    await page.getByRole("checkbox", { name: `Seleccionar ${c}` }).check();
  }
  await expect(
    page
      .getByRole("toolbar", { name: "Acciones sobre la selección" })
      .getByText(`${comprobantes.length} seleccionadas`),
  ).toBeVisible();
}

const barraMasiva = (page: Page) =>
  page.getByRole("toolbar", { name: "Acciones sobre la selección" });

test("masiva con informe, y Ctrl+Z / Ctrl+Y con el foco en la grilla", async ({
  siembra,
  sesiones,
  api,
}) => {
  const { page } = await conCompras({ siembra, sesiones, api });
  const masivas: { items: unknown[]; destino: string }[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/masivas/clasificar")) {
      masivas.push(r.postDataJSON());
    }
  });

  await seleccionar(page, ["F001-3064", "F001-4062", "F001-5070"]);
  await barraMasiva(page).getByRole("button", { name: "Clasificar como DNG" }).click();

  // Una sola petición con las tres; el informe cuenta las aplicadas y la pantalla lo avisa una vez.
  const informe = page.getByRole("dialog", { name: "Resultado de la acción masiva" });
  await expect(informe).toContainText("3 aplicadas");
  expect(masivas).toHaveLength(1);
  expect(masivas[0]?.items).toHaveLength(3);
  expect(masivas[0]?.destino).toBe("DNG");
  await expect(estado(page, "3 aplicadas · 0 rechazadas")).toHaveCount(1);
  await informe.getByRole("button", { name: "Cerrar" }).click();
  await expect(informe).toHaveCount(0);
  for (const c of ["F001-3064", "F001-4062", "F001-5070"]) {
    await expect(celda(page, c, "destino")).toContainText("DNG");
  }

  // Ctrl+Z en la grilla deshace la operación entera; las tres filas quedan resaltadas.
  await celda(page, "F001-2056", "comprobante").focus();
  await page.keyboard.press("Control+z");
  await expect(estado(page, "Se deshizo la operación (3 compras).")).toHaveCount(1);
  for (const c of ["F001-3064", "F001-4062", "F001-5070"]) {
    await expect(celda(page, c, "destino")).toContainText("Por clasificar");
    await expect(fila(page, c)).toContainText("Actualizada");
  }
  await expect(fila(page, "F001-2056")).not.toContainText("Actualizada");

  // Ctrl+Y la rehace.
  await page.keyboard.press("Control+y");
  await expect(estado(page, "Se rehízo la operación (3 compras).")).toHaveCount(1);
  for (const c of ["F001-3064", "F001-4062", "F001-5070"]) {
    await expect(celda(page, c, "destino")).toContainText("DNG");
  }
  expect(masivas).toHaveLength(1);
});

test("sin operación propia, Ctrl+Z no llama al servidor y el botón «Deshacer» pide confirmar", async ({
  siembra,
  sesiones,
  api,
}) => {
  const { page } = await conCompras({ siembra, sesiones, api });
  const deshacer: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/compras/deshacer")) {
      deshacer.push(r.url());
    }
  });

  await celda(page, "F001-2056", "comprobante").focus();
  await page.keyboard.press("Control+z");
  await expect(estado(page, /Se deshizo/)).toHaveCount(0);
  expect(deshacer).toHaveLength(0);

  await page.getByRole("button", { name: "Deshacer", exact: true }).click();
  const confirmar = page.getByRole("alertdialog");
  await expect(confirmar).toContainText(
    "Se deshará la última operación del periodo, aunque no la hayas hecho en esta pantalla.",
  );
  await confirmar.getByRole("button", { name: "Cancelar" }).click();
  await expect(confirmar).toHaveCount(0);
  expect(deshacer).toHaveLength(0);
});

test("masiva parcial: el informe lista la rechazada por «version_obsoleta» y recarga su fila", async ({
  siembra,
  sesiones,
  api,
}) => {
  const entorno = { siembra, sesiones, api };
  const { page, estudio, cliente } = await conCompras(entorno);
  const otra = await segundaSesion(entorno, estudio);
  const usd = await compraPorComprobante(otra, cliente.id, PERIODO, "F001-4062");
  await otra.exigir("POST", rutaAccion(cliente.id, usd.id, "clasificar"), {
    versionBase: usd.version,
    destino: "DNG",
  });

  await seleccionar(page, ["F001-3064", "F001-4062", "F001-5070"]);
  await barraMasiva(page).getByRole("button", { name: "Clasificar como DNG" }).click();

  const informe = page.getByRole("dialog", { name: "Resultado de la acción masiva" });
  await expect(informe).toContainText("2 aplicadas");
  await expect(informe).toContainText("1 rechazada");
  const rechazadas = informe.getByRole("table", { name: "Compras rechazadas" });
  await expect(rechazadas.getByRole("row")).toHaveCount(2);
  await expect(rechazadas.getByRole("row", { name: /F001-4062/ })).toContainText(
    "Otra persona la cambió; se recargó la fila.",
  );
  await expect(estado(page, "2 aplicadas · 1 rechazada")).toHaveCount(1);
  await informe.getByRole("button", { name: "Cerrar" }).click();

  // La fila rechazada se recargó con lo que dejó la otra sesión; las aplicadas quedaron en DNG.
  for (const c of ["F001-3064", "F001-4062", "F001-5070"]) {
    await expect(celda(page, c, "destino")).toContainText("DNG");
  }
  await expect(celda(page, "F001-4062", "destino")).toContainText("Clasificada");
});

test("Ctrl+Z con una fila cambiada por otra sesión: «fila_cambiada», sin reintento, y «Ver filas»", async ({
  siembra,
  sesiones,
  api,
  vigilancia,
}) => {
  vigilancia.permitirError(/409/);
  const entorno = { siembra, sesiones, api };
  const { page, estudio, cliente } = await conCompras(entorno);
  const deshacer: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/compras/deshacer")) {
      deshacer.push(r.url());
    }
  });

  await seleccionar(page, ["F001-3064", "F001-4062"]);
  await barraMasiva(page).getByRole("button", { name: "Clasificar como DNG" }).click();
  const informe = page.getByRole("dialog", { name: "Resultado de la acción masiva" });
  await expect(informe).toContainText("2 aplicadas");
  await informe.getByRole("button", { name: "Cerrar" }).click();

  // Otra persona (deshacer es por usuario: la pila de Alice no ve lo de ella) edita una de las dos filas.
  const admin = await siembra.miembro(estudio.tenantId, "admin");
  const otra = await segundaSesion(entorno, estudio, admin);
  const bolsas = await compraPorComprobante(otra, cliente.id, PERIODO, "F001-3064");
  expect(bolsas.version).toBe(2);
  await otra.exigir("POST", rutaAccion(cliente.id, bolsas.id, "editar"), {
    versionBase: bolsas.version,
    cambios: { biDng: "90.00" },
  });

  await celda(page, "F001-2056", "comprobante").focus();
  await page.keyboard.press("Control+z");
  const conflicto = alerta(page, "Otra persona cambió estas filas");
  await expect(conflicto).toHaveCount(1);
  await expect(conflicto).toContainText("F001-3064");
  await expect(conflicto).not.toContainText("F001-4062");
  expect(deshacer).toHaveLength(1);

  // «Ver filas» resalta la fila en conflicto y cierra el aviso; nada se reintenta solo.
  await conflicto.getByRole("button", { name: "Ver filas" }).click();
  await expect(conflicto).toHaveCount(0);
  await expect(fila(page, "F001-3064")).toContainText("Actualizada");
  expect(deshacer).toHaveLength(1);
  // La fila de la otra sesión no se tocó: sigue como la dejó ella.
  const sigue = await compraPorComprobante(otra, cliente.id, PERIODO, "F001-3064");
  expect(sigue.version).toBe(3);
});

test("clasificar una fila que otra sesión ya cambió: «version_obsoleta» recarga la fila", async ({
  siembra,
  sesiones,
  api,
  vigilancia,
}) => {
  vigilancia.permitirError(/409/);
  const entorno = { siembra, sesiones, api };
  const { page, estudio, cliente } = await conCompras(entorno);
  const otra = await segundaSesion(entorno, estudio);
  const zapatilla = await compraPorComprobante(otra, cliente.id, PERIODO, "F001-5070");
  await otra.exigir("POST", rutaAccion(cliente.id, zapatilla.id, "clasificar"), {
    versionBase: zapatilla.version,
    destino: "DNG",
  });
  // La pantalla sigue con la versión 1: sin clasificar.
  await expect(celda(page, "F001-5070", "destino")).toContainText("Por clasificar");

  const menu = await abrirMenuAcciones(page, "F001-5070");
  await menu.getByRole("menuitem", { name: "Clasificar como DGNG" }).click();

  const aviso = alerta(
    page,
    "Otra persona cambió esta compra. Se recargó la fila: revisa y repite.",
  );
  await expect(aviso).toHaveCount(1);
  await expect(celda(page, "F001-5070", "destino")).toContainText("DNG");
  await expect(celda(page, "F001-5070", "destino")).toContainText("Clasificada");
  // No se aplicó la clasificación vieja: el servidor sigue en la versión 2.
  const actual = await compraPorComprobante(otra, cliente.id, PERIODO, "F001-5070");
  expect(actual.version).toBe(2);
});

test("marcar el periodo como revisado y reabrirlo, con confirmación", async ({
  siembra,
  sesiones,
  api,
}) => {
  const { page } = await conCompras({ siembra, sesiones, api });
  const region = page.getByRole("region", { name: "Estado del periodo" });
  await expect(region.getByText("Abierto", { exact: true })).toBeVisible();

  await region.getByRole("button", { name: "Marcar como revisado" }).click();
  const confirmar = page.getByRole("alertdialog");
  await expect(confirmar).toContainText("¿Marcar el periodo como revisado?");
  await confirmar.getByRole("button", { name: "Confirmar" }).click();

  await expect(estado(page, "Periodo marcado como revisado.")).toHaveCount(1);
  await expect(region.getByText("Revisado", { exact: true })).toBeVisible();
  await expect(region).toContainText(/Marcado el \d{1,2}\/\d{1,2}\/\d{4} por/);
  await expect(region).toContainText("Dueño E2E");
  await expect(region.getByRole("button", { name: "Marcar como revisado" })).toHaveCount(0);
  // Quien puede aprobar y generar sigue pudiendo modificar.
  await expect(page.getByRole("button", { name: "Acciones F001-3064" })).toBeEnabled();

  await region.getByRole("button", { name: "Reabrir" }).click();
  await expect(confirmar).toContainText("¿Reabrir el periodo revisado?");
  await confirmar.getByRole("button", { name: "Confirmar" }).click();
  await expect(estado(page, "Periodo reabierto.")).toHaveCount(1);
  await expect(region.getByText("Abierto", { exact: true })).toBeVisible();
  await expect(region.getByRole("button", { name: "Marcar como revisado" })).toBeVisible();
});

test("un asistente no modifica un periodo revisado: aviso único y sin acciones", async ({
  siembra,
  sesiones,
  api,
}) => {
  const entorno = { siembra, sesiones, api };
  const { estudio, cliente, apiDueno } = await conCompras(entorno);
  const asistente = await siembra.miembro(estudio.tenantId, "asistente");
  await siembra.asignar(cliente, asistente);
  await apiDueno.exigir("POST", `${apiCompras(cliente.id, PERIODO)}/estado/revisar`, {});

  const { page } = await sesiones.paginaDe(asistente);
  await page.goto(rutaCompras(cliente.id, PERIODO));
  await expect(filasDeCompras(page)).toHaveCount(4);

  const aviso = estado(
    page,
    "El periodo está revisado: solo quien puede aprobar y generar lo modifica.",
  );
  await expect(aviso).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Reabrir" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Agregar compra" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Acciones F001-3064" })).toBeDisabled();

  // Enter sobre una celda de monto no abre la edición.
  await irACelda(page, "F001-3064", "biDg");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Base DG de F001-3064")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Editando F001-3064" })).toHaveCount(0);
});

test("canarios: la razón social y el motivo se ven como texto y el Excel los guarda como texto", async ({
  siembra,
  sesiones,
  api,
}, testInfo) => {
  const { page, cliente, apiDueno } = await conCompras({ siembra, sesiones, api });
  const base = apiCompras(cliente.id, PERIODO);
  const CANARIO_IMG = "<img src=x onerror=window.__pwn=1>";
  const MOTIVO = `=1+1 ${CANARIO_IMG}`;
  const agregar = (numero: string, razonSocial: string) =>
    apiDueno.exigir<{ fila: { id: string; version: number } }>("POST", base, {
      tipo: "01",
      serie: "F003",
      numero,
      proveedor: { tipo: "6", numero: RUCS.generico, razonSocial },
      fecha: "2026-10-20",
      moneda: "PEN",
      montos: { biDg: "100.00", igvDg: "18.00" },
    });
  await agregar("1", "=1+1");
  await agregar("2", CANARIO_IMG);
  // Una agregada a mano no se excluye (equivale a descartarla): el motivo va en la zapatilla del SIRE.
  const zapatilla = await compraPorComprobante(apiDueno, cliente.id, PERIODO, "F001-5070");
  await apiDueno.exigir("POST", rutaAccion(cliente.id, zapatilla.id, "excluir"), {
    versionBase: zapatilla.version,
    motivo: MOTIVO,
  });
  await page.reload();
  await expect(filasDeCompras(page)).toHaveCount(5);

  // En pantalla es texto: ni se evalúa «=1+1» ni se inyecta una imagen.
  await expect(fila(page, "F003-1")).toContainText("=1+1");
  await expect(fila(page, "F003-2")).toContainText(CANARIO_IMG);
  await expect(page.getByRole("img")).toHaveCount(0);
  expect(await page.evaluate(() => "__pwn" in window && window.__pwn !== undefined)).toBe(false);
  await page.getByRole("radio", { name: "Excluidas" }).check();
  await expect(filasDeCompras(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Historial de F001-5070" }).click();
  const historial = page.getByRole("complementary", { name: "Historial de la compra" });
  await expect(historial.getByText(MOTIVO, { exact: true })).toHaveCount(2);
  await expect(page.getByRole("img")).toHaveCount(0);
  await historial.getByRole("button", { name: "Cerrar" }).click();

  // El Excel del periodo lleva ambos textos neutralizados, como texto y sin una sola fórmula.
  const descarga = page.waitForEvent("download");
  await page.getByRole("button", { name: "Exportar a Excel" }).click();
  const archivo = await descarga;
  expect(archivo.suggestedFilename()).toBe(`compras-${PERIODO}.xlsx`);
  const ruta = testInfo.outputPath("compras.xlsx");
  await archivo.saveAs(ruta);
  const hoja = (n: number): string =>
    execFileSync("unzip", ["-p", ruta, `xl/worksheets/sheet${n}.xml`], {
      encoding: "utf8",
    });
  const vigentes = hoja(1);
  const excluidas = hoja(2);
  expect(vigentes).toContain('t="inlineStr"><is><t xml:space="preserve">\'=1+1</t>');
  expect(vigentes).toContain("&lt;img src=x onerror=window.__pwn=1&gt;");
  expect(vigentes).not.toContain("<img");
  expect(vigentes).not.toContain("<f>");
  expect(vigentes).not.toContain("<f ");
  expect(excluidas).toContain(
    "'=1+1 &lt;img src=x onerror=window.__pwn=1&gt;",
  );
  expect(excluidas).not.toContain("<img");
  expect(excluidas).not.toContain("<f>");
});
