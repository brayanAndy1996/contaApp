// E-14 · Prorrata e IGV estimado (spec 026, T21; HU-35, HU-36, RF-130, RF-133, RF-135; CA-1, CA-3 a CA-6, CA-12). Con el
// mock de SOL (`fixtures/sol/pdt621/20700000002.json`: 11 meses declarados 2025-11 a 2026-09, 2026-10 sin declarar, una
// rectificatoria en 2026-06 y prorrata usada «72.00» solo en 2026-09), el mock del SIRE (ventas y compras de 2026-10 del mismo
// cliente) y el worker real.
//  1. Mes 2026-10: «Obtener declaraciones» → el trabajo termina → 10 «Declarado», 1 «Rectificatoria» y 2026-10 «SIRE» →
//     coeficiente 73,14 % «provisional» → IGV estimado con sus componentes (compras en DG, DGNG y DNG) y «A pagar» → una segunda
//     obtención no duplica filas.
//  2. Mes 2026-09: falta 2025-10 (el PDT no lo trae) → no se calcula y se lista → «Ingresar a mano» con motivo → coeficiente
//     73,36 % → prorrata usada del PDT (72,00 %) distinta → alerta con ambos valores; sin ventas de 2026-09 no se estima el IGV.
//  3. Lectura ve la pantalla completa sin botones de escritura.
// El mes 2026-10 no está en el PDT del fixture, así que no hace falta borrar nada del mock para que falte un mes: 2025-10
// queda fuera del PDT en la ventana de 2026-09. Cálculo a mano (ver cada bloque): ventas gravadas del PDT 1.237.800,00 y no
// gravadas 455.000,00 en los 11 meses declarados (2026-06 con la rectificatoria 117.800,00).
import {
  PERIODO,
  RUCS,
  alerta,
  expect,
  test,
  type Api,
  type Cliente,
} from "../soporte/fixtures.js";
import {
  apiCompras,
  compraPorComprobante,
} from "../soporte/selectores/compras.js";
import {
  apiProrrata,
  botonObtener,
  dialogoManual,
  filaMes,
  ingresarAMano,
  rutaProrrata,
  selectorMes,
  tablaMeses,
  tarjetaCoeficiente,
  tarjetaIgv,
  tarjetaUsada,
  valorIgv,
} from "../soporte/selectores/prorrata.js";

test.setTimeout(120_000);

const TIPO_TRABAJO = "sol.declaraciones.descargar";
const MOTIVO = "Mes previo al PDT descargado: tomado del libro del cliente";

interface VistaProrrata {
  readonly coeficiente: {
    readonly estado: string;
    readonly porcentaje?: string;
  };
  readonly diferencia: {
    readonly diferencia: string;
    readonly alerta: boolean;
  } | null;
  readonly ventana: readonly {
    readonly periodo: string;
    readonly origen: string;
    readonly versionManual: number;
  }[];
  readonly versionUsada: number;
}

/** Cliente del fixture con credencial SOL del mock, ventas y compras de 2026-10 cargadas y las compras clasificadas. */
async function prepararCliente(llamadas: Api, cliente: Cliente): Promise<void> {
  await llamadas.cargarCredenciales(cliente.id);
  await llamadas.descargar(cliente.id, PERIODO, "ventas");
  await llamadas.descargar(cliente.id, PERIODO);
  // Compras de M en DG (mixta F001-2056 y USD F001-4062), DGNG (zapatilla F001-5070) y DNG (bolsas F001-3064).
  const destinos = [
    ["F001-2056", "DG"],
    ["F001-4062", "DG"],
    ["F001-5070", "DGNG"],
    ["F001-3064", "DNG"],
  ] as const;
  for (const [comprobante, destino] of destinos) {
    const compra = await compraPorComprobante(
      llamadas,
      cliente.id,
      PERIODO,
      comprobante,
    );
    await llamadas.exigir(
      "POST",
      `${apiCompras(cliente.id, PERIODO)}/${compra.id}/clasificar`,
      { versionBase: compra.version, destino },
    );
  }
}

