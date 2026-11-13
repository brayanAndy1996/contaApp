// E-07 · Reglas aprendidas (spec 021, T22; HU-28, RF-110, RF-111; CA-1 a CA-3, CA-14). Un cliente cuyo RUC no tiene
// fixture propio recibe del mock el conjunto genérico (F001-6010 y F001-6012, del mismo proveedor X) en cualquier
// periodo. Flujo: clasificar una fila de X en DNG con el teclado → «Recordar» con Alt+R → descargar el periodo
// siguiente → filas de X «Según historial» → filtro → masiva a DG → la etiqueta sale y el resumen se actualiza.
import {
  PERIODO,
  RUCS,
  estado,
  expect,
  test,
} from "../soporte/fixtures.js";
import {
  casilleroDelResumen,
  celda,
  compraPorComprobante,
  fila,
  filasDeCompras,
  grilla,
  rutaCompras,
} from "../soporte/selectores/compras.js";
import {
  apiReglas,
  avisoRecordar,
  botonRecordar,
  etiquetaSegunHistorial,
  filtroSegunHistorial,
} from "../soporte/selectores/reglas.js";

const SIGUIENTE = "202611";
const COMPRAS = ["F001-6010", "F001-6012"] as const;

interface ReglaApi {
  readonly destino: string;
  readonly activa: boolean;
  readonly proveedor: { readonly numero: string };
}

test("«Recordar» → descarga siguiente → «Según historial» → filtro → masiva a DG revierte", async ({
  siembra,
  sesiones,
  api,
}) => {
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId, { ruc: RUCS.mixta });
  const { page, sesion } = await sesiones.paginaDe(estudio.dueno);
  const apiDueno = api(sesion);
  await apiDueno.cargarCredenciales(cliente.id);
  await apiDueno.descargar(cliente.id, PERIODO);
  await page.goto(rutaCompras(cliente.id, PERIODO));
  await expect(filasDeCompras(page)).toHaveCount(2);
  await expect(celda(page, COMPRAS[0], "destino")).toContainText("DG");

  // CA-1 · Clasificar F001-6010 en DNG solo con el teclado: celda de acciones → menú → «Clasificar como DNG».
  await celda(page, COMPRAS[0], "comprobante").focus();
  await page.keyboard.press("End");
  await expect(celda(page, COMPRAS[0], "acciones")).toBeFocused();
  await page.keyboard.press("Enter");
  const boton = page.getByRole("button", { name: `Acciones ${COMPRAS[0]}` });
  await expect(boton).toBeFocused();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: `Acciones ${COMPRAS[0]}` });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  // Una fila por clasificar ofrece DG, DGNG y DNG: dos flechas llevan a DNG.
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Clasificar como DGNG" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Clasificar como DNG" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(estado(page, "Compra clasificada.")).toHaveCount(1);
  await expect(celda(page, COMPRAS[0], "destino")).toContainText("DNG");

  // El aviso se ofrece sin quitar el foco del flujo de teclado y declara su atajo; Alt+R lo acepta.
  await expect(avisoRecordar(page)).toBeVisible();
  await expect(botonRecordar(page)).toHaveAttribute("aria-keyshortcuts", "Alt+R");
  await expect(botonRecordar(page)).not.toBeFocused();
  await page.keyboard.press("Alt+r");
  await expect(
    estado(page, "Regla guardada. Se aplicará en las próximas descargas de este proveedor."),
  ).toHaveCount(1);
  await expect(avisoRecordar(page)).toHaveCount(0);
  const reglas = await apiDueno.exigir<ReglaApi[]>("GET", apiReglas(cliente.id));
  expect(reglas).toHaveLength(1);
  expect(reglas[0]).toMatchObject({ destino: "DNG", activa: true });
  // La compra del periodo ya clasificado no se mueve sola (R-HIS solo mira periodos posteriores al aprendido).
  await expect(etiquetaSegunHistorial(page, COMPRAS[1])).toHaveCount(0);
  await expect(celda(page, COMPRAS[1], "destino")).toContainText("DG");

  // CA-2 · El periodo siguiente: sus dos compras de X llegan en DNG, con la etiqueta y en versión 2.
  await apiDueno.descargar(cliente.id, SIGUIENTE);
  await page.goto(rutaCompras(cliente.id, SIGUIENTE));
  await expect(filasDeCompras(page)).toHaveCount(2);
  for (const c of COMPRAS) {
    await expect(celda(page, c, "destino")).toContainText("DNG");
    await expect(etiquetaSegunHistorial(page, c)).toBeVisible();
    const compra = await compraPorComprobante(apiDueno, cliente.id, SIGUIENTE, c);
    expect(compra.version).toBe(2);
  }
  await expect(casilleroDelResumen(page, "Base DNG")).toHaveText([
    "0.00",
    "280.00",
    "+280.00 (aumenta)",
  ]);
  await expect(casilleroDelResumen(page, "Base DG")).toHaveText([
    "280.00",
    "0.00",
    "-280.00 (disminuye)",
  ]);

  // El filtro «Según historial» deja las dos filas de X.
  await filtroSegunHistorial(page).check();
  await expect(filasDeCompras(page)).toHaveCount(2);

  // CA-3 · Masiva a DG sobre las filas «Según historial»: otra versión con el destino elegido, sin etiqueta.
  for (const c of COMPRAS) {
    await page.getByRole("checkbox", { name: `Seleccionar ${c}` }).check();
  }
  const barra = page.getByRole("toolbar", { name: "Acciones sobre la selección" });
  await expect(barra.getByText("2 seleccionadas")).toBeVisible();
  await barra.getByRole("button", { name: "Clasificar como DG", exact: true }).click();
  const informe = page.getByRole("dialog", { name: "Resultado de la acción masiva" });
  await expect(informe).toContainText("2 aplicadas");
  await informe.getByRole("button", { name: "Cerrar" }).click();
  await expect(informe).toHaveCount(0);

  // Con el filtro puesto, las filas ya no cumplen: salen del listado. Sin él, siguen en DG y sin etiqueta.
  await filtroSegunHistorial(page).uncheck();
  await expect(filasDeCompras(page)).toHaveCount(2);
  for (const c of COMPRAS) {
    await expect(celda(page, c, "destino")).toContainText("DG");
    await expect(celda(page, c, "destino")).toContainText("Clasificada");
    await expect(fila(page, c)).not.toContainText("Según historial");
    const compra = await compraPorComprobante(apiDueno, cliente.id, SIGUIENTE, c);
    expect(compra.version).toBe(3);
  }
  await expect(grilla(page).getByText("Según historial", { exact: true })).toHaveCount(0);
  await expect(casilleroDelResumen(page, "Base DNG")).toHaveText([
    "0.00",
    "0.00",
    "0.00 (sin cambio)",
  ]);
  await expect(casilleroDelResumen(page, "Base DG")).toHaveText([
    "280.00",
    "280.00",
    "0.00 (sin cambio)",
  ]);

  // La regla sigue ahí: revertir las compras no la borra ni la cambia.
  const despues = await apiDueno.exigir<ReglaApi[]>("GET", apiReglas(cliente.id));
  expect(despues).toHaveLength(1);
  expect(despues[0]).toMatchObject({ destino: "DNG", activa: true });
});
