// E-10 · Historial de auditoría por cliente (spec 031; HU-39, RF-151; CA-3, CA-10; P-1): desde la ficha del cliente,
// «Ver historial» abre la auditoría filtrada por ese cliente y sin límite de fechas; al editar el cliente por la UI,
// el historial pasa de vacío a mostrar «Editó un cliente» con el antes → después. Sin `auditoria.ver` no hay enlace.
import { alerta, expect, test } from "../soporte/fixtures.js";
import {
  filaAuditoria,
  tablaAuditoria,
} from "../soporte/selectores/notificaciones.js";

test.describe("historial por cliente", () => {
  test("ficha → Ver historial → editar el cliente → el cambio aparece con antes y después", async ({
    siembra,
    sesiones,
  }) => {
    const estudio = await siembra.estudio();
    const cliente = await siembra.cliente(estudio.tenantId, {
      razonSocial: "CLIENTE HISTORIAL S.A.C.",
    });
    const otro = await siembra.cliente(estudio.tenantId, {
      ruc: "20700000011",
      razonSocial: "OTRO CLIENTE S.A.C.",
    });
    const { page } = await sesiones.paginaDe(estudio.dueno);

    // Antes: el historial del cliente, abierto desde la ficha, no tiene registros.
    await page.goto(`/clientes/${cliente.id}`);
    await page.getByRole("link", { name: "Ver historial" }).click();
    await page.waitForURL(
      (url) =>
        url.pathname === "/configuracion/auditoria" &&
        url.searchParams.get("clienteId") === cliente.id &&
        url.searchParams.get("todo") === "1",
    );
    await expect(page.getByLabel("Cliente")).toHaveValue(
      /CLIENTE HISTORIAL S\.A\.C\./,
    );
    await expect(
      page.getByText(/No hay registros para los filtros elegidos/),
    ).toBeVisible();
    await expect(tablaAuditoria(page)).toHaveCount(0);

    // Se edita el cliente por la UI (y el otro cliente, que no debe aparecer en este historial).
    await page.goto(`/clientes/${otro.id}`);
    await page.getByLabel("Razón social").fill("OTRO CLIENTE CORREGIDO S.A.C.");
    await page.getByRole("button", { name: "Guardar datos fiscales" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Datos guardados." }),
    ).toBeVisible();

    await page.goto(`/clientes/${cliente.id}`);
    await page.getByLabel("Razón social").fill("CLIENTE CORREGIDO S.A.C.");
    await page.getByRole("button", { name: "Guardar datos fiscales" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Datos guardados." }),
    ).toBeVisible();

    // Después: el mismo enlace muestra solo el cambio de este cliente, de qué a qué y quién.
    await page.getByRole("link", { name: "Ver historial" }).click();
    await expect(tablaAuditoria(page)).toBeVisible();
    const editado = filaAuditoria(page, "Editó un cliente");
    await expect(editado).toHaveCount(1);
    await expect(editado).toContainText(
      "Razón social: CLIENTE HISTORIAL S.A.C. → CLIENTE CORREGIDO S.A.C.",
    );
    await expect(editado).toContainText(estudio.dueno.nombre);
    await expect(tablaAuditoria(page)).not.toContainText(/OTRO CLIENTE/);
    expect(new URL(page.url()).searchParams.get("clienteId")).toBe(cliente.id);

    // Los filtros viven en la URL: al recargar siguen puestos y el resultado es el mismo.
    await page.reload();
    await expect(page.getByLabel("Cliente")).toHaveValue(
      /CLIENTE CORREGIDO S\.A\.C\./,
    );
    await expect(filaAuditoria(page, "Editó un cliente")).toHaveCount(1);
    await expect(tablaAuditoria(page)).not.toContainText(/OTRO CLIENTE/);
  });

  test("un cliente que el usuario no ve da 404 en español y sin enlace «Ver historial» sin `auditoria.ver`", async ({
    siembra,
    sesiones,
    vigilancia,
  }) => {
    vigilancia.permitirError(/status of (403|404)/);
    const estudio = await siembra.estudio();
    const asistente = await siembra.miembro(estudio.tenantId, "asistente");
    const propio = await siembra.cliente(estudio.tenantId, {
      asignadoA: asistente,
    });
    const ajeno = await siembra.cliente(estudio.tenantId, {
      ruc: "20700000011",
    });
    const { page } = await sesiones.paginaDe(asistente);

    // El asistente no tiene `auditoria.ver`: la ficha no ofrece el enlace.
    await page.goto(`/clientes/${propio.id}`);
    await expect(
      page.getByRole("navigation", { name: "Registros del cliente" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Ver historial" })).toHaveCount(
      0,
    );

    // El Dueño, con la URL de un cliente de otro estudio, ve el 404 sin datos ni códigos.
    const otroEstudio = await siembra.estudio();
    const { page: paginaDueno } = await sesiones.paginaDe(otroEstudio.dueno);
    await paginaDueno.goto(
      `/configuracion/auditoria?clienteId=${ajeno.id}&todo=1`,
    );
    await expect(
      alerta(paginaDueno, /No se encontró el cliente/),
    ).toHaveCount(1);
    await expect(tablaAuditoria(paginaDueno)).toHaveCount(0);
  });
});
