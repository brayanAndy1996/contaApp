/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 023 · T6 (rojo): POST /clientes/:clienteId/buzon/revisar, «Revisar buzón ahora» (D-6, P-6; CA-2, CA-9, CA-13).
// Contrato fijado por estas pruebas (módulo `buzon` de T13; errores `{codigo}`, `Cache-Control: no-store`):
//  - Rutas del módulo y permiso que declaran (`@Permiso`): POST …/buzon/revisar, GET …/buzon/mensajes, GET …/mensajes/:mensajeId y
//    GET …/mensajes/:mensajeId/adjuntos/:adjuntoId piden `buzon.ver`; POST …/mensajes/:mensajeId/abrir pide `buzon.marcar_leido`.
//    Todas cuelgan de `/clientes/:clienteId` (`ClienteScopeGuard`: ajeno, no asignado e inexistente dan el mismo 404).
//  - 202 `{ trabajo: TrabajoVista }` cuando la captura es nueva: fila `sol.buzon.revisar` (cola y canal `sol`, prioridad `interactivo`,
//    parámetros `{}`, `creado_por` = quien pulsó), pista en Redis tras el commit, `buzon_estado_cliente.ultima_solicitud_en` = ahora y
//    auditoría `buzon.captura_solicitada` (actor usuario, entidad `cliente`). No llama a SUNAT ni espera a nadie.
//  - 200 `{ trabajo }` con la captura viva del cliente (en cola o ejecutando, sea cual sea su origen): el mismo id, sin fila nueva.
//    Si estaba en cola como `programado` pasa a `interactivo` y su puntaje en Redis baja por debajo de todo programado; ejecutando no
//    cambia. El cuerpo de la petición se ignora.
//  - 409 `cliente_archivado` | `credencial_no_configurada` | `credencial_invalida` (SOL; en ese orden de precedencia); no encola, no
//    audita y no toca el estado.
//  - 429 `captura_reciente` + `Retry-After` (segundos enteros, ≤ 600) si no hay captura viva y la última solicitud bajo demanda o la
//    última captura terminada es de hace menos de 10 min. No encola, no audita, no toca `ultima_programada_en`: no cuenta contra la
//    frecuencia del plan.
//  - 50 pedidos (seguidos o simultáneos) dejan UN trabajo.
// Rojo: el módulo `buzon` aún no existe (T13): toda ruta responde 404 de ruta inexistente.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoBuzon,
  codigosErrorBuzon,
  cumple,
  DESPLAZAMIENTO_PROGRAMADO,
  rutasDeBuzon,
  type Actor,
  type BancoBuzon,
  type Estudio,
} from "../../../test/soporte-buzon.js";
import { forma } from "../../../test/soporte.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const REVISAR = "sol.buzon.revisar";
let b: BancoBuzon;
let E: Estudio;
let contador: Actor;
let asistente: Actor;
let lectura: Actor;

beforeAll(async () => {
  b = await abrirBancoBuzon();
  E = await b.estudio();
  const p = b.v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  lectura = await p.miembro(E.tenantId, "lectura");
});
afterAll(async () => {
  await b?.cerrar();
});

const ruta = (clienteId: string): string =>
  `/clientes/${clienteId}/buzon/revisar`;
const revisar = (a: Actor, clienteId: string, cuerpo?: unknown) =>
  b.llamar(a, "POST", ruta(clienteId), cuerpo);
const nuevo = (o: Parameters<BancoBuzon["cliente"]>[1] = {}, e: Estudio = E) =>
  b.cliente(e, {
    responsable: contador.id,
    colaboradores: [asistente.id, lectura.id],
    ...o,
  });
const retryAfter = (r: { headers: Record<string, unknown> }): number =>
  Number(r.headers["retry-after"]);

