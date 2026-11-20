// E-11 · Buzón SOL (spec 023; HU-33, RF-120, RF-123, RF-126, RF-160; CA-2, CA-4, CA-6, CA-8, CA-12). Un solo caso de
// punta a punta con el `MockSolPortal` y el buzón de fixture del RUC de prueba (`fixtures/sol/buzon/20700000002.json`):
// «Revisar buzón ahora» en la ficha → trabajo en el panel → aviso crítico en la campana → vista mínima → «Abrir en
// SUNAT» con confirmación → contenido como texto → adjunto idéntico al del fixture (SHA-256) → segundo pedido con el
// mensaje de espera. El programador va apagado (`BUZON_PROGRAMADOR=off`): las únicas capturas son las que pide la prueba.
import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { RAIZ, URL_BACKEND } from "../soporte/pila/entorno.js";
import {
  RUCS,
  alerta,
  estado,
  expect,
  test,
  type Api,
} from "../soporte/fixtures.js";
import {
  campana,
  notificacion,
  panel,
} from "../soporte/selectores/notificaciones.js";
import {
  abrirEnSunat,
  avisoRevision,
  dialogoAbrir,
  enlaceAdjunto,
  filaTrabajo,
  revisarAhora,
} from "../soporte/selectores/buzon.js";
import { marcarBuzonSincronizado } from "../soporte/siembra-buzon.js";

test.setTimeout(90_000);

interface FixtureBuzon {
  readonly mensajes: readonly {
    readonly idSunat: string;
    readonly contenido: { readonly cuerpo: string };
    readonly adjuntos: readonly {
      readonly nombre: string;
      readonly base64: string;
    }[];
  }[];
}

/** El mensaje FX-0001 (coactiva, texto plano, un PDF) del fixture y el SHA-256 de su PDF. */
function coactivaDelFixture(): { cuerpo: string; pdf: string; sha256: string } {
  const buzon = JSON.parse(
    readFileSync(
      `${RAIZ}/fixtures/sol/buzon/${RUCS.contribuyente}.json`,
      "utf8",
    ),
  ) as FixtureBuzon;
  const mensaje = buzon.mensajes.find((m) => m.idSunat === "FX-0001");
  const adjunto = mensaje?.adjuntos[0];
  if (mensaje === undefined || adjunto === undefined) {
    throw new Error("El fixture del buzón no trae FX-0001 con adjunto.");
  }
  return {
    cuerpo: mensaje.contenido.cuerpo,
    pdf: adjunto.nombre,
    sha256: createHash("sha256")
      .update(Buffer.from(adjunto.base64, "base64"))
      .digest("hex"),
  };
}

