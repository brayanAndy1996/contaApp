// E-12 · Avisos por correo (spec 028; HU-33, R-2, R-7, R-9, R-13; CA-2, CA-4, CA-8, CA-13, CA-15). Con el `MockSolPortal` y el
// buzón de fixture del RUC de prueba (`fixtures/sol/buzon/20700000002.json`):
//  - «Mi cuenta → Correo»: interruptores por defecto, «Guardar» y la invitación al resumen (aparece una vez).
//  - Un caso de punta a punta: el Dueño ve «Coactivas y avisos críticos del buzón» activado → «Revisar buzón ahora» → el
//    correo del aviso llega con la razón social, sin RUC ni asunto de los mensajes, con `List-Unsubscribe` y el enlace
//    `/ir` que lleva a la bandeja del cliente (también con otro estudio activo) → el enlace de baja: al cargar `/baja` la
//    preferencia sigue activa y nada se pide a la API; solo «Darme de baja» la apaga → «Mi cuenta → Correo» la muestra
//    apagada → el Dueño activa el resumen y, con la hora del ciclo movida a la actual por el soporte, llega el resumen
//    con el cliente.
// El ciclo del worker corre cada 60 s (`CORREO_TICK_MS`), así que el caso espera hasta ~70 s por cada correo. Los correos
// se buscan por destinatario único y por asunto: ningún otro flujo (invitación, recuperación) toma uno de 028.
import { readFileSync } from "node:fs";
import { RAIZ } from "../soporte/pila/entorno.js";
import { enlacesDeAviso } from "../soporte/correo.js";
import { RUCS, expect, test, type Api } from "../soporte/fixtures.js";
import { marcarBuzonSincronizado } from "../soporte/siembra-buzon.js";
import {
  adelantarResumen,
  restaurarProgramacionDeResumen,
} from "../soporte/siembra-correo.js";
import {
  INTERRUPTORES,
  activarResumen,
  ahoraNo,
  bajaListo,
  darmeDeBaja,
  guardarCorreo,
  interruptor,
  invitacionResumen,
} from "../soporte/selectores/correo.js";
import {
  filaMensaje,
  revisarAhora,
  tablaMensajes,
} from "../soporte/selectores/buzon.js";

const ASUNTO_AVISO = /^Coactiva y avisos críticos del buzón/;
const ASUNTO_RESUMEN = /^Resumen diario/;
/** Espera de un correo que sale en el siguiente ciclo del worker (60 s) más el envío. */
const ESPERA_CICLO_MS = 90_000;

interface PreferenciasApi {
  readonly buzonCritico: boolean;
  readonly credencialInvalida: boolean;
  readonly planLimite: boolean;
  readonly resumen: boolean;
  readonly todosClientes: boolean;
  readonly todosDisponible: boolean;
  readonly invitacionResumen: boolean;
}

const preferencias = (llamadas: Api): Promise<PreferenciasApi> =>
  llamadas.exigir<PreferenciasApi>("GET", "/cuenta/correo");

/** Los asuntos del buzón de fixture: ninguno puede salir en un correo (R-6). */
function asuntosDelFixture(): string[] {
  const buzon = JSON.parse(
    readFileSync(
      `${RAIZ}/fixtures/sol/buzon/${RUCS.contribuyente}.json`,
      "utf8",
    ),
  ) as { mensajes: { asunto: string }[] };
  return buzon.mensajes.map((m) => m.asunto);
}