describe("contrato de rutas del módulo buzón (D-8, CA-9)", () => {
  it("las ocho rutas existen y declaran su permiso (buzon.ver; abrir, buzon.marcar_leido; atención de 024, buzon.atender)", () => {
    const rutas = rutasDeBuzon(b.v.b.c.p.b.h.app)
      .map((r) => `${r.metodo} ${r.ruta} ${r.permiso}`)
      .sort();
    expect(rutas).toEqual(
      [
        "GET /buzon/mensajes buzon.ver",
        "POST /buzon/atencion buzon.atender",
        "POST /clientes/:clienteId/buzon/mensajes/:mensajeId/atencion buzon.atender",
        "GET /clientes/:clienteId/buzon/mensajes buzon.ver",
        "GET /clientes/:clienteId/buzon/mensajes/:mensajeId buzon.ver",
        "GET /clientes/:clienteId/buzon/mensajes/:mensajeId/adjuntos/:adjuntoId buzon.ver",
        "POST /clientes/:clienteId/buzon/mensajes/:mensajeId/abrir buzon.marcar_leido",
        "POST /clientes/:clienteId/buzon/revisar buzon.ver",
      ].sort(),
    );
  });
});

describe("CA-2 · revisar encola una captura interactivo sin llamar a SUNAT", () => {
  it("202 { trabajo } nuevo: fila sol.buzon.revisar en cola, publicada en Redis, visible en el panel", async () => {
    const c = await nuevo();
    const r = await revisar(contador, c.id);
    expect(r.status, r.text).toBe(202);
    expect(Object.keys(r.body)).toEqual(["trabajo"]);
    expect(cumple("revisarBuzonRespuestaSchema", r.body)).toBe(true);
    expect(r.body.trabajo).toMatchObject({
      tipo: REVISAR,
      clienteId: c.id,
      estado: "en_cola",
      intentos: 0,
      creadoPor: { usuarioId: contador.id },
    });
    expect(r.ms).toBeLessThan(3000); // nada espera a SUNAT
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(r.headers["retry-after"]).toBeUndefined();

    const filas = await b.trabajos(c.id, REVISAR);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      id: r.body.trabajo.id,
      tenant_id: E.tenantId,
      cliente_id: c.id,
      tipo: REVISAR,
      cola: "sol",
      canal: "sol",
      prioridad: "interactivo",
      estado: "en_cola",
      intentos: 0,
      creado_por: contador.id,
      ruc: c.ruc,
    });
    expect(filas[0].parametros).toEqual({});
    const puntaje = await b.puntaje(E.tenantId, r.body.trabajo.id);
    expect(puntaje).not.toBeNull();
    expect(puntaje).toBeLessThan(DESPLAZAMIENTO_PROGRAMADO);

    const lista = await b.llamar(contador, "GET", "/trabajos");
    expect(lista.status, lista.text).toBe(200);
    const t = (lista.body as any[]).find((x) => x.id === r.body.trabajo.id);
    expect(t).toMatchObject({
      tipo: REVISAR,
      clienteId: c.id,
      estado: "en_cola",
    });
  });

  it("Dueño, contador, asistente y lectura asignados piden (buzon.ver basta); el cliente queda sin captura ni mensajes tocados", async () => {
    for (const a of [E.titular, contador, asistente, lectura]) {
      const c = await nuevo();
      const r = await revisar(a, c.id);
      expect(r.status, `${a.rol}: ${r.text}`).toBe(202);
      expect(r.body.trabajo.creadoPor).toEqual({ usuarioId: a.id });
      expect((await b.estado(c.id))?.ultima_captura_en ?? null).toBeNull();
    }
  });

  it("fija ultima_solicitud_en y deja en blanco la última captura y la franja programada (no cuenta contra el plan)", async () => {
    const c = await nuevo();
    const antes = Date.now();
    expect((await revisar(contador, c.id)).status).toBe(202);
    const e = await b.estado(c.id);
    expect(e).toBeTruthy();
    expect(
      Math.abs(new Date(e.ultima_solicitud_en).getTime() - antes),
    ).toBeLessThan(15_000);
    expect(e.ultima_captura_en).toBeNull();
    expect(e.ultima_programada_en).toBeNull();
  });

  it("audita buzon.captura_solicitada con usuario y cliente, sin datos del buzón", async () => {
    const c = await nuevo({ razonSocial: "CANARIO-razon-023" });
    const antes = (await b.auditoria(E.tenantId, "buzon.captura_solicitada"))
      .length;
    expect((await revisar(contador, c.id)).status).toBe(202);
    const filas = (
      await b.auditoria(E.tenantId, "buzon.captura_solicitada")
    ).filter((f) => f.cliente_id === c.id);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      actor_tipo: "usuario",
      usuario_id: contador.id,
      entidad: "cliente",
    });
    expect(
      (await b.auditoria(E.tenantId, "buzon.captura_solicitada")).length,
    ).toBe(antes + 1);
    const datos = JSON.stringify(filas[0].datos);
    for (const prohibido of [c.ruc, "CANARIO-razon-023"])
      expect(datos).not.toContain(prohibido);
  });

  it("la respuesta no deja ver el estudio, el RUC ni el creador técnico de la cola", async () => {
    const c = await nuevo();
    const r = await revisar(contador, c.id);
    expect(r.status).toBe(202);
    const texto = JSON.stringify(r.body);
    for (const prohibido of [E.tenantId, c.ruc])
      expect(texto).not.toContain(prohibido);
  });
});

