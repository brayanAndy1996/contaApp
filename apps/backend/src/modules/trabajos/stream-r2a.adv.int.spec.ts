/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON dinámicos en pruebas adversariales */
// Spec 008 · T15a (ronda adversarial 2a): reintenta por otra vía las correcciones de H-008-1b-8 (alcance global del SSE
// como lista de clientes) y H-008-1a-1 (filtros de `GET /trabajos` con forma de arreglo). PG y Redis reales (base 15,
// prefijo propio del banco); el banco borra sus estudios y su prefijo.
//
// Hallazgo que fija (rojo):
//  1. (regresión de H-008-1b-8) Con alcance global, el SSE solo reenvía eventos de los clientes que había en el estudio
//     en la última revalidación (cada 5 s). Un cliente creado con el stream abierto (el Dueño lo da de alta y lanza su
//     primer trabajo enseguida) no recibe sus eventos hasta la siguiente revalidación y los que salieron antes se
//     pierden: CA-6 pide un evento por cambio de estado en ≤ 2 s.
import { publicarEvento } from "@contapp/queue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Estudio } from "../../../test/soporte-acceso.js";
import {
  abrirBancoTrabajos,
  abrirSse,
  cerrarSseAbiertos,
  esEventoId,
  esperarSuscripcion,
  vistaCon,
  type BancoTrabajos,
} from "../../../test/soporte-trabajos.js";

let b: BancoTrabajos;
let A: Estudio;
let cA: string[];

beforeAll(async () => {
  b = await abrirBancoTrabajos();
  A = await b.estudio();
  cA = await b.clientes(A.tenantId, 2);
}, 60_000);

afterAll(async () => {
  cerrarSseAbiertos();
  await b?.cerrar();
}, 60_000);

const cuerpo = (r: { status: number; body: any }) => ({ status: r.status, body: r.body });

describe("H-008-1b-8 por otra vía: cliente creado con el stream abierto (CA-6)", () => {
  it("el Dueño recibe en ≤ 2 s el evento del primer trabajo de un cliente dado de alta después de abrir el stream", async () => {
    const s = await abrirSse(b.h, { cookie: A.titular.cookie, estudio: A.tenantId });
    expect(s.status).toBe(200);
    const abierto = Date.now();
    await esperarSuscripcion(b.redis, b.prefijo, A.tenantId);
    // Alta del cliente y su primer trabajo (como hará 007 con "Verificar"), antes de la revalidación de los 5 s.
    const [nuevo] = await b.clientes(A.tenantId, 1);
    const T = await b.sembrar(A.tenantId, nuevo!, { creadoPor: A.titular.id });
    await publicarEvento(b.redis, A.tenantId, vistaCon(T, { estado: "ejecutando", intentos: 0 }), { prefijo: b.prefijo });
    const publicado = Date.now() - abierto;
    const llego = await s.esperar(esEventoId(T.id), 2000);
    // Control: un evento de un cliente que ya existía al abrir llega por el mismo stream.
    const previo = await b.sembrar(A.tenantId, cA[0]!, { creadoPor: A.titular.id });
    await publicarEvento(b.redis, A.tenantId, vistaCon(previo, { estado: "ejecutando", intentos: 0 }), { prefijo: b.prefijo });
    const control = await s.esperar(esEventoId(previo.id), 2000);
    s.cerrar();
    expect(
      { nuevo: llego !== null, control: control !== null },
      `evento publicado a los ${publicado} ms de abrir el stream (revalidación cada 5 s)`,
    ).toEqual({ nuevo: true, control: true });
  });
});

describe("H-008-1a-1 por otra vía: clave repetida en la query", () => {
  it("clienteId o estado repetidos (forma de arreglo sin corchetes) dan el error de un valor mal formado, no la lista", async () => {
    await b.sembrar(A.tenantId, cA[0]!, { creadoPor: A.titular.id });
    await b.sembrar(A.tenantId, cA[1]!, { creadoPor: A.titular.id });
    const clienteMal = cuerpo(await b.llamar(A.titular, "GET", "/trabajos?clienteId=no-es-uuid"));
    const estadoMal = cuerpo(await b.llamar(A.titular, "GET", "/trabajos?estado=no-es-estado"));
    const resumen = (r: { status: number; body: any }) =>
      r.status === 200 ? { status: 200, body: `lista de ${(r.body as any[]).length}` } : cuerpo(r);
    const respuestas = {
      clientes: resumen(await b.llamar(A.titular, "GET", `/trabajos?clienteId=${cA[0]}&clienteId=${cA[1]}`)),
      clienteDoble: resumen(await b.llamar(A.titular, "GET", `/trabajos?clienteId=${cA[0]}&clienteId=${cA[0]}`)),
      estados: resumen(await b.llamar(A.titular, "GET", "/trabajos?estado=en_cola&estado=error")),
    };
    expect(respuestas).toEqual({ clientes: clienteMal, clienteDoble: clienteMal, estados: estadoMal });
  });
});
