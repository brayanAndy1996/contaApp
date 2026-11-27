// E-13 · Cuenta segura (spec 029, T11; CA-2, CA-4, CA-5, CA-6, CA-9, CA-10; RF-012, RF-014, RF-015). Con los adaptadores en `mock`:
//  - Super-admin (alta en `admin_plataforma`, sin estudio): sin TOTP entra pero solo puede enrolar (403 en `/plataforma`, `/admin` lo
//    manda a «Seguridad»); enrola por la pantalla con un TOTP calculado en la prueba; el login pide el segundo paso (la sesión
//    `pendiente` recibe 401 en el resto), rechaza el código ya usado (replay) y acepta el siguiente; un código de recuperación
//    entra una sola vez; el operador restablece (`db:totp-restablecer`): la sesión viva cae y vuelve la exigencia.
//  - Avisos U8 en Mailpit (activar, código de recuperación usado, restablecer, desactivar): uno por evento, sin código, secreto,
//    URI ni enlace; y el secreto, los códigos y el URI no aparecen en los logs ni en la BD en claro (CA-6).
//  - Dueño (rol que lo exige, U1): bloqueado en las rutas del estudio hasta enrolar y, activo, sin «Desactivar» (CA-4).
//  - «Mi cuenta → Seguridad»: lista las sesiones propias, revoca una y luego las demás (la revocada recibe 401); un rol que no lo
//    exige desactiva el TOTP con contraseña y código (CA-5, CA-10).
// El código de recuperación y el TOTP los pone la prueba (un solo uso), así que cada prueba lleva sus propias cuentas.
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { URL_BACKEND, URL_FRONTEND } from "../soporte/pila/entorno.js";
import { restablecerTotp } from "../soporte/cli-totp.js";
import { ipUnica } from "../soporte/sesiones.js";
import { estado, expect, test as base } from "../soporte/fixtures.js";
import { SiembraCuenta } from "../soporte/siembra-cuenta.js";
import {
  loginPendiente,
  obtener,
  verificarSegundoPaso,
} from "../soporte/segundo-paso.js";
import {
  ASUNTO_INVITACION,
  TEXTOS as TEXTOS_ACCESO,
  ingresar,
} from "../soporte/selectores/acceso.js";
import {
  ASUNTOS,
  TEXTOS,
  activarPorPantalla,
  activarTotp,
  campoCodigoLogin,
  codigosListados,
  desactivarTotp,
  logsDeLaPila,
  pasoDeCodigo,
  revocarOtras,
  revocarUna,
  sesionesFilas,
  verificar,
  verificarAvisoLimpio,
} from "../soporte/selectores/cuenta-segura.js";
import type { Vigilancia } from "../soporte/vigilancia.js";

interface PaginaNueva {
  readonly page: Page;
  readonly context: BrowserContext;
}

const test = base.extend<{
  cuentas: SiembraCuenta;
  paginaNueva: () => Promise<PaginaNueva>;
}>({
  // La siembra y la limpieza de la cuenta segura: borra `auth.totp*`, `cuenta_evento` y sesiones antes del usuario.
  cuentas: async ({}, use) => {
    const url = process.env.MIGRATIONS_DATABASE_URL;
    if (url === undefined)
      throw new Error(
        "Falta MIGRATIONS_DATABASE_URL (la fija el globalSetup).",
      );
    const cuentas = new SiembraCuenta(url);
    await use(cuentas);
    await cuentas.limpiar();
  },
  // Otro navegador (otro dispositivo) sin sesión, con su propia IP: así ninguna prueba comparte cupo de login.
  paginaNueva: async ({ browser, vigilancia }, use) => {
    const abiertas: PaginaNueva[] = [];
    await use(() => abrirContexto(browser, vigilancia, abiertas));
    for (const { context } of abiertas) {
      await vigilancia.revisarContexto(context);
      await context.close();
    }
  },
});

