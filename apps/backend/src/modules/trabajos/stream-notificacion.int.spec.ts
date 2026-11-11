/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 017 (T5, rojo): aviso en vivo de notificaciones por `GET /trabajos/stream` (D-9, D-11; CA-8, CA-10, CA-12). PG y Redis reales.
// Contrato (plan 017, «Aviso en vivo»; lo implementa T10 en `StreamService.recibir` y en los servicios que consumen cupo):
//  - Los avisos viajan por el mismo canal `eventos:{tenantId}` que los eventos de trabajo, con la forma estricta
//    `{ evento: "notificacion", destinatarios: uuid[1..200] }` (`avisoNotificacionSchema`, sin contenido). Una forma distinta
//    (claves de más, lista vacía, otro `evento`) se descarta en silencio, sin cerrar el stream.
//  - `StreamService.recibir` escribe `event: notificacion\ndata: {}\n\n` SOLO a las conexiones cuyo `usuarioId` está en
//    `destinatarios`: el cuerpo es siempre `{}` (ni los destinatarios, ni el tipo, ni el cliente). Cada conexión del destinatario
//    (varias pestañas) lo recibe; otro usuario del estudio no recibe nada. Los eventos de trabajo siguen igual (`event: trabajo`).
//  - Alta de cliente, importación, reactivación; invitar y reactivar miembros: tras el COMMIT del hecho, el backend publica el aviso
//    con lo que devolvió `destinatariosNuevos` dentro de la transacción (los Dueños activos al cruzar el 90 % o el 100 % de RUCs o de
//    usuarios). Si no hubo notificación nueva (no cruzó, se revirtió) no publica nada. Al recibir el aviso, la notificación ya se lee
//    por `GET /notificaciones` (se publica después del commit, nunca antes).
// Rojo: el stream aún no reenvía `notificacion` y los servicios no publican (T10).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Actor } from "../../../test/soporte-acceso.js";
import { abrirBancoCola, rucValido, type BancoCola, type Estudio } from "../../../test/soporte-credenciales.js";
import { limpiarAvisosDeEstudios } from "../../../test/soporte-notificaciones.js";
import {
  abrirSse,
  cerrarSseAbiertos,
  emitir,
  emitirCrudo,
  esperarSuscripcion,
  observarEventos,
  sembrarTrabajo,
  vistaCon,
  type ClienteSse,
  type Observador,
} from "../../../test/soporte-trabajos.js";

let b: BancoCola;
let E: Estudio;
let F: Estudio;
let contador: Actor;
let clienteE: string;
const tenants: string[] = [];
const observadores: Observador[] = [];

beforeAll(async () => {
  b = await abrirBancoCola();
  E = await b.estudio();
  F = await b.estudio();
  tenants.push(E.tenantId, F.tenantId);
  contador = await b.c.p.b.miembro(E.tenantId, "contador");
  clienteE = (await b.c.sembrar(E.tenantId, { responsable: contador.id })).id;
});
afterEach(async () => {
  // Máximo 3 streams por sesión (008): cada prueba cierra los suyos y deja que el servidor libere el cupo.
  cerrarSseAbiertos();
  await new Promise((r) => setTimeout(r, 250));
});
afterAll(async () => {
  cerrarSseAbiertos();
  for (const o of observadores) o.cerrar();
  if (b) await limpiarAvisosDeEstudios(tenants);
  await b?.cerrar();
});

const h = () => b.c.p.b.h;
const abrir = async (a: Pick<Actor, "cookie" | "tenantId">): Promise<ClienteSse> => {
  const s = await abrirSse(h(), { cookie: a.cookie, estudio: a.tenantId });
  expect(s.status, JSON.stringify(s.cuerpo)).toBe(200);
  return s;
};
const aviso = (tenantId: string, destinatarios: string[], extra: Record<string, unknown> = {}) =>
  emitirCrudo(b.redis, b.prefijo, tenantId, JSON.stringify({ evento: "notificacion", destinatarios, ...extra }));
