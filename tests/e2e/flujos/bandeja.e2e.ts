// E-12 · Bandeja de buzones (spec 024; HU-33, HU-34, RF-122, RF-124, RF-125; CA-3, CA-4, CA-8, CA-12, CA-14). Un caso
// de punta a punta con el `MockSolPortal` y el buzón de fixture del RUC de prueba: campana → bandeja → «Críticos
// pendientes» → atender la coactiva con comentario → sale de «Pendientes» y el detalle dice quién, cuándo y por qué →
// el indicador del listado de clientes baja en uno (nuevos y críticos) → deshacer → vuelve. Más una pasada corta a
// 390 × 844. El programador va apagado (`BUZON_PROGRAMADOR=off`): la única captura es la que pide la prueba.
import {
  RUCS,
  expect,
  test,
  type Api,
  type Estudio,
  type Cliente,
} from "../soporte/fixtures.js";
import {
  campana,
  notificacion,
  panel,
} from "../soporte/selectores/notificaciones.js";
import {
  atencion,
  botonDeshacer,
  botonFiltros,
  botonMarcar,
  campoComentario,
  chipCriticosPendientes,
  chipPendientes,
  dialogoFiltros,
  enlaceMensaje,
  entradaBuzones,
  filaMensaje,
  historialAtencion,
  indicadorCliente,
  tablaMensajes,
  textoCriticos,
  textoNuevos,
} from "../soporte/selectores/buzon.js";
import { filaCliente } from "../soporte/selectores/clientes.js";
import { marcarBuzonSincronizado } from "../soporte/siembra-buzon.js";

test.setTimeout(120_000);

const ASUNTO_COACTIVA = "Resolución de Ejecución Coactiva N.° 0123-2026/SUNAT";
const ASUNTO_BOLETIN =
  "Boletín informativo: calendario de obligaciones mensuales";
const COMENTARIO = "Se presentó el escrito de reclamación el mismo día.";

interface IndicadorApi {
  nuevos: number;
  criticosNuevos: number;
}

/** El indicador del cliente en `GET /clientes` (la misma fuente que el listado). */
async function indicadorPorApi(
  llamadas: Api,
  clienteId: string,
): Promise<IndicadorApi> {
  const lista = await llamadas.exigir<{ id: string; buzon?: IndicadorApi }[]>(
    "GET",
    "/clientes",
  );
  const buzon = lista.find((c) => c.id === clienteId)?.buzon;
  if (buzon === undefined) throw new Error("El listado no trae el indicador.");
  return buzon;
}

/** Cliente con el RUC del fixture, buzón ya sincronizado y la captura hecha por API (el worker la procesa). */
async function clienteConBuzonCapturado(
  siembra: { cliente: (t: string, o: { ruc: string }) => Promise<Cliente> },
  estudio: Estudio,
  llamadas: Api,
): Promise<Cliente> {
  const cliente = await siembra.cliente(estudio.tenantId, {
    ruc: RUCS.contribuyente,
  });
  await llamadas.cargarCredenciales(cliente.id);
  await marcarBuzonSincronizado(estudio.tenantId, cliente.id);
  const revisar = await llamadas.exigir<{ trabajo: { id: string } }>(
    "POST",
    `/clientes/${cliente.id}/buzon/revisar`,
  );
  expect(
    (await llamadas.esperarTrabajo(cliente.id, revisar.trabajo.id)).estado,
  ).toBe("completado");
  return cliente;
}

