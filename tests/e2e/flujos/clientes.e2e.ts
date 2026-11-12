// E-03 · Clientes y credenciales (spec 018; HU-06, 09, 10, 02): alta con consulta de RUC, importación con vista
// previa, credenciales SOL y SIRE que nunca vuelven a verse, credencial rechazada con aviso en la campana, tope del
// plan Prueba y razón social canario. Cada prueba siembra su propio estudio.
import {
  CREDENCIALES_FIXTURE,
  RUCS,
  alerta,
  estado,
  expect,
  rucCentinela,
  test,
} from "../soporte/fixtures.js";
import {
  archivoImportacion,
  campo,
  filaCliente,
  grupoSire,
  grupoSol,
  resultadoImportacion,
  vistaPrevia,
} from "../soporte/selectores/clientes.js";
import {
  campana,
  notificacion,
  panel,
} from "../soporte/selectores/notificaciones.js";

const CANARIO = '<img src=x onerror="window.__pwn=1">';
const RAZON_MOCK = /EMPRESA MOCK [0-9A-F]{8} S\.A\.C\./;

test.describe("alta de un cliente", () => {
  test("la consulta de RUC completa la razón social provisional", async ({
    siembra,
    sesiones,
  }) => {
    const estudio = await siembra.estudio();
    const { page } = await sesiones.paginaDe(estudio.dueno);

    await page.goto("/clientes/nuevo");
    await page.getByLabel("RUC", { exact: true }).fill(RUCS.contribuyente);
    await page.getByRole("button", { name: "Crear cliente" }).click();

    await expect(page).toHaveURL(/\/clientes\/[0-9a-f-]{36}$/);
    await expect(
      page
        .getByRole("paragraph")
        .filter({ hasText: `RUC ${RUCS.contribuyente}` }),
    ).toBeVisible();
    // La consulta la hace el worker después del alta: la ficha se recarga hasta que trae el nombre del padrón.
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        RAZON_MOCK,
      );
    }).toPass({ timeout: 30_000 });

    await page.goto("/clientes");
    await expect(filaCliente(page, RUCS.contribuyente)).toContainText(
      RAZON_MOCK,
    );
  });

  test("un RUC inválido o repetido no crea el cliente", async ({
    siembra,
    sesiones,
    vigilancia,
  }) => {
    vigilancia.permitirError(/status of 409/);
    const estudio = await siembra.estudio();
    await siembra.cliente(estudio.tenantId, { ruc: RUCS.sanJuan });
    const { page } = await sesiones.paginaDe(estudio.dueno);

    await page.goto("/clientes/nuevo");
    await page.getByLabel("RUC", { exact: true }).fill("12345678901");
    await page.getByLabel("Razón social").click();
    await expect(alerta(page, "El RUC no es válido.")).toHaveCount(1);

    await page.getByLabel("RUC", { exact: true }).fill(RUCS.sanJuan);
    await page.getByRole("button", { name: "Crear cliente" }).click();
    await expect(alerta(page, "Ya existe un cliente con ese RUC.")).toHaveCount(
      1,
    );
    await expect(page).toHaveURL(/\/clientes\/nuevo$/);
  });

  test("una razón social con HTML se ve como texto y no ejecuta nada", async ({
    siembra,
    sesiones,
  }) => {
    const estudio = await siembra.estudio();
    const { page } = await sesiones.paginaDe(estudio.dueno);

    await page.goto("/clientes/nuevo");
    await page.getByLabel("RUC", { exact: true }).fill(RUCS.mixta);
    await page.getByLabel("Razón social").fill(CANARIO);
    await page.getByRole("button", { name: "Crear cliente" }).click();

    await expect(page).toHaveURL(/\/clientes\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(CANARIO);
    await page.goto("/clientes");
    await expect(filaCliente(page, RUCS.mixta)).toContainText(CANARIO);
    await expect(page.getByRole("img")).toHaveCount(0);
    expect(await page.evaluate("window.__pwn")).toBeUndefined();
  });
});