/** Obtiene las declaraciones de `periodo` por API y espera a que el trabajo termine. */
async function obtenerPorApi(
  llamadas: Api,
  clienteId: string,
  periodo: string,
): Promise<void> {
  const { trabajoId } = await llamadas.exigir<{ trabajoId: string }>(
    "POST",
    `${apiProrrata(clienteId)}/declaraciones`,
    { periodo },
  );
  const trabajo = await llamadas.esperarTrabajo(clienteId, trabajoId);
  expect(trabajo.estado).toBe("completado");
}

/** Cuántas obtenciones de declaraciones terminaron bien (el trabajo de la cola). */
async function obtencionesCompletadas(
  llamadas: Api,
  clienteId: string,
): Promise<number> {
  const lista = await llamadas.exigir<{ tipo: string; estado: string }[]>(
    "GET",
    `/trabajos?clienteId=${clienteId}`,
  );
  return lista.filter(
    (t) => t.tipo === TIPO_TRABAJO && t.estado === "completado",
  ).length;
}

test("obtener → mes faltante a mano → coeficiente → IGV estimado → alerta de prorrata usada", async ({
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
  await prepararCliente(llamadas, cliente);

  await test.step("2026-10 antes de obtener: faltan los 11 meses del PDT y no hay IGV por la prorrata", async () => {
    await page.goto(rutaProrrata(cliente.id));
    await expect(
      page.getByRole("heading", { level: 1, name: "Prorrata e IGV estimado" }),
    ).toBeVisible();
    await selectorMes(page).selectOption("202610");
    await expect(
      page.getByText("Aún no se obtuvieron declaraciones de este cliente."),
    ).toBeVisible();
    await expect(
      tablaMeses(page).getByText("Falta", { exact: true }),
    ).toHaveCount(11);
    await expect(filaMes(page, "202610")).toContainText("SIRE");
    await expect(tarjetaCoeficiente(page)).toContainText(
      "Faltan meses para calcular el coeficiente.",
    );
    await expect(tarjetaIgv(page)).toContainText(
      "No se puede estimar el IGV: primero hay que determinar el coeficiente de prorrata.",
    );
  });

  await test.step("«Obtener declaraciones» (CA-1): 10 declarados, la rectificatoria vigente y 2026-10 en SIRE", async () => {
    await botonObtener(page).click();
    // El trabajo corre en el worker; al terminar la pantalla vuelve a leer sola.
    await expect(page.getByText(/^Última obtención: /)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Sin declaración en: 2026-10")).toBeVisible();
    await expect(
      tablaMeses(page).getByText("Declarado", { exact: true }),
    ).toHaveCount(10);
    await expect(
      tablaMeses(page).getByText("Rectificatoria", { exact: true }),
    ).toHaveCount(1);
    await expect(
      tablaMeses(page).getByText("SIRE", { exact: true }),
    ).toHaveCount(1);
    await expect(
      tablaMeses(page).getByText("Falta", { exact: true }),
    ).toHaveCount(0);

    // Montos del PDT tal cual; la rectificatoria (orden 790000175) reemplaza a la original sin borrarla.
    await expect(filaMes(page, "202511")).toContainText("100,000.00");
    await expect(filaMes(page, "202511")).toContainText("40,000.00");
    await expect(filaMes(page, "202511")).toContainText(
      "N.º de orden 790000100, presentada el 12/12/2025",
    );
    await expect(filaMes(page, "202606")).toContainText("117,800.00");
    await expect(filaMes(page, "202606")).toContainText(
      "N.º de orden 790000175, presentada el 28/7/2026 (2 presentaciones)",
    );
    // 2026-10 viene de las ventas de 013: 1.385,00 gravadas (USD con tipo de cambio convertidas; la USD sin tipo queda fuera).
    await expect(filaMes(page, "202610")).toContainText("1,385.00");
    await expect(filaMes(page, "202610")).toContainText("150.00");
    await expect(filaMes(page, "202610")).toContainText("1,535.00");
    await expect(filaMes(page, "202610")).toContainText(
      "El SIRE no separa exportaciones",
    );
    await expect(filaMes(page, "202610")).toContainText(
      "Hay ventas en USD sin tipo de cambio",
    );
  });

  await test.step("coeficiente 73,14 % provisional (11 meses del PDT + 2026-10 del SIRE)", async () => {
    // (1.237.800,00 + 1.385,00) / (1.237.800,00 + 1.385,00 + 455.000,00 + 150,00) = 1.239.185,00 / 1.694.335,00 = 73,14 %.
    await expect(tarjetaCoeficiente(page)).toContainText("73,14 %");
    await expect(tarjetaCoeficiente(page)).toContainText("Provisional");
    await expect(tarjetaCoeficiente(page)).not.toContainText("Faltan meses");
  });

  await test.step("IGV estimado con cada componente y «A pagar» (CA-5)", async () => {
    // Ventas: IGV 249,30 (18 + 9 + 36 + 54 − 9 + 36 × 3,300 + 4,50 + 7,20 + 10,80; la USD sin tipo de cambio no suma).
    // Compras: DG 1,61 (mixta) + 0,10 (USD 0,03 × 3,300 = 0,099); DGNG 27,00 (zapatilla); DNG 18,00 (bolsas, sin crédito).
    // Crédito DGNG = 27,00 × 73,14 % = 19,7478 → 19,75. Resultado = 249,30 − 1,71 − 19,75 = 227,84.
    await expect(valorIgv(page, "IGV de ventas")).toHaveText("249.30");
    await expect(valorIgv(page, "Crédito fiscal de compras DG")).toHaveText(
      "1.71",
    );
    await expect(valorIgv(page, "IGV de compras DGNG")).toHaveText("27.00");
    await expect(
      valorIgv(page, "Crédito de compras DGNG (por la prorrata)"),
    ).toHaveText("19.75");
    await expect(valorIgv(page, "IGV de compras DNG (sin crédito)")).toHaveText(
      "18.00",
    );
    await expect(valorIgv(page, "A pagar")).toHaveText("227.84");
    await expect(tarjetaIgv(page)).toContainText("Periodo de compras abierto");
    await expect(tarjetaIgv(page)).toContainText(
      "Estimado: no incluye saldo a favor anterior, percepciones ni retenciones",
    );
    // Sin prorrata usada en 2026-10 no hay alerta.
    await expect(tarjetaUsada(page)).toContainText(
      "No hay prorrata usada registrada para este mes.",
    );
    await expect(alerta(page, /no coincide con la usada/)).toHaveCount(0);
  });

  await test.step("una segunda obtención no duplica filas (CA-1)", async () => {
    expect(await obtencionesCompletadas(llamadas, cliente.id)).toBe(1);
    await botonObtener(page).click();
    await expect
      .poll(() => obtencionesCompletadas(llamadas, cliente.id), {
        timeout: 30_000,
      })
      .toBe(2);
    await page.getByRole("button", { name: "Historial 2026-06" }).click();
    const historial = page.getByRole("dialog", {
      name: "Historial de 2026-06",
    });
    const declaraciones = historial.getByRole("table", {
      name: "Declaraciones del mes",
    });
    await expect(declaraciones.getByRole("row")).toHaveCount(3); // encabezado + original + rectificatoria
    await expect(declaraciones).toContainText("790000170");
    await expect(declaraciones).toContainText("790000175");
    await historial.getByRole("button", { name: "Cerrar" }).first().click();
    await expect(historial).toHaveCount(0);
    await expect(
      tablaMeses(page).getByText("Declarado", { exact: true }),
    ).toHaveCount(10);
    await expect(valorIgv(page, "A pagar")).toHaveText("227.84");
  });

  await test.step("2026-09: falta 2025-10, no se calcula y se lista el mes (CA-4)", async () => {
    await selectorMes(page).selectOption("202609");
    await botonObtener(page).click();
    await expect
      .poll(() => obtencionesCompletadas(llamadas, cliente.id), {
        timeout: 30_000,
      })
      .toBe(3);
    await expect(page.getByText("Sin declaración en: 2025-10")).toBeVisible();
    await expect(filaMes(page, "202510")).toContainText("Falta");
    await expect(
      tablaMeses(page).getByText("Declarado", { exact: true }),
    ).toHaveCount(10);
    await expect(
      tablaMeses(page).getByText("Rectificatoria", { exact: true }),
    ).toHaveCount(1);
    await expect(tarjetaCoeficiente(page)).toContainText(
      "Faltan meses para calcular el coeficiente.",
    );
    await expect(
      tarjetaCoeficiente(page).getByRole("link", {
        name: "Ingresar el mes 2025-10",
      }),
    ).toBeVisible();
    await expect(tarjetaCoeficiente(page)).not.toContainText("%");
    // La prorrata usada del PDT sí se ve, pero sin coeficiente no hay alerta.
    await expect(tarjetaUsada(page)).toContainText("72,00 %");
    await expect(tarjetaUsada(page)).toContainText("Declarada en el PDT 621");
    await expect(alerta(page, /no coincide con la usada/)).toHaveCount(0);
    // Sin ventas ni compras de 2026-09 cargadas, el IGV no se estima (R-7).
    await expect(tarjetaIgv(page)).toContainText("No se puede estimar el IGV:");
  });

  await test.step("«Ingresar a mano» con motivo: el mes sale «Manual» y el coeficiente se calcula (CA-4)", async () => {
    await ingresarAMano(page, "202510").click();
    const dialogo = dialogoManual(page, "202510");
    // Sin motivo no se envía.
    await dialogo.getByLabel("Ventas gravadas").fill("125000.00");
    await dialogo.getByLabel("Exportaciones").fill("0");
    await dialogo.getByLabel("Ventas no gravadas").fill("40000.00");
    await dialogo.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(dialogo.getByText("Escribe el motivo.")).toBeVisible();
    await dialogo.getByLabel("Motivo").fill(MOTIVO);
    await dialogo.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(dialogo).toHaveCount(0);

    await expect(filaMes(page, "202510")).toContainText("Manual");
    await expect(filaMes(page, "202510")).toContainText("125,000.00");
    await expect(filaMes(page, "202510")).toContainText(
      "Ingresado por Dueño E2E el",
    );
    await expect(filaMes(page, "202510")).toContainText(MOTIVO);
    await expect(
      filaMes(page, "202510").getByRole("button", {
        name: "Historial 2025-10",
      }),
    ).toBeVisible();
    // (1.237.800,00 + 125.000,00) / (1.237.800,00 + 125.000,00 + 455.000,00 + 40.000,00) = 1.362.800,00 / 1.857.800,00 = 73,36 %.
    await expect(tarjetaCoeficiente(page)).toContainText("73,36 %");
    await expect(tarjetaCoeficiente(page)).toContainText("Provisional");
    await expect(tarjetaCoeficiente(page)).not.toContainText("Faltan meses");
  });

  await test.step("prorrata usada del PDT distinta: alerta con ambos valores y sin ingreso a mano (CA-6)", async () => {
    await expect(tarjetaUsada(page)).toContainText("72,00 %");
    await expect(tarjetaUsada(page)).toContainText("Declarada en el PDT 621");
    const aviso = alerta(page, /no coincide con la usada/);
    await expect(aviso).toHaveCount(1);
    await expect(aviso).toHaveText(
      "La prorrata calculada (73,36 %) no coincide con la usada (72,00 %, declarada en el PDT 621). Diferencia: 1,36 puntos.",
    );
    // La prorrata viene en el PDT: no hay campo para ingresarla.
    await expect(
      tarjetaUsada(page).getByLabel("Prorrata usada (%)"),
    ).toHaveCount(0);
    await expect(
      tarjetaUsada(page).getByRole("button", {
        name: "Guardar prorrata usada",
      }),
    ).toHaveCount(0);
    // Sin ventas de 2026-09 el IGV sigue sin estimarse.
    await expect(tarjetaIgv(page)).toContainText(
      "No se puede estimar el IGV: falta cargar las ventas del periodo.",
    );

    // La API dice lo mismo y rechaza lo que la pantalla no ofrece: mes declarado y prorrata declarada (409).
    const vista = await llamadas.exigir<VistaProrrata>(
      "GET",
      `${apiProrrata(cliente.id)}?periodo=202609`,
    );
    expect(vista.coeficiente).toMatchObject({
      estado: "calculado",
      porcentaje: "73.36",
    });
    expect(vista.diferencia).toEqual({ diferencia: "1.36", alerta: true });
    const declarado = await llamadas.pedir<{ codigo: string }>(
      "PUT",
      `${apiProrrata(cliente.id)}/meses/202609`,
      {
        gravadas: "1.00",
        exportaciones: "0.00",
        noGravadas: "0.00",
        motivo: MOTIVO,
        version: 0,
      },
    );
    expect(declarado.status).toBe(409);
    expect(declarado.cuerpo.codigo).toBe("mes_declarado");
    const usada = await llamadas.pedir<{ codigo: string }>(
      "PUT",
      `${apiProrrata(cliente.id)}/usada/202609`,
      {
        porcentaje: "73.36",
        version: vista.versionUsada,
      },
    );
    expect(usada.status).toBe(409);
    expect(usada.cuerpo.codigo).toBe("prorrata_declarada");
  });

  await test.step("volver a 2026-10: el IGV de ese mes no cambia con el manual de 2025-10 fuera de su ventana (2025-11..2026-10)", async () => {
    await selectorMes(page).selectOption("202610");
    await expect(tarjetaCoeficiente(page)).toContainText("73,14 %");
    await expect(valorIgv(page, "A pagar")).toHaveText("227.84");
    await expect(filaMes(page, "202510")).toHaveCount(0);
  });
});

test("Lectura ve la pantalla completa sin botones de escritura", async ({
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
  const dueno = api(await sesiones.entrar(estudio.dueno));
  await prepararCliente(dueno, cliente);
  await obtenerPorApi(dueno, cliente.id, "202609");
  const manual = await dueno.pedir(
    "PUT",
    `${apiProrrata(cliente.id)}/meses/202510`,
    {
      gravadas: "125000.00",
      exportaciones: "0.00",
      noGravadas: "40000.00",
      motivo: MOTIVO,
      version: 0,
    },
  );
  expect(manual.status).toBeLessThan(300);

  const { page } = await sesiones.paginaDe(lectura);
  await page.goto(rutaProrrata(cliente.id));
  await expect(
    page.getByRole("heading", { level: 1, name: "Prorrata e IGV estimado" }),
  ).toBeVisible();
  await selectorMes(page).selectOption("202609");
  // Ve todo: tabla, coeficiente, prorrata usada y la alerta.
  await expect(filaMes(page, "202510")).toContainText("Manual");
  await expect(filaMes(page, "202609")).toContainText("Declarado");
  await expect(tarjetaCoeficiente(page)).toContainText("73,36 %");
  await expect(tarjetaUsada(page)).toContainText("72,00 %");
  await expect(alerta(page, /no coincide con la usada/)).toHaveCount(1);
  await expect(tarjetaIgv(page)).toContainText("No se puede estimar el IGV:");
  // Sin botones de escritura: ni obtener, ni ingresar a mano, ni campos de la prorrata usada.
  await expect(botonObtener(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /^Ingresar a mano/ }),
  ).toHaveCount(0);
  await expect(tarjetaUsada(page).getByRole("textbox")).toHaveCount(0);
  await expect(tarjetaUsada(page).getByRole("button")).toHaveCount(0);
  // El historial es de lectura y sí está.
  await expect(
    page.getByRole("button", { name: "Historial 2025-10" }),
  ).toBeVisible();
  // Y en 2026-10, con las compras clasificadas, ve el IGV estimado.
  await selectorMes(page).selectOption("202610");
  await expect(valorIgv(page, "IGV de ventas")).toHaveText("249.30");
  await expect(botonObtener(page)).toHaveCount(0);
});
