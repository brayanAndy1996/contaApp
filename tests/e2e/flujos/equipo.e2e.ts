// E-02 · Invitación y roles (spec 018, T4): el Dueño invita a un asistente, este acepta por correo, se le asigna
// un cliente y solo ve ese; `lectura` sin botones de escritura; un usuario en dos estudios cambia de estudio;
// invitación revocada o usada. La invitación y su aceptación van por la UI y el correo (D-4); cada contexto lleva
// su propio `X-Forwarded-For`.
import type { Browser, Page } from "@playwright/test";
import { alerta, estado, expect, test } from "../soporte/fixtures.js";
import type { Estudio } from "../soporte/fixtures.js";
import { correoUnico } from "../soporte/siembra.js";
import {
  ASUNTO_INVITACION,
  TEXTOS,
  contrasenaNueva,
  fila,
  ingresar,
} from "../soporte/selectores/acceso.js";
import { ipUnica } from "../soporte/sesiones.js";

/** El Dueño invita desde `/usuarios` y devuelve el correo invitado. */
async function invitar(
  page: Page,
  correoInvitado: string,
  rol: string,
): Promise<void> {
  await page.goto("/usuarios");
  await expect(
    page.getByRole("heading", { name: "Invitar a una persona" }),
  ).toBeVisible();
  await page.getByLabel("Correo", { exact: true }).fill(correoInvitado);
  await page
    .getByRole("combobox", { name: /^Rol/ })
    .selectOption({ label: rol });
  await page.getByRole("button", { name: "Invitar", exact: true }).click();
  await expect(estado(page, TEXTOS.invitacionEnviada)).toBeVisible();
  await expect(fila(page, correoInvitado)).toContainText("Pendiente");
}

/** Contexto sin sesión con IP propia (la persona invitada aún no tiene cuenta). */
async function paginaAnonima(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    extraHTTPHeaders: { "X-Forwarded-For": ipUnica() },
  });
  return context.newPage();
}

async function crearCuentaConInvitacion(
  page: Page,
  enlace: string,
  nombre: string,
  contrasena: string,
): Promise<void> {
  await page.goto(enlace);
  await expect(
    page.getByRole("heading", { name: "Invitación a ContApp" }),
  ).toBeVisible();
  await page.getByLabel("Nombre", { exact: true }).fill(nombre);
  await page.getByLabel("Contraseña", { exact: true }).fill(contrasena);
  await page.getByRole("button", { name: "Crear cuenta y aceptar" }).click();
  await expect(estado(page, TEXTOS.cuentaCreada)).toBeVisible();
}

