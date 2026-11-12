// E-01 · Alta y login (spec 018, T4): registro público → enlace por correo → contraseña → panel; login con
// credenciales correctas y erróneas (mensaje único); enlace de registro ya usado. El registro y el correo van
// por la UI (D-4); el contexto de cada prueba lleva su propio `X-Forwarded-For`.
import { correoUnico } from "../soporte/siembra.js";
import { alerta, estado, expect, test } from "../soporte/fixtures.js";
import {
  ASUNTO_REGISTRO,
  TEXTOS,
  contrasenaNueva,
  ingresar,
  nombreDeEstudio,
} from "../soporte/selectores/acceso.js";

test("el registro por correo termina en el panel del estudio nuevo", async ({
  page,
  correo,
}) => {
  const estudio = nombreDeEstudio();
  const dueno = correoUnico();
  const contrasena = contrasenaNueva();

  await page.goto("/registro");
  await page.getByLabel("Nombre del estudio").fill(estudio);
  await page.getByLabel("Tu nombre").fill("Dueña de Alta");
  await page.getByLabel("Correo", { exact: true }).fill(dueno);
  await page.getByRole("button", { name: "Crear estudio" }).click();
  await expect(estado(page, TEXTOS.revisaCorreo)).toBeVisible();

  const enlace = await correo.enlaceDe(dueno, ASUNTO_REGISTRO);
  await page.goto(enlace);
  await expect(
    page.getByRole("heading", { name: "Crear estudio en ContApp" }),
  ).toBeVisible();
  await expect(page.getByText(`Estudio: ${estudio}`)).toBeVisible();
  // El token solo viaja en el fragmento y se borra de la URL al leerlo.
  expect(page.url()).not.toContain("#t=");

  await page.getByLabel("Contraseña", { exact: true }).fill(contrasena);
  await page.getByRole("button", { name: "Confirmar y crear estudio" }).click();
  await expect(estado(page, TEXTOS.registroCreado)).toBeVisible();

  await page.getByRole("link", { name: "Ir a iniciar sesión" }).click();
  await expect(
    page.getByRole("heading", { name: "Ingresar a ContApp" }),
  ).toBeVisible();
  await ingresar(page, dueno, contrasena);

  await expect(
    page.getByRole("heading", { name: "ContApp", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Clientes" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Usuarios" })).toBeVisible();
  await expect(page.getByRole("option", { name: estudio })).toBeAttached();
});

test("el registro rechaza un RUC y una contraseña que no cumplen", async ({
  page,
  correo,
}) => {
  const dueno = correoUnico();

  await page.goto("/registro");
  await page.getByLabel("Nombre del estudio").fill(nombreDeEstudio());
  await page.getByLabel("RUC del estudio (opcional)").fill("123");
  await page.getByLabel("Tu nombre").fill("Dueña de Alta");
  await page.getByLabel("Correo", { exact: true }).fill(dueno);
  await page.getByRole("button", { name: "Crear estudio" }).click();
  await expect(page.getByText(TEXTOS.rucInvalido)).toBeVisible();
  // Nada se envió: no hay mensaje de «revisa tu correo» ni correo.
  await expect(estado(page, TEXTOS.revisaCorreo)).toHaveCount(0);
  expect(await correo.cuantos(dueno, ASUNTO_REGISTRO)).toBe(0);

  await page.getByLabel("RUC del estudio (opcional)").fill("");
  await page.getByRole("button", { name: "Crear estudio" }).click();
  await expect(estado(page, TEXTOS.revisaCorreo)).toBeVisible();

  const enlace = await correo.enlaceDe(dueno, ASUNTO_REGISTRO);
  await page.goto(enlace);
  await page.getByLabel("Contraseña", { exact: true }).fill("corta");
  await page.getByRole("button", { name: "Confirmar y crear estudio" }).click();
  await expect(alerta(page, TEXTOS.contrasenaLongitud)).toBeVisible();
});

test("el enlace de registro ya usado ya no sirve", async ({
  page,
  correo,
  vigilancia,
}) => {
  vigilancia.permitirError(/400/);
  const dueno = correoUnico();

  await page.goto("/registro");
  await page.getByLabel("Nombre del estudio").fill(nombreDeEstudio());
  await page.getByLabel("Tu nombre").fill("Dueña de Alta");
  await page.getByLabel("Correo", { exact: true }).fill(dueno);
  await page.getByRole("button", { name: "Crear estudio" }).click();
  await expect(estado(page, TEXTOS.revisaCorreo)).toBeVisible();

  const enlace = await correo.enlaceDe(dueno, ASUNTO_REGISTRO);
  await page.goto(enlace);
  await page.getByLabel("Contraseña", { exact: true }).fill(contrasenaNueva());
  await page.getByRole("button", { name: "Confirmar y crear estudio" }).click();
  await expect(estado(page, TEXTOS.registroCreado)).toBeVisible();

  // Otra página antes: ir al mismo enlace solo con otro fragmento no recarga la pantalla.
  await page.goto("/login");
  await page.goto(enlace);
  await expect(alerta(page, TEXTOS.registroInvalido)).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Solicitar un registro nuevo" }),
  ).toBeVisible();
  await expect(page.getByLabel("Contraseña", { exact: true })).toHaveCount(0);
});

test("un enlace de registro sin token es inválido", async ({
  page,
  vigilancia,
}) => {
  vigilancia.permitirError(/400/);
  await page.goto("/registro/confirmar");
  await expect(alerta(page, TEXTOS.registroInvalido)).toBeVisible();
});

test("con la contraseña correcta el login lleva al panel", async ({
  page,
  siembra,
}) => {
  const estudio = await siembra.estudio();

  await page.goto("/login");
  await ingresar(page, estudio.dueno.correo, estudio.dueno.contrasena);

  await expect(
    page.getByRole("heading", { name: "ContApp", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: /^Estudio/ })).toHaveValue(
    estudio.tenantId,
  );
});

test("credenciales erróneas dan el mismo mensaje exista o no la cuenta", async ({
  page,
  siembra,
  vigilancia,
}) => {
  vigilancia.permitirError(/401/);
  const estudio = await siembra.estudio();

  await page.goto("/login");
  await ingresar(page, estudio.dueno.correo, "Contrasena-equivocada-1");
  await expect(alerta(page, TEXTOS.credencialesInvalidas)).toBeVisible();
  const conCuenta = await alerta(page, /./).innerText();

  await page.getByLabel("Correo", { exact: true }).fill(correoUnico());
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(alerta(page, TEXTOS.credencialesInvalidas)).toBeVisible();
  const sinCuenta = await alerta(page, /./).innerText();

  expect(sinCuenta).toBe(conCuenta);
  await expect(page).toHaveURL(/\/login$/);
});

test("cerrar sesión desde el panel devuelve al login y se puede volver a entrar", async ({
  page,
  siembra,
}) => {
  const estudio = await siembra.estudio();
  await page.goto("/login");
  await ingresar(page, estudio.dueno.correo, estudio.dueno.contrasena);
  await expect(
    page.getByRole("heading", { name: "ContApp", exact: true }),
  ).toBeVisible();

  const cerrar = page.getByRole("button", { name: "Cerrar sesión" });
  await expect(cerrar).toBeVisible();
  await cerrar.click();
  await expect(page).toHaveURL(/\/login$/);

  // Sin sesión, el panel manda al login.
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);

  await ingresar(page, estudio.dueno.correo, estudio.dueno.contrasena);
  await expect(
    page.getByRole("heading", { name: "ContApp", exact: true }),
  ).toBeVisible();
});