test.describe("E-11 · buzón SOL", () => {
  test("Revisar ahora → aviso crítico en la campana → vista mínima → Abrir en SUNAT → contenido y adjunto", async ({
    siembra,
    sesiones,
    api,
    vigilancia,
  }) => {
    // El segundo «Revisar ahora» responde 429 a propósito (CA-2).
    vigilancia.permitirError(/status of 429/);
    const esperado = coactivaDelFixture();
    const estudio = await siembra.estudio();
    const cliente = await siembra.cliente(estudio.tenantId, {
      ruc: RUCS.contribuyente,
    });
    const llamadas = api(await sesiones.entrar(estudio.dueno));
    await llamadas.cargarCredenciales(cliente.id);
    await marcarBuzonSincronizado(estudio.tenantId, cliente.id);
    const { page } = await sesiones.paginaDe(estudio.dueno);

    await test.step("«Revisar buzón ahora» en la ficha encola la captura y la lleva al panel de trabajos", async () => {
      await page.goto(`/clientes/${cliente.id}`);
      await expect(revisarAhora(page)).toBeEnabled();
      await revisarAhora(page).click();
      await expect(avisoRevision(page)).toHaveText(/Revisión encolada\./);
      await avisoRevision(page)
        .getByRole("link", { name: "Ver en el panel de trabajos" })
        .click();
      await expect(page).toHaveURL(/\/trabajos$/);
      await expect(
        filaTrabajo(page, "Revisión de buzón SOL", "Completado"),
      ).toHaveCount(1, { timeout: 30_000 });
    });

    await test.step("el aviso crítico llega a la campana con la categoría y lleva al detalle del mensaje", async () => {
      await expect(campana(page)).toHaveAccessibleName(/sin leer/, {
        timeout: 30_000,
      });
      await campana(page).click();
      const aviso = notificacion(panel(page), "Coactiva");
      await expect(aviso).toContainText(
        `Mensaje crítico en el buzón SOL de ${cliente.razonSocial}: Coactiva`,
      );
      await aviso.click();
      await expect(page).toHaveURL(
        new RegExp(`/clientes/${cliente.id}/buzon\\?mensaje=[0-9a-f-]{36}$`),
      );
    });

    await test.step("sin «Abrir» el contenido no se obtuvo (RF-126)", async () => {
      await expect(
        page.getByRole("heading", {
          level: 2,
          name: /Resolución de Ejecución Coactiva/,
        }),
      ).toBeVisible();
      // Con la bandeja (024) la lista y el detalle comparten pantalla: la insignia crítica del detalle.
      await expect(
        page.getByRole("article").getByText("Crítico · Coactiva"),
      ).toBeVisible();
      await expect(
        page.getByText("El contenido aún no se obtuvo."),
      ).toBeVisible();
      await expect(
        page.getByText(esperado.cuerpo.split("\n")[0] ?? ""),
      ).toHaveCount(0);
    });

    await test.step("«Abrir en SUNAT» pide confirmar y encola la apertura; el contenido sale como texto", async () => {
      await abrirEnSunat(page).click();
      await dialogoAbrir(page)
        .getByRole("button", { name: "Confirmar" })
        .click();
      await expect(
        page.getByText("Apertura encolada.", { exact: false }),
      ).toBeVisible();

      // El trabajo corre en el worker; la vista no se refresca sola, así que se espera el contenido por API.
      await expect
        .poll(
          async () => {
            const r = await llamadas.pedir<{ contenido: string | null }>(
              "GET",
              `/clientes/${cliente.id}/buzon/mensajes/${await idDeMensaje(page)}`,
            );
            return r.cuerpo?.contenido ?? null;
          },
          { timeout: 30_000, intervals: [250, 500, 1_000] },
        )
        .not.toBeNull();
      await page.reload();
      await expect(
        page.getByText(
          "Se le notifica la Resolución de Ejecución Coactiva N.° 0123-2026.",
        ),
      ).toBeVisible();
      await expect(
        page.getByText("El contenido aún no se obtuvo."),
      ).toHaveCount(0);
      await expect(abrirEnSunat(page)).toHaveCount(0);
    });

    await test.step("el adjunto sale idéntico al del fixture (SHA-256) con attachment, nosniff y no-store", async () => {
      // Por la API con las cabeceras de la app: el clic en el enlace del detalle está roto (ver el caso `test.fail`).
      await expect(enlaceAdjunto(page, esperado.pdf)).toBeVisible();
      const descarga = await descargarAdjunto(
        llamadas,
        cliente.id,
        await idDeMensaje(page),
        esperado.pdf,
      );
      expect(descarga.sha256).toBe(esperado.sha256);
      expect(descarga.cabeceras.get("content-disposition")).toMatch(
        /^attachment/,
      );
      expect(descarga.cabeceras.get("x-content-type-options")).toBe("nosniff");
      expect(descarga.cabeceras.get("cache-control")).toMatch(/no-store/);
    });

    await test.step("un segundo «Revisar ahora» antes de 10 min dice cuánto falta (429)", async () => {
      await page.goto(`/clientes/${cliente.id}`);
      await expect(revisarAhora(page)).toBeEnabled();
      await revisarAhora(page).click();
      await expect(
        alerta(
          page,
          /Se revisó hace poco\. Podrás pedirlo de nuevo en \d+ min\./,
        ),
      ).toHaveCount(1);
      await expect(estado(page, /Revisión encolada\./)).toHaveCount(0);
    });

    // Un solo trabajo de revisión: el 429 no encoló otro.
    const trabajos = await llamadas.exigir<{ tipo: string }[]>(
      "GET",
      `/trabajos?clienteId=${cliente.id}`,
    );
    expect(trabajos.filter((t) => t.tipo === "sol.buzon.revisar")).toHaveLength(
      1,
    );
    expect(trabajos.filter((t) => t.tipo === "sol.buzon.abrir")).toHaveLength(
      1,
    );
  });
  // El enlace del adjunto no navega: baja el archivo con `fetch` + `X-Estudio` (apps/frontend/lib/buzon.ts).
  test("el clic en el adjunto del detalle descarga el archivo", async ({
    siembra,
    sesiones,
    api,
  }) => {
    const esperado = coactivaDelFixture();
    const estudio = await siembra.estudio();
    const cliente = await siembra.cliente(estudio.tenantId, {
      ruc: RUCS.contribuyente,
    });
    const llamadas = api(await sesiones.entrar(estudio.dueno));
    await llamadas.cargarCredenciales(cliente.id);
    await marcarBuzonSincronizado(estudio.tenantId, cliente.id);

    // Preparación por API: la captura y la apertura del mensaje FX-0001 (lo que el flujo anterior hace por la pantalla).
    const base = `/clientes/${cliente.id}/buzon`;
    const revisar = await llamadas.exigir<{ trabajo: { id: string } }>(
      "POST",
      `${base}/revisar`,
    );
    expect(
      (await llamadas.esperarTrabajo(cliente.id, revisar.trabajo.id)).estado,
    ).toBe("completado");
    const pagina = await llamadas.exigir<{
      mensajes: { id: string; asunto: string }[];
    }>("GET", `${base}/mensajes`);
    const coactiva = pagina.mensajes.find((m) =>
      /Ejecución Coactiva/.test(m.asunto),
    );
    if (coactiva === undefined)
      throw new Error("La captura no guardó la coactiva.");
    const abrir = await llamadas.exigir<{ trabajo: { id: string } | null }>(
      "POST",
      `${base}/mensajes/${coactiva.id}/abrir`,
    );
    if (abrir.trabajo !== null) {
      expect(
        (await llamadas.esperarTrabajo(cliente.id, abrir.trabajo.id)).estado,
      ).toBe("completado");
    }

    const { page } = await sesiones.paginaDe(estudio.dueno);
    await page.goto(`/clientes/${cliente.id}/buzon?mensaje=${coactiva.id}`);
    const respuesta = page.waitForResponse((r) =>
      r.url().includes("/adjuntos/"),
    );
    const descarga = page.waitForEvent("download");
    await enlaceAdjunto(page, esperado.pdf).click();
    expect((await respuesta).status()).toBe(200);
    const archivo = await descarga;
    expect(archivo.suggestedFilename()).toBe(esperado.pdf);
    const flujo = await archivo.createReadStream();
    const trozos: Buffer[] = [];
    for await (const trozo of flujo) trozos.push(Buffer.from(trozo as Buffer));
    expect(
      createHash("sha256").update(Buffer.concat(trozos)).digest("hex"),
    ).toBe(esperado.sha256);
    // Ningún aviso de error: el clic no mostró un JSON ni un 409.
    await expect(alerta(page, /.+/)).toHaveCount(0);
  });
});