test.describe("invitación y alcance del asistente", () => {
  test("el Dueño invita, el asistente acepta por correo y solo ve el cliente que se le asigna", async ({
    siembra,
    sesiones,
    correo,
    browser,
    vigilancia,
  }) => {
    // El asistente intenta abrir un cliente que no es suyo: el 404 llega a la consola.
    vigilancia.permitirError(/404/);
    const estudio = await siembra.estudio();
    const asignado = await siembra.cliente(estudio.tenantId, {
      ruc: "20700000011",
      razonSocial: "CLIENTE ASIGNADO E2E S.A.C.",
    });
    const ajeno = await siembra.cliente(estudio.tenantId, {
      ruc: "20700000045",
      razonSocial: "CLIENTE AJENO E2E S.A.C.",
    });
    const invitado = correoUnico();
    const contrasena = contrasenaNueva();
    const nombre = "Asistente Invitado E2E";
    const dueno = await sesiones.paginaDe(estudio.dueno);

    await invitar(dueno.page, invitado, "Asistente");

    const enlace = await correo.enlaceDe(invitado, ASUNTO_INVITACION);
    const asistente = await paginaAnonima(browser);
    await asistente.goto(enlace);
    await expect(
      asistente.getByText("Te invitaron a", { exact: false }),
    ).toContainText("Asistente");
    expect(asistente.url()).not.toContain("#t=");
    await asistente.getByLabel("Nombre", { exact: true }).fill(nombre);
    await asistente.getByLabel("Contraseña", { exact: true }).fill(contrasena);
    await asistente
      .getByRole("button", { name: "Crear cuenta y aceptar" })
      .click();
    await expect(estado(asistente, TEXTOS.cuentaCreada)).toBeVisible();

    await asistente.getByRole("link", { name: "Ir a iniciar sesión" }).click();
    await ingresar(asistente, invitado, contrasena);
    await expect(
      asistente.getByRole("heading", { name: "ContApp", exact: true }),
    ).toBeVisible();

    // Sin asignaciones, el asistente no ve ningún cliente.
    await asistente.goto("/clientes");
    await expect(
      asistente.getByRole("heading", { name: "Clientes" }),
    ).toBeVisible();
    await expect(asistente.getByRole("table")).toBeVisible();
    await expect(asistente.getByText(asignado.razonSocial)).toHaveCount(0);
    await expect(asistente.getByText(ajeno.razonSocial)).toHaveCount(0);

    // El Dueño ve la invitación aceptada como miembro y le asigna un cliente.
    await dueno.page.goto("/usuarios");
    await expect(fila(dueno.page, invitado)).toContainText("Asistente");
    await expect(fila(dueno.page, invitado)).toContainText("Activo");

    await dueno.page.goto("/clientes");
    await dueno.page
      .getByRole("checkbox", { name: `Seleccionar ${asignado.razonSocial}` })
      .check();
    await dueno.page
      .getByRole("combobox", { name: /^Usuario/ })
      .selectOption({ label: nombre });
    await dueno.page
      .getByRole("combobox", { name: /^Tipo/ })
      .selectOption({ label: "Responsable" });
    await dueno.page
      .getByRole("button", { name: "Asignar seleccionados" })
      .click();
    await expect(estado(dueno.page, "Clientes asignados: 1")).toBeVisible();
    await expect(fila(dueno.page, asignado.razonSocial)).toContainText(nombre);

    // Ahora el asistente ve solo ese cliente, y el otro es «no encontrado».
    await asistente.goto("/clientes");
    await expect(
      asistente.getByRole("link", { name: asignado.razonSocial }),
    ).toBeVisible();
    await expect(asistente.getByText(ajeno.razonSocial)).toHaveCount(0);
    await expect(asistente.getByText(ajeno.ruc)).toHaveCount(0);

    await asistente.goto(`/clientes/${ajeno.id}`);
    await expect(alerta(asistente, TEXTOS.noEncontrado)).toBeVisible();
    await expect(asistente.getByText(ajeno.razonSocial)).toHaveCount(0);

    // Un asistente no gestiona usuarios.
    await expect(asistente.getByRole("link", { name: "Usuarios" })).toHaveCount(
      0,
    );
    await asistente.goto("/usuarios");
    await expect(asistente.getByText(TEXTOS.sinPermiso)).toBeVisible();
    await expect(
      asistente.getByRole("button", { name: "Invitar" }),
    ).toHaveCount(0);

    await asistente.context().close();
  });

  test("una invitación revocada ya no se puede aceptar", async ({
    siembra,
    sesiones,
    correo,
    browser,
    vigilancia,
  }) => {
    vigilancia.permitirError(/400/);
    const estudio = await siembra.estudio();
    const invitado = correoUnico();
    const dueno = await sesiones.paginaDe(estudio.dueno);

    await invitar(dueno.page, invitado, "Contador");
    const enlace = await correo.enlaceDe(invitado, ASUNTO_INVITACION);

    await fila(dueno.page, invitado)
      .getByRole("button", { name: "Revocar" })
      .click();
    await expect(fila(dueno.page, invitado)).toHaveCount(0);

    const persona = await paginaAnonima(browser);
    await persona.goto(enlace);
    await expect(alerta(persona, TEXTOS.invitacionInvalida)).toBeVisible();
    await expect(
      persona.getByRole("button", { name: "Crear cuenta y aceptar" }),
    ).toHaveCount(0);
    await persona.context().close();
  });

  test("una invitación ya usada no se puede aceptar de nuevo", async ({
    siembra,
    sesiones,
    correo,
    browser,
    vigilancia,
  }) => {
    vigilancia.permitirError(/400/);
    const estudio = await siembra.estudio();
    const invitado = correoUnico();
    const dueno = await sesiones.paginaDe(estudio.dueno);

    await invitar(dueno.page, invitado, "Lectura");
    const enlace = await correo.enlaceDe(invitado, ASUNTO_INVITACION);

    const persona = await paginaAnonima(browser);
    await crearCuentaConInvitacion(
      persona,
      enlace,
      "Persona Lectura E2E",
      contrasenaNueva(),
    );

    // Otra página antes: el mismo enlace con otro fragmento no recarga la pantalla.
    await persona.goto("/login");
    await persona.goto(enlace);
    await expect(alerta(persona, TEXTOS.invitacionInvalida)).toBeVisible();
    await persona.context().close();
  });

  test("un enlace de invitación sin token es inválido", async ({
    browser,
    vigilancia,
  }) => {
    vigilancia.permitirError(/400/);
    const persona = await paginaAnonima(browser);
    await persona.goto("/invitacion");
    await expect(alerta(persona, TEXTOS.invitacionInvalida)).toBeVisible();
    await persona.context().close();
  });
});