async function abrirContexto(
  browser: Browser,
  vigilancia: Vigilancia,
  lista: PaginaNueva[],
): Promise<PaginaNueva> {
  const context = await browser.newContext({
    extraHTTPHeaders: { "X-Forwarded-For": ipUnica() },
  });
  await vigilancia.observarContexto(context);
  const nueva = { page: await context.newPage(), context };
  lista.push(nueva);
  return nueva;
}

interface EstadoSesion {
  readonly factor?: string;
  readonly totpActivo?: boolean;
  readonly factorExigido?: boolean;
}

/** `GET /api/auth/sesion` con la sesión del navegador (por el frontend, que reescribe a la API). */
async function estadoDeSesion(page: Page): Promise<EstadoSesion> {
  const r = await page.request.get("/api/auth/sesion");
  expect(r.status()).toBe(200);
  return (await r.json()) as EstadoSesion;
}

async function codigoDeError(
  page: Page,
  ruta: string,
  estudioId?: string,
): Promise<{ status: number; codigo: string | undefined }> {
  const r = await page.request.get(`/api${ruta}`, {
    headers: estudioId === undefined ? {} : { "X-Estudio": estudioId },
  });
  const cuerpo = (await r.json().catch(() => null)) as {
    codigo?: string;
  } | null;
  return { status: r.status(), codigo: cuerpo?.codigo };
}

/** Estado HTTP de `GET /auth/sesion` con una cookie de sesión concreta, directo a la API. */
async function estadoConCookie(cookie: string, ip: string): Promise<number> {
  const r = await fetch(`${URL_BACKEND}/auth/sesion`, {
    headers: { Cookie: cookie, Origin: URL_FRONTEND, "X-Forwarded-For": ip },
  });
  return r.status;
}

/** Login por la pantalla hasta el paso del código (la contraseña ya fue correcta). */
async function ingresarHastaElCodigo(
  page: Page,
  correo: string,
  contrasena: string,
): Promise<void> {
  await page.goto("/login");
  await ingresar(page, correo, contrasena);
  await expect(pasoDeCodigo(page)).toBeVisible();
}

