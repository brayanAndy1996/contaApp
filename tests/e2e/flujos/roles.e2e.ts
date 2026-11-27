// E-14 · Roles personalizados (spec 030, T5; CA-1, CA-2, CA-4, CA-6, CA-7, CA-9; HU-05, RF-022, RF-023). Con los adaptadores en `mock`:
//  - Flujo completo: el Dueño (con TOTP real, U1) crea «Practicante» (alcance asignado) por la pantalla «Equipo → Roles», lo invita
//    (Mailpit), la persona acepta y entra, y ve solo su cliente asignado (404 en el otro). El Dueño le agrega `usuarios.gestionar`
//    (con su `usuarios.ver`, U3): la UI avisa del impacto antes (U6, U8), la siguiente petición del practicante ya pide el segundo factor
//    (CA-7) y, tras enrolar, vuelve a entrar. Eliminar el rol en uso da 409 `rol_en_uso` con ambos conteos (U5); al liberarlo, se elimina.
//  - Por API: nombre único por estudio, distinto de los de sistema (CA-1); permiso fuera del catálogo o combinación inválida: 422
//    (CA-2); un rol de otro estudio da 404 al invitar y al cambiar rol (CA-9); nunca queda una fila con un rol inexistente (CA-6).
// Los nombres de rutas, campos y códigos salen de `plan.md#contratos`; los de la pantalla, de `soporte/selectores/roles.ts`.
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { ipUnica } from "../soporte/sesiones.js";
import type { Sesion } from "../soporte/sesiones.js";
import {
  loginPendiente,
  obtener,
  verificarSegundoPaso,
} from "../soporte/segundo-paso.js";
import type { Autenticador } from "../soporte/totp.js";
import { alerta, estado, expect, test as base } from "../soporte/fixtures.js";
import type { Api } from "../soporte/fixtures.js";
import { correoUnico } from "../soporte/siembra.js";
import { SiembraCuenta } from "../soporte/siembra-cuenta.js";
import { SiembraRoles, rolAsignado } from "../soporte/siembra-roles.js";
import {
  ASUNTO_INVITACION,
  TEXTOS as TEXTOS_ACCESO,
  contrasenaNueva,
  fila,
  ingresar,
} from "../soporte/selectores/acceso.js";
import {
  TEXTOS as TEXTOS_CUENTA,
  activarPorPantalla,
} from "../soporte/selectores/cuenta-segura.js";
import {
  TEXTOS,
  abrirNuevoRol,
  campoNombre,
  casillaPermiso,
  confirmarRol,
  crearRolPorPantalla,
  editarRol,
  elegirRolPropio,
  guardarRol,
  irARoles,
} from "../soporte/selectores/roles.js";
import type { Vigilancia } from "../soporte/vigilancia.js";

interface PaginaNueva {
  readonly page: Page;
  readonly context: BrowserContext;
}