test.describe("roles y estudios", () => {
  test("un usuario de solo lectura ve sus clientes sin botones de escritura", async ({
    siembra,
    sesiones,
  }) => {
    const estudio = await siembra.estudio();
    const lector = await siembra.miembro(estudio.tenantId, "lectura");
    const cliente = await siembra.cliente(estudio.tenantId, {
      asignadoA: lector,
      tipoAsignacion: "colaborador",
    });
    const { page } = await sesiones.paginaDe(lector);

    await page.goto("/clientes");
    await expect(
      page.getByRole("link", { name: cliente.razonSocial }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Nuevo cliente" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("link", { name: "Importar clientes" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Asignar seleccionados" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("checkbox", { name: /^Seleccionar/ }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Archivar" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Usuarios" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Auditoría" })).toHaveCount(0);

    await page.getByRole("link", { name: cliente.razonSocial }).click();
    await expect(
      page.getByRole("heading", { name: cliente.razonSocial }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Archivar" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Guardar" })).toHaveCount(0);

    await page.goto("/usuarios");
    await expect(page.getByText(TEXTOS.sinPermiso)).toBeVisible();
    await expect(page.getByRole("button", { name: "Invitar" })).toHaveCount(0);
  });

  test("un usuario en dos estudios cambia de estudio y ve los datos del nuevo", async ({
    siembra,
    sesiones,
  }) => {
    const a: Estudio = await siembra.estudio({
      nombre: "Estudio A Cambio E2E",
    });
    const b: Estudio = await siembra.estudio({
      nombre: "Estudio B Cambio E2E",
    });
    const clienteA = await siembra.cliente(a.tenantId, {
      ruc: "20700000011",
      razonSocial: "CLIENTE DE A E2E S.A.C.",
    });
    const clienteB = await siembra.cliente(b.tenantId, {
      ruc: "20700000045",
      razonSocial: "CLIENTE DE B E2E S.A.C.",
    });
    // El Dueño de A es Administrador en B: ve todos los clientes y usuarios de los dos.
    await siembra.membresia(a.dueno, b.tenantId, "admin");
    const { page } = await sesiones.paginaDe(a.dueno);

    await page.goto("/clientes");
    const selector = page.getByRole("combobox", { name: /^Estudio/ });
    await expect(selector).toHaveValue(a.tenantId);
    await expect(
      page.getByRole("link", { name: clienteA.razonSocial }),
    ).toBeVisible();
    await expect(page.getByText(clienteB.razonSocial)).toHaveCount(0);

    await selector.selectOption({ label: b.nombre });
    await expect(selector).toHaveValue(b.tenantId);
    // Pantallas nuevas: cada lista es la del estudio activo.
    await page.goto("/clientes");
    await expect(
      page.getByRole("link", { name: clienteB.razonSocial }),
    ).toBeVisible();
    await expect(page.getByText(clienteA.razonSocial)).toHaveCount(0);
    await page.goto("/usuarios");
    await expect(fila(page, b.dueno.correo)).toBeVisible();
    await expect(fila(page, a.dueno.correo)).toContainText("Administrador");

    await selector.selectOption({ label: a.nombre });
    await expect(selector).toHaveValue(a.tenantId);
    await page.goto("/clientes");
    await expect(
      page.getByRole("link", { name: clienteA.razonSocial }),
    ).toBeVisible();
    await expect(page.getByText(clienteB.razonSocial)).toHaveCount(0);
  });

  test("al cambiar de estudio con la lista abierta, la lista pasa a ser la del estudio nuevo", async ({
    siembra,
    sesiones,
    vigilancia,
  }) => {
    // T11a: al cambiar de estudio una petición en vuelo con la cookie vieja puede recibir 401 (el
    // servidor revoca el token al rotar). `api()` lo recupera; el navegador igual lo anota en consola.
    vigilancia.permitirError(/status of 401/);
    const a: Estudio = await siembra.estudio();
    const b: Estudio = await siembra.estudio();
    const clienteA = await siembra.cliente(a.tenantId, {
      ruc: "20700000011",
      razonSocial: "CLIENTE ABIERTO DE A E2E S.A.C.",
    });
    const clienteB = await siembra.cliente(b.tenantId, {
      ruc: "20700000045",
      razonSocial: "CLIENTE ABIERTO DE B E2E S.A.C.",
    });
    await siembra.membresia(a.dueno, b.tenantId, "admin");
    const { page } = await sesiones.paginaDe(a.dueno);

    await page.goto("/clientes");
    await expect(
      page.getByRole("link", { name: clienteA.razonSocial }),
    ).toBeVisible();

    const selector = page.getByRole("combobox", { name: /^Estudio/ });
    await selector.selectOption({ label: b.nombre });
    await expect(selector).toHaveValue(b.tenantId);

    // Sin recargar: no deben quedar clientes del estudio anterior bajo el estudio nuevo.
    await expect(
      page.getByRole("link", { name: clienteB.razonSocial }),
    ).toBeVisible();
    await expect(page.getByText(clienteA.razonSocial)).toHaveCount(0);
  });

  test("quien ya tiene cuenta acepta la invitación a otro estudio y cambia a él", async ({
    siembra,
    sesiones,
    correo,
    browser,
  }) => {
    const a = await siembra.estudio({ nombre: "Estudio Origen E2E" });
    const b = await siembra.estudio({ nombre: "Estudio Destino E2E" });
    const duenoB = await sesiones.paginaDe(b.dueno);

    await invitar(duenoB.page, a.dueno.correo, "Contador");
    const enlace = await correo.enlaceDe(a.dueno.correo, ASUNTO_INVITACION);

    const persona = await paginaAnonima(browser);
    await persona.goto(enlace);
    await expect(
      persona.getByText("Ya tienes una cuenta: inicia sesión para aceptar."),
    ).toBeVisible();
    await persona
      .getByLabel("Contraseña", { exact: true })
      .fill(a.dueno.contrasena);
    await persona
      .getByRole("button", { name: "Iniciar sesión y aceptar" })
      .click();
    await expect(estado(persona, `Te uniste a ${b.nombre}.`)).toBeVisible();

    await persona
      .getByRole("button", { name: "Cambiar a este estudio" })
      .click();
    await expect(
      persona.getByRole("heading", { name: "ContApp", exact: true }),
    ).toBeVisible();
    await expect(
      persona.getByRole("combobox", { name: /^Estudio/ }),
    ).toHaveValue(b.tenantId);
    await expect(
      persona.getByRole("option", { name: a.nombre }),
    ).toBeAttached();
    await persona.context().close();
  });
});