/** Baja el adjunto `nombre` del mensaje por la API (con `X-Estudio`, como la app) y calcula su SHA-256. */
async function descargarAdjunto(
  llamadas: Api,
  clienteId: string,
  mensajeId: string,
  nombre: string,
): Promise<{ sha256: string; cabeceras: Headers }> {
  const ruta = `/clientes/${clienteId}/buzon/mensajes/${mensajeId}`;
  const detalle = await llamadas.exigir<{
    adjuntos: { id: string; nombre: string }[];
  }>("GET", ruta);
  const adjunto = detalle.adjuntos.find((a) => a.nombre === nombre);
  if (adjunto === undefined) throw new Error("El mensaje no trae ese adjunto.");
  const r = await fetch(`${URL_BACKEND}${ruta}/adjuntos/${adjunto.id}`, {
    headers: {
      Cookie: llamadas.sesion.cookie,
      "X-Estudio": llamadas.sesion.tenantId,
      "X-Forwarded-For": llamadas.sesion.ip,
    },
  });
  if (r.status !== 200) throw new Error(`El adjunto respondió ${r.status}.`);
  return {
    sha256: createHash("sha256")
      .update(Buffer.from(await r.arrayBuffer()))
      .digest("hex"),
    cabeceras: r.headers,
  };
}

/** El id del mensaje abierto, de `?mensaje=<id>` en la URL actual. */
async function idDeMensaje(page: Page): Promise<string> {
  const id = new URL(page.url()).searchParams.get("mensaje");
  if (id === null) throw new Error("La URL no trae ?mensaje=.");
  return id;
}
