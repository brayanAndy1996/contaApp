// E-04 · Descarga SIRE de compras (spec 018, T6; HU-14, RF-042; CA-2, CA-8, CA-10). Cada prueba crea su estudio,
// su cliente y su sesión. El caso feliz cubre D-1 de 015 (la grilla se actualiza sola al completar la descarga).
import { retenerRuc } from "../soporte/cola.js";
import {
  PERIODO,
  RUCS,
  alerta,
  estado,
  expect,
  rucCentinela,
  test,
} from "../soporte/fixtures.js";
import type { TrabajoApi } from "../soporte/api.js";
import {
  apiCompras,
  filasDeCompras,
  rutaCompras,
} from "../soporte/selectores/compras.js";

const TOPE_TRABAJO_MS = 30_000;

test("descarga 202610: en cola, «5 nuevas» y la grilla se actualiza sola", async ({
  siembra,
  sesiones,
  api,
}) => {
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId, {
    ruc: RUCS.contribuyente,
  });
  const { page, sesion } = await sesiones.paginaDe(estudio.dueno);
  await api(sesion).cargarCredenciales(cliente.id);

  await page.goto(rutaCompras(cliente.id, PERIODO));
  await expect(page.getByText("Aún no hay descargas de este periodo.")).toBeVisible();
  await expect(estado(page, "No hay compras en este periodo.")).toBeVisible();
  await expect(filasDeCompras(page)).toHaveCount(0);

  const descargar = page.getByRole("button", { name: "Descargar", exact: true });
  // T11b: «En cola» dura hasta el siguiente ciclo del despachador (0 a 500 ms) y podía no llegar a pintarse. Con el
  // lock del RUC retenido el trabajo se queda en cola: la posición se comprueba en pantalla, no en un instante.
  const retencion = await retenerRuc("sire", RUCS.contribuyente);
  try {
    await descargar.click();
    await expect(estado(page, "En cola · posición 1")).toBeVisible();
  } finally {
    await retencion.soltar();
  }

  // Sin recargar la página: la descarga termina y la grilla pide sola el listado (D-1 de 015, CA-8).
  await expect(page.getByText("5 nuevas, 0 distintas")).toBeVisible({
    timeout: TOPE_TRABAJO_MS,
  });
  await expect(filasDeCompras(page)).toHaveCount(4);
  await expect(estado(page, "4 compras cargadas")).toBeVisible();
  await expect(page.getByText(/^Última descarga: /)).toBeVisible();
  await expect(descargar).toBeEnabled();

  // Tras la cola pasó por `ejecutando` («Descargando la propuesta…»). En pantalla ese estado dura lo que el trabajo
  // del mock (decenas de ms) y sus dos eventos pueden llegar juntos, así que no es determinista verlo (T11b): se
  // comprueba en el registro del trabajo, y el texto lo cubre la prueba de componente (`descarga-compras.spec.tsx`).
  const trabajos = await api(sesion).exigir<TrabajoApi[]>(
    "GET",
    `/trabajos?clienteId=${cliente.id}`,
  );
  const descarga = trabajos.filter((t) => t.tipo === "sire.propuesta.descargar");
  expect(descarga).toHaveLength(1);
  expect(descarga[0]).toMatchObject({ estado: "completado" });
  expect(descarga[0]?.iniciadoEn).not.toBeNull();

  // Cada aviso aparece una vez en el árbol de accesibilidad (CA-10).
  await expect(estado(page, "4 compras cargadas")).toHaveCount(1);
  await expect(alerta(page, /./)).toHaveCount(0);

  // El servidor guardó lo mismo que muestra la pantalla.
  const lista = await api(sesion).exigir<{ filas: unknown[] }>(
    "GET",
    `${apiCompras(cliente.id, PERIODO)}?vista=con_igv&limite=100`,
  );
  expect(lista.filas.length).toBe(4);
});

test("RUC …68: «La descarga falló» con «Reintentar», que encola de nuevo", async ({
  siembra,
  sesiones,
  api,
}) => {
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId, {
    ruc: rucCentinela(8),
  });
  const { page, sesion } = await sesiones.paginaDe(estudio.dueno);
  await api(sesion).cargarCredenciales(cliente.id);
  const descargas: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/compras/descargar")) {
      descargas.push(r.url());
    }
  });

  await page.goto(rutaCompras(cliente.id, PERIODO));
  await page.getByRole("button", { name: "Descargar", exact: true }).click();

  const fallo = estado(page, "La descarga falló: Datos inválidos");
  await expect(fallo).toBeVisible({ timeout: TOPE_TRABAJO_MS });
  await expect(fallo).toHaveCount(1);
  await expect(alerta(page, /./)).toHaveCount(0);
  await expect(filasDeCompras(page)).toHaveCount(0);
  expect(descargas).toHaveLength(1);

  const reintentar = fallo.getByRole("button", { name: "Reintentar" });
  await expect(reintentar).toBeEnabled();
  await reintentar.click();
  await expect.poll(() => descargas.length).toBe(2);
  // Vuelve a fallar con el mismo motivo y de nuevo ofrece «Reintentar».
  await expect(fallo).toBeVisible({ timeout: TOPE_TRABAJO_MS });
  await expect(reintentar).toBeEnabled();
  await expect(fallo).toHaveCount(1);
});

test("sin credenciales el servidor responde 409 y la pantalla explica qué falta", async ({
  siembra,
  sesiones,
  vigilancia,
}) => {
  vigilancia.permitirError(/409/);
  const estudio = await siembra.estudio();
  const cliente = await siembra.cliente(estudio.tenantId, {
    ruc: RUCS.contribuyente,
  });
  const { page } = await sesiones.paginaDe(estudio.dueno);

  await page.goto(rutaCompras(cliente.id, PERIODO));
  const respuesta = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && r.url().endsWith("/compras/descargar"),
  );
  await page.getByRole("button", { name: "Descargar", exact: true }).click();

  expect((await respuesta).status()).toBe(409);
  const aviso = alerta(
    page,
    "Faltan las credenciales SOL o SIRE del cliente: configúralas para descargar.",
  );
  await expect(aviso).toBeVisible();
  await expect(aviso).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Descargar", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Reintentar" })).toHaveCount(0);
  await expect(filasDeCompras(page)).toHaveCount(0);
});
