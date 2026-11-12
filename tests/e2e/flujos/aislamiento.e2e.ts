// E-11 Aislamiento en la UI (spec 018, RNF-001, RNF-007, HU-08; CA-7): quien no ve un recurso (otro estudio o
// cliente no asignado) recibe la misma pantalla y la misma respuesta que con un id inexistente: 404, sin ningún
// dato ajeno en el DOM ni en las respuestas. Y al cambiar de estudio las listas no se mezclan.
import { randomUUID } from "node:crypto";
import type { Page, Request, Response } from "@playwright/test";
import {
  PERIODO,
  RUCS,
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
import {
  AVISO_NO_ENCONTRADO,
  selectorDeEstudio,
} from "../soporte/selectores/aislamiento.js";

const SIN_CONSOLA_404 = /404|Failed to load resource/;

interface DatosDeA {
  readonly estudio: Estudio;
  readonly cliente: Cliente;
  readonly sesion: Sesion;
  readonly compraId: string;
  readonly archivoId: string;
}

/** Un estudio con un cliente de razón social inconfundible, compras descargadas y un archivo de ventas generado. */
async function prepararA(
  siembra: Siembra,
  sesiones: Sesiones,
  api: (s: Sesion) => Api,
): Promise<DatosDeA> {
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId, {
    ruc: RUCS.contribuyente,
    razonSocial: `RESERVADO ESTUDIO A ${randomUUID().slice(0, 8)}`,
  });
  const sesion = await sesiones.entrar(estudio.dueno);
  const llamadas = api(sesion);
  await llamadas.cargarCredenciales(cliente.id);
  await llamadas.descargar(cliente.id, PERIODO, "compras");
  await llamadas.descargar(cliente.id, PERIODO, "ventas");
  const lista = await llamadas.exigir<{ filas: { id: string }[] }>(
    "GET",
    `/clientes/${cliente.id}/periodos/${PERIODO}/compras`,
  );
  const compraId = lista.filas[0]?.id;
  if (compraId === undefined) throw new Error("A no tiene compras.");
  return {
    estudio,
    cliente,
    sesion,
    compraId,
    archivoId: await generarVentas(llamadas, cliente),
  };
}

/** Excluye las ventas que bloquean (USD sin tipo de cambio) y genera el archivo de ventas de A. */
async function generarVentas(llamadas: Api, cliente: Cliente): Promise<string> {
  const base = `/clientes/${cliente.id}/periodos/${PERIODO}/ventas`;
  const previo = await llamadas.previoArchivo(cliente.id, PERIODO, "ventas");
  for (const e of previo.errores) {
    if (e.filaId === null) continue;
    await llamadas.exigir("POST", `${base}/${e.filaId}/excluir`, {
      motivo: "Excluida para la prueba de aislamiento",
    });
  }
  return (await llamadas.generarArchivo(cliente.id, PERIODO, "ventas")).id;
}

/** Lo que una persona ve y lo que el navegador recibe al abrir una URL. */
interface Observado {
  readonly alertas: string[];
  readonly principal: string;
  readonly cuerpos: string[];
  readonly estados: number[];
}

/** Abre `url`, espera el aviso de «no encontrado» y devuelve lo visible y las respuestas `/api` recibidas. */
async function observar(page: Page, url: string): Promise<Observado> {
  const cuerpos: string[] = [];
  const estados: number[] = [];
  const pendientes: Promise<void>[] = [];
  const alResponder = (r: Response): void => {
    if (new URL(r.url()).pathname.startsWith("/api/")) estados.push(r.status());
  };
  // Los cuerpos se leen cuando la petición terminó: el stream de notificaciones (SSE) nunca termina.
  const alTerminar = (req: Request): void => {
    if (!new URL(req.url()).pathname.startsWith("/api/")) return;
    pendientes.push(
      req
        .response()
        .then((r) => r?.text())
        .then((t) => void (t === undefined || cuerpos.push(t)))
        .catch(() => undefined),
    );
  };
  page.on("response", alResponder);
  page.on("requestfinished", alTerminar);
  await page.goto(url);
  await expect(alerta(page, AVISO_NO_ENCONTRADO).first()).toBeVisible();
  await Promise.all(pendientes);
  page.off("response", alResponder);
  page.off("requestfinished", alTerminar);
  return {
    alertas: await page.getByRole("alert").allTextContents(),
    principal: (await page.getByRole("main").innerText()).trim(),
    cuerpos,
    // Solo los rechazos: cuántas lecturas 200 hace la pantalla depende del momento (sondeos, avisos).
    estados: [...new Set(estados.filter((s) => s !== 200))].sort(),
  };
}

const sinDatosDeA = (observado: Observado, html: string, a: DatosDeA): void => {
  // El id sí está en el HTML (es la URL que pidió la persona); lo que no puede estar son los datos del cliente.
  const ajenos = [a.cliente.razonSocial, a.cliente.ruc];
  for (const dato of ajenos) {
    expect(html).not.toContain(dato);
    expect(observado.principal).not.toContain(dato);
    for (const cuerpo of observado.cuerpos) expect(cuerpo).not.toContain(dato);
  }
};