test.describe("importación de clientes", () => {
  const CABECERA =
    "ruc,razon social,usuario sol,clave sol,client id,client secret,responsable";
  const claves = [
    CREDENCIALES_FIXTURE.usuario,
    CREDENCIALES_FIXTURE.clave,
    CREDENCIALES_FIXTURE.clientId,
    CREDENCIALES_FIXTURE.clientSecret,
  ].join(",");

  test("la vista previa separa válidas y con error, oculta las claves y confirma", async ({
    siembra,
    sesiones,
  }) => {
    const estudio = await siembra.estudio();
    await siembra.cliente(estudio.tenantId, { ruc: RUCS.contribuyente });
    const { page } = await sesiones.paginaDe(estudio.dueno);
    const csv = [
      CABECERA,
      `${RUCS.sanJuan},IMPORTADA UNO S.A.C.,${claves},`,
      `${RUCS.mixta},IMPORTADA DOS S.A.C.,${claves},`,
      "12345,RUC MAL ESCRITO,,,,,",
      `${RUCS.contribuyente},YA EXISTE S.A.C.,,,,,`,
    ].join("\n");

    await page.goto("/clientes/importar");
    await archivoImportacion(page).setInputFiles({
      name: "clientes.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    await page.getByRole("button", { name: "Revisar archivo" }).click();

    const vista = vistaPrevia(page);
    await expect(vista.getByText("Filas válidas: 2")).toBeVisible();
    await expect(vista.getByText("Filas con error: 2")).toBeVisible();
    await expect(
      vista.getByRole("row").filter({ hasText: RUCS.sanJuan }),
    ).toContainText("SOL •••• · SIRE ••••");
    await expect(
      vista.getByRole("row").filter({ hasText: "12345" }),
    ).toContainText("El RUC no es válido.");
    await expect(
      vista.getByRole("row").filter({ hasText: RUCS.contribuyente }),
    ).toContainText("Ya existe un cliente con ese RUC.");

    await page.getByRole("button", { name: "Confirmar importación" }).click();
    const resultado = resultadoImportacion(page);
    await expect(resultado.getByText("Clientes creados: 2")).toBeVisible();
    await expect(
      resultado.getByText("Consultas de RUC encoladas: 2"),
    ).toBeVisible();

    await resultado.getByRole("link", { name: "Ir a clientes" }).click();
    await expect(filaCliente(page, "IMPORTADA UNO S.A.C.")).toContainText(
      "SOL: Configurada",
    );
    await expect(filaCliente(page, "IMPORTADA DOS S.A.C.")).toContainText(
      "SIRE API: Configurada",
    );
  });

  test("un archivo sin las columnas de la plantilla se rechaza", async ({
    siembra,
    sesiones,
    vigilancia,
  }) => {
    vigilancia.permitirError(/status of 400/);
    const estudio = await siembra.estudio();
    const { page } = await sesiones.paginaDe(estudio.dueno);

    await page.goto("/clientes/importar");
    await archivoImportacion(page).setInputFiles({
      name: "mal.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(`ruc,nombre\n${RUCS.sanJuan},X\n`),
    });
    await page.getByRole("button", { name: "Revisar archivo" }).click();

    await expect(
      alerta(
        page,
        "Faltan columnas en la cabecera. Descarga la plantilla y úsala.",
      ),
    ).toHaveCount(1);
    await expect(vistaPrevia(page)).toHaveCount(0);
  });
});

test.describe("credenciales del cliente", () => {
  test("SOL y SIRE se guardan sin mostrar la clave y el worker las verifica", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const estudio = await siembra.estudio();
    const cliente = await siembra.cliente(estudio.tenantId);
    const llamadas = api(await sesiones.entrar(estudio.dueno));
    const { page } = await sesiones.paginaDe(estudio.dueno);

    await page.goto(`/clientes/${cliente.id}`);
    const sol = grupoSol(page);
    const sire = grupoSire(page);
    await expect(sol).toContainText("Estado: No configurada");

    await campo(sol, "Usuario SOL").fill(CREDENCIALES_FIXTURE.usuario);
    await campo(sol, "Clave SOL").fill(CREDENCIALES_FIXTURE.clave);
    await sol.getByRole("button", { name: "Guardar" }).click();
    await expect(estado(page, "Credencial guardada.")).toBeVisible();
    await expect(sol).toContainText("Estado: Configurada");
    await expect(campo(sol, "Usuario SOL")).toHaveValue("");
    await expect(campo(sol, "Clave SOL")).toHaveValue("");

    await campo(sire, "Client ID").fill(CREDENCIALES_FIXTURE.clientId);
    await campo(sire, "Client secret").fill(CREDENCIALES_FIXTURE.clientSecret);
    await sire.getByRole("button", { name: "Guardar" }).click();
    await expect(sire).toContainText("Estado: Configurada");
    await expect(campo(sire, "Client secret")).toHaveValue("");

    // Ni la ficha recién guardada ni la recargada devuelven un valor de las credenciales (la vigilancia lo
    // comprueba también en las respuestas y en la consola).
    for (const valor of Object.values(CREDENCIALES_FIXTURE)) {
      expect(await page.content()).not.toContain(valor);
    }

    await sol.getByRole("button", { name: "Verificar" }).click();
    await expect(estado(page, "Verificación encolada.")).toBeVisible();
    await expect
      .poll(() => llamadas.estadoCredencial(cliente.id, "sol"), {
        timeout: 30_000,
      })
      .toBe("verificada");

    await sire.getByRole("button", { name: "Verificar" }).click();
    await expect
      .poll(() => llamadas.estadoCredencial(cliente.id, "sire_api"), {
        timeout: 30_000,
      })
      .toBe("verificada");

    // La ficha se refresca sola (spec 020 CA-5): pasa de «Verificando…» a «Verificada» sin recargar la página.
    await expect(grupoSol(page)).toContainText(/Estado: Verificada/, {
      timeout: 30_000,
    });
    await expect(grupoSire(page)).toContainText(/Estado: Verificada/, {
      timeout: 30_000,
    });
    await expect(campo(grupoSol(page), "Clave SOL")).toHaveValue("");
    for (const valor of Object.values(CREDENCIALES_FIXTURE)) {
      expect(await page.content()).not.toContain(valor);
    }
  });

  test("guardar con campos vacíos pide revisar los datos", async ({
    siembra,
    sesiones,
  }) => {
    const estudio = await siembra.estudio();
    const cliente = await siembra.cliente(estudio.tenantId);
    const { page } = await sesiones.paginaDe(estudio.dueno);

    await page.goto(`/clientes/${cliente.id}`);
    await grupoSol(page).getByRole("button", { name: "Guardar" }).click();
    await expect(
      alerta(page, "Revisa los datos de la credencial."),
    ).toHaveCount(1);
    await expect(grupoSol(page)).toContainText("Estado: No configurada");
  });

  test("una clave rechazada por SUNAT deja la credencial «Inválida» y avisa en la campana", async ({
    siembra,
    sesiones,
  }) => {
    const estudio = await siembra.estudio();
    const cliente = await siembra.cliente(estudio.tenantId, {
      ruc: rucCentinela(9),
      razonSocial: "CLIENTE RECHAZADO S.A.C.",
    });
    const { page } = await sesiones.paginaDe(estudio.dueno);

    await page.goto(`/clientes/${cliente.id}`);
    const sol = grupoSol(page);
    await campo(sol, "Usuario SOL").fill(CREDENCIALES_FIXTURE.usuario);
    await campo(sol, "Clave SOL").fill("clave-errada");
    await sol.getByRole("button", { name: "Guardar" }).click();
    await expect(sol).toContainText("Estado: Configurada");
    await expect(campana(page)).toHaveAccessibleName("Notificaciones");

    await sol.getByRole("button", { name: "Verificar" }).click();
    // El aviso llega por el stream en vivo, sin recargar.
    await expect(campana(page)).toHaveAccessibleName(/sin leer/, {
      timeout: 30_000,
    });
    await page.reload();
    await expect(grupoSol(page)).toContainText("Estado: Inválida");

    await campana(page).click();
    await expect(
      notificacion(
        panel(page),
        "La clave SOL de CLIENTE RECHAZADO S.A.C. fue rechazada por SUNAT. Actualízala para seguir trabajando.",
      ),
    ).toBeVisible();
    await page.goto("/clientes");
    await expect(filaCliente(page, "CLIENTE RECHAZADO S.A.C.")).toContainText(
      "SOL: Inválida",
    );
  });

  test("un asistente sin permiso de credenciales las ve sin formulario", async ({
    siembra,
    sesiones,
  }) => {
    const estudio = await siembra.estudio();
    const asistente = await siembra.miembro(estudio.tenantId, "asistente");
    const cliente = await siembra.cliente(estudio.tenantId, {
      asignadoA: asistente,
    });
    const { page } = await sesiones.paginaDe(asistente);

    await page.goto(`/clientes/${cliente.id}`);
    await expect(grupoSol(page)).toContainText("Estado: No configurada");
    await expect(
      grupoSol(page).getByRole("button", { name: "Guardar" }),
    ).toHaveCount(0);
    await expect(
      grupoSire(page).getByRole("button", { name: "Verificar" }),
    ).toHaveCount(0);
  });
});

test.describe("tope del plan Prueba", () => {
  test("el sexto RUC no cabe: aviso de límite y uso del plan", async ({
    siembra,
    sesiones,
    vigilancia,
  }) => {
    vigilancia.permitirError(/status of 409/);
    const estudio = await siembra.estudio({ plan: "prueba" });
    for (let i = 0; i < 5; i += 1) {
      await siembra.cliente(estudio.tenantId, { ruc: rucCentinela(9, i) });
    }
    const { page } = await sesiones.paginaDe(estudio.dueno);

    await page.goto("/clientes/nuevo");
    await page.getByLabel("RUC", { exact: true }).fill(RUCS.sanJuan);
    await page.getByRole("button", { name: "Crear cliente" }).click();

    const uso = page.getByRole("region", { name: "Uso del plan" });
    await expect(uso).toContainText("Plan Prueba");
    await expect(uso).toContainText("RUCs: 5 de 5");
    await expect(uso).toContainText("Contacta a ContApp para subir de plan.");
    await expect(page).toHaveURL(/\/clientes\/nuevo$/);

    await page.goto("/clientes");
    await expect(
      page.getByRole("row").filter({ hasText: RUCS.sanJuan }),
    ).toHaveCount(0);
  });

  test("el aviso de límite de RUCs se anuncia una sola vez", async ({
    siembra,
    sesiones,
    vigilancia,
  }) => {
    vigilancia.permitirError(/status of 409/);
    const estudio = await siembra.estudio({ plan: "prueba" });
    for (let i = 0; i < 5; i += 1) {
      await siembra.cliente(estudio.tenantId, { ruc: rucCentinela(9, i) });
    }
    const { page } = await sesiones.paginaDe(estudio.dueno);

    await page.goto("/clientes/nuevo");
    await page.getByLabel("RUC", { exact: true }).fill(RUCS.sanJuan);
    await page.getByRole("button", { name: "Crear cliente" }).click();

    await expect(
      page.getByRole("region", { name: "Uso del plan" }),
    ).toBeVisible();
    await expect(
      alerta(page, "Llegaste al límite de RUCs de tu plan."),
    ).toHaveCount(1);
  });
});