describe("CA-2 · una sola captura viva por cliente: devuelve la existente, eleva la programada y no duplica", () => {
  it("el segundo pedido con la captura en cola devuelve 200 con el mismo trabajo y deja una fila", async () => {
    const c = await nuevo();
    const a = await revisar(contador, c.id);
    const o = await revisar(asistente, c.id);
    expect([a.status, o.status], `${a.text} ${o.text}`).toEqual([202, 200]);
    expect(cumple("revisarBuzonRespuestaSchema", o.body)).toBe(true);
    expect(o.body.trabajo.id).toBe(a.body.trabajo.id);
    expect(await b.trabajos(c.id, REVISAR)).toHaveLength(1);
    expect(o.headers["cache-control"]).toMatch(/no-store/);
  });

  it("50 pedidos simultáneos dejan UN trabajo: un 202, 49 × 200, la misma pista en Redis", async () => {
    const F = await b.estudio();
    const dueno = F.titular;
    const c = await b.cliente(F);
    const rs = await Promise.all(
      Array.from({ length: 50 }, () => revisar(dueno, c.id)),
    );
    expect(rs.map((r) => r.status).sort()).toEqual([
      ...Array(49).fill(200),
      202,
    ]);
    const ids = new Set(rs.map((r) => r.body.trabajo?.id));
    expect(ids.size).toBe(1);
    expect(await b.trabajos(c.id, REVISAR)).toHaveLength(1);
    expect(await b.v.b.redis.zcard(b.v.b.claves.pend("sol", F.tenantId))).toBe(
      1,
    );
  });

  it("50 pedidos seguidos dejan UN trabajo", async () => {
    const c = await nuevo();
    const estados: number[] = [];
    let id = "";
    for (let i = 0; i < 50; i++) {
      const r = await revisar(contador, c.id);
      estados.push(r.status);
      if (r.status >= 300) break; // rojo: la ruta no existe
      if (i === 0) id = r.body.trabajo.id;
      else expect(r.body.trabajo.id).toBe(id);
    }
    expect(estados).toEqual([202, ...Array(49).fill(200)]);
    expect(await b.trabajos(c.id, REVISAR)).toHaveLength(1);
  });

  it("una captura programada en cola pasa a interactivo sin duplicarse y su puntaje en Redis baja de 1e13", async () => {
    const c = await nuevo();
    const viva = await b.sembrarRevisarVivo(E.tenantId, c.id, {
      prioridad: "programado",
    });
    expect(await b.puntaje(E.tenantId, viva)).toBeGreaterThanOrEqual(
      DESPLAZAMIENTO_PROGRAMADO,
    );
    const r = await revisar(contador, c.id);
    expect(r.status, r.text).toBe(200);
    expect(r.body.trabajo.id).toBe(viva);
    expect(cumple("revisarBuzonRespuestaSchema", r.body)).toBe(true);
    const filas = await b.trabajos(c.id, REVISAR);
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({
      id: viva,
      prioridad: "interactivo",
      estado: "en_cola",
      creado_por: null,
    });
    expect(await b.puntaje(E.tenantId, viva)).toBeLessThan(
      DESPLAZAMIENTO_PROGRAMADO,
    );
  });

  it("en un estudio con 300 capturas programadas en cola, la bajo demanda sale antes que todas ellas", async () => {
    const F = await b.estudio();
    const relleno = await b.cliente(F);
    await b.sembrarProgramadosEnCola(F.tenantId, relleno.id, 300);
    expect(await b.v.b.redis.zcard(b.v.b.claves.pend("sol", F.tenantId))).toBe(
      300,
    );
    const c = await b.cliente(F);
    const r = await revisar(F.titular, c.id);
    expect(r.status, r.text).toBe(202);
    const primero = await b.v.b.redis.zrange(
      b.v.b.claves.pend("sol", F.tenantId),
      "0",
      "0",
    );
    expect(primero).toEqual([r.body.trabajo.id]);
  });

  it("una captura programada de un cliente elevada sale antes que las demás programadas del estudio", async () => {
    const F = await b.estudio();
    const otro = await b.cliente(F);
    await b.sembrarProgramadosEnCola(F.tenantId, otro.id, 20);
    const c = await b.cliente(F);
    const viva = await b.sembrarRevisarVivo(F.tenantId, c.id, {
      prioridad: "programado",
    });
    expect((await revisar(F.titular, c.id)).status).toBe(200);
    expect(
      await b.v.b.redis.zrange(b.v.b.claves.pend("sol", F.tenantId), "0", "0"),
    ).toEqual([viva]);
  });

  it("una captura ya ejecutándose se devuelve tal cual (200) y no se toca", async () => {
    const c = await nuevo();
    const viva = await b.sembrarRevisarVivo(E.tenantId, c.id, {
      prioridad: "programado",
      estado: "ejecutando",
    });
    const r = await revisar(contador, c.id);
    expect(r.status, r.text).toBe(200);
    expect(r.body.trabajo).toMatchObject({ id: viva, estado: "ejecutando" });
    const filas = await b.trabajos(c.id, REVISAR);
    expect(filas).toHaveLength(1);
    expect(filas[0].prioridad).toBe("programado");
  });

  it("el cuerpo se ignora: ni un clienteId ni parámetros cambian lo que se encola", async () => {
    const c = await nuevo();
    const otro = await nuevo();
    const r = await revisar(contador, c.id, {
      clienteId: otro.id,
      tenantId: randomUUID(),
      parametros: { x: 1 },
    });
    expect(r.status, r.text).toBe(202);
    expect(await b.trabajos(otro.id, REVISAR)).toHaveLength(0);
    const filas = await b.trabajos(c.id, REVISAR);
    expect(filas).toHaveLength(1);
    expect(filas[0].parametros).toEqual({});
  });
});