test.describe("el estudio B no ve nada del estudio A", () => {
  test("las pantallas de cliente, compras y ventas de A dicen «no encontrado», igual que un id inexistente", async ({
    siembra,
    sesiones,
    api,
    vigilancia,
  }) => {
    vigilancia.permitirError(SIN_CONSOLA_404);
    const a = await prepararA(siembra, sesiones, api);
    const estudioB = await siembra.estudio();
    const { page } = await sesiones.paginaDe(estudioB.dueno);
    const inexistente = randomUUID();

    const rutas = (id: string): string[] => [
      `/clientes/${id}`,
      `/clientes/${id}/compras?periodo=${PERIODO}`,
      `/clientes/${id}/ventas?periodo=${PERIODO}`,
    ];
    const ajenas = rutas(a.cliente.id);
    const vacias = rutas(inexistente);

    for (const [i, ruta] of ajenas.entries()) {
      const deA = await observar(page, ruta);
      sinDatosDeA(deA, await page.content(), a);
      const deNadie = await observar(page, vacias[i] as string);

      // La misma pantalla, el mismo aviso y los mismos estados HTTP que con un id que no existe.
      expect(deA.alertas, ruta).toEqual(deNadie.alertas);
      expect(deA.principal, ruta).toBe(deNadie.principal);
      expect(deA.estados, ruta).toEqual(deNadie.estados);
      expect(deA.estados, ruta).toEqual([404]);
    }
  });

  test("el aviso de «no encontrado» se anuncia una sola vez en cliente, compras y ventas (CA-10)", async ({
    siembra,
    sesiones,
    api,
    vigilancia,
  }) => {
    vigilancia.permitirError(SIN_CONSOLA_404);
    const a = await prepararA(siembra, sesiones, api);
    const estudioB = await siembra.estudio();
    const { page } = await sesiones.paginaDe(estudioB.dueno);

    for (const ruta of [
      `/clientes/${a.cliente.id}`,
      `/clientes/${a.cliente.id}/compras?periodo=${PERIODO}`,
      `/clientes/${a.cliente.id}/ventas?periodo=${PERIODO}`,
    ]) {
      await page.goto(ruta);
      await expect.soft(alerta(page, AVISO_NO_ENCONTRADO), ruta).toHaveCount(1);
    }
  });

  test("la compra, su XML y el ZIP de A dan 404 idéntico al de un id inexistente", async ({
    siembra,
    sesiones,
    api,
    vigilancia,
  }) => {
    vigilancia.permitirError(SIN_CONSOLA_404);
    const a = await prepararA(siembra, sesiones, api);
    const estudioB = await siembra.estudio();
    const { page } = await sesiones.paginaDe(estudioB.dueno);
    await page.goto("/");

    const base = (id: string): string =>
      `/api/clientes/${id}/periodos/${PERIODO}`;
    const rutas = (clienteId: string, compraId: string, archivoId: string) => ({
      compra: `${base(clienteId)}/compras/${compraId}`,
      detalle: `${base(clienteId)}/compras/${compraId}/detalle`,
      lupa: `${base(clienteId)}/compras/${compraId}/xml`,
      zipVentas: `${base(clienteId)}/ventas/archivos/${archivoId}/zip`,
      versionesVentas: `${base(clienteId)}/ventas/archivos`,
      listado: `${base(clienteId)}/compras`,
    });
    const deA = rutas(a.cliente.id, a.compraId, a.archivoId);
    const deNadie = rutas(randomUUID(), randomUUID(), randomUUID());

    for (const clave of Object.keys(deA) as (keyof typeof deA)[]) {
      // Como el frontend: la sesión va en la cookie y el estudio activo en `X-Estudio`.
      const headers = { "X-Estudio": estudioB.tenantId };
      const ajena = await page.request.get(deA[clave], { headers });
      const vacia = await page.request.get(deNadie[clave], { headers });
      const cuerpoAjeno = await ajena.text();
      const cuerpoVacio = await vacia.text();
      expect(ajena.status(), clave).toBe(404);
      expect(vacia.status(), clave).toBe(404);
      expect(ajena.headers()["content-type"], clave).toBe(
        vacia.headers()["content-type"],
      );
      expect(ajena.headers()["content-length"], clave).toBe(
        vacia.headers()["content-length"],
      );
      for (const dato of [a.cliente.razonSocial, a.cliente.ruc, a.cliente.id]) {
        expect(cuerpoAjeno, clave).not.toContain(dato);
      }
      // Mismo cuerpo salvo los ids de la ruta, que cada respuesta puede repetir.
      const sinIds = (t: string): string =>
        t.replaceAll(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "ID");
      expect(sinIds(cuerpoAjeno), clave).toBe(sinIds(cuerpoVacio));
    }

    // Control: la misma petición, con la sesión de A, sí devuelve el ZIP.
    const zipDeA = await api(a.sesion).descargarZip(
      a.cliente.id,
      PERIODO,
      a.archivoId,
      "ventas",
    );
    expect(zipDeA.byteLength).toBeGreaterThan(0);
  });
});

