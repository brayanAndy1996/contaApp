// E-10 · Notificaciones y auditoría (spec 018; RF-150, 152, 160, HU-10): la campana sube en vivo al terminar una
// descarga, marcar leída y «marcar todas», la auditoría lista las acciones con el nombre del autor y el asistente
// no entra a la auditoría. Incluye una aserción por cada defecto de pantalla de 017 T18 (CA-8): P-2 a P-8.
import {
  PERIODO,
  alerta,
  expect,
  test,
  type Api,
  type Cliente,
  type Estudio,
  type Sesion,
  type Sesiones,
} from "../soporte/fixtures.js";
import type { Siembra } from "../soporte/siembra.js";
import { sembrarAvisosDePlan } from "../soporte/siembra-avisos.js";
import {
  campana,
  filaAuditoria,
  marcarTodas,
  notificacion,
  panel,
  tablaAuditoria,
} from "../soporte/selectores/notificaciones.js";
import { credenciales, grupoSol } from "../soporte/selectores/clientes.js";

const DESCARGA = (razon: string): string =>
  `La descarga de la propuesta del SIRE de ${razon} terminó.`;

/** Estudio con un Dueño, un cliente con credenciales y la API del Dueño lista. */
async function preparar(
  deps: {
    siembra: Siembra;
    sesiones: Sesiones;
    api: (sesion: Sesion) => Api;
  },
  razonSocial?: string,
): Promise<{ estudio: Estudio; cliente: Cliente; llamadas: Api }> {
  const estudio = await deps.siembra.estudio();
  const cliente = await deps.siembra.cliente(
    estudio.tenantId,
    razonSocial === undefined ? {} : { razonSocial },
  );
  const llamadas = deps.api(await deps.sesiones.entrar(estudio.dueno));
  await llamadas.cargarCredenciales(cliente.id);
  return { estudio, cliente, llamadas };
}

async function descargar(
  llamadas: Api,
  cliente: Cliente,
  periodo: string,
): Promise<void> {
  const id = await llamadas.iniciarDescarga(cliente.id, periodo);
  const trabajo = await llamadas.esperarTrabajo(cliente.id, id);
  expect(trabajo.estado).toBe("completado");
}