describe("D-6 · 409 por cliente archivado o credencial SOL no lista", () => {
  const sinEfectos = async (c: { id: string }): Promise<void> => {
    expect(await b.trabajos(c.id, REVISAR)).toHaveLength(0);
    expect(
      (await b.auditoria(E.tenantId, "buzon.captura_solicitada")).filter(
        (f) => f.cliente_id === c.id,
      ),
    ).toHaveLength(0);
    expect((await b.estado(c.id))?.ultima_solicitud_en ?? null).toBeNull();
  };

  it("cliente archivado: 409 cliente_archivado", async () => {
    const c = await nuevo({ archivado: true });
    const r = await revisar(contador, c.id);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    await sinEfectos(c);
  });

  it("credencial SOL no configurada: 409 credencial_no_configurada (la de SIRE no cuenta)", async () => {
    const c = await nuevo({ sol: "no_configurada", sireApi: "verificada" });
    const r = await revisar(contador, c.id);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "credencial_no_configurada" });
    await sinEfectos(c);
  });

  it("credencial SOL inválida: 409 credencial_invalida", async () => {
    const c = await nuevo({ sol: "invalida" });
    const r = await revisar(contador, c.id);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "credencial_invalida" });
    await sinEfectos(c);
  });

  it("configurada (sin verificar) basta para pedir", async () => {
    const c = await nuevo({ sol: "configurada" });
    expect((await revisar(contador, c.id)).status).toBe(202);
  });

  it("archivado y sin credencial: gana cliente_archivado", async () => {
    const c = await nuevo({ archivado: true, sol: "no_configurada" });
    const r = await revisar(contador, c.id);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
  });

  it("los códigos 409 y 429 son de CODIGOS_ERROR_BUZON y el cuerpo cumple errorBuzonSchema", async () => {
    const c = await nuevo({ archivado: true });
    const r = await revisar(contador, c.id);
    expect(r.status, r.text).toBe(409);
    expect(codigosErrorBuzon()).toEqual(
      expect.arrayContaining(["cliente_archivado", "captura_reciente"]),
    );
    expect(cumple("errorBuzonSchema", r.body)).toBe(true);
  });

  it("CA-13 · archivado con la captura programada en cola: no se devuelve ni se eleva, es 409", async () => {
    const c = await nuevo({ archivado: true });
    const viva = await b.sembrarRevisarVivo(E.tenantId, c.id, {
      prioridad: "programado",
    });
    const r = await revisar(contador, c.id);
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "cliente_archivado" });
    expect((await b.trabajos(c.id, REVISAR))[0]).toMatchObject({
      id: viva,
      prioridad: "programado",
    });
  });
});