const esNotificacion = (e: { evento: string }) => e.evento === "notificacion";
const pausa = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const observar = async (tenantId: string): Promise<Observador> => {
  const o = await observarEventos(b.prefijo, tenantId);
  observadores.push(o);
  return o;
};
const llamar = (a: Actor, m: "GET" | "POST", ruta: string, cuerpo?: unknown) => b.c.p.b.llamar(a, m, ruta, cuerpo);

describe("CA-12 · el SSE avisa solo al destinatario y sin contenido", () => {
  it("el destinatario recibe «event: notificacion» con «data: {}» exacto y otro usuario del estudio no recibe nada", async () => {
    const destinatario = await abrir(E.titular);
    const otro = await abrir(contador);
    await esperarSuscripcion(b.redis, b.prefijo, E.tenantId);
    await aviso(E.tenantId, [E.titular.id]);
    const e = await destinatario.esperar(esNotificacion, 2500);
    expect(e, "el destinatario no recibió el aviso").not.toBeNull();
    expect(e!.datos).toBe("{}");
    expect(destinatario.texto).toContain("event: notificacion\ndata: {}\n\n");
    // Sin contenido: ni el id del destinatario, ni la lista, ni el estudio.
    for (const prohibido of [E.titular.id, "destinatarios", E.tenantId, "plan_limite", "params"])
      expect(destinatario.texto.split("event: notificacion")[1], prohibido).not.toContain(prohibido);
    await pausa(800);
    expect(otro.eventos.filter(esNotificacion)).toEqual([]);
    expect(otro.texto).not.toContain("notificacion");
    expect(otro.cerrado).toBe(false);
  });

  it("con varios destinatarios cada uno lo recibe, y quien no figura no; cada pestaña (conexión) del destinatario lo recibe", async () => {
    const pestana1 = await abrir(E.titular);
    const pestana2 = await abrir(E.titular);
    const otroDestinatario = await abrir(contador);
    const nuevo = await b.c.p.b.miembro(E.tenantId, "lectura");
    const ajeno = await abrir(nuevo);
    await esperarSuscripcion(b.redis, b.prefijo, E.tenantId);
    await aviso(E.tenantId, [E.titular.id, contador.id]);
    for (const s of [pestana1, pestana2, otroDestinatario]) expect(await s.esperar(esNotificacion, 2500), "falta un aviso").not.toBeNull();
    await pausa(800);
    expect(ajeno.eventos.filter(esNotificacion)).toEqual([]);
  });

  it("un aviso para usuarios de otro estudio, o publicado en el canal de otro estudio, no llega a nadie de este", async () => {
    const dueno = await abrir(E.titular);
    await esperarSuscripcion(b.redis, b.prefijo, E.tenantId);
    await aviso(E.tenantId, [F.titular.id]); // destinatario que no es de este estudio
    await aviso(F.tenantId, [E.titular.id]); // canal de otro estudio con el id de este usuario
    await pausa(900);
    expect(dueno.eventos.filter(esNotificacion)).toEqual([]);
    await aviso(E.tenantId, [E.titular.id]); // control: el aviso válido sí llega
    expect(await dueno.esperar(esNotificacion, 2500)).not.toBeNull();
  });

  it.each([
    ["lista vacía", { evento: "notificacion", destinatarios: [] }],
    ["sin destinatarios", { evento: "notificacion" }],
    ["destinatarios que no son uuid", { evento: "notificacion", destinatarios: ["nadie"] }],
    ["otro evento", { evento: "otra", destinatarios: ["USUARIO"] }],
    ["con contenido (tipo y params)", { evento: "notificacion", destinatarios: ["USUARIO"], tipo: "plan_limite", params: { recurso: "rucs" } }],
    ["con tenantId", { evento: "notificacion", destinatarios: ["USUARIO"], tenantId: "T" }],
  ])("un aviso mal formado (%s) se descarta sin cerrar el stream y el siguiente válido llega", async (_n, cuerpo) => {
    const dueno = await abrir(E.titular);
    await esperarSuscripcion(b.redis, b.prefijo, E.tenantId);
    const texto = JSON.stringify(cuerpo).replace("USUARIO", E.titular.id).replace('"T"', JSON.stringify(E.tenantId));
    await emitirCrudo(b.redis, b.prefijo, E.tenantId, texto);
    await emitirCrudo(b.redis, b.prefijo, E.tenantId, "no es json");
    await pausa(900);
    expect(dueno.eventos.filter(esNotificacion)).toEqual([]);
    expect(dueno.cerrado).toBe(false);
    await aviso(E.tenantId, [E.titular.id]);
    expect(await dueno.esperar(esNotificacion, 2500)).not.toBeNull();
  });

  it("convive con los eventos de trabajo: el trabajo sigue saliendo como «event: trabajo»", async () => {
    const dueno = await abrir(E.titular);
    await esperarSuscripcion(b.redis, b.prefijo, E.tenantId);
    const t = await sembrarTrabajo(h(), E.tenantId, clienteE, { creadoPor: E.titular.id }, { redis: b.redis, prefijo: b.prefijo });
    await emitir(b.redis, b.prefijo, E.tenantId, vistaCon(t, { estado: "ejecutando", intentos: 1, iniciadoEn: new Date().toISOString() }));
    await aviso(E.tenantId, [E.titular.id]);
    expect(await dueno.esperar((e) => e.evento === "trabajo" && e.json?.id === t.id, 2500)).not.toBeNull();
    expect(await dueno.esperar(esNotificacion, 2500)).not.toBeNull();
  });
});