test.describe("un asistente sin asignación no ve el cliente", () => {
  test("recibe «no encontrado» como con un id inexistente y lo ve cuando se le asigna", async ({
    siembra,
    sesiones,
    vigilancia,
  }) => {
    vigilancia.permitirError(SIN_CONSOLA_404);
    const estudio = await siembra.estudio();
    const cliente = await siembra.cliente(estudio.tenantId, {
      razonSocial: `RESERVADO SIN ASIGNAR ${randomUUID().slice(0, 8)}`,
    });
    const asistente = await siembra.miembro(estudio.tenantId, "asistente");
    const sinAsignar = await sesiones.paginaDe(asistente);

    // El listado no lo trae y el detalle responde como si no existiera.
    await sinAsignar.page.goto("/clientes");
    await expect(
      sinAsignar.page.getByRole("heading", { name: "Clientes", exact: true }),
    ).toBeVisible();
    await expect(sinAsignar.page.getByText(cliente.razonSocial)).toHaveCount(0);

    const deAsistente = await observar(
      sinAsignar.page,
      `/clientes/${cliente.id}`,
    );
    const deNadie = await observar(
      sinAsignar.page,
      `/clientes/${randomUUID()}`,
    );
    expect(deAsistente.alertas).toEqual(deNadie.alertas);
    expect(deAsistente.principal).toBe(deNadie.principal);
    expect(deAsistente.estados).toEqual(deNadie.estados);
    for (const dato of [cliente.razonSocial, cliente.ruc]) {
      expect(deAsistente.principal).not.toContain(dato);
      for (const cuerpo of deAsistente.cuerpos)
        expect(cuerpo).not.toContain(dato);
    }

    const headers = { "X-Estudio": estudio.tenantId };
    const respuesta = await sinAsignar.page.request.get(
      `/api/clientes/${cliente.id}`,
      { headers },
    );
    const respuestaNadie = await sinAsignar.page.request.get(
      `/api/clientes/${randomUUID()}`,
      { headers },
    );
    expect(respuesta.status()).toBe(404);
    expect(respuestaNadie.status()).toBe(404);
    expect(await respuesta.text()).toBe(await respuestaNadie.text());

    // Con la asignación, la misma persona lo ve.
    await siembra.asignar(cliente, asistente);
    const asignado = await sesiones.paginaDe(asistente);
    await asignado.page.goto(`/clientes/${cliente.id}`);
    await expect(
      asignado.page.getByText(cliente.razonSocial).first(),
    ).toBeVisible();
  });
});

test.describe("quien está en dos estudios", () => {
  test("las listas no se mezclan al cambiar de estudio", async ({
    siembra,
    sesiones,
    vigilancia,
  }) => {
    vigilancia.permitirError(SIN_CONSOLA_404);
    const estudioA = await siembra.estudio();
    const estudioB = await siembra.estudio();
    const clienteA = await siembra.cliente(estudioA.tenantId, {
      ruc: RUCS.contribuyente,
      razonSocial: `CLIENTE SOLO DE A ${randomUUID().slice(0, 8)}`,
    });
    const clienteB = await siembra.cliente(estudioB.tenantId, {
      ruc: RUCS.zapatilla,
      razonSocial: `CLIENTE SOLO DE B ${randomUUID().slice(0, 8)}`,
    });
    const enA = await siembra.miembro(estudioA.tenantId, "admin");
    const enB = await siembra.membresia(enA, estudioB.tenantId, "admin");
    const { page } = await sesiones.paginaDe(enA, estudioA.tenantId);

    await page.goto("/clientes");
    await expect(selectorDeEstudio(page)).toHaveValue(estudioA.tenantId);
    await expect(page.getByText(clienteA.razonSocial).first()).toBeVisible();
    await expect(page.getByText(clienteB.razonSocial)).toHaveCount(0);

    // Cambiar de estudio recarga la lista: solo B, nada de A.
    await selectorDeEstudio(page).selectOption(estudioB.tenantId);
    await expect(selectorDeEstudio(page)).toHaveValue(enB.tenantId);
    await expect
      .soft(page.getByText(clienteB.razonSocial).first())
      .toBeVisible();
    await expect.soft(page.getByText(clienteA.razonSocial)).toHaveCount(0);

    // Con B activo, el cliente de A deja de existir también por su URL.
    const deA = await observar(page, `/clientes/${clienteA.id}`);
    expect(deA.principal).not.toContain(clienteA.razonSocial);
    for (const cuerpo of deA.cuerpos) {
      expect(cuerpo).not.toContain(clienteA.razonSocial);
    }

    // Y de vuelta en A pasa lo contrario.
    await page.goto("/clientes");
    await selectorDeEstudio(page).selectOption(estudioA.tenantId);
    await expect
      .soft(page.getByText(clienteA.razonSocial).first())
      .toBeVisible();
    await expect.soft(page.getByText(clienteB.razonSocial)).toHaveCount(0);
  });
});