describe("P-6 · enfriamiento de 10 min por cliente: 429 captura_reciente con Retry-After", () => {
  it("con la captura terminada a los pocos segundos de la solicitud: 429, Retry-After ≈ 600 s, nada nuevo", async () => {
    const c = await nuevo();
    const a = await revisar(contador, c.id);
    expect(a.status, a.text).toBe(202);
    await b.terminar(a.body.trabajo.id);
    const r = await revisar(asistente, c.id);
    expect(r.status, r.text).toBe(429);
    expect(r.body).toEqual({ codigo: "captura_reciente" });
    expect(cumple("errorBuzonSchema", r.body)).toBe(true);
    expect(retryAfter(r)).toBeGreaterThan(500);
    expect(retryAfter(r)).toBeLessThanOrEqual(600);
    expect(Number.isInteger(retryAfter(r))).toBe(true);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(await b.trabajos(c.id, REVISAR)).toHaveLength(1);
    expect(
      (await b.auditoria(E.tenantId, "buzon.captura_solicitada")).filter(
        (f) => f.cliente_id === c.id,
      ),
    ).toHaveLength(1);
  });

  it("la última captura terminada hace 9 min: 429 con Retry-After de 1 a ~60 s y sin tocar ultima_solicitud_en", async () => {
    const c = await nuevo();
    await b.sembrarEstado(E.tenantId, c.id, { capturaHace: 9 });
    const r = await revisar(contador, c.id);
    expect(r.status, r.text).toBe(429);
    expect(r.body).toEqual({ codigo: "captura_reciente" });
    expect(retryAfter(r)).toBeGreaterThanOrEqual(1);
    expect(retryAfter(r)).toBeLessThanOrEqual(65);
    expect((await b.estado(c.id)).ultima_solicitud_en).toBeNull();
    expect(await b.trabajos(c.id, REVISAR)).toHaveLength(0);
  });

  it("la última solicitud hace 9 min (sin captura): 429", async () => {
    const c = await nuevo();
    await b.sembrarEstado(E.tenantId, c.id, { solicitudHace: 9 });
    const r = await revisar(contador, c.id);
    expect(r.status, r.text).toBe(429);
    expect(r.body).toEqual({ codigo: "captura_reciente" });
  });

  it("cuenta la más reciente de las dos: solicitud hace 11 min y captura hace 2 min es 429", async () => {
    const c = await nuevo();
    await b.sembrarEstado(E.tenantId, c.id, {
      solicitudHace: 11,
      capturaHace: 2,
    });
    const r = await revisar(contador, c.id);
    expect(r.status, r.text).toBe(429);
    expect(retryAfter(r)).toBeGreaterThan(400);
  });

  it("pasados 10 min de ambas: 202 y se registra la nueva solicitud", async () => {
    const c = await nuevo();
    await b.sembrarEstado(E.tenantId, c.id, {
      solicitudHace: 11,
      capturaHace: 12,
    });
    const r = await revisar(contador, c.id);
    expect(r.status, r.text).toBe(202);
    const e = await b.estado(c.id);
    expect(Date.now() - new Date(e.ultima_solicitud_en).getTime()).toBeLessThan(
      30_000,
    );
  });

  it("una captura programada reciente (franja consumida) no frena la bajo demanda: solo cuentan solicitud y captura terminada", async () => {
    const c = await nuevo();
    await b.sembrarEstado(E.tenantId, c.id, { programadaHace: 1 });
    const r = await revisar(contador, c.id);
    expect(r.status, r.text).toBe(202);
  });

  it("la captura viva gana al enfriamiento: con solicitud de hace 1 min y trabajo en cola, 200 y no 429", async () => {
    const c = await nuevo();
    const viva = await b.sembrarRevisarVivo(E.tenantId, c.id, {
      prioridad: "interactivo",
    });
    await b.sembrarEstado(E.tenantId, c.id, { solicitudHace: 1 });
    const r = await revisar(contador, c.id);
    expect(r.status, r.text).toBe(200);
    expect(r.body.trabajo.id).toBe(viva);
  });

  it("el enfriamiento es por cliente: otro cliente del mismo estudio pide sin problema", async () => {
    const c1 = await nuevo();
    const c2 = await nuevo();
    await b.sembrarEstado(E.tenantId, c1.id, { solicitudHace: 1 });
    expect((await revisar(contador, c1.id)).status).toBe(429);
    expect((await revisar(contador, c2.id)).status).toBe(202);
  });
});