test.describe("E-12 · avisos por correo", () => {
  test("«Mi cuenta → Correo»: valores por defecto, Guardar y la invitación al resumen (una vez)", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const estudio = await siembra.estudio();
    const llamadas = api(await sesiones.entrar(estudio.dueno));
    const { page } = await sesiones.paginaDe(estudio.dueno);

    await test.step("los avisos vienen activados y el resumen apagado; el Dueño ve «todos los clientes»", async () => {
      await page.goto("/cuenta/correo");
      await expect(page.getByRole("heading", { name: "Correo" })).toBeVisible();
      await expect(interruptor(page, INTERRUPTORES.buzonCritico)).toBeChecked();
      await expect(
        interruptor(page, INTERRUPTORES.credencialInvalida),
      ).toBeChecked();
      await expect(interruptor(page, INTERRUPTORES.planLimite)).toBeChecked();
      await expect(interruptor(page, INTERRUPTORES.resumen)).not.toBeChecked();
      await expect(interruptor(page, INTERRUPTORES.todos)).toBeVisible();
      await expect(invitacionResumen(page)).toBeVisible();
    });

    await test.step("«Ahora no» cierra la invitación y no vuelve a aparecer", async () => {
      await expect(invitacionResumen(page)).toBeVisible();
      await ahoraNo(page).click();
      await expect(invitacionResumen(page)).toHaveCount(0);
      expect((await preferencias(llamadas)).invitacionResumen).toBe(false);
      await page.reload();
      await expect(interruptor(page, INTERRUPTORES.resumen)).toBeVisible();
      await expect(invitacionResumen(page)).toHaveCount(0);
      await expect(interruptor(page, INTERRUPTORES.resumen)).not.toBeChecked();
      expect((await preferencias(llamadas)).resumen).toBe(false);
    });
    await test.step("cambiar un interruptor no guarda hasta pulsar «Guardar»", async () => {
      await interruptor(page, INTERRUPTORES.planLimite).click();
      await expect(
        interruptor(page, INTERRUPTORES.planLimite),
      ).not.toBeChecked();
      expect((await preferencias(llamadas)).planLimite).toBe(true);

      await guardarCorreo(page).click();
      await expect(page.getByText("Guardamos tus preferencias.")).toBeVisible();
      const guardadas = await preferencias(llamadas);
      expect(guardadas.planLimite).toBe(false);
      expect(guardadas.buzonCritico).toBe(true);
      expect(guardadas.credencialInvalida).toBe(true);
      expect(guardadas.resumen).toBe(false);

      await page.reload();
      await expect(
        interruptor(page, INTERRUPTORES.planLimite),
      ).not.toBeChecked();
      await expect(interruptor(page, INTERRUPTORES.buzonCritico)).toBeChecked();
    });
  });

  test("un Contador sin clientes asignados no ve «todos los clientes»", async ({
    siembra,
    sesiones,
  }) => {
    const estudio = await siembra.estudio();
    const contador = await siembra.miembro(estudio.tenantId, "contador");
    const { page } = await sesiones.paginaDe(contador);

    await page.goto("/cuenta/correo");
    await expect(interruptor(page, INTERRUPTORES.buzonCritico)).toBeVisible();
    await expect(interruptor(page, INTERRUPTORES.todos)).toHaveCount(0);
  });

  test("coactiva → correo con su enlace /ir → baja desde /baja (solo al pulsar) → resumen", async ({
    siembra,
    sesiones,
    api,
    correo,
    browser,
  }) => {
    test.setTimeout(300_000);
    const estudio = await siembra.estudio();
    const otro = await siembra.estudio();
    const cliente = await siembra.cliente(estudio.tenantId, {
      ruc: RUCS.contribuyente,
    });
    // El mismo Dueño es miembro de otro estudio, para abrir el enlace con ese otro estudio activo.
    await siembra.membresia(estudio.dueno, otro.tenantId, "dueno");
    const llamadas = api(await sesiones.entrar(estudio.dueno));
    await llamadas.cargarCredenciales(cliente.id);
    await marcarBuzonSincronizado(estudio.tenantId, cliente.id);
    const { page } = await sesiones.paginaDe(estudio.dueno);
    const destinatario = estudio.dueno.correo;

    try {
      await test.step("el Dueño ve activado «Coactivas y avisos críticos del buzón»", async () => {
        await page.goto("/cuenta/correo");
        await expect(
          interruptor(page, INTERRUPTORES.buzonCritico),
        ).toBeChecked();
      });

      await test.step("«Revisar buzón ahora» deja el trabajo completado y el correo en camino", async () => {
        await page.goto(`/clientes/${cliente.id}`);
        await expect(revisarAhora(page)).toBeEnabled();
        await revisarAhora(page).click();
        await expect
          .poll(
            async () => {
              const trabajos = await llamadas.exigir<
                { tipo: string; estado: string }[]
              >("GET", `/trabajos?clienteId=${cliente.id}`);
              return trabajos.find((t) => t.tipo === "sol.buzon.revisar")
                ?.estado;
            },
            { timeout: 30_000, intervals: [250, 500, 1_000] },
          )
          .toBe("completado");
      });

      const aviso = await correo.ultimo(
        destinatario,
        ASUNTO_AVISO,
        ESPERA_CICLO_MS,
      );

      await test.step("el correo trae la razón social, sin RUC ni asunto de los mensajes (R-6)", async () => {
        expect(aviso.asunto).toContain(cliente.razonSocial);
        expect(aviso.texto).toContain(cliente.razonSocial);
        expect(aviso.texto).toContain("Coactiva");
        expect(aviso.conHtml).toBe(true);
        const todo = [
          aviso.asunto,
          aviso.texto,
          aviso.html ?? "",
          JSON.stringify(aviso.cabeceras ?? {}),
        ].join("\n");
        expect(todo.includes(cliente.ruc)).toBe(false);
        for (const asunto of asuntosDelFixture()) {
          expect(todo.includes(asunto)).toBe(false);
        }
        // Un solo correo para toda la captura (agrupación).
        expect(await correo.cuantos(destinatario, ASUNTO_AVISO)).toBe(1);
      });

      await test.step("lleva `List-Unsubscribe` y `List-Unsubscribe-Post` (RFC 8058)", async () => {
        expect(aviso.conBaja).toBe(true);
        if (aviso.cabeceras !== undefined) {
          const baja = aviso.cabeceras["list-unsubscribe"]?.[0] ?? "";
          // Sin imprimir el token si falla: solo se comprueba la forma.
          expect(
            /^<https?:\/\/[^>\s]+\/api\/correo\/baja\?t=[A-Za-z0-9_-]{43}>$/.test(
              baja,
            ),
          ).toBe(true);
          expect(aviso.cabeceras["list-unsubscribe-post"]).toEqual([
            "List-Unsubscribe=One-Click",
          ]);
        }
      });

      const { ir, baja } = enlacesDeAviso(aviso.texto);
      expect(ir).not.toBeNull();
      expect(baja).not.toBeNull();

      await test.step("el enlace `/ir` abre la bandeja del cliente, también con otro estudio activo", async () => {
        await page.goto(ir ?? "");
        await expect(page).toHaveURL(
          new RegExp(`/clientes/${cliente.id}/buzon`),
        );
        await expect(
          page.getByRole("heading", { level: 1, name: "Buzón SOL" }),
        ).toBeVisible();
        await expect(tablaMensajes(page)).toBeVisible();
        await expect(filaMensaje(page, /Ejecución Coactiva/)).toHaveCount(1);

        const { page: pagina2 } = await sesiones.paginaDe(
          estudio.dueno,
          otro.tenantId,
        );
        await pagina2.goto(ir ?? "");
        await expect(pagina2).toHaveURL(
          new RegExp(`/clientes/${cliente.id}/buzon`),
        );
        await expect(
          pagina2.getByRole("heading", { level: 1, name: "Buzón SOL" }),
        ).toBeVisible();
        await expect(filaMensaje(pagina2, /Ejecución Coactiva/)).toHaveCount(1);
        // El enlace cambió el estudio activo al del correo.
        await expect(
          pagina2.getByRole("combobox", { name: "Estudio" }),
        ).toHaveValue(estudio.tenantId);
      });

      await test.step("`/baja` al cargar no cambia nada ni pide nada a la API", async () => {
        const contexto = await browser.newContext();
        try {
          const publica = await contexto.newPage();
          const pedidos: string[] = [];
          publica.on("request", (r) => {
            if (/\/api\/correo\/baja/.test(r.url())) {
              pedidos.push(r.method());
            }
          });
          await publica.goto(baja ?? "");
          await expect(darmeDeBaja(publica)).toBeVisible();
          await publica.waitForLoadState("networkidle");
          expect(pedidos).toEqual([]);
          // El token sale de la barra de direcciones (D-4).
          expect(publica.url()).not.toContain("t=");
          expect((await preferencias(llamadas)).buzonCritico).toBe(true);

          await darmeDeBaja(publica).click();
          await expect(bajaListo(publica)).toBeVisible();
          expect(pedidos).toEqual(["POST"]);
        } finally {
          await contexto.close();
        }
      });

      await test.step("«Mi cuenta → Correo» lo muestra apagado y lo demás sigue igual", async () => {
        expect((await preferencias(llamadas)).buzonCritico).toBe(false);
        await page.goto("/cuenta/correo");
        await expect(
          interruptor(page, INTERRUPTORES.buzonCritico),
        ).not.toBeChecked();
        await expect(
          interruptor(page, INTERRUPTORES.credencialInvalida),
        ).toBeChecked();
        await expect(interruptor(page, INTERRUPTORES.planLimite)).toBeChecked();
      });

      await test.step("el Dueño activa el resumen y, con la hora del ciclo movida a la actual, llega con el cliente", async () => {
        await expect(invitacionResumen(page)).toBeVisible();
        await activarResumen(page).click();
        await expect(invitacionResumen(page)).toHaveCount(0);
        await expect(interruptor(page, INTERRUPTORES.resumen)).toBeChecked();
        expect((await preferencias(llamadas)).resumen).toBe(true);

        // Un Dueño sin clientes asignados solo recibe el resumen de todo el estudio con «todos los clientes» (U-3).
        await interruptor(page, INTERRUPTORES.todos).click();
        await guardarCorreo(page).click();
        await expect(
          page.getByText("Guardamos tus preferencias."),
        ).toBeVisible();
        const guardadas = await preferencias(llamadas);
        expect(guardadas.todosClientes).toBe(true);
        expect(guardadas.resumen).toBe(true);
        // La baja de antes sigue vigente: guardar no reactivó el aviso.
        expect(guardadas.buzonCritico).toBe(false);

        // Después de activar: un ciclo anterior no puede dejar el día cerrado sin este usuario.
        await adelantarResumen();
        const resumen = await correo.ultimo(
          destinatario,
          ASUNTO_RESUMEN,
          ESPERA_CICLO_MS,
        );
        expect(resumen.texto).toContain(cliente.razonSocial);
        expect(resumen.conBaja).toBe(true);
        const todo = [
          resumen.asunto,
          resumen.texto,
          resumen.html ?? "",
          JSON.stringify(resumen.cabeceras ?? {}),
        ].join("\n");
        expect(todo.includes(cliente.ruc)).toBe(false);
        for (const asunto of asuntosDelFixture()) {
          expect(todo.includes(asunto)).toBe(false);
        }
        // Un solo resumen del día y ningún aviso nuevo tras la baja.
        expect(await correo.cuantos(destinatario, ASUNTO_RESUMEN)).toBe(1);
        expect(await correo.cuantos(destinatario, ASUNTO_AVISO)).toBe(1);
      });
    } finally {
      await restaurarProgramacionDeResumen();
    }
  });
});
