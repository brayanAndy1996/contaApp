// E-15 · Gastos no deducibles (spec 027, T21; HU-41, HU-42, RF-116 a RF-118; CA-1, CA-3, CA-9, CA-12, CA-17). Con el
// cliente 20700000002 (ferretería, CIIU 4752 en `fixtures/ruc/ciiu.json`), el mock del SIRE (compras de 2026-10) con sus
// XML simulados y el worker real. La compra F001-5070 es de «PRUEBA PROVEEDOR CALZADO» (CIIU 4771) con la glosa «Par de
// zapatillas deportivas de prueba».
//  1. Descarga de compras → XML de F001-5070 → chip «Posible gasto no deducible» → lupa con las señales «palabra clave:
//     zapatilla», «rubro del proveedor no relacionado» y «categoría no permitida para el giro» → excluir con motivo →
//     «Aprender estas palabras» propone «deportivas», se corrige a «deportiva» en calzado-ropa → «Volver a evaluar» marca
//     otra compra del periodo (F001-5071, agregada desde un XML con «deportiva») sin crear versiones.
//  2. Lectura ve el chip y la lupa con las señales, sin «Volver a evaluar» ni acciones de escritura.
// El XML del mock no trae otra compra con la palabra aprendida: se siembra la segunda subiendo un XML (016).
import { readFileSync } from "node:fs";
import { RAIZ } from "../soporte/pila/entorno.js";
import {
  PERIODO,
  RUCS,
  expect,
  test,
  type Api,
  type Cliente,
} from "../soporte/fixtures.js";
import {
  apiCompras,
  compraPorComprobante,
  fila,
  rutaCompras,
} from "../soporte/selectores/compras.js";
import {
  abrirLupaConEnter,
  abrirMenuAcciones as abrirMenuAccionesLupa,
  esperarXmlDescargados,
} from "../soporte/selectores/lupa.js";
import {
  agregarCompraDesdeXml,
  apiGastos,
  botonVolverAEvaluar,
  chipGasto,
  dialogoAprender,
  listaSenales,
} from "../soporte/selectores/gastos.js";

test.setTimeout(120_000);

const MOTIVO = "Gasto personal: zapatillas";
const PALABRA_APRENDIDA = "deportiva";
const OTRA = "F001-5071";

/**
 * El XML de F001-5070 convertido en otra compra, con otra glosa («maleta deportiva», palabra fuera del diccionario base) y
 * del proveedor genérico 20700000096, cuyo CIIU el mock no informa: sin S2 ni S3 ni S1 solo suma S5 (1), bajo el umbral
 * (3). Con un proveedor con CIIU de consumo personal (S2 + S5) la compra ya saldría marcada y «Volver a evaluar» no se vería.
 */
function xmlDeOtraCompra(): string {
  const original = readFileSync(
    `${RAIZ}/fixtures/xml/20700000070-01-F001-5070.xml`,
    "utf8",
  );
  const xml = original
    .replaceAll("F001-5070", OTRA)
    .replaceAll("20700000070", "20700000096")
    .replace(
      "Par de zapatillas deportivas de prueba (PRUEBA)",
      "Maleta deportiva de prueba (PRUEBA)",
    );
  expect(xml).toContain(OTRA);
  expect(xml).not.toContain("zapatillas deportivas");
  return xml;
}

/** Cliente de fixtures con las compras de 2026-10 descargadas y sus XML (y CIIU) procesados por el worker. */
async function prepararCompras(
  llamadas: Api,
  cliente: Cliente,
): Promise<void> {
  await llamadas.cargarCredenciales(cliente.id);
  await llamadas.descargar(cliente.id, PERIODO);
  await esperarXmlDescargados(llamadas, cliente.id);
}