test.describe("E-12 · bandeja de buzones", () => {
  test("campana → bandeja → «Críticos pendientes» → atender con comentario → indicador baja → deshacer → vuelve", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const estudio = await siembra.estudio();
    const llamadas = api(await sesiones.entrar(estudio.dueno));
    const cliente = await clienteConBuzonCapturado(siembra, estudio, llamadas);
    const antes = await indicadorPorApi(llamadas, cliente.id);
    // Del fixture, una vez capturado: hay varios críticos pendientes y la coactiva es uno de ellos.
    expect(antes.nuevos).toBeGreaterThan(1);
    expect(antes.criticosNuevos).toBeGreaterThan(0);
    expect(antes.criticosNuevos).toBeLessThan(antes.nuevos);
    const { page } = await sesiones.paginaDe(estudio.dueno);

    await test.step("el aviso crítico de la campana abre la bandeja del cliente con el detalle (CA-12)", async () => {
      await page.goto("/");
      await expect(campana(page)).toHaveAccessibleName(/sin leer/, {
        timeout: 30_000,
      });
      await campana(page).click();
      await notificacion(panel(page), "Coactiva").click();
      await expect(page).toHaveURL(
        new RegExp(`/clientes/${cliente.id}/buzon\\?mensaje=[0-9a-f-]{36}`),
      );
      await expect(
        page.getByRole("heading", { level: 2, name: ASUNTO_COACTIVA }),
      ).toBeVisible();
      await expect(page.getByText("Crítico · Coactiva").first()).toBeVisible();
      // Atender no crea ni marca notificaciones: el detalle abierto desde la campana sigue pendiente.
      await expect(atencion(page).getByText("Pendiente")).toBeVisible();
    });

    await test.step("«Buzones» lleva a /buzon, que abre en «Pendientes»", async () => {
      await entradaBuzones(page).click();
      await expect(page).toHaveURL(/\/buzon(\?.*)?$/);
      await expect(
        page.getByRole("heading", { level: 1, name: "Buzones" }),
      ).toBeVisible();
      await expect(chipPendientes(page)).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(filaMensaje(page, ASUNTO_COACTIVA)).toHaveCount(1);
      await expect(filaMensaje(page, ASUNTO_BOLETIN)).toHaveCount(1);
    });

    await test.step("«Críticos pendientes» deja solo los críticos, en rojo y con la categoría en texto (CA-3)", async () => {
      await chipCriticosPendientes(page).click();
      await expect(chipCriticosPendientes(page)).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(page).toHaveURL(/categoria=criticos/);
      await expect(filaMensaje(page, ASUNTO_COACTIVA)).toHaveCount(1);
      await expect(filaMensaje(page, ASUNTO_BOLETIN)).toHaveCount(0);
      await expect(
        filaMensaje(page, ASUNTO_COACTIVA).getByText("Crítico · Coactiva"),
      ).toBeVisible();
      await expect(
        filaMensaje(page, ASUNTO_COACTIVA).getByText("Pendiente", {
          exact: true,
        }),
      ).toBeVisible();
    });

    await test.step("marcar la coactiva sin comentario no se puede; con comentario queda atendida (CA-4)", async () => {
      await enlaceMensaje(page, ASUNTO_COACTIVA).click();
      await expect(page).toHaveURL(
        new RegExp(`/clientes/${cliente.id}/buzon\\?.*mensaje=`),
      );
      await expect(botonMarcar(page)).toBeDisabled();
      await expect(
        atencion(page).getByText(
          "El comentario es obligatorio para marcar un mensaje crítico.",
        ),
      ).toBeVisible();
      await campoComentario(page).fill(COMENTARIO);
      await expect(botonMarcar(page)).toBeEnabled();
      await botonMarcar(page).click();
      await expect(
        atencion(page).getByText(/^Atendido por Dueño E2E · /),
      ).toBeVisible();
      await expect(atencion(page).getByText(COMENTARIO).first()).toBeVisible();
      await expect(
        historialAtencion(page).getByText("Marcó como atendido"),
      ).toBeVisible();
      await expect(
        historialAtencion(page).getByText("Dueño E2E"),
      ).toBeVisible();
      await expect(botonDeshacer(page)).toBeVisible();
    });

    await test.step("la coactiva sale de «Pendientes» y entra en «Atendidos» de la bandeja del cliente", async () => {
      await expect(tablaMensajes(page)).toBeVisible();
      await expect(filaMensaje(page, ASUNTO_COACTIVA)).toHaveCount(0);
      await expect(filaMensaje(page, ASUNTO_BOLETIN)).toHaveCount(1);
      await page.goto(`/buzon?atencion=atendidos`);
      await expect(filaMensaje(page, ASUNTO_COACTIVA)).toHaveCount(1);
      await expect(
        filaMensaje(page, ASUNTO_COACTIVA).getByText("Atendido", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        filaMensaje(page, ASUNTO_COACTIVA).getByText("por Dueño E2E"),
      ).toBeVisible();
    });

    await test.step("el indicador del listado de clientes baja en uno, nuevos y críticos (CA-8)", async () => {
      expect(await indicadorPorApi(llamadas, cliente.id)).toEqual({
        nuevos: antes.nuevos - 1,
        criticosNuevos: antes.criticosNuevos - 1,
      });
      await page.goto("/clientes");
      const indicador = indicadorCliente(
        filaCliente(page, cliente.razonSocial),
      );
      await expect(indicador).toContainText(textoNuevos(antes.nuevos - 1));
      await expect(indicador).toContainText(
        textoCriticos(antes.criticosNuevos - 1),
      );
    });

    await test.step("deshacer vuelve el mensaje a «Pendientes» y el indicador al número de antes", async () => {
      await page.goto(`/buzon?atencion=atendidos`);
      await enlaceMensaje(page, ASUNTO_COACTIVA).click();
      await expect(
        atencion(page).getByText(/^Atendido por Dueño E2E · /),
      ).toBeVisible();
      await botonDeshacer(page).click();
      await expect(botonMarcar(page)).toBeVisible();
      await expect(atencion(page).getByText("Pendiente")).toBeVisible();
      await expect(
        historialAtencion(page).getByText("Deshizo la atención"),
      ).toBeVisible();

      expect(await indicadorPorApi(llamadas, cliente.id)).toEqual(antes);
      await page.goto("/clientes");
      const indicador = indicadorCliente(
        filaCliente(page, cliente.razonSocial),
      );
      await expect(indicador).toContainText(textoNuevos(antes.nuevos));
      await expect(indicador).toContainText(
        textoCriticos(antes.criticosNuevos),
      );
      // El enlace del indicador abre la bandeja fijada en el cliente.
      await indicador.click();
      await expect(page).toHaveURL(new RegExp(`/clientes/${cliente.id}/buzon`));
      await expect(filaMensaje(page, ASUNTO_COACTIVA)).toHaveCount(1);
    });
  });

  test("a 390 × 844: «Buzones» en la barra inferior, tarjeta crítica y filtros en un Dialog", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const estudio = await siembra.estudio();
    const llamadas = api(await sesiones.entrar(estudio.dueno));
    await clienteConBuzonCapturado(siembra, estudio, llamadas);
    const { page } = await sesiones.paginaDe(estudio.dueno);
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto("/clientes");
    await expect(entradaBuzones(page)).toBeVisible();
    const caja = await entradaBuzones(page).boundingBox();
    // La barra inferior: la entrada queda en la parte baja de la pantalla y con área táctil de 44 px.
    expect(caja?.y ?? 0).toBeGreaterThan(844 / 2);
    expect(caja?.height ?? 0).toBeGreaterThanOrEqual(44);

    await entradaBuzones(page).click();
    await expect(page).toHaveURL(/\/buzon(\?.*)?$/);
    await expect(
      filaMensaje(page, ASUNTO_COACTIVA).getByText("Crítico · Coactiva"),
    ).toBeVisible();

    await botonFiltros(page).click();
    await expect(dialogoFiltros(page)).toBeVisible();
    await dialogoFiltros(page).getByLabel("Categoría").selectOption("criticos");
    // Nada se aplica hasta «Aplicar» (con el Dialog abierto la lista queda `aria-hidden`: se mira por texto).
    await expect(page.getByText(ASUNTO_BOLETIN)).toHaveCount(1);
    await dialogoFiltros(page).getByRole("button", { name: "Aplicar" }).click();
    await expect(dialogoFiltros(page)).toHaveCount(0);
    await expect(filaMensaje(page, ASUNTO_BOLETIN)).toHaveCount(0);
    await expect(filaMensaje(page, ASUNTO_COACTIVA)).toHaveCount(1);
  });

  // CA-3 a 390 px: la insignia «Crítico · <categoría>» parte línea y, con una categoría larga («Crítico · Requerimiento
  // de fiscalización»), no ensancha la tarjeta apilada (antes `whitespace-nowrap` desplazaba la página: scrollWidth 405).
  test("a 390 × 844 la página no se desplaza en horizontal", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const estudio = await siembra.estudio();
    const llamadas = api(await sesiones.entrar(estudio.dueno));
    await clienteConBuzonCapturado(siembra, estudio, llamadas);
    const { page } = await sesiones.paginaDe(estudio.dueno);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/buzon");
    await expect(filaMensaje(page, ASUNTO_COACTIVA)).toHaveCount(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });

  // T15a-1 y T15a-3: con el detalle abierto (dos columnas) a 1440 y 1280 la lista se desplaza dentro de su contenedor y
  // «Atención» se alcanza; la página no desborda. Marcar con Enter deja el foco en «Deshacer» (y deshacer, en «Marcar»).
  for (const ancho of [1440, 1280]) {
    test(`a ${ancho} px con el detalle abierto la lista se lee completa y el foco no se pierde al atender`, async ({
      siembra,
      sesiones,
      api,
    }) => {
      const estudio = await siembra.estudio();
      const llamadas = api(await sesiones.entrar(estudio.dueno));
      const cliente = await clienteConBuzonCapturado(siembra, estudio, llamadas);
      const { page } = await sesiones.paginaDe(estudio.dueno);
      await page.setViewportSize({ width: ancho, height: 900 });
      await page.goto(`/clientes/${cliente.id}/buzon?atencion=pendientes`);
      await enlaceMensaje(page, ASUNTO_COACTIVA).click();
      await expect(
        page.getByRole("heading", { level: 2, name: ASUNTO_COACTIVA }),
      ).toBeVisible();

      const lista = page.getByRole("region", { name: "Mensajes del buzón SOL" });
      const medidas = await lista.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
        const cabecera = el.querySelector("th:last-child")!.getBoundingClientRect();
        const caja = el.getBoundingClientRect();
        return {
          pagina: document.documentElement.scrollWidth <= window.innerWidth,
          atencionVisible: cabecera.right <= caja.right + 1 && cabecera.left >= caja.left,
        };
      });
      expect(medidas.pagina).toBe(true);
      expect(medidas.atencionVisible).toBe(true);

      await campoComentario(page).fill(COMENTARIO);
      await botonMarcar(page).focus();
      await page.keyboard.press("Enter");
      await expect(botonDeshacer(page)).toBeFocused();
      await page.keyboard.press("Enter");
      // Un crítico pide comentario para volver a marcarse: el botón queda inactivo y el foco va al cuadro del comentario.
      await expect(botonMarcar(page)).toBeDisabled();
      await expect(campoComentario(page)).toBeFocused();
    });
  }
});
