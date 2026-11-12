// Comprobación del soporte de la E2E (spec 018, T3): siembra, sesiones, correo, acciones por API y vigilancia.
// Los flujos E-01 a E-11 las dan por buenas; si esta falla, el problema es del soporte y no de un flujo.
import {
  CREDENCIALES_FIXTURE,
  PERIODO,
  RUCS,
  alerta,
  expect,
  rucCentinela,
  test,
} from "../soporte/fixtures.js";

interface ListadoApi {
  filas: { proveedor: { numero: string } }[];
}

test("un estudio con Dueño y sesión abre el panel", async ({
  siembra,
  sesiones,
}) => {
  const estudio = await siembra.estudio();
  const { page } = await sesiones.paginaDe(estudio.dueno);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "ContApp" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Clientes" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: /^Estudio/ })).toHaveValue(
    estudio.tenantId,
  );
  expect(page.viewportSize()?.width).toBe(1440);
});

test("el enlace de un correo de recuperación se lee del correo", async ({
  page,
  siembra,
  correo,
}) => {
  const estudio = await siembra.estudio();

  await page.goto("/recuperar");
  await page.getByLabel("Correo", { exact: true }).fill(estudio.dueno.correo);
  await page.getByRole("button", { name: "Enviar enlace" }).click();
  await expect(alerta(page, /./)).toHaveCount(0);

  const enlace = await correo.enlaceDe(
    estudio.dueno.correo,
    "restablece tu contraseña",
  );
  expect(enlace).toMatch(/\/recuperar\/nueva#t=\S+$/);

  await page.goto(enlace);
  await expect(
    page.getByRole("heading", { name: "Nueva contraseña" }),
  ).toBeVisible();
});

test("las acciones por API cargan credenciales, descargan compras y esperan el trabajo", async ({
  siembra,
  sesiones,
  api,
}) => {
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId);
  const sesion = await sesiones.entrar(estudio.dueno);
  const llamadas = api(sesion);

  expect(await llamadas.estadoCredencial(cliente.id, "sol")).toBe(
    "no_configurada",
  );
  await llamadas.cargarCredenciales(cliente.id);
  expect(await llamadas.estadoCredencial(cliente.id, "sol")).toBe(
    "configurada",
  );

  const trabajo = await llamadas.descargar(cliente.id, PERIODO);
  expect(trabajo.estado).toBe("completado");

  const lista = await llamadas.exigir<ListadoApi>(
    "GET",
    `/clientes/${cliente.id}/periodos/${PERIODO}/compras`,
  );
  expect(lista.filas).toHaveLength(5);
});

test("un RUC centinela hace fallar la descarga y la API lo informa", async ({
  siembra,
  sesiones,
  api,
}) => {
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId, {
    ruc: rucCentinela(8),
  });
  const llamadas = api(await sesiones.entrar(estudio.dueno));
  await llamadas.cargarCredenciales(cliente.id);

  const id = await llamadas.iniciarDescarga(cliente.id, PERIODO);
  const trabajo = await llamadas.esperarTrabajo(cliente.id, id);
  expect(trabajo.estado).toBe("error");
  expect(trabajo.motivo).toBe("datos_invalidos");
});

test("la siembra de compras por SQL aparece en el listado", async ({
  siembra,
  sesiones,
  api,
}) => {
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId, {
    ruc: RUCS.generico,
  });
  await siembra.comprasPorSql(cliente.id, PERIODO, 30);
  const llamadas = api(await sesiones.entrar(estudio.dueno));

  const lista = await llamadas.exigir<ListadoApi>(
    "GET",
    `/clientes/${cliente.id}/periodos/${PERIODO}/compras`,
  );
  expect(lista.filas).toHaveLength(30);
});

test("la sesión de un usuario sin asignación no ve clientes ajenos", async ({
  siembra,
  sesiones,
  api,
}) => {
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId);
  const asistente = await siembra.miembro(estudio.tenantId, "asistente");
  const llamadas = api(await sesiones.entrar(asistente));

  const r = await llamadas.pedir("GET", `/clientes/${cliente.id}`);
  expect(r.status).toBe(404);
});

test("un error de consola declarado no hace fallar la prueba", async ({
  page,
  vigilancia,
}) => {
  vigilancia.permitirError(/Failed to load resource/);
  await page.goto("/login");
  await page.evaluate(() => fetch("/api/no-existe"));
  await expect(page.getByRole("button", { name: "Ingresar" })).toBeVisible();
});

test.describe("la vigilancia hace fallar la prueba", () => {
  test("con un centinela de credencial en el DOM", async ({ page }) => {
    test.fail();
    await page.goto("/login");
    await page.evaluate(
      (valor) => document.body.append(valor),
      CREDENCIALES_FIXTURE.clave,
    );
  });

  test("con un centinela de credencial en una respuesta /api", async ({
    page,
  }) => {
    test.fail();
    await page.route("**/api/auth/sesion", (ruta) =>
      ruta.fulfill({
        status: 200,
        json: { dato: CREDENCIALES_FIXTURE.clientSecret },
      }),
    );
    await page.goto("/login");
    // T11b: la vigilancia lee el cuerpo de la respuesta después del evento `response`; si la prueba termina antes,
    // el contexto se cierra con la lectura a medias y no hay hallazgo. Se espera la respuesta y su cuerpo.
    const [respuesta] = await Promise.all([
      page.waitForResponse("**/api/auth/sesion"),
      page.evaluate(() => fetch("/api/auth/sesion")),
    ]);
    await respuesta.text();
  });

  test("con window.__pwn definido, aunque la página cambie después", async ({
    page,
  }) => {
    test.fail();
    await page.goto("/login");
    await page.evaluate(() => {
      (window as unknown as { __pwn: number }).__pwn = 1;
    });
    await page.goto("/recuperar");
  });

  test("con un error de consola que la prueba no declaró", async ({ page }) => {
    test.fail();
    await page.goto("/login");
    await page.evaluate(() => console.error("fallo inesperado de prueba"));
  });
});
