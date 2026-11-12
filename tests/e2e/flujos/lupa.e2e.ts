// E-07 · Lupa XML (spec 018; HU-20 a 24; CA-2, CA-8, CA-10). Caso feliz: abrir con Enter, recorrer con ← →, Esc y
// foco devuelto, aceptar R-MIX (8.97) y R-ISC (San Juan 770.00) y descargar el XML. Caso de error: el centinela 8
// deja «XML no disponible» con «Subir XML», y un XML ajeno se rechaza (422). Además, los defectos de pantalla que
// 016 T24a corrigió (foco tras «Reintentar», error de la subida anterior, «Editar» en la lupa), vistos en el navegador.
import { readFileSync } from "node:fs";
import { RAIZ } from "../soporte/pila/entorno.js";
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
} from "../soporte/fixtures.js";
import type { Siembra } from "../soporte/siembra.js";
import {
  COLUMNAS,
  abrirLupaConEnter,
  abrirMenuAcciones,
  botonLupa,
  comprobarComparacion,
  esperarXmlDescargados,
  lupaAbierta,
  lupaDe,
  rutaCompras,
} from "../soporte/selectores/lupa.js";

test.setTimeout(90_000);

/** Cliente de fixtures con las compras de 202610 ya descargadas y sus XML simulados guardados. */
async function prepararCompras(
  siembra: Siembra,
  sesiones: Sesiones,
  api: (s: Sesion) => Api,
): Promise<{ estudio: Estudio; cliente: Cliente }> {
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId);
  const llamadas = api(await sesiones.entrar(estudio.dueno));
  await llamadas.cargarCredenciales(cliente.id);
  await llamadas.descargar(cliente.id, PERIODO);
  await esperarXmlDescargados(llamadas, cliente.id);
  return { estudio, cliente };
}

const fixtureXml = (nombre: string): Buffer =>
  readFileSync(`${RAIZ}/fixtures/xml/${nombre}`);