const test = base.extend<{
  cuentas: SiembraCuenta;
  roles: SiembraRoles;
  paginaNueva: () => Promise<PaginaNueva>;
}>({
  // Borra, antes del estudio, todo lo que cuelga de él (incluidos `rol` y `rol_permiso`) y lo de la cuenta segura de los usuarios.
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
  roles: async ({}, use) => {
    const url = process.env.MIGRATIONS_DATABASE_URL;
    if (url === undefined)
      throw new Error(
        "Falta MIGRATIONS_DATABASE_URL (la fija el globalSetup).",
      );
    const roles = new SiembraRoles(url);
    await use(roles);
    await roles.cerrar();
  },
  // Otro navegador (otro dispositivo) sin sesión, con su propia IP: ninguna prueba comparte cupo de login.
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

/** `GET /api<ruta>` con la sesión del navegador y el estudio activo: estado y `codigo` del error, si lo trae. */
async function consultar(
  page: Page,
  ruta: string,
  estudioId: string,
): Promise<{ status: number; codigo: string | undefined; cuerpo: unknown }> {
  const r = await page.request.get(`/api${ruta}`, {
    headers: { "X-Estudio": estudioId },
  });
  const cuerpo = (await r.json().catch(() => null)) as {
    codigo?: string;
  } | null;
  return { status: r.status(), codigo: cuerpo?.codigo, cuerpo };
}

/** Login por API de quien ya tiene TOTP: contraseña → sesión `pendiente` → segundo paso con su autenticador → sesión de trabajo. */
async function sesionConSegundoPaso(
  usuario: Sesion["usuario"],
  tenantId: string,
  autenticador: Autenticador,
): Promise<Sesion> {
  const pendiente = await loginPendiente(usuario.correo, usuario.contrasena);
  const entro = await verificarSegundoPaso(pendiente, {
    codigo: await autenticador.siguiente(),
  });
  expect(entro.status).toBe(200);
  const viva = { ...pendiente, cookie: entro.cookie ?? "" };
  const sesion = await obtener(viva, "/auth/sesion", tenantId);
  expect(sesion.status).toBe(200);
  const csrf = sesion.cuerpo?.csrf;
  if (typeof csrf !== "string") throw new Error("La sesión no trae csrf.");
  return {
    usuario,
    tenantId,
    ip: pendiente.ip,
    cookie: viva.cookie,
    csrf,
  } as unknown as Sesion;
}

const texto = (cuerpo: unknown): string => JSON.stringify(cuerpo ?? null);

/** El Dueño invita desde `/usuarios` a un correo con un rol propio (por su nombre) y espera la confirmación. */
async function invitarConRolPropio(
  page: Page,
  correoInvitado: string,
  rol: string,
): Promise<void> {
  await page.goto("/usuarios");
  await expect(
    page.getByRole("heading", { name: "Invitar a una persona" }),
  ).toBeVisible();
  await page.getByLabel("Correo", { exact: true }).fill(correoInvitado);
  await elegirRolPropio(page, rol);
  await page.getByRole("button", { name: "Invitar", exact: true }).click();
  await expect(estado(page, TEXTOS_ACCESO.invitacionEnviada)).toBeVisible();
  await expect(fila(page, correoInvitado)).toContainText("Pendiente");
}

test.describe("E-14 · roles personalizados", () => {
  test("el Dueño crea «Practicante», lo invita, ve solo lo asignado, le suma un permiso sensible y no puede eliminarlo en uso", async ({
    page,
    siembra,
    api,
    cuentas,
    roles,
    correo,
    paginaNueva,
    vigilancia,
  }) => {
    // 403 (sin permiso o segundo factor), 404 (cliente ajeno) y 409 (rol en uso) llegan a la consola del navegador.
    vigilancia.permitirError(/40[134]|409/);
    const estudio = await siembra.estudio({ nombre: "Estudio Roles E2E" });
    cuentas.registrar(estudio);
    const dueno = estudio.dueno;
    const asignado = await siembra.cliente(estudio.tenantId, {
      ruc: "20700000011",
      razonSocial: "CLIENTE ASIGNADO ROLES E2E S.A.C.",
    });
    const ajeno = await siembra.cliente(estudio.tenantId, {
      ruc: "20700000045",
      razonSocial: "CLIENTE AJENO ROLES E2E S.A.C.",
    });

    // Al enrolar, las sesiones por API anteriores del Dueño caen: su sesión por API se abre después, con el segundo paso real.
    let apiDueno!: Api;

    await test.step("el Dueño exige el TOTP (U1): entra, enrola por la pantalla y queda verificado", async () => {
      await page.goto("/login");
      await ingresar(page, dueno.correo, dueno.contrasena);
      await expect(page).toHaveURL(/\/cuenta\/seguridad$/);
      const { autenticador } = await activarPorPantalla(page, dueno.contrasena);
      expect(await estadoDeSesion(page)).toMatchObject({
        factor: "verificado",
        totpActivo: true,
      });
      apiDueno = api(
        await sesionConSegundoPaso(dueno, estudio.tenantId, autenticador),
      );
    });

    await test.step("el formulario rechaza un nombre con carácter invisible (ronda 1) y no guarda nada", async () => {
      await irARoles(page);
      await abrirNuevoRol(page);
      await campoNombre(page).fill("Prac\u200Bticante");
      await casillaPermiso(page, "clientes.ver").check();
      await guardarRol(page).click();
      await expect(alerta(page, TEXTOS.nombreInvalido)).toBeVisible();
      expect(await roles.cuantosRoles(estudio.tenantId)).toBe(0);
    });

    const permisosIniciales = ["clientes.ver", "sire.descargar"];
    await test.step("CA-1 · crea «Practicante» (alcance asignado) por «Equipo → Roles» y queda guardado", async () => {
      await crearRolPorPantalla(page, {
        nombre: "Practicante",
        alcance: "asignado",
        permisos: permisosIniciales,
      });
      const rol = await roles.rolPorNombre(estudio.tenantId, "Practicante");
      expect(rol).toMatchObject({
        alcance: "asignado",
        permisos: permisosIniciales,
      });
    });
    const rolId = (await roles.rolPorNombre(estudio.tenantId, "Practicante"))
      ?.id;
    if (rolId === undefined) throw new Error("No se creó el rol Practicante.");

    await test.step("CA-1 · el rol es asignable: aparece en los roles asignables y en el selector de la invitación", async () => {
      const asignables = await apiDueno.pedir("GET", "/roles/asignables");
      expect(asignables.status).toBe(200);
      expect(texto(asignables.cuerpo)).toContain(rolId);
    });

    const invitado = correoUnico();
    const contrasena = contrasenaNueva();
    const nombre = "Practicante Invitado E2E";
    const persona = (await paginaNueva()).page;

    await test.step("lo invita (Mailpit): la invitación queda con el rol propio; la persona crea su cuenta y entra", async () => {
      await invitarConRolPropio(page, invitado, "Practicante");
      expect(await roles.rolDeInvitacion(estudio.tenantId, invitado)).toEqual({
        rol: "propio",
        rolId,
      });
      const enlace = await correo.enlaceDe(invitado, ASUNTO_INVITACION);
      await persona.goto(enlace);
      // La página pública solo conoce el rol de sistema (`consultar` no devuelve el nombre del propio): ver el reporte de T15.
      await expect(
        persona.getByText("Te invitaron a", { exact: false }),
      ).toContainText("Estudio Roles E2E");
      expect(persona.url()).not.toContain("#t=");
      await persona.getByLabel("Nombre", { exact: true }).fill(nombre);
      await persona.getByLabel("Contraseña", { exact: true }).fill(contrasena);
      await persona
        .getByRole("button", { name: "Crear cuenta y aceptar" })
        .click();
      await expect(estado(persona, TEXTOS_ACCESO.cuentaCreada)).toBeVisible();
      await persona.getByRole("link", { name: "Ir a iniciar sesión" }).click();
      await ingresar(persona, invitado, contrasena);
      await expect(
        persona.getByRole("heading", { name: "ContApp", exact: true }),
      ).toBeVisible();
    });
    const practicanteId = await roles.usuarioIdPorCorreo(invitado);
    cuentas.registrar(estudio, { id: practicanteId });

    await test.step("CA-6 · la membresía quedó con el rol propio, sin filas huérfanas", async () => {
      expect(
        await roles.rolDeMembresia(estudio.tenantId, practicanteId),
      ).toEqual({ rol: "propio", rolId });
      expect(await roles.huerfanos(estudio.tenantId)).toBe(0);
      await page.goto("/usuarios");
      await expect(fila(page, invitado)).toContainText("Practicante");
      await expect(fila(page, invitado)).toContainText("Activo");
    });

    await roles.asignar(asignado, practicanteId, "colaborador");

    await test.step("CA-4 · con alcance asignado, el practicante ve su cliente y el otro es «no encontrado»", async () => {
      await persona.goto("/clientes");
      await expect(
        persona.getByRole("link", { name: asignado.razonSocial }),
      ).toBeVisible();
      await expect(persona.getByText(ajeno.razonSocial)).toHaveCount(0);
      await expect(persona.getByText(ajeno.ruc)).toHaveCount(0);
      await persona.goto(`/clientes/${ajeno.id}`);
      await expect(alerta(persona, TEXTOS_ACCESO.noEncontrado)).toBeVisible();
      await expect(persona.getByText(ajeno.razonSocial)).toHaveCount(0);
      expect(
        (await consultar(persona, `/clientes/${ajeno.id}`, estudio.tenantId))
          .status,
      ).toBe(404);
      expect(
        (await consultar(persona, `/clientes/${asignado.id}`, estudio.tenantId))
          .status,
      ).toBe(200);
    });

    await test.step("CA-4 · sin `usuarios.gestionar` ni `roles.gestionar`: sin enlace «Usuarios» y 403 en /roles; /acceso/yo da sus efectivos", async () => {
      await persona.goto("/");
      await expect(persona.getByRole("link", { name: "Usuarios" })).toHaveCount(
        0,
      );
      expect(
        (await consultar(persona, "/roles", estudio.tenantId)).status,
      ).toBe(403);
      const yo = await consultar(persona, "/acceso/yo", estudio.tenantId);
      expect(yo.status).toBe(200);
      expect(yo.cuerpo).toMatchObject({
        rolPropio: { id: rolId, nombre: "Practicante" },
        alcance: "asignado",
      });
      expect(
        [...((yo.cuerpo as { permisos: string[] }).permisos ?? [])].sort(),
      ).toEqual(permisosIniciales);
      expect(await estadoDeSesion(persona)).toMatchObject({
        totpActivo: false,
        factorExigido: false,
      });
    });

    const permisosNuevos = [
      ...permisosIniciales,
      "usuarios.ver",
      "usuarios.gestionar",
    ];
    await test.step("CA-7 · el impacto de agregar `usuarios.gestionar` cuenta al practicante sin TOTP y no escribe nada (U6, U8)", async () => {
      const impacto = await apiDueno.pedir<Record<string, number>>(
        "POST",
        `/roles/${rolId}/impacto`,
        { permisos: permisosNuevos },
      );
      expect(impacto.status).toBe(200);
      expect(impacto.cuerpo).toMatchObject({
        miembros: 1,
        miembrosSinTotpExigidos: 1,
        clientesSinResponsable: 0,
      });
      expect(
        (await roles.rolPorNombre(estudio.tenantId, "Practicante"))?.permisos,
      ).toEqual(permisosIniciales);
    });

    await test.step("el Dueño edita el rol: al guardar, la pantalla avisa del impacto (segundo factor) y solo aplica al confirmar (005 D3)", async () => {
      await irARoles(page);
      await editarRol(page, "Practicante").click();
      await casillaPermiso(page, "usuarios.ver").check();
      await casillaPermiso(page, "usuarios.gestionar").check();
      await guardarRol(page).click();
      await expect(page.getByText(TEXTOS.impactoMiembros)).toBeVisible();
      await expect(page.getByText(TEXTOS.aviso2fa)).toBeVisible();
      // Antes de confirmar no se escribe nada.
      expect(
        (await roles.rolPorNombre(estudio.tenantId, "Practicante"))?.permisos,
      ).toEqual(permisosIniciales);
      await confirmarRol(page).click();
      await expect(
        page.getByRole("status").filter({ hasText: TEXTOS.rolGuardado }),
      ).toBeVisible();
      expect(
        (await roles.rolPorNombre(estudio.tenantId, "Practicante"))?.permisos,
      ).toEqual([...permisosNuevos].sort());
    });

    await test.step("CA-7 · el practicante, con la misma sesión, queda exigido de TOTP: 403 `segundo_factor_requerido` en la siguiente petición", async () => {
      expect(
        await consultar(persona, `/clientes/${asignado.id}`, estudio.tenantId),
      ).toMatchObject({ status: 403, codigo: "segundo_factor_requerido" });
      expect(await estadoDeSesion(persona)).toMatchObject({
        totpActivo: false,
        factorExigido: true,
      });
      await persona.goto("/clientes");
      await expect(persona).toHaveURL(/\/cuenta\/seguridad$/);
      await expect(
        persona.getByText(TEXTOS_CUENTA.exigidoAviso).first(),
      ).toBeVisible();
    });

    await test.step("enrola su TOTP y vuelve a entrar con sus nuevos permisos y el mismo alcance", async () => {
      await activarPorPantalla(persona, contrasena);
      expect(await estadoDeSesion(persona)).toMatchObject({
        factor: "verificado",
        totpActivo: true,
        factorExigido: true,
      });
      expect(
        (await consultar(persona, `/clientes/${asignado.id}`, estudio.tenantId))
          .status,
      ).toBe(200);
      expect(
        (await consultar(persona, `/clientes/${ajeno.id}`, estudio.tenantId))
          .status,
      ).toBe(404);
      await persona.goto("/usuarios");
      await expect(
        persona.getByRole("heading", { name: "Invitar a una persona" }),
      ).toBeVisible();
      // `usuarios.gestionar` no da `roles.gestionar`: sigue sin poder abrir los roles.
      expect(
        (await consultar(persona, "/roles", estudio.tenantId)).status,
      ).toBe(403);
    });

    await test.step("CA-6 · eliminar el rol en uso da 409 `rol_en_uso` con miembros e invitaciones, y no cambia nada", async () => {
      const otro = correoUnico();
      const invitar = await apiDueno.pedir("POST", "/invitaciones", {
        correo: otro,
        rol: rolAsignado(rolId),
      });
      expect(invitar.status).toBeGreaterThanOrEqual(200);
      expect(invitar.status).toBeLessThan(300);

      const borrar = await apiDueno.pedir("DELETE", `/roles/${rolId}`);
      expect(borrar.status).toBe(409);
      expect(borrar.cuerpo).toMatchObject({ codigo: "rol_en_uso" });
      expect(texto(borrar.cuerpo)).toMatch(/"miembros":\s*1\b/);
      expect(texto(borrar.cuerpo)).toMatch(/"invitaciones":\s*1\b/);
      expect(await roles.rolExiste(rolId)).toBe(true);
      expect(
        await roles.rolDeMembresia(estudio.tenantId, practicanteId),
      ).toEqual({ rol: "propio", rolId });
      expect(await roles.rolDeInvitacion(estudio.tenantId, otro)).toEqual({
        rol: "propio",
        rolId,
      });
      expect(await roles.huerfanos(estudio.tenantId)).toBe(0);

      // Se libera el rol: el miembro pasa a un rol de sistema y la invitación se revoca por la pantalla.
      const cambio = await apiDueno.pedir(
        "PATCH",
        `/usuarios/${practicanteId}/rol`,
        { rol: "lectura" },
      );
      expect(cambio.status).toBe(200);
      expect(
        await roles.rolDeMembresia(estudio.tenantId, practicanteId),
      ).toEqual({ rol: "lectura", rolId: null });
      const aunEnUso = await apiDueno.pedir("DELETE", `/roles/${rolId}`);
      expect(aunEnUso.status).toBe(409);
      expect(texto(aunEnUso.cuerpo)).toMatch(/"miembros":\s*0\b/);
      expect(texto(aunEnUso.cuerpo)).toMatch(/"invitaciones":\s*1\b/);

      await page.goto("/usuarios");
      await fila(page, otro).getByRole("button", { name: "Revocar" }).click();
      await expect(fila(page, otro)).toHaveCount(0);

      const eliminado = await apiDueno.pedir("DELETE", `/roles/${rolId}`);
      expect(eliminado.status).toBe(204);
      expect(await roles.rolExiste(rolId)).toBe(false);
      expect(await roles.huerfanos(estudio.tenantId)).toBe(0);
    });
  });

  test("el nombre es único por estudio y distinto de los de sistema, el catálogo se respeta y un rol de otro estudio da 404", async ({
    siembra,
    sesiones,
    api,
    cuentas,
    roles,
  }) => {
    const a = await siembra.estudio({ nombre: "Estudio Roles A E2E" });
    const b = await siembra.estudio({ nombre: "Estudio Roles B E2E" });
    const contador = await siembra.miembro(a.tenantId, "contador");
    cuentas.registrar(a, contador);
    cuentas.registrar(b);
    const apiA = api(await sesiones.entrar(a.dueno));
    const apiB = api(await sesiones.entrar(b.dueno));

    const revisor = {
      nombre: "Revisor",
      alcance: "global",
      permisos: ["clientes.ver"],
    };

    await test.step("CA-1 · crea el rol (201) y el mismo nombre en otro estudio no choca", async () => {
      const enA = await apiA.pedir<{ id?: string }>("POST", "/roles", revisor);
      expect(enA.status).toBe(201);
      const enB = await apiB.pedir<{ id?: string }>("POST", "/roles", revisor);
      expect(enB.status).toBe(201);
      expect(await roles.cuantosRoles(a.tenantId)).toBe(1);
      expect(await roles.cuantosRoles(b.tenantId)).toBe(1);
    });
    const rolA = (await roles.rolPorNombre(a.tenantId, "Revisor"))?.id;
    const rolB = (await roles.rolPorNombre(b.tenantId, "Revisor"))?.id;
    if (rolA === undefined || rolB === undefined)
      throw new Error("No se crearon los roles de prueba.");

    await test.step("CA-1 · nombre repetido sin importar mayúsculas ni tildes, o igual a uno de sistema: 409 `nombre_duplicado`", async () => {
      for (const nombre of [
        "revisor",
        "REVISÓR",
        "Contador",
        "ADMINISTRADOR",
      ]) {
        const r = await apiA.pedir("POST", "/roles", { ...revisor, nombre });
        expect({ nombre, status: r.status }).toEqual({ nombre, status: 409 });
        expect(r.cuerpo).toMatchObject({ codigo: "nombre_duplicado" });
      }
      expect(await roles.cuantosRoles(a.tenantId)).toBe(1);
    });

    await test.step("CA-2 · `plan.gestionar`, un permiso inventado o una combinación inválida: 422, sin crear nada", async () => {
      for (const permiso of ["plan.gestionar", "inventado.ver"]) {
        const r = await apiA.pedir("POST", "/roles", {
          nombre: "Malo",
          alcance: "global",
          permisos: ["clientes.ver", permiso],
        });
        expect(r.status).toBe(422);
        expect(r.cuerpo).toMatchObject({ codigo: "permiso_invalido" });
      }
      // U3: `usuarios.gestionar` sin su `usuarios.ver` (y sin `clientes.ver`) se rechaza y nombra lo que falta.
      const combinacion = await apiA.pedir("POST", "/roles", {
        nombre: "Malo",
        alcance: "global",
        permisos: ["usuarios.gestionar"],
      });
      expect(combinacion.status).toBe(422);
      expect(combinacion.cuerpo).toMatchObject({
        codigo: "combinacion_invalida",
      });
      expect(texto(combinacion.cuerpo)).toContain("usuarios.ver");
      expect(await roles.rolPorNombre(a.tenantId, "Malo")).toBeNull();
    });

    await test.step("CA-1 · el rol guardado se asigna al cambiar rol; el de otro estudio da 404 al cambiar rol y al invitar (CA-9)", async () => {
      const ajeno = await apiA.pedir("PATCH", `/usuarios/${contador.id}/rol`, {
        rol: rolAsignado(rolB),
      });
      expect(ajeno.status).toBe(404);
      const inexistente = await apiA.pedir(
        "PATCH",
        `/usuarios/${contador.id}/rol`,
        {
          rol: rolAsignado("00000000-0000-4000-8000-000000000000"),
        },
      );
      expect(inexistente.status).toBe(404);
      expect(
        (
          await apiA.pedir("POST", "/invitaciones", {
            correo: correoUnico(),
            rol: rolAsignado(rolB),
          })
        ).status,
      ).toBe(404);
      expect(await roles.rolDeMembresia(a.tenantId, contador.id)).toEqual({
        rol: "contador",
        rolId: null,
      });

      const propio = await apiA.pedir("PATCH", `/usuarios/${contador.id}/rol`, {
        rol: rolAsignado(rolA),
      });
      expect(propio.status).toBe(200);
      expect(await roles.rolDeMembresia(a.tenantId, contador.id)).toEqual({
        rol: "propio",
        rolId: rolA,
      });
      expect(await roles.huerfanos(a.tenantId)).toBe(0);
      expect(await roles.huerfanos(b.tenantId)).toBe(0);
    });

    await test.step("CA-9 · el rol de otro estudio no se ve, no se edita ni se elimina (404)", async () => {
      expect(texto((await apiA.pedir("GET", "/roles")).cuerpo)).not.toContain(
        rolB,
      );
      expect(
        (await apiA.pedir("PATCH", `/roles/${rolB}`, { nombre: "Tomado" }))
          .status,
      ).toBe(404);
      expect((await apiA.pedir("DELETE", `/roles/${rolB}`)).status).toBe(404);
      expect(await roles.rolPorNombre(b.tenantId, "Revisor")).not.toBeNull();
    });

    await test.step("ronda 1/2 · con alcance asignado, `POST /asignaciones/por-usuario` sobre un cliente fuera de alcance da el mismo 404 que uno inexistente y no escribe", async () => {
      const dentro = await siembra.cliente(a.tenantId, {
        ruc: "20700000011",
        razonSocial: "CLIENTE DENTRO ROLES E2E S.A.C.",
      });
      const fuera = await siembra.cliente(a.tenantId, {
        ruc: "20700000045",
        razonSocial: "CLIENTE FUERA ROLES E2E S.A.C.",
      });
      const asignador = await siembra.miembro(a.tenantId, "lectura");
      cuentas.registrar(a, asignador);
      const rol = await apiA.pedir<{ id?: string }>("POST", "/roles", {
        nombre: "Asignador",
        alcance: "asignado",
        permisos: ["clientes.ver", "clientes.asignar"],
      });
      expect(rol.status).toBe(201);
      const rolAsignador = (await roles.rolPorNombre(a.tenantId, "Asignador"))
        ?.id;
      if (rolAsignador === undefined)
        throw new Error("No se creó el rol Asignador.");
      expect(
        (
          await apiA.pedir("PATCH", `/usuarios/${asignador.id}/rol`, {
            rol: rolAsignado(rolAsignador),
          })
        ).status,
      ).toBe(200);
      await roles.asignar(dentro, asignador.id, "colaborador");
      const apiAsignador = api(await sesiones.entrar(asignador));
      const filas = () => roles.cuantasAsignaciones(a.tenantId);
      const antes = await filas();

      const porUsuario = (clienteId: string) =>
        apiAsignador.pedir("POST", "/asignaciones/por-usuario", {
          usuarioId: contador.id,
          clienteIds: [clienteId],
          tipo: "colaborador",
        });
      const inexistente = await porUsuario(
        "00000000-0000-4000-8000-000000000000",
      );
      const fueraDeAlcance = await porUsuario(fuera.id);
      expect(inexistente.status).toBe(404);
      expect({
        status: fueraDeAlcance.status,
        cuerpo: fueraDeAlcance.cuerpo,
      }).toEqual({ status: 404, cuerpo: inexistente.cuerpo });
      expect(await filas()).toBe(antes);

      // Control positivo: el cliente asignado al actor sí se puede asignar.
      const permitido = await porUsuario(dentro.id);
      expect(permitido.status).toBe(200);
      expect(await filas()).toBe(antes + 1);
    });
  });
});
