// Spec 008 · T15b (ronda adversarial 2b, caja blanca): el SSE tras la corrección de H-008-1b-8 (alcance global = lista
// de clientes del estudio, recargada en cada revalidación ≤ 5 s). PG y Redis reales; banco propio (estudio, prefijo).
//
// Hallazgo que fija (rojo):
//  1. Para Dueño/Administrador la lista de clientes es una foto de la apertura (o de la última revalidación). Un cliente
//     creado con el stream abierto (crear cliente y "Verificar" en seguida, 007) no está en la foto: los eventos de sus
//     trabajos en los primeros ≤ 5 s se DESCARTAN (no se retrasan) y el panel nunca ve `en_cola`/`ejecutando`/
//     `completado` de ese trabajo hasta reconectar (CA-6: un evento por cambio de estado en ≤ 2 s). Antes de T14 el
//     alcance global los reenviaba todos.
import type { TrabajoVista } from "@contapp/shared";
import { publicarEvento } from "@contapp/queue";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoTrabajos,
  abrirSse,
  cerrarSseAbiertos,
  esEventoId,
  esperarSuscripcion,
  vistaCon,
  type BancoTrabajos,
} from "../../../test/soporte-trabajos.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const bancos: BancoTrabajos[] = [];

afterAll(async () => {
  cerrarSseAbiertos();
  for (const b of bancos) await b.cerrar().catch(() => undefined);
});

describe("SSE del Dueño y un cliente creado con el stream abierto (CA-6)", () => {
  it("el evento del trabajo de un cliente nuevo llega en ≤ 2 s", async () => {
    const b = await abrirBancoTrabajos();
    bancos.push(b);
    const E = await b.estudio();
    const [viejo] = await b.clientes(E.tenantId, 1);
    const previo = await b.sembrar(E.tenantId, viejo!, { creadoPor: E.titular.id });
    const s = await abrirSse(b.h, { cookie: E.titular.cookie, estudio: E.tenantId });
    expect(s.status).toBe(200);
    await esperarSuscripcion(b.redis, b.prefijo, E.tenantId);

    // El Dueño crea un cliente y encola en seguida (p. ej. "Verificar credencial" de 007).
    const [nuevo] = await b.clientes(E.tenantId, 1);
    const trabajo: TrabajoVista = await b.sembrar(E.tenantId, nuevo!, { creadoPor: E.titular.id });
    const tPublicado = Date.now();
    await publicarEvento(b.redis, E.tenantId, trabajo, { prefijo: b.prefijo });
    await publicarEvento(b.redis, E.tenantId, vistaCon(trabajo, { estado: "ejecutando", intentos: 0 }), {
      prefijo: b.prefijo,
    });
    // Control: el canal funciona para un cliente que ya existía al abrir.
    await publicarEvento(b.redis, E.tenantId, vistaCon(previo, { estado: "ejecutando", intentos: 0 }), {
      prefijo: b.prefijo,
    });
    expect(await s.esperar(esEventoId(previo.id), 2_000), "control").not.toBeNull();

    const llego = await s.esperar(esEventoId(trabajo.id), 2_000);
    s.cerrar();
    expect(
      llego,
      `se descartó el evento del cliente nuevo (publicado ${tPublicado - s.abiertoEn} ms después de abrir el stream)`,
    ).not.toBeNull();
  });
});