test.describe("E-07 · lupa XML", () => {
  test("Enter abre la lupa, ← → recorren las compras y Esc devuelve el foco", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const { estudio, cliente } = await prepararCompras(siembra, sesiones, api);
    const { page } = await sesiones.paginaDe(estudio.dueno);
    await page.goto(rutaCompras(cliente.id, PERIODO));

    const lupa = await abrirLupaConEnter(page, "F001-2056");
    await expect(lupa).toBeFocused();
    await expect(lupa.getByText("XML simulado")).toBeVisible();
    await expect(lupa.getByText("Compra 1 de 4")).toBeVisible();

    // ← no pasa del primero; → recorre en el orden de la grilla y ← vuelve.
    await page.keyboard.press("ArrowLeft");
    await expect(lupa).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(lupaDe(page, "F001-3064")).toBeVisible();
    await expect(lupaAbierta(page).getByText("Compra 2 de 4")).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(lupaDe(page, "F001-2056")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(lupaAbierta(page)).toBeHidden();
    await expect(botonLupa(page, "F001-2056")).toBeFocused();
  });

  test("aceptar R-MIX (8.97) y R-ISC de San Juan (770.00) desde la lupa", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const { estudio, cliente } = await prepararCompras(siembra, sesiones, api);
    const { page } = await sesiones.paginaDe(estudio.dueno);
    await page.goto(rutaCompras(cliente.id, PERIODO));

    // Mixta: 21.48 con IGV 1.61 -> gravado 8.97 y no gravado 12.51.
    const mixta = await abrirLupaConEnter(page, "F001-2056");
    await comprobarComparacion(mixta, COLUMNAS.bi, "21.48", "8.97", "Difiere");
    await comprobarComparacion(
      mixta,
      COLUMNAS.noGravado,
      "0.00",
      "12.51",
      "Difiere",
    );
    await expect(mixta.getByText("R-MIX · Compra mixta").first()).toBeVisible();

    await mixta.getByRole("button", { name: "Aceptar sugerencias" }).click();
    const sugerencias = page.getByRole("dialog", {
      name: "Aceptar sugerencias F001-2056",
    });
    await sugerencias.getByRole("button", { name: "Aceptar R-MIX" }).click();

    await expect(estado(page, "Sugerencia aceptada.")).toHaveCount(1);
    await expect(alerta(page, /./)).toHaveCount(0);
    await comprobarComparacion(mixta, COLUMNAS.bi, "8.97", "8.97", "Coincide");
    await comprobarComparacion(mixta, COLUMNAS.igv, "1.61", "1.61", "Coincide");
    await comprobarComparacion(
      mixta,
      COLUMNAS.noGravado,
      "12.51",
      "12.51",
      "Coincide",
    );
    await comprobarComparacion(
      mixta,
      COLUMNAS.total,
      "23.09",
      "23.09",
      "Coincide",
    );
    await page.keyboard.press("Escape");
    await expect(lupaAbierta(page)).toBeHidden();

    // San Juan: el ISC 770.00 va en DG; con el XML se mueve a su columna.
    await page.getByRole("radio", { name: "Sin IGV" }).check();
    const sanJuan = await abrirLupaConEnter(page, "F001-1040");
    await comprobarComparacion(
      sanJuan,
      COLUMNAS.isc,
      "0.00",
      "770.00",
      "Difiere",
    );

    await sanJuan.getByRole("button", { name: "Aceptar sugerencias" }).click();
    await page
      .getByRole("dialog", { name: "Aceptar sugerencias F001-1040" })
      .getByRole("button", { name: "Aceptar R-ISC" })
      .click();
    await expect(estado(page, "Sugerencia aceptada.")).toHaveCount(1);
    await comprobarComparacion(
      sanJuan,
      COLUMNAS.isc,
      "770.00",
      "770.00",
      "Coincide",
    );
    await comprobarComparacion(
      sanJuan,
      COLUMNAS.bi,
      "0.00",
      "0.00",
      "Coincide",
    );
  });

  test("una acción de la fila desde la lupa (clasificar) deja el foco dentro: Esc la cierra", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const { estudio, cliente } = await prepararCompras(siembra, sesiones, api);
    const { page } = await sesiones.paginaDe(estudio.dueno);
    await page.goto(rutaCompras(cliente.id, PERIODO));

    const lupa = await abrirLupaConEnter(page, "F001-3064");
    await abrirMenuAcciones(lupa, "F001-3064");
    await page.getByRole("menuitem", { name: "Clasificar como DNG" }).click();
    await expect(estado(page, "Compra clasificada.")).toHaveCount(1);
    await expect(
      lupa.getByRole("button", { name: "Acciones F001-3064" }),
    ).toBeEnabled();

    // RF-096: el botón pulsado se deshabilita mientras guarda; el foco no puede quedar en <body>.
    await page.keyboard.press("Escape");
    await expect(lupaAbierta(page)).toBeHidden();
    await expect(botonLupa(page, "F001-3064")).toBeFocused();
  });

  test("«Descargar XML» baja el mismo archivo de la fixture", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const { estudio, cliente } = await prepararCompras(siembra, sesiones, api);
    const { page } = await sesiones.paginaDe(estudio.dueno);
    await page.goto(rutaCompras(cliente.id, PERIODO));

    const lupa = await abrirLupaConEnter(page, "F001-3064");
    const [descarga] = await Promise.all([
      page.waitForEvent("download"),
      lupa.getByRole("button", { name: "Descargar XML" }).click(),
    ]);
    expect(descarga.suggestedFilename()).toBe("20700000053-01-F001-3064.xml");
    const ruta = await descarga.path();
    expect(
      readFileSync(ruta).equals(fixtureXml("20700000053-01-F001-3064.xml")),
    ).toBe(true);
  });

  test("«Editar» cierra la lupa y abre la fila en edición", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const { estudio, cliente } = await prepararCompras(siembra, sesiones, api);
    const { page } = await sesiones.paginaDe(estudio.dueno);
    await page.goto(rutaCompras(cliente.id, PERIODO));

    const lupa = await abrirLupaConEnter(page, "F001-4062");
    await lupa.getByRole("button", { name: "Editar" }).click();

    await expect(lupaAbierta(page)).toBeHidden();
    await expect(
      page.getByRole("region", { name: "Editando F001-4062" }),
    ).toBeVisible();
  });
});