test("zapatillas → chip y lupa → excluir → aprender → volver a evaluar marca otra compra", async ({
  siembra,
  sesiones,
  api,
}) => {
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId, {
    ruc: RUCS.contribuyente,
  });
  const { page, sesion } = await sesiones.paginaDe(estudio.dueno);
  const llamadas = api(sesion);
  await prepararCompras(llamadas, cliente);

  // Otra compra del periodo con la glosa «maleta deportiva»: aún sin la palabra en el diccionario, no se marca.
  expect(
    await agregarCompraDesdeXml(
      llamadas,
      cliente.id,
      PERIODO,
      xmlDeOtraCompra(),
      "DG",
    ),
  ).toBe(201);
  const otraAntes = await compraPorComprobante(
    llamadas,
    cliente.id,
    PERIODO,
    OTRA,
  );

  await test.step("la zapatilla F001-5070 sale con el chip «Posible gasto no deducible»; la compra sembrada, sin chip (CA-1)", async () => {
    await page.goto(rutaCompras(cliente.id, PERIODO));
    await expect(chipGasto(page, "F001-5070")).toBeVisible();
    await expect(chipGasto(page, "F001-5070")).toHaveText(
      /^Posible gasto no deducible · \d+ puntos$/,
    );
    await expect(fila(page, OTRA)).toBeVisible();
    await expect(chipGasto(page, OTRA)).toHaveCount(0);
  });

  await test.step("la lupa de F001-5070 lista las tres señales con su puntaje (CA-1)", async () => {
    const lupa = await abrirLupaConEnter(page, "F001-5070");
    const senales = listaSenales(lupa);
    await expect(senales).toBeVisible();
    await expect(
      senales.getByText("Palabra clave: zapatilla (1 de 1 ítems)"),
    ).toBeVisible();
    await expect(
      senales.getByText("Rubro del proveedor no relacionado"),
    ).toBeVisible();
    await expect(
      senales.getByText("Categoría no permitida para el giro: calzado-ropa"),
    ).toBeVisible();
    // S1 +3, S2 +3 y S3 +2 = 8; con proveedor nuevo para el cliente (S5) son 9.
    await expect(senales.getByText("+3", { exact: true })).toHaveCount(2);
    await expect(senales.getByText("+2", { exact: true })).toHaveCount(1);
    await expect(lupa.getByText(/^Puntaje: (8|9)$/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(lupa).toBeHidden();
  });

  await test.step("excluir con motivo y «Aprender estas palabras»: «deportivas» se corrige a «deportiva» en calzado-ropa (CA-9)", async () => {
    // Se excluye desde la lupa: desde el menú de la fila la compra sale de la lista y el diálogo de aprender se desmonta
    // antes de verse (defecto de pantalla informado en T21, no se corrige aquí).
    const lupa = await abrirLupaConEnter(page, "F001-5070");
    await abrirMenuAccionesLupa(lupa, "F001-5070");
    await page.getByRole("menuitem", { name: "Excluir", exact: true }).click();
    const excluir = page.getByRole("dialog", { name: "Excluir F001-5070" });
    await excluir.getByLabel("Motivo (opcional)").fill(MOTIVO);
    await excluir.getByRole("button", { name: "Excluir", exact: true }).click();

    const aprender = dialogoAprender(page);
    await expect(aprender).toBeVisible();
    // Se propone la palabra de la glosa que no estaba en el diccionario; «zapatillas» ya está y no se repite.
    const terminos = aprender.getByRole("textbox");
    await expect(terminos.first()).toBeVisible();
    const valores = await terminos.evaluateAll((campos) =>
      campos.map((c) => (c as HTMLInputElement).value),
    );
    expect(valores).toContain("deportivas");
    expect(valores).not.toContain("zapatillas");
    const i = valores.indexOf("deportivas") + 1;

    // Sin marcar ni elegir categoría no se guarda.
    await aprender.getByRole("button", { name: "Aprender palabras" }).click();
    await expect(aprender.getByText("Marca al menos una palabra.")).toBeVisible();
    await aprender.getByLabel(`Incluir el término ${i}`, { exact: true }).check();
    await aprender.getByRole("button", { name: "Aprender palabras" }).click();
    await expect(
      aprender.getByText("Elige una categoría para cada palabra marcada."),
    ).toBeVisible();

    await aprender.getByLabel(`Término ${i}`, { exact: true }).fill(PALABRA_APRENDIDA);
    await aprender
      .getByLabel(`Categoría del término ${i}`, { exact: true })
      .selectOption("calzado-ropa");
    await aprender.getByRole("button", { name: "Aprender palabras" }).click();
    await expect(
      aprender.getByText(`Palabras aprendidas: ${PALABRA_APRENDIDA}.`),
    ).toBeVisible();
    await aprender.getByRole("button", { name: "Cerrar", exact: true }).click();
    await expect(aprender).toHaveCount(0);
    await lupa.getByRole("button", { name: "Cerrar comprobante" }).click();
    await expect(lupa).toBeHidden();

    // La zapatilla excluida quedó en «Excluidas» con su motivo; la API da la versión excluida (nunca por el sistema solo).
    await page.getByRole("radio", { name: "Excluidas" }).check();
    await expect(fila(page, "F001-5070")).toContainText("Excluida");
    const excluida = await compraPorComprobante(
      llamadas,
      cliente.id,
      PERIODO,
      "F001-5070",
    );
    expect(excluida.excluida).toBe(true);
    // Aprender de nuevo lo mismo omite la palabra (ya existe) y no falla.
    const repetida = await llamadas.exigir<{
      guardadas: string[];
      omitidas: string[];
    }>("POST", `${apiGastos(cliente.id, PERIODO)}/aprender/${excluida.id}`, {
      terminos: [{ termino: PALABRA_APRENDIDA, categoria: "calzado-ropa" }],
    });
    expect(repetida.guardadas).toEqual([]);
    expect(repetida.omitidas).toEqual([PALABRA_APRENDIDA]);
  });

  await test.step("«Volver a evaluar» marca F001-5071 sin crear versiones (CA-12)", async () => {
    await page.getByRole("radio", { name: "Con IGV" }).check();
    // Los hallazgos guardados no cambian solos (R-8): la otra compra sigue sin chip hasta volver a evaluar.
    await expect(fila(page, OTRA)).toBeVisible();
    await expect(chipGasto(page, OTRA)).toHaveCount(0);

    await botonVolverAEvaluar(page).click();
    await expect(page.getByText("Compras evaluadas de nuevo.")).toBeVisible({
      timeout: 30_000,
    });
    await expect(chipGasto(page, OTRA)).toBeVisible();

    const lupa = await abrirLupaConEnter(page, OTRA);
    await expect(
      listaSenales(lupa).getByText(
        `Palabra clave: ${PALABRA_APRENDIDA} (1 de 1 ítems)`,
      ),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    // La evaluación nueva no mueve la versión vigente ni excluye sola (R-1, CA-3).
    const otraDespues = await compraPorComprobante(
      llamadas,
      cliente.id,
      PERIODO,
      OTRA,
    );
    expect(otraDespues.version).toBe(otraAntes.version);
    expect(otraDespues.excluida).toBe(false);
    const lista = await llamadas.exigir<{ filas: { excluida: boolean }[] }>(
      "GET",
      `${apiCompras(cliente.id, PERIODO)}?vista=excluidas&limite=100`,
    );
    expect(lista.filas).toHaveLength(1);
  });
});

test("Lectura ve el chip y las señales sin botones de escritura", async ({
  siembra,
  sesiones,
  api,
}) => {
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId, {
    ruc: RUCS.contribuyente,
  });
  const lectura = await siembra.miembro(estudio.tenantId, "lectura");
  await siembra.asignar(cliente, lectura);
  await prepararCompras(api(await sesiones.entrar(estudio.dueno)), cliente);

  const { page } = await sesiones.paginaDe(lectura);
  await page.goto(rutaCompras(cliente.id, PERIODO));
  await expect(chipGasto(page, "F001-5070")).toBeVisible();
  const lupa = await abrirLupaConEnter(page, "F001-5070");
  await expect(
    listaSenales(lupa).getByText("Palabra clave: zapatilla (1 de 1 ítems)"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(lupa).toBeHidden();

  // Sin «Volver a evaluar», sin menú de acciones (excluir, clasificar) ni «Aprender estas palabras».
  await expect(botonVolverAEvaluar(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Acciones / })).toHaveCount(0);
  await expect(dialogoAprender(page)).toHaveCount(0);
});