test.describe("E-13 · cuenta segura", () => {
  test("el super-admin solo puede enrolar; luego entra en dos pasos, con código de recuperación y el operador lo restablece", async ({
    page,
    cuentas,
    correo,
    vigilancia,
    paginaNueva,
  }) => {
    vigilancia.permitirError(/40[13]/);
    const admin = await cuentas.superAdmin();

    await test.step("sin TOTP, la contraseña entra pero solo se puede enrolar (CA-4)", async () => {
      await page.goto("/login");
      await ingresar(page, admin.correo, admin.contrasena);
      await expect(page).toHaveURL(/\/cuenta\/seguridad$/);
      expect(await estadoDeSesion(page)).toMatchObject({
        factor: "sin_factor",
        totpActivo: false,
        factorExigido: true,
      });
      expect(await codigoDeError(page, "/plataforma/yo")).toEqual({
        status: 403,
        codigo: "segundo_factor_requerido",
      });
      await page.goto("/admin");
      await expect(page).toHaveURL(/\/cuenta\/seguridad$/);
      await expect(page.getByText(TEXTOS.exigidoAviso).first()).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Administración de plataforma" }),
      ).toHaveCount(0);
    });

    // El secreto, el URI y los códigos nunca deben salir de la respuesta de enrolar y de la pantalla (CA-6).
    const { autenticador, codigos, cacheControl } = await activarPorPantalla(
      page,
      admin.contrasena,
    );
    const prohibidos = (): string[] => [
      autenticador.secretoBase32,
      ...codigos,
      ...autenticador.entregados,
    ];

    await test.step("activo: la respuesta con el URI no se cachea, la sesión queda verificada y el panel abre", async () => {
      expect(cacheControl).toContain("no-store");
      expect(await estadoDeSesion(page)).toMatchObject({
        factor: "verificado",
        totpActivo: true,
        factorExigido: true,
      });
      await expect(desactivarTotp(page)).toHaveCount(0);
      await page.goto("/admin");
      await expect(
        page.getByRole("heading", { name: "Administración de plataforma" }),
      ).toBeVisible();
      expect((await page.request.get("/api/plataforma/yo")).status()).toBe(200);
    });

    await test.step("login en dos pasos: la sesión pendiente solo sirve para verificar; el código ya usado se rechaza y el siguiente entra (CA-2)", async () => {
      const p = await loginPendiente(admin.correo, admin.contrasena);
      expect(p.cuerpo).toMatchObject({
        segundoFactor: true,
        estudioActivo: null,
      });
      expect(p.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // CA-2: la sesión `pendiente` recibe 401 en toda ruta salvo verificar y salir.
      for (const ruta of [
        "/auth/sesion",
        "/auth/sesiones",
        "/auth/estudios",
        "/plataforma/yo",
      ]) {
        expect((await obtener(p, ruta)).status).toBe(401);
      }
      // Replay (D3): el código con el que se confirmó el enrolamiento ya se usó.
      const replay = await verificarSegundoPaso(p, {
        codigo: autenticador.repetido(),
      });
      expect(replay).toMatchObject({
        status: 401,
        cuerpo: { codigo: "codigo_invalido" },
      });
      // Un código de un paso muy lejano, fuera de la ventana de ±1.
      expect(
        (
          await verificarSegundoPaso(p, {
            codigo: autenticador.fueraDeVentana(),
          })
        ).status,
      ).toBe(401);
      const ok = await verificarSegundoPaso(p, {
        codigo: await autenticador.siguiente(),
      });
      expect(ok.status).toBe(200);
      expect(ok.cookie).not.toBeNull();
      const verificada = { ...p, cookie: ok.cookie ?? "" };
      expect((await obtener(verificada, "/auth/sesion")).cuerpo).toMatchObject({
        factor: "verificado",
        totpActivo: true,
      });
      expect((await obtener(verificada, "/plataforma/yo")).status).toBe(200);
      // El token rotó: la cookie `pendiente` ya no vale (ni para repetir el código).
      expect((await obtener(p, "/auth/sesion")).status).toBe(401);
    });

    await test.step("un código de recuperación entra una sola vez (CA-9)", async () => {
      const [primero, segundo] = codigos;
      if (primero === undefined || segundo === undefined)
        throw new Error("Faltan códigos de recuperación.");
      const uno = await loginPendiente(admin.correo, admin.contrasena);
      const entro = await verificarSegundoPaso(uno, {
        codigoRecuperacion: primero,
      });
      expect(entro.status).toBe(200);
      expect(
        (
          await obtener(
            { ...uno, cookie: entro.cookie ?? "" },
            "/plataforma/yo",
          )
        ).status,
      ).toBe(200);

      const dos = await loginPendiente(admin.correo, admin.contrasena);
      const repetido = await verificarSegundoPaso(dos, {
        codigoRecuperacion: primero,
      });
      expect(repetido).toMatchObject({
        status: 401,
        cuerpo: { codigo: "codigo_invalido" },
      });
      // Otro código de recuperación sí sirve: solo se gastó el primero.
      expect(
        (await verificarSegundoPaso(dos, { codigoRecuperacion: segundo }))
          .status,
      ).toBe(200);
    });

    await test.step("avisos de activación y de uso de un código de recuperación, sin códigos, secreto ni enlaces (CA-10, CA-6)", async () => {
      const activado = await correo.ultimo(admin.correo, ASUNTOS.activado);
      verificarAvisoLimpio(activado, prohibidos());
      expect(activado.texto).toContain(admin.nombre);
      const usado = await correo.ultimo(
        admin.correo,
        ASUNTOS.recuperacionUsada,
      );
      verificarAvisoLimpio(usado, prohibidos());
      // Se usaron dos códigos de recuperación (uno por cada ingreso que entró): dos avisos; el rechazado no manda ninguno.
      await expect
        .poll(() => correo.cuantos(admin.correo, ASUNTOS.recuperacionUsada))
        .toBe(2);
      expect(await correo.cuantos(admin.correo, ASUNTOS.activado)).toBe(1);
    });

    await test.step("el secreto no está en claro en la BD ni en los logs (CA-6, D1)", async () => {
      const volcado = await cuentas.volcadoTotp(admin.id);
      expect(volcado).not.toBe("");
      for (const valor of [
        autenticador.secretoBase32,
        autenticador.secreto.toString("hex"),
        autenticador.secreto.toString("base64"),
        ...codigos,
      ]) {
        expect(volcado).not.toContain(valor);
      }
      const logs = await logsDeLaPila();
      for (const valor of [autenticador.secretoBase32, ...codigos]) {
        expect(logs).not.toContain(valor);
      }
      expect(logs).not.toContain("otpauth://");
      expect(await cuentas.eventos(admin.id)).toEqual([
        "totp_activado",
        "recuperacion_usada",
        "recuperacion_usada",
      ]);
    });

    await test.step("el operador restablece: la sesión viva cae, avisa por correo y vuelve la exigencia (CA-9, U5, U8)", async () => {
      const [, , tercero] = codigos;
      if (tercero === undefined)
        throw new Error("Faltan códigos de recuperación.");
      const pendiente = await loginPendiente(admin.correo, admin.contrasena);
      const entro = await verificarSegundoPaso(pendiente, {
        codigoRecuperacion: tercero,
      });
      expect(entro.status).toBe(200);
      const viva = { ...pendiente, cookie: entro.cookie ?? "" };
      expect((await obtener(viva, "/auth/sesion")).status).toBe(200);
      expect(await cuentas.sesionesVigentes(admin.id)).toBeGreaterThan(0);

      await restablecerTotp(admin.correo);

      expect(await cuentas.sesionesVigentes(admin.id)).toBe(0);
      expect((await obtener(viva, "/auth/sesion")).status).toBe(401);
      const aviso = await correo.ultimo(admin.correo, ASUNTOS.restablecido);
      verificarAvisoLimpio(aviso, prohibidos());
      expect(await cuentas.eventos(admin.id)).toContain("totp_restablecido");
      expect(await cuentas.volcadoTotp(admin.id)).toBe("");

      // La contraseña sigue igual y ya no pide código; pero el super-admin vuelve a quedar bloqueado hasta enrolar.
      const despues = await paginaNueva();
      await despues.page.goto("/login");
      await ingresar(despues.page, admin.correo, admin.contrasena);
      await expect(despues.page).toHaveURL(/\/cuenta\/seguridad$/);
      expect(await estadoDeSesion(despues.page)).toMatchObject({
        factor: "sin_factor",
        totpActivo: false,
        factorExigido: true,
      });
      expect(
        (await despues.page.request.get("/api/plataforma/yo")).status(),
      ).toBe(403);
    });
  });

  // T11b: la pantalla de «Verificación en dos pasos» toma el CSRF de la respuesta del login (la sesión `pendiente` no lee
  // `GET /auth/sesion`, que responde 401) y termina el login.
  test("login en dos pasos por pantalla: el código llega al servidor y entra", async ({
    page,
    siembra,
    cuentas,
    paginaNueva,
    vigilancia,
  }) => {
    vigilancia.permitirError(/40[13]/);
    const estudio = await siembra.estudio();
    cuentas.registrar(estudio);
    const dueno = estudio.dueno;
    await page.goto("/login");
    await ingresar(page, dueno.correo, dueno.contrasena);
    await expect(page).toHaveURL(/\/cuenta\/seguridad$/);
    const { autenticador } = await activarPorPantalla(page, dueno.contrasena);

    const otro = await paginaNueva();
    await ingresarHastaElCodigo(otro.page, dueno.correo, dueno.contrasena);
    await campoCodigoLogin(otro.page).fill(await autenticador.siguiente());
    await verificar(otro.page).click();
    await expect(otro.page).toHaveURL(/\/$/);
    expect(await estadoDeSesion(otro.page)).toMatchObject({
      factor: "verificado",
    });
  });

  test("el Dueño queda bloqueado en su estudio hasta enrolar y con el TOTP activo ya no puede desactivarlo (CA-4, U1)", async ({
    page,
    siembra,
    cuentas,
    correo,
    vigilancia,
  }) => {
    vigilancia.permitirError(/40[13]/);
    const estudio = await siembra.estudio();
    cuentas.registrar(estudio);
    const dueno = estudio.dueno;

    await page.goto("/login");
    await ingresar(page, dueno.correo, dueno.contrasena);
    // Con un estudio activo el login lleva al panel; el marco lo manda a «Seguridad» y no deja ver nada más.
    await expect(page).toHaveURL(/\/cuenta\/seguridad$/);
    await expect(page.getByText(TEXTOS.exigidoAviso).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Clientes" })).toHaveCount(0);
    expect(await codigoDeError(page, "/clientes", estudio.tenantId)).toEqual({
      status: 403,
      codigo: "segundo_factor_requerido",
    });
    // Lista cerrada sin factor: ver la sesión sigue permitido.
    expect(await estadoDeSesion(page)).toMatchObject({
      factor: "sin_factor",
      factorExigido: true,
    });

    const { autenticador, codigos } = await activarPorPantalla(
      page,
      dueno.contrasena,
    );
    await expect(desactivarTotp(page)).toHaveCount(0);
    expect(await estadoDeSesion(page)).toMatchObject({
      factor: "verificado",
      totpActivo: true,
    });
    expect(
      (await codigoDeError(page, "/clientes", estudio.tenantId)).status,
    ).toBe(200);
    await expect(page.getByRole("link", { name: "Clientes" })).toBeVisible();

    const aviso = await correo.ultimo(dueno.correo, ASUNTOS.activado);
    verificarAvisoLimpio(aviso, [
      autenticador.secretoBase32,
      ...codigos,
      ...autenticador.entregados,
    ]);
  });

  test("«Mi cuenta → Seguridad» lista las sesiones, revoca una y luego las demás; un rol que no lo exige desactiva el TOTP (CA-5, CA-10)", async ({
    page,
    siembra,
    sesiones,
    cuentas,
    correo,
    vigilancia,
  }) => {
    vigilancia.permitirError(/401/);
    const estudio = await siembra.estudio();
    const contador = await siembra.miembro(estudio.tenantId, "contador");
    cuentas.registrar(estudio, contador);

    // Dos sesiones más de la misma persona (otros dispositivos), por API; la de la pantalla es la tercera.
    const otraA = await sesiones.entrar(contador);
    const otraB = await sesiones.entrar(contador);
    await page.goto("/login");
    await ingresar(page, contador.correo, contador.contrasena);
    await expect(page).toHaveURL(/\/$/);
    await page.goto("/cuenta/seguridad");

    await test.step("lista las propias vigentes, sin hashes ni tokens, y marca «Esta sesión»", async () => {
      await expect(sesionesFilas(page)).toHaveCount(3);
      await expect(page.getByText("Esta sesión")).toHaveCount(1);
      await expect(revocarUna(page)).toHaveCount(2);
      const lista = await page.request.get("/api/auth/sesiones");
      expect(lista.status()).toBe(200);
      for (const fila of (await lista.json()) as Record<string, unknown>[]) {
        expect(Object.keys(fila).sort()).toEqual([
          "actual",
          "creadaEn",
          "dispositivo",
          "id",
          "ip",
          "ultimoUso",
        ]);
      }
    });

    await test.step("revocar una: la revocada recibe 401 en su siguiente petición (CA-5)", async () => {
      await revocarUna(page).first().click();
      await expect(sesionesFilas(page)).toHaveCount(2);
      const estados = [
        await estadoConCookie(otraA.cookie, otraA.ip),
        await estadoConCookie(otraB.cookie, otraB.ip),
      ].sort();
      expect(estados).toEqual([200, 401]);
    });

    await test.step("revocar las demás: solo queda la actual", async () => {
      await revocarOtras(page).click();
      await expect(sesionesFilas(page)).toHaveCount(1);
      await expect(revocarOtras(page)).toHaveCount(0);
      expect(await estadoConCookie(otraA.cookie, otraA.ip)).toBe(401);
      expect(await estadoConCookie(otraB.cookie, otraB.ip)).toBe(401);
      expect((await page.request.get("/api/auth/sesion")).status()).toBe(200);
      expect(await cuentas.sesionesVigentes(contador.id)).toBe(1);
    });

    const { autenticador, codigos } = await activarPorPantalla(
      page,
      contador.contrasena,
    );
    const prohibidos = (): string[] => [
      autenticador.secretoBase32,
      ...codigos,
      ...autenticador.entregados,
    ];

    await test.step("un rol que no lo exige puede desactivarlo con contraseña y código", async () => {
      expect((await estadoDeSesion(page)).factorExigido).toBe(false);
      await desactivarTotp(page).click();
      await page.getByLabel("Contraseña actual").fill(contador.contrasena);
      await campoCodigoLogin(page).fill(await autenticador.siguiente());
      await page
        .getByRole("button", { name: "Confirmar desactivación" })
        .click();
      await expect(page.getByText(TEXTOS.desactivada)).toBeVisible();
      await expect(activarTotp(page)).toBeVisible();
      await expect(codigosListados(page)).toHaveCount(0);
      expect(await estadoDeSesion(page)).toMatchObject({ totpActivo: false });
    });

    await test.step("un aviso por cada evento, sin códigos, secreto ni enlaces (CA-10)", async () => {
      verificarAvisoLimpio(
        await correo.ultimo(contador.correo, ASUNTOS.activado),
        prohibidos(),
      );
      verificarAvisoLimpio(
        await correo.ultimo(contador.correo, ASUNTOS.desactivado),
        prohibidos(),
      );
      expect(await correo.cuantos(contador.correo, ASUNTOS.activado)).toBe(1);
      expect(await correo.cuantos(contador.correo, ASUNTOS.desactivado)).toBe(
        1,
      );
      expect(await cuentas.eventos(contador.id)).toEqual([
        "totp_activado",
        "totp_desactivado",
      ]);
    });
  });
});

/** El Dueño del estudio invita desde `/usuarios` a un correo con el rol dado (por su etiqueta en pantalla). */
async function invitarPorPantalla(
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
  await expect(estado(page, TEXTOS_ACCESO.invitacionEnviada)).toBeVisible();
}

test.describe("E-13 · invitación con segundo factor (T18a)", () => {
  test("quien ya tiene cuenta y TOTP activo acepta la invitación pasando por el paso de código de la propia página, sin perder el token", async ({
    page,
    siembra,
    sesiones,
    cuentas,
    correo,
    paginaNueva,
    vigilancia,
  }) => {
    vigilancia.permitirError(/401/);
    const a = await siembra.estudio({ nombre: "Estudio Origen 2FA E2E" });
    const b = await siembra.estudio({ nombre: "Estudio Destino 2FA E2E" });
    // Rol que no exige el factor: puede enrolar por su cuenta y entrar a su estudio.
    const existente = await siembra.miembro(a.tenantId, "contador");
    cuentas.registrar(a, existente);
    cuentas.registrar(b);

    await page.goto("/login");
    await ingresar(page, existente.correo, existente.contrasena);
    await expect(page).toHaveURL(/\/$/);
    await page.goto("/cuenta/seguridad");
    const { autenticador } = await activarPorPantalla(
      page,
      existente.contrasena,
    );

    const duenoB = await sesiones.paginaDe(b.dueno);
    await invitarPorPantalla(duenoB.page, existente.correo, "Contador");
    const enlace = await correo.enlaceDe(existente.correo, ASUNTO_INVITACION);

    const persona = (await paginaNueva()).page;
    await persona.goto(enlace);
    await expect(
      persona.getByText("Ya tienes una cuenta: inicia sesión para aceptar."),
    ).toBeVisible();
    // El token se lee una vez y se borra de la URL.
    expect(persona.url()).not.toContain("#t=");
    await persona
      .getByLabel("Contraseña", { exact: true })
      .fill(existente.contrasena);
    await persona
      .getByRole("button", { name: "Iniciar sesión y aceptar" })
      .click();

    await test.step("pide el código en la misma página (no manda a /login ni a Seguridad)", async () => {
      await expect(campoCodigoLogin(persona)).toBeVisible();
      await expect(persona).toHaveURL(/\/invitacion$/);
      await expect(
        persona.getByText("Ingresa el código de verificación para aceptar"),
      ).toBeVisible();
      expect((await persona.request.get("/api/auth/sesion")).status()).toBe(
        401,
      );
    });

    await test.step("un código incorrecto se queda en el paso y no pierde la invitación", async () => {
      await campoCodigoLogin(persona).fill("000000");
      await verificar(persona).click();
      await expect(persona.getByText(TEXTOS.codigoIncorrecto)).toBeVisible();
      await expect(campoCodigoLogin(persona)).toBeVisible();
      await expect(persona).toHaveURL(/\/invitacion$/);
    });

    await test.step("con el código correcto acepta la invitación y sigue en la misma página", async () => {
      await campoCodigoLogin(persona).fill(await autenticador.siguiente());
      await verificar(persona).click();
      await expect(estado(persona, `Te uniste a ${b.nombre}.`)).toBeVisible();
      expect(await estadoDeSesion(persona)).toMatchObject({
        factor: "verificado",
        totpActivo: true,
      });
      await persona
        .getByRole("button", { name: "Cambiar a este estudio" })
        .click();
      await expect(
        persona.getByRole("combobox", { name: /^Estudio/ }),
      ).toHaveValue(b.tenantId);
      await expect(
        persona.getByRole("option", { name: a.nombre }),
      ).toBeAttached();
    });
  });

  test("un rol que exige el segundo factor y aún no lo activó ve el aviso con «Ir a Seguridad», sin aceptar la invitación", async ({
    siembra,
    sesiones,
    cuentas,
    correo,
    paginaNueva,
    vigilancia,
  }) => {
    vigilancia.permitirError(/40[13]/);
    const a = await siembra.estudio({ nombre: "Estudio Origen Exigido E2E" });
    const b = await siembra.estudio({ nombre: "Estudio Destino Exigido E2E" });
    // El Dueño de A exige el factor (U1) y no lo ha activado: inicia sesión como `sin_factor`.
    cuentas.registrar(a);
    cuentas.registrar(b);
    const exigido = a.dueno;

    const duenoB = await sesiones.paginaDe(b.dueno);
    await invitarPorPantalla(duenoB.page, exigido.correo, "Contador");
    const enlace = await correo.enlaceDe(exigido.correo, ASUNTO_INVITACION);

    const persona = (await paginaNueva()).page;
    await persona.goto(enlace);
    await persona
      .getByLabel("Contraseña", { exact: true })
      .fill(exigido.contrasena);
    await persona
      .getByRole("button", { name: "Iniciar sesión y aceptar" })
      .click();

    await expect(persona.getByText(TEXTOS.exigidoAviso).first()).toBeVisible();
    await expect(persona).toHaveURL(/\/invitacion$/);
    await expect(
      persona.getByText("vuelve a abrir el enlace de la invitación"),
    ).toBeVisible();
    await expect(estado(persona, `Te uniste a ${b.nombre}.`)).toHaveCount(0);
    expect(await estadoDeSesion(persona)).toMatchObject({
      factor: "sin_factor",
      factorExigido: true,
    });
    expect(await cuentas.esMiembro(exigido.id, b.tenantId)).toBe(false);

    await persona.getByRole("link", { name: "Ir a Seguridad" }).click();
    await expect(persona).toHaveURL(/\/cuenta\/seguridad$/);
    await expect(activarTotp(persona)).toBeVisible();
  });
});