test.describe("E-07 · XML no disponible y XML ajeno", () => {
  /** Una compra agregada con número que termina en 8: el mock de XML responde «no encontrado» (centinela 8). */
  async function conCentinela8(
    siembra: Siembra,
    sesiones: Sesiones,
    api: (s: Sesion) => Api,
  ) {
    const estudio = await siembra.estudio();
    const cliente = await siembra.cliente(estudio.tenantId);
    const llamadas = api(await sesiones.entrar(estudio.dueno));
    await llamadas.exigir(
      "POST",
      `/clientes/${cliente.id}/periodos/${PERIODO}/compras`,
      {
        tipo: "01",
        serie: "F001",
        numero: "6008",
        proveedor: {
          tipo: "6",
          numero: RUCS.generico,
          razonSocial: "PRUEBA PROVEEDOR CENTINELA S.A.C.",
        },
        fecha: "2026-10-15",
        moneda: "PEN",
        montos: { biDg: "100.00", igvDg: "18.00" },
      },
    );
    const { page } = await sesiones.paginaDe(estudio.dueno);
    await page.goto(rutaCompras(cliente.id, PERIODO));
    return { page };
  }

  test("centinela 8: «XML no disponible» con «Reintentar» y «Subir XML»; el foco sigue en la lupa", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const { page } = await conCentinela8(siembra, sesiones, api);
    const lupa = await abrirLupaConEnter(page, "F001-6008");

    await expect(
      lupa.getByText("El XML de este comprobante aún no se solicitó."),
    ).toBeVisible();
    await lupa.getByRole("button", { name: "Obtener XML" }).click();

    await expect(lupa.getByText("XML no disponible")).toBeVisible();
    await expect(
      lupa.getByText("SUNAT no entregó el XML de este comprobante."),
    ).toBeVisible();
    const reintentar = lupa.getByRole("button", { name: "Reintentar" });
    await expect(reintentar).toBeEnabled();
    await expect(lupa.getByText("Subir XML")).toBeVisible();

    // 016 T24a P-1: tras «Reintentar» el foco no se pierde; Esc sigue cerrando la lupa.
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          /\/xml\/obtener$/.test(new URL(r.url()).pathname),
      ),
      reintentar.click(),
    ]);
    await expect(lupa.getByText("XML no disponible")).toBeVisible();
    await expect(reintentar).toBeEnabled();
    await expect(lupa).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(lupaAbierta(page)).toBeHidden();
  });

  test("un XML ajeno se rechaza con 422 y el error de la subida anterior no queda junto al de tamaño", async ({
    siembra,
    sesiones,
    api,
    vigilancia,
  }) => {
    vigilancia.permitirError(/status of 422/);
    const { page } = await conCentinela8(siembra, sesiones, api);
    const lupa = await abrirLupaConEnter(page, "F001-6008");
    await lupa.getByRole("button", { name: "Obtener XML" }).click();
    await expect(lupa.getByText("XML no disponible")).toBeVisible();

    // El XML de otro comprobante (F001-3064 del RUC 20700000053).
    const [respuesta] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          /\/compras\/[^/]+\/xml$/.test(new URL(r.url()).pathname),
      ),
      lupa.getByLabel("Subir XML").setInputFiles({
        name: "ajeno.xml",
        mimeType: "text/xml",
        buffer: fixtureXml("20700000053-01-F001-3064.xml"),
      }),
    ]);
    expect(respuesta.status()).toBe(422);
    await expect(
      alerta(page, /^El XML no corresponde a este comprobante: no coincide /),
    ).toHaveCount(1);
    await expect(lupa.getByText("XML no disponible")).toBeVisible();

    // 016 T24a P-2: un archivo de más de 1 MiB se rechaza en la pantalla y limpia el error anterior.
    await lupa.getByLabel("Subir XML").setInputFiles({
      name: "enorme.xml",
      mimeType: "text/xml",
      buffer: Buffer.alloc(1024 * 1024 + 1, 0x20),
    });
    await expect(
      alerta(page, "El archivo pesa más de 1 MiB: no se envió."),
    ).toHaveCount(1);
    await expect(alerta(page, /^El XML no corresponde/)).toHaveCount(0);
  });
});