describe("CA-10 · el backend publica el aviso tras el commit de un alta que cruza el 90 % de RUCs", () => {
  it("el alta que llega a 9 de 10 avisa a los Dueños (no al Administrador ni al Contador) con el aviso sin contenido, y la notificación ya se lee", async () => {
    const e = await b.estudioCon(10);
    tenants.push(e.tenantId);
    const dueno2 = await b.c.p.b.miembro(e.tenantId, "dueno");
    const admin = await b.c.p.b.miembro(e.tenantId, "admin");
    const cont = await b.c.p.b.miembro(e.tenantId, "contador");
    for (let i = 0; i < 8; i++) await b.c.sembrar(e.tenantId, {});
    const sD1 = await abrir(e.titular);
    const sD2 = await abrir(dueno2);
    const sAdmin = await abrir(admin);
    const sCont = await abrir(cont);
    const obs = await observar(e.tenantId);
    await esperarSuscripcion(b.redis, b.prefijo, e.tenantId);

    const alta = await b.c.crear(admin, { ruc: rucValido(), razonSocial: "Noveno Cliente SAC" });
    expect(alta.status, alta.text).toBe(201);

    const msg = await obs.esperar((m) => m.evento === "notificacion", 2500);
    expect(msg, "el backend no publicó el aviso tras el alta").not.toBeNull();
    expect(Object.keys(msg).sort()).toEqual(["destinatarios", "evento"]);
    expect([...msg.destinatarios].sort()).toEqual([e.titular.id, dueno2.id].sort());
    // Los dos Dueños reciben el aviso en vivo, y la notificación ya existe cuando llega (se publicó tras el commit).
    for (const [s, a] of [[sD1, e.titular], [sD2, dueno2]] as const) {
      const ev = await s.esperar(esNotificacion, 2500);
      expect(ev, `${a.id} no recibió el aviso`).not.toBeNull();
      expect(ev!.datos).toBe("{}");
      const lista = await llamar(a, "GET", "/notificaciones");
      expect(lista.status, lista.text).toBe(200);
      const plan = lista.body.items.filter((x: any) => x.tipo === "plan_limite");
      expect(plan).toHaveLength(1);
      expect(plan[0]).toMatchObject({ cliente: null, trabajoId: null, leidaEn: null, params: { recurso: "rucs", umbral: 90, usado: 9, limite: 10 } });
    }
    await pausa(800);
    for (const s of [sAdmin, sCont]) expect(s.eventos.filter(esNotificacion)).toEqual([]);
    expect((await llamar(admin, "GET", "/notificaciones")).body.items).toEqual([]);
    expect((await llamar(cont, "GET", "/notificaciones")).body.items).toEqual([]);
  });

  it("un alta que no cruza el umbral no publica nada; llegar a 10 de 10 avisa otra vez; el 11.º (409 cupo_rucs) no publica", async () => {
    const e = await b.estudioCon(10);
    tenants.push(e.tenantId);
    for (let i = 0; i < 5; i++) await b.c.sembrar(e.tenantId, {});
    const sD = await abrir(e.titular);
    const obs = await observar(e.tenantId);
    await esperarSuscripcion(b.redis, b.prefijo, e.tenantId);
    const mensajes = () => obs.mensajes.filter((m) => m.evento === "notificacion");

    expect((await b.c.crear(e.titular, { ruc: rucValido(), razonSocial: "Sexto SAC" })).status).toBe(201); // 6 de 10: no cruza
    await pausa(900);
    expect(mensajes()).toEqual([]);
    expect(sD.eventos.filter(esNotificacion)).toEqual([]);

    for (let i = 0; i < 3; i++) expect((await b.c.crear(e.titular, { ruc: rucValido(), razonSocial: `Cliente ${i} SAC` })).status).toBe(201); // 9 de 10
    expect(await obs.esperar((m) => m.evento === "notificacion", 2500)).not.toBeNull();
    expect(mensajes()).toHaveLength(1);

    expect((await b.c.crear(e.titular, { ruc: rucValido(), razonSocial: "Décimo SAC" })).status).toBe(201); // 10 de 10
    await pausa(1200);
    expect(mensajes()).toHaveLength(2);
    const lista = await llamar(e.titular, "GET", "/notificaciones");
    expect(lista.body.items.map((x: any) => x.params.umbral).sort()).toEqual([100, 90]);
    expect(lista.body.items.every((x: any) => x.params.limite === 10)).toBe(true);

    const rechazado = await b.c.crear(e.titular, { ruc: rucValido(), razonSocial: "Undécimo SAC" });
    expect(rechazado.status, rechazado.text).toBe(409);
    expect(rechazado.body).toEqual({ codigo: "cupo_rucs" });
    await pausa(900);
    expect(mensajes()).toHaveLength(2);
    expect((await llamar(e.titular, "GET", "/notificaciones")).body.items).toHaveLength(2);
  });

  it("invitar al usuario que cruza el 90 % de usuarios también avisa a los Dueños tras el commit", async () => {
    const plan = await b.c.p.plan({ maxRucs: 50, maxUsuarios: 10 });
    const e = await b.c.p.estudio(plan);
    tenants.push(e.tenantId);
    await b.c.p.b.miembrosMasivos(e.tenantId, 7, "lectura"); // 1 Dueño + 7 = 8 de 10
    const sD = await abrir(e.titular);
    const obs = await observar(e.tenantId);
    await esperarSuscripcion(b.redis, b.prefijo, e.tenantId);

    const { r } = await b.c.p.b.invitar(e.titular, b.c.p.b.correoNuevo(), "lectura"); // 9 de 10
    expect(r.status, r.text).toBe(201);
    const msg = await obs.esperar((m) => m.evento === "notificacion", 2500);
    expect(msg, "invitar no publicó el aviso").not.toBeNull();
    expect(msg.destinatarios).toEqual([e.titular.id]);
    expect(await sD.esperar(esNotificacion, 2500)).not.toBeNull();
    const lista = await llamar(e.titular, "GET", "/notificaciones");
    expect(lista.body.items).toHaveLength(1);
    expect(lista.body.items[0]).toMatchObject({ tipo: "plan_limite", cliente: null, params: { recurso: "usuarios", umbral: 90, usado: 9, limite: 10 } });
  });
});
