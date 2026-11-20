// Spec 023 · T23a (backend, rojo): decisión de producto aprobada tras la prueba manual (observación (b) de T23, P-6).
// Una captura que terminó por credencial inválida NO cuenta para el enfriamiento de 10 min de «Revisar buzón ahora»: tras
// corregir la clave SOL, el pedido se acepta al instante (202), aunque la solicitud que la originó y la captura parcial que
// dejó el worker sean de hace segundos. Siguen contando las demás capturas terminadas (ok, o con error de otro motivo) y las
// solicitudes recientes que no acabaron en credencial inválida.
// Se modela como el worker la deja: trabajo `sol.buzon.revisar` en `error` con `motivo = credencial_invalida`, estado con
// `ultima_solicitud_en` y (captura parcial) `ultima_captura_en` recientes, y la credencial ya corregida (`configurada`).
// Rojo: hoy `esperaDeEnfriamiento` solo mira las dos fechas y da 429.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoBuzon,
  cumple,
  type Actor,
  type BancoBuzon,
  type Estudio,
} from "../../../test/soporte-buzon.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const REVISAR = "sol.buzon.revisar";
let b: BancoBuzon;
let E: Estudio;
let contador: Actor;

beforeAll(async () => {
  b = await abrirBancoBuzon();
  E = await b.estudio();
  contador = await b.v.b.c.p.b.miembro(E.tenantId, "contador");
});
afterAll(async () => {
  await b?.cerrar();
});

const nuevo = () =>
  b.cliente(E, { responsable: contador.id, sol: "configurada" });
const revisar = (clienteId: string) =>
  b.llamar(contador, "POST", `/clientes/${clienteId}/buzon/revisar`);
const retryAfter = (r: { headers: Record<string, unknown> }): number =>
  Number(r.headers["retry-after"]);

/** Pedido que encola y cuya captura el worker termina en `error` con `motivo`; deja la captura parcial recién guardada. */
async function pedidoTerminadoConError(
  clienteId: string,
  motivo: string,
  conCapturaParcial = true,
): Promise<string> {
  const a = await revisar(clienteId);
  expect(a.status, a.text).toBe(202);
  await b.terminar(a.body.trabajo.id, "error", motivo);
  await b.sembrarEstado(E.tenantId, clienteId, {
    solicitudHace: 1,
    capturaHace: conCapturaParcial ? 0.5 : null,
  });
  return a.body.trabajo.id as string;
}

describe("P-6 · la captura terminada por credencial inválida no cuenta para el enfriamiento", () => {
  it("con la clave corregida: 202 al instante, trabajo nuevo, solicitud registrada y auditada", async () => {
    const c = await nuevo();
    const fallido = await pedidoTerminadoConError(c.id, "credencial_invalida");

    const r = await revisar(c.id);
    expect(r.status, r.text).toBe(202);
    expect(cumple("revisarBuzonRespuestaSchema", r.body)).toBe(true);
    expect(r.body.trabajo.id).not.toBe(fallido);
    expect(r.headers["retry-after"]).toBeUndefined();
    const filas = await b.trabajos(c.id, REVISAR);
    expect(filas).toHaveLength(2);
    expect(filas.map((f) => f.estado)).toEqual(["error", "en_cola"]);
    expect(filas[1]).toMatchObject({ prioridad: "interactivo", creado_por: contador.id });
    const e = await b.estado(c.id);
    expect(Date.now() - new Date(e.ultima_solicitud_en).getTime()).toBeLessThan(30_000);
    expect(
      (await b.auditoria(E.tenantId, "buzon.captura_solicitada")).filter(
        (f) => f.cliente_id === c.id,
      ),
    ).toHaveLength(2);
  });

  it("también si la captura falló antes de guardar nada (sin ultima_captura_en): 202", async () => {
    const c = await nuevo();
    await pedidoTerminadoConError(c.id, "credencial_invalida", false);
    const r = await revisar(c.id);
    expect(r.status, r.text).toBe(202);
  });

  it("el nuevo pedido vuelve a abrir el enfriamiento: terminado bien, el siguiente es 429", async () => {
    const c = await nuevo();
    await pedidoTerminadoConError(c.id, "credencial_invalida");
    const bueno = await revisar(c.id);
    expect(bueno.status, bueno.text).toBe(202);
    await b.terminar(bueno.body.trabajo.id);
    await b.sembrarEstado(E.tenantId, c.id, { solicitudHace: 0.2, capturaHace: 0.1 });
    const r = await revisar(c.id);
    expect(r.status, r.text).toBe(429);
    expect(r.body).toEqual({ codigo: "captura_reciente" });
  });
});

describe("P-6 · lo demás sigue contando para el enfriamiento (controles)", () => {
  it("una captura terminada bien hace pocos segundos sigue dando 429 con Retry-After ≈ 600 s", async () => {
    const c = await nuevo();
    const a = await revisar(c.id);
    expect(a.status, a.text).toBe(202);
    await b.terminar(a.body.trabajo.id);
    await b.sembrarEstado(E.tenantId, c.id, { solicitudHace: 1, capturaHace: 0.5 });
    const r = await revisar(c.id);
    expect(r.status, r.text).toBe(429);
    expect(r.body).toEqual({ codigo: "captura_reciente" });
    expect(retryAfter(r)).toBeGreaterThan(500);
    expect(retryAfter(r)).toBeLessThanOrEqual(600);
    expect(await b.trabajos(c.id, REVISAR)).toHaveLength(1);
  });

  it.each(["sunat_no_responde", "error_interno", "portal_cambio"])(
    "una captura terminada con error «%s» sigue contando: 429",
    async (motivo) => {
      const c = await nuevo();
      await pedidoTerminadoConError(c.id, motivo);
      const r = await revisar(c.id);
      expect(r.status, r.text).toBe(429);
      expect(r.body).toEqual({ codigo: "captura_reciente" });
      expect(await b.trabajos(c.id, REVISAR)).toHaveLength(1);
    },
  );

  it("una solicitud reciente sin captura fallida por credencial sigue contando: 429", async () => {
    const c = await nuevo();
    await b.sembrarEstado(E.tenantId, c.id, { solicitudHace: 1 });
    const r = await revisar(c.id);
    expect(r.status, r.text).toBe(429);
    expect(await b.trabajos(c.id, REVISAR)).toHaveLength(0);
  });

  it("la falla por credencial de OTRO cliente no libera a este: sigue 429", async () => {
    const otro = await nuevo();
    await pedidoTerminadoConError(otro.id, "credencial_invalida");
    const c = await nuevo();
    await b.sembrarEstado(E.tenantId, c.id, { solicitudHace: 1, capturaHace: 1 });
    expect((await revisar(c.id)).status).toBe(429);
    expect((await revisar(otro.id)).status).toBe(202); // el afectado sí queda libre
  });

  it("una captura bien terminada DESPUÉS de la fallida cuenta: 429", async () => {
    const c = await nuevo();
    await pedidoTerminadoConError(c.id, "credencial_invalida");
    // La clave se corrigió y otra captura (p. ej. la programada) terminó bien después.
    const ok = await b.sembrarRevisarVivo(E.tenantId, c.id, { prioridad: "programado" });
    await b.terminar(ok);
    await b.sembrarEstado(E.tenantId, c.id, { solicitudHace: 1, capturaHace: 0.1 });
    const r = await revisar(c.id);
    expect(r.status, r.text).toBe(429);
  });
});