describe("CA-9 · permisos y alcance: el mismo 404 para ajeno, no asignado e inexistente", () => {
  it("el contador no asignado recibe el mismo 404 que un cliente inexistente y no se encola nada", async () => {
    const ajeno = await b.cliente(E); // sin responsable
    const r = await revisar(contador, ajeno.id);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(forma(r)).toEqual(forma(await revisar(contador, randomUUID())));
    expect(await b.trabajos(ajeno.id, REVISAR)).toHaveLength(0);
    expect((await revisar(E.titular, ajeno.id)).status).toBe(202); // control: la ruta existe
  });

  it("otro estudio: el cliente de E es un 404 para el Dueño de F y no se encola nada", async () => {
    const F = await b.estudio();
    const c = await nuevo();
    expect((await revisar(E.titular, c.id)).status).toBe(202); // control: la ruta existe
    const r = await revisar(F.titular, c.id);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(forma(r)).toEqual(forma(await revisar(F.titular, randomUUID())));
    expect(await b.trabajos(c.id, REVISAR)).toHaveLength(1); // solo el del control
  });

  it("un id mal formado en la ruta es un 404 igual que uno inexistente", async () => {
    expect((await revisar(contador, (await nuevo()).id)).status).toBe(202); // control: la ruta existe
    const mal = await revisar(contador, "no-es-un-uuid");
    expect(mal.status).toBe(404);
    expect(mal.body).toEqual({ codigo: "no_encontrado" });
  });

  it("un usuario de otro estudio con el X-Estudio de E no entra: no hay 2xx ni trabajo", async () => {
    const F = await b.estudio();
    const c = await nuevo();
    expect((await revisar(contador, c.id)).status).toBe(202); // control: la ruta existe
    const r = await revisar({ ...F.titular, tenantId: E.tenantId }, c.id);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(await b.trabajos(c.id, REVISAR)).toHaveLength(1); // solo el del control
  });

  it("sin sesión: 401 y no se encola nada", async () => {
    const c = await nuevo();
    expect((await revisar(contador, c.id)).status).toBe(202); // control: la ruta existe
    const r = await b.sinSesion("POST", ruta(c.id));
    expect(r.status, r.text).toBe(401);
    expect(await b.trabajos(c.id, REVISAR)).toHaveLength(1); // solo el del control
  });
});