test.describe("campana", () => {
  test("sube en vivo al terminar una descarga y abrir el aviso lo marca leído", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const { estudio, cliente, llamadas } = await preparar({
      siembra,
      sesiones,
      api,
    });
    const { page } = await sesiones.paginaDe(estudio.dueno);
    await page.goto("/clientes");
    await expect(campana(page)).toHaveAccessibleName("Notificaciones");

    await descargar(llamadas, cliente, PERIODO);
    // Sin recargar: llega por el stream en vivo.
    await expect(campana(page)).toHaveAccessibleName(
      "Notificaciones, 1 sin leer",
      {
        timeout: 30_000,
      },
    );

    await campana(page).click();
    const aviso = notificacion(panel(page), DESCARGA(cliente.razonSocial));
    await expect(aviso).toContainText("Sin leer");
    await aviso.click();

    await expect(panel(page)).toHaveCount(0);
    await expect(campana(page)).toHaveAccessibleName("Notificaciones");
    await campana(page).click();
    await expect(
      notificacion(panel(page), DESCARGA(cliente.razonSocial)),
    ).not.toContainText("Sin leer");
  });

  test("«marcar todas» deja la campana sin número", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const { estudio, cliente, llamadas } = await preparar({
      siembra,
      sesiones,
      api,
    });
    const { page } = await sesiones.paginaDe(estudio.dueno);
    await page.goto("/clientes");

    await descargar(llamadas, cliente, PERIODO);
    await descargar(llamadas, cliente, "202609");
    await expect(campana(page)).toHaveAccessibleName(
      "Notificaciones, 2 sin leer",
      {
        timeout: 30_000,
      },
    );

    await campana(page).click();
    await marcarTodas(panel(page)).click();
    await expect(campana(page)).toHaveAccessibleName("Notificaciones");
    await expect(panel(page).getByText("Sin leer")).toHaveCount(0);

    await page.goto("/notificaciones");
    await expect(
      notificacion(page, DESCARGA(cliente.razonSocial)).filter({
        hasText: "Sin leer",
      }),
    ).toHaveCount(0);
    await expect(notificacion(page, DESCARGA(cliente.razonSocial))).toHaveCount(
      2,
    );
  });

  test("la página de notificaciones abierta incorpora el aviso nuevo sin recargar (P-8)", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const { estudio, cliente, llamadas } = await preparar({
      siembra,
      sesiones,
      api,
    });
    const { page } = await sesiones.paginaDe(estudio.dueno);
    await page.goto("/notificaciones");
    await expect(page.getByText("No tienes notificaciones.")).toBeVisible();

    await descargar(llamadas, cliente, PERIODO);

    await expect(notificacion(page, DESCARGA(cliente.razonSocial))).toHaveCount(
      1,
      {
        timeout: 30_000,
      },
    );
    await expect(page.getByText("No tienes notificaciones.")).toHaveCount(0);
    await expect(campana(page)).toHaveAccessibleName(
      "Notificaciones, 1 sin leer",
    );
  });

  test("el texto de un aviso con HTML en la razón social se ve literal", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const razon = '<img src=x onerror="window.__pwn=1">';
    const { estudio, cliente, llamadas } = await preparar(
      { siembra, sesiones, api },
      razon,
    );
    const { page } = await sesiones.paginaDe(estudio.dueno);
    await page.goto("/clientes");

    await descargar(llamadas, cliente, PERIODO);
    await expect(campana(page)).toHaveAccessibleName(/sin leer/, {
      timeout: 30_000,
    });
    await campana(page).click();

    await expect(notificacion(panel(page), DESCARGA(razon))).toBeVisible();
    await expect(page.getByRole("img")).toHaveCount(0);
    expect(await page.evaluate("window.__pwn")).toBeUndefined();
  });

  test("Esc y un clic fuera cierran el panel y el foco vuelve a la campana (P-5)", async ({
    siembra,
    sesiones,
  }) => {
    const estudio = await siembra.estudio();
    const { page } = await sesiones.paginaDe(estudio.dueno);
    await page.goto("/clientes");

    await campana(page).click();
    await expect(panel(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await expect(campana(page)).toBeFocused();

    await campana(page).click();
    await expect(panel(page)).toBeVisible();
    await page.getByRole("heading", { name: "Clientes", level: 1 }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect(campana(page)).toBeFocused();
  });

  test("a 390 px la barra no desborda y la campana se ve (P-7)", async ({
    siembra,
    sesiones,
  }) => {
    const estudio = await siembra.estudio();
    const { page } = await sesiones.paginaDe(estudio.dueno);
    await page.setViewportSize({ width: 390, height: 844 });

    for (const ruta of ["/clientes", "/configuracion/auditoria"]) {
      await page.goto(ruta);
      await expect(campana(page)).toBeInViewport({ ratio: 1 });
      await expect
        .poll(() => page.evaluate("document.documentElement.scrollWidth"))
        .toBeLessThanOrEqual(390);
    }
  });

  test("«Cargar más» pasa el foco a la primera fila nueva en notificaciones (P-6)", async ({
    siembra,
    sesiones,
  }) => {
    const estudio = await siembra.estudio();
    await sembrarAvisosDePlan(estudio.tenantId, estudio.dueno.id, 60);
    const { page } = await sesiones.paginaDe(estudio.dueno);
    await page.goto("/notificaciones");

    const filas = page.getByRole("listitem").getByRole("button");
    await expect(filas).toHaveCount(50);
    const mas = page.getByRole("button", { name: "Cargar más" });
    await mas.focus();
    await page.keyboard.press("Enter");

    await expect(filas).toHaveCount(60);
    await expect(filas.nth(50)).toBeFocused();
    await expect(mas).toHaveCount(0);
  });
});

test.describe("auditoría", () => {
  test("lista las acciones del flujo con el nombre del autor y sin códigos (P-2, P-3, P-4)", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const estudio = await siembra.estudio();
    const cliente = await siembra.cliente(estudio.tenantId, {
      razonSocial: "CLIENTE AUDITADO S.A.C.",
    });
    const llamadas = api(await sesiones.entrar(estudio.dueno));
    const { page } = await sesiones.paginaDe(estudio.dueno);

    // El flujo, por la UI: guardar y verificar la clave SOL y corregir la razón social.
    await page.goto(`/clientes/${cliente.id}`);
    await page.getByLabel("Razón social").fill("CLIENTE CORREGIDO S.A.C.");
    await page.getByRole("button", { name: "Guardar datos fiscales" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Datos guardados." }),
    ).toBeVisible();
    const sol = grupoSol(page);
    await sol
      .getByLabel("Usuario SOL", { exact: true })
      .fill("USUARIO AUDITADO");
    await sol.getByLabel("Clave SOL", { exact: true }).fill("clave-auditada");
    await sol.getByRole("button", { name: "Guardar" }).click();
    await expect(credenciales(page)).toContainText("Estado: Configurada");
    await sol.getByRole("button", { name: "Verificar" }).click();
    await expect
      .poll(() => llamadas.estadoCredencial(cliente.id, "sol"), {
        timeout: 30_000,
      })
      .toBe("verificada");

    await page.goto("/configuracion/auditoria");
    await expect(tablaAuditoria(page)).toBeVisible();
    const nombre = estudio.dueno.nombre;

    const guardo = filaAuditoria(page, "Guardó una credencial");
    await expect(guardo).toContainText(nombre);
    await expect(guardo).toContainText("Credencial: Clave SOL");
    await expect(guardo).toContainText("CLIENTE CORREGIDO S.A.C.");

    // P-4c: «Editó un cliente» dice qué campo cambió, de qué a qué.
    await expect(
      filaAuditoria(page, "Editó un cliente").filter({
        hasText:
          "Razón social: CLIENTE AUDITADO S.A.C. → CLIENTE CORREGIDO S.A.C.",
      }),
    ).toContainText(nombre);

    // P-2: el trabajo que lanzó el Dueño lleva su nombre.
    await expect(
      filaAuditoria(page, "Verificó una credencial").filter({
        hasText: `${nombre} (proceso automático)`,
      }),
    ).toBeVisible();

    // P-3: ningún código crudo en la tabla.
    await expect(tablaAuditoria(page)).not.toContainText(
      /\b(sol|sire_api|dueno|credencial\.verificar|credencial_invalida|sire\.token|abierto)\b/,
    );
  });

  test("«Cargar más» pasa el foco a la primera fila nueva en la auditoría (P-6)", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const estudio = await siembra.estudio();
    const cliente = await siembra.cliente(estudio.tenantId);
    const llamadas = api(await sesiones.entrar(estudio.dueno));
    // Cada guardado de credencial deja una fila: más de 50 en total (50 por página).
    for (let i = 0; i < 28; i += 1)
      await llamadas.cargarCredenciales(cliente.id);
    const { page } = await sesiones.paginaDe(estudio.dueno);

    await page.goto("/configuracion/auditoria");
    const filas = tablaAuditoria(page).getByRole("row");
    await expect(filas).toHaveCount(51); // cabecera + 50
    const mas = page.getByRole("button", { name: "Cargar más" });
    await mas.focus();
    await page.keyboard.press("Enter");

    await expect.poll(() => filas.count()).toBeGreaterThan(51);
    await expect(filas.nth(51)).toBeFocused();
    await expect(mas).toHaveCount(0);
  });

  test("un asistente no ve el enlace y la página dice que no tiene permiso (403)", async ({
    siembra,
    sesiones,
    vigilancia,
  }) => {
    vigilancia.permitirError(/status of 403/);
    const estudio = await siembra.estudio();
    const asistente = await siembra.miembro(estudio.tenantId, "asistente");
    await siembra.cliente(estudio.tenantId, { asignadoA: asistente });
    const { page } = await sesiones.paginaDe(asistente);

    await page.goto("/clientes");
    await expect(page.getByRole("link", { name: "Clientes" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Auditoría" })).toHaveCount(0);

    const respuesta = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/auditoria",
    );
    await page.goto("/configuracion/auditoria");
    expect((await respuesta).status()).toBe(403);
    await expect(
      alerta(page, "No tienes permiso para ver la auditoría."),
    ).toHaveCount(1);
    await expect(tablaAuditoria(page)).toHaveCount(0);
  });
});
