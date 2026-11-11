/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 017 (T5, rojo): API de notificaciones (D-8, D-10, D-11; P-3, P-5, P-7; CA-4, CA-11, CA-12). PG real.
// Contrato (plan 017, «Contratos: HTTP» y shared; lo implementa T10 sobre las tablas de T7 y los repositorios de T8):
//  - Las cuatro rutas son `@SoloEstudio` (cualquier miembro activo del estudio, sin permiso aparte) y responden `Cache-Control: no-store`.
//  - `GET /notificaciones?cursor=` -> 200 `{ items, siguiente }`: SOLO las del usuario de la sesión, de la más nueva a la más vieja por
//    `(creada_en, id)` desc, a lo sumo 50; `siguiente` es un cursor OPACO (texto) o `null` en la última página. Cada item lleva
//    exactamente `{ id, tipo, creadaEn, leidaEn, cliente: { id, razonSocial } | null, trabajoId, params }`: nunca `tenantId`,
//    `usuarioId` ni `claveDedupe`. Un cursor mal formado, o cualquier consulta fuera de `cursor` (`usuarioId`, `tenantId`, `clienteId`,
//    `limite`), es 400 `{ codigo: "solicitud_invalida" }`.
//  - `GET /notificaciones/no-leidas` -> 200 `{ noLeidas }` con tope 100 (100 se muestra «99+»); cuenta solo las propias, no leídas y visibles.
//  - `POST /notificaciones/leidas` `{ hasta: ISO }` (estricto) -> 200 `{ marcadas }`: marca las propias, visibles y no leídas con
//    `creada_en <= hasta`. Cuerpo sin `hasta`, `hasta` inválido o con claves extra (`usuarioId`, `tenantId`) = 400 y no cambia nada.
//  - `POST /notificaciones/:id/leida` -> 204 sin cuerpo (idempotente: la segunda vez no cambia `leida_en`). Una notificación de otro
//    usuario, de otro estudio, de un cliente no visible (D-10, CA-11), inexistente o con id mal formado es el MISMO 404
//    `{ codigo: "no_encontrado" }` y no cambia nada. Un cuerpo con claves (`usuarioId`) es 400.
//  - Las visibles respetan `filtroAlcance` de 005 sobre `cliente_id` no nulo: Dueño y Administrador ven todo el estudio; los demás roles,
//    solo los clientes que tienen asignados. Una desasignación oculta al instante (sin borrar nada); reasignar la devuelve.
// Cada 404 se acompaña del control positivo (el dueño real recibe 204) para que una ruta inexistente no pase por 404 de ruta.
// Rojo: las rutas aún no existen (T10): 404 de ruta. Las pruebas que siembran filas fallan además por la tabla `notificacion` (T7).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirBanco, type Actor, type Banco, type Estudio, type RolSistema } from "../../../test/soporte-acceso.js";
import {
  CLAVES_INTERNAS,
  esNoStore,
  limpiarAvisosDeEstudios,
  sembrarNotificacion,
  sembrarNotificaciones,
} from "../../../test/soporte-notificaciones.js";
import type { Resp } from "../../../test/soporte.js";

let b: Banco;
let E: Estudio;
let F: Estudio;
let c0: string; // cliente asignado a asistente y lectura
let c1: string; // cliente sin asignaciones
let cF: string; // cliente del otro estudio

beforeAll(async () => {
  b = await abrirBanco();
  E = await b.estudio();
  F = await b.estudio();
  [c0, c1] = (await b.clientes(E.tenantId, 2)) as [string, string];
  [cF] = (await b.clientes(F.tenantId, 1)) as [string];
});
afterAll(async () => {
  if (b) await limpiarAvisosDeEstudios([E?.tenantId, F?.tenantId].filter((t): t is string => typeof t === "string"));
  await b?.cerrar();
});

const sql = <T = any>(t: string, v?: unknown[]) => b.sql<T>(t, v);
const get = (a: Actor, ruta: string) => b.llamar(a, "GET", ruta);
const post = (a: Actor, ruta: string, cuerpo?: unknown) => b.llamar(a, "POST", ruta, cuerpo);
/** Miembro nuevo de E (cada prueba usa el suyo: así ninguna ve las notificaciones de otra). */
const nuevo = async (rol: RolSistema, asignadoA: string[] = []): Promise<Actor> => {
  const a = await b.miembro(E.tenantId, rol);
  for (const c of asignadoA) await b.asignar(E.tenantId, c, a.id, "colaborador");
  // Antes de sembrar nada: la ruta debe existir (así el rojo es «ruta ausente» y no «tabla ausente»).
  const sonda = await get(a, "/notificaciones");
  expect(sonda.status, `GET /notificaciones no responde 200 (¿ruta ausente?): ${sonda.text}`).toBe(200);
  return a;
};
const propias = (a: Actor, o: Partial<Parameters<typeof sembrarNotificacion>[1]> = {}) =>
  sembrarNotificacion(sql, { tenantId: a.tenantId, usuarioId: a.id, ...o });
const leidaEn = async (id: string): Promise<string | null> => {
  const f = await sql("select leida_en::text as l from notificacion where id = $1", [id]);
  return f[0]?.l ?? null;
};
/** El DTO nunca expone las columnas internas. */
const sinInternos = (r: Resp): void => {
  for (const clave of CLAVES_INTERNAS) expect(r.text, clave).not.toContain(clave);
};
const lista = async (a: Actor, consulta = ""): Promise<Resp> => {
  const r = await get(a, `/notificaciones${consulta}`);
  expect(r.status, r.text).toBe(200);
  return r;
};
const ids = (r: Resp): string[] => (r.body.items as any[]).map((x) => x.id);
const noLeidas = async (a: Actor): Promise<number> => {
  const r = await get(a, "/notificaciones/no-leidas");
  expect(r.status, r.text).toBe(200);
  return r.body.noLeidas;
};

describe("CA-12 · GET /notificaciones: forma, orden y propiedad", () => {
  it("sin notificaciones: 200 { items: [], siguiente: null } y no-store", async () => {
    const a = await nuevo("contador");
    const r = await lista(a);
    expect(r.body).toEqual({ items: [], siguiente: null });
    expect(esNoStore(r.headers["cache-control"])).toBe(true);
  });

  it("de la más nueva a la más vieja, con la forma exacta del DTO y sin columnas internas", async () => {
    const a = await nuevo("dueno");
    await sql("update cliente set razon_social = 'SAN JUAN SAC T5' where id = $1", [c0]);
    const vieja = await propias(a, { hace: 300, clienteId: c0 });
    const media = await propias(a, { hace: 200, tipo: "trabajo_terminado", clienteId: c1 });
    const nueva = await propias(a, { hace: 100, tipo: "plan_limite" });
    const r = await lista(a);
    expect(ids(r)).toEqual([nueva.id, media.id, vieja.id]);
    expect(r.body.siguiente).toBeNull();
    expect(esNoStore(r.headers["cache-control"])).toBe(true);
    for (const x of r.body.items) {
      expect(Object.keys(x).sort()).toEqual(["cliente", "creadaEn", "id", "leidaEn", "params", "tipo", "trabajoId"]);
      expect(x.leidaEn).toBeNull();
    }
    const [n, m, v] = r.body.items;
    expect(n).toMatchObject({ tipo: "plan_limite", cliente: null, trabajoId: null, params: { recurso: "rucs", umbral: 90, usado: 9, limite: 10 } });
    expect(m).toMatchObject({ tipo: "trabajo_terminado", cliente: { id: c1 }, params: { tipoTrabajo: "sire.propuesta.descargar", estado: "completado", motivo: null } });
    expect(typeof m.trabajoId).toBe("string");
    expect(v).toMatchObject({ tipo: "credencial_invalida", cliente: { id: c0, razonSocial: "SAN JUAN SAC T5" }, params: { credencial: "sol" } });
    expect(Object.keys(v.cliente).sort()).toEqual(["id", "razonSocial"]);
    expect(v.creadaEn).toBe(vieja.creadaEn);
    sinInternos(r);
  });

  it("una leída trae su instante en leidaEn", async () => {
    const a = await nuevo("contador");
    await propias(a, { hace: 120, leida: true });
    const r = await lista(a);
    expect(Number.isNaN(Date.parse(r.body.items[0].leidaEn))).toBe(false);
  });

  it("solo las propias: otro usuario del estudio y otro estudio no ven ni cuentan las ajenas", async () => {
    const a = await nuevo("contador");
    const otro = await nuevo("contador");
    const x = await propias(a, { hace: 10 });
    await sembrarNotificacion(sql, { tenantId: F.tenantId, usuarioId: F.titular.id, clienteId: cF, hace: 10 });
    expect(ids(await lista(a))).toEqual([x.id]);
    expect((await lista(otro)).body).toEqual({ items: [], siguiente: null });
    expect(await noLeidas(otro)).toBe(0);
    const delOtroEstudio = await lista(F.titular);
    expect(ids(delOtroEstudio)).not.toContain(x.id);
    expect(delOtroEstudio.text).not.toContain(a.id);
  });
});

describe("CA-12 · cursor y página de 50", () => {
  it("52 notificaciones con 4 empatadas en el corte: dos páginas (50 y 2), sin repetir ni saltar, con cursor opaco", async () => {
    const a = await nuevo("dueno");
    const esperadas = await sembrarNotificaciones(sql, { tenantId: E.tenantId, usuarioId: a.id, n: 52, empates: 4 });
    expect(esperadas).toHaveLength(52);
    const p1 = await lista(a);
    expect(p1.body.items).toHaveLength(50);
    expect(typeof p1.body.siguiente).toBe("string");
    expect(p1.body.siguiente).not.toMatch(/\d{4}-\d{2}-\d{2}/); // opaco: no deja ver la fecha
    expect(p1.body.siguiente).not.toContain(p1.body.items[49].id);
    const p2 = await lista(a, `?cursor=${encodeURIComponent(p1.body.siguiente)}`);
    expect(p2.body.items).toHaveLength(2);
    expect(p2.body.siguiente).toBeNull();
    expect([...ids(p1), ...ids(p2)]).toEqual(esperadas);
    expect(new Set([...ids(p1), ...ids(p2)]).size).toBe(52);
  });

  it("una página llena sin más filas no inventa cursor", async () => {
    const a = await nuevo("dueno");
    await sembrarNotificaciones(sql, { tenantId: E.tenantId, usuarioId: a.id, n: 50 });
    const p = await lista(a);
    expect(p.body.items).toHaveLength(50);
    expect(p.body.siguiente).toBeNull();
  });

  it.each([
    ["basura", "basura"],
    ["signos", "!!!"],
    ["JSON sin forma", "eyJhIjoxfQ"],
    ["relleno", "AAAA"],
    ["2000 caracteres", "x".repeat(2000)],
  ])("el cursor mal formado (%s) es 400 solicitud_invalida", async (_nombre, cursor) => {
    const a = await nuevo("contador");
    await propias(a);
    const r = await get(a, `/notificaciones?cursor=${encodeURIComponent(cursor)}`);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect((await lista(a)).body.items).toHaveLength(1); // control: la ruta existe y responde
  });

  it.each(["usuarioId", "tenantId", "clienteId", "limite"])("la consulta es estricta: «%s» es 400 y no cambia el resultado (CA-4)", async (clave) => {
    const a = await nuevo("contador");
    const mia = await propias(a);
    const valor = clave === "limite" ? "1000" : F.titular.id;
    const r = await get(a, `/notificaciones?${clave}=${valor}`);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(ids(await lista(a))).toEqual([mia.id]);
  });
});

describe("CA-12 · GET /notificaciones/no-leidas", () => {
  it("cuenta solo las propias no leídas: { noLeidas } y no-store", async () => {
    const a = await nuevo("contador");
    const otro = await nuevo("contador");
    await propias(a, { hace: 30 });
    await propias(a, { hace: 20 });
    await propias(a, { hace: 10 });
    await propias(a, { hace: 40, leida: true });
    await propias(otro, { hace: 10 });
    const r = await get(a, "/notificaciones/no-leidas");
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ noLeidas: 3 });
    expect(esNoStore(r.headers["cache-control"])).toBe(true);
    expect(await noLeidas(otro)).toBe(1);
  });

  it("tiene tope 100: con 105 sin leer responde 100 (la pantalla muestra «99+»)", async () => {
    const a = await nuevo("dueno");
    await sembrarNotificaciones(sql, { tenantId: E.tenantId, usuarioId: a.id, n: 105 });
    expect(await noLeidas(a)).toBe(100);
  });

  it("sin nada responde 0, y la consulta es estricta (400 con usuarioId)", async () => {
    const a = await nuevo("lectura");
    expect(await noLeidas(a)).toBe(0);
    const r = await get(a, `/notificaciones/no-leidas?usuarioId=${F.titular.id}`);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
  });
});

describe("CA-12 · POST /notificaciones/leidas (leer todas hasta un instante)", () => {
  it("marca solo las propias con creada_en <= hasta, es idempotente y no toca las de otros", async () => {
    const a = await nuevo("dueno");
    const otro = await nuevo("dueno");
    const n400 = await propias(a, { hace: 400 });
    const n300 = await propias(a, { hace: 300 });
    const n200 = await propias(a, { hace: 200 });
    const n100 = await propias(a, { hace: 100 });
    const ajena = await propias(otro, { hace: 500 });
    const r = await post(a, "/notificaciones/leidas", { hasta: n300.creadaEn });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ marcadas: 2 });
    expect(esNoStore(r.headers["cache-control"])).toBe(true);
    expect(await leidaEn(n400.id)).not.toBeNull();
    expect(await leidaEn(n300.id)).not.toBeNull();
    expect(await leidaEn(n200.id)).toBeNull();
    expect(await leidaEn(n100.id)).toBeNull();
    expect(await leidaEn(ajena.id)).toBeNull();
    expect(await noLeidas(a)).toBe(2);
    const otra = await post(a, "/notificaciones/leidas", { hasta: n300.creadaEn });
    expect(otra.body).toEqual({ marcadas: 0 });
    expect(await noLeidas(otro)).toBe(1);
  });

  it("con un instante futuro marca todas las propias y conserva el instante de las que ya estaban leídas", async () => {
    const a = await nuevo("admin");
    const vieja = await propias(a, { hace: 500, leida: true });
    const antes = await leidaEn(vieja.id);
    await propias(a, { hace: 50 });
    await propias(a, { hace: 40 });
    const r = await post(a, "/notificaciones/leidas", { hasta: new Date(Date.now() + 3_600_000).toISOString() });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ marcadas: 2 });
    expect(await noLeidas(a)).toBe(0);
    expect(await leidaEn(vieja.id)).toBe(antes);
  });

  it.each([
    ["sin cuerpo", {}],
    ["hasta no es una fecha", { hasta: "ayer" }],
    ["hasta es un número", { hasta: 1 }],
    ["usuarioId extra (CA-4)", { hasta: "2099-01-01T00:00:00.000Z", usuarioId: "00000000-0000-4000-8000-000000000001" }],
    ["tenantId extra (CA-4)", { hasta: "2099-01-01T00:00:00.000Z", tenantId: "00000000-0000-4000-8000-000000000001" }],
    ["clienteId extra", { hasta: "2099-01-01T00:00:00.000Z", clienteId: "00000000-0000-4000-8000-000000000001" }],
  ])("%s es 400 solicitud_invalida y no marca nada", async (_n, cuerpo) => {
    const a = await nuevo("contador");
    const x = await propias(a, { hace: 30 });
    const r = await post(a, "/notificaciones/leidas", cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await leidaEn(x.id)).toBeNull();
    expect((await post(a, "/notificaciones/leidas", { hasta: x.creadaEn })).body).toEqual({ marcadas: 1 }); // control: la ruta existe
  });
});

describe("CA-12 · POST /notificaciones/:id/leida (idempotente)", () => {
  it("204 sin cuerpo y no-store; repetirla es 204 y conserva el primer instante de lectura", async () => {
    const a = await nuevo("contador");
    const x = await propias(a, { hace: 30 });
    const primera = await post(a, `/notificaciones/${x.id}/leida`);
    expect(primera.status, primera.text).toBe(204);
    expect(primera.text).toBe("");
    expect(esNoStore(primera.headers["cache-control"])).toBe(true);
    const l1 = await leidaEn(x.id);
    expect(l1).not.toBeNull();
    await new Promise((r) => setTimeout(r, 1100));
    const segunda = await post(a, `/notificaciones/${x.id}/leida`);
    expect(segunda.status, segunda.text).toBe(204);
    expect(await leidaEn(x.id)).toBe(l1);
    expect(await noLeidas(a)).toBe(0);
  });

  it("una notificación ya leída desde el inicio también responde 204", async () => {
    const a = await nuevo("lectura");
    const x = await propias(a, { hace: 30, leida: true });
    const r = await post(a, `/notificaciones/${x.id}/leida`);
    expect(r.status, r.text).toBe(204);
  });

  it("un cuerpo con usuarioId o tenantId es 400 y no marca nada (CA-4)", async () => {
    const a = await nuevo("contador");
    const x = await propias(a, { hace: 30 });
    for (const cuerpo of [{ usuarioId: F.titular.id }, { tenantId: F.tenantId }]) {
      const r = await post(a, `/notificaciones/${x.id}/leida`, cuerpo);
      expect(r.status, r.text).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
      expect(await leidaEn(x.id)).toBeNull();
    }
    expect((await post(a, `/notificaciones/${x.id}/leida`)).status).toBe(204); // control
  });
});

describe("CA-11 · lo ajeno es 404 y no cambia nada", () => {
  it("la de otro usuario del mismo estudio: 404 no_encontrado, sin cambios; la dueña real sí la marca (control)", async () => {
    const duena = await nuevo("contador");
    const intruso = await nuevo("dueno"); // ni siquiera un Dueño lee las notificaciones de otro usuario
    const x = await propias(duena, { hace: 30 });
    const r = await post(intruso, `/notificaciones/${x.id}/leida`);
    expect(r.status, r.text).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(await leidaEn(x.id)).toBeNull();
    expect(await noLeidas(duena)).toBe(1);
    expect((await post(duena, `/notificaciones/${x.id}/leida`)).status).toBe(204);
  });

  it("la de otro estudio: 404 desde la sesión del otro estudio, y viceversa; ninguna cambia (CA-7)", async () => {
    const duena = await nuevo("contador");
    const x = await propias(duena, { hace: 30 });
    const deF = await sembrarNotificacion(sql, { tenantId: F.tenantId, usuarioId: F.titular.id, clienteId: cF, hace: 30 });
    const r1 = await post(F.titular, `/notificaciones/${x.id}/leida`);
    const r2 = await post(duena, `/notificaciones/${deF.id}/leida`);
    for (const r of [r1, r2]) {
      expect(r.status, r.text).toBe(404);
      expect(r.body).toEqual({ codigo: "no_encontrado" });
    }
    expect(await leidaEn(x.id)).toBeNull();
    expect(await leidaEn(deF.id)).toBeNull();
    expect((await post(duena, `/notificaciones/${x.id}/leida`)).status).toBe(204);
    expect((await post(F.titular, `/notificaciones/${deF.id}/leida`)).status).toBe(204);
  });

  it("inexistente o con id mal formado: el mismo 404 que una ajena", async () => {
    const a = await nuevo("contador");
    const x = await propias(a, { hace: 30 });
    for (const id of ["00000000-0000-4000-8000-0000000000aa", "no-es-un-uuid", "123"]) {
      const r = await post(a, `/notificaciones/${id}/leida`);
      expect(r.status, `${id}: ${r.text}`).toBe(404);
      expect(r.body).toEqual({ codigo: "no_encontrado" });
    }
    expect((await post(a, `/notificaciones/${x.id}/leida`)).status).toBe(204); // control: la ruta existe
  });

  it("un Asistente desasignado deja de ver y de contar la del cliente; marcarla es 404; reasignarlo la devuelve", async () => {
    const as = await nuevo("asistente", [c0]);
    const delCliente = await propias(as, { hace: 60, clienteId: c0 });
    const sinCliente = await propias(as, { hace: 30, tipo: "plan_limite" });
    expect(ids(await lista(as))).toEqual([sinCliente.id, delCliente.id]);
    expect(await noLeidas(as)).toBe(2);

    await sql("delete from asignacion where cliente_id = $1 and usuario_id = $2", [c0, as.id]);
    expect(ids(await lista(as))).toEqual([sinCliente.id]);
    expect(await noLeidas(as)).toBe(1);
    const r = await post(as, `/notificaciones/${delCliente.id}/leida`);
    expect(r.status, r.text).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
    expect(await leidaEn(delCliente.id)).toBeNull();
    const todas = await post(as, "/notificaciones/leidas", { hasta: new Date(Date.now() + 60_000).toISOString() });
    expect(todas.body).toEqual({ marcadas: 1 }); // solo la visible
    expect(await leidaEn(delCliente.id)).toBeNull();
    // Nada se borró: reasignar la devuelve intacta.
    await b.asignar(E.tenantId, c0, as.id, "colaborador");
    expect(ids(await lista(as))).toEqual([sinCliente.id, delCliente.id]);
    expect(await noLeidas(as)).toBe(1);
    expect((await post(as, `/notificaciones/${delCliente.id}/leida`)).status).toBe(204);
  });

  it("un cliente que nunca tuvo asignado el Asistente tampoco se ve; el Dueño sí lo ve (alcance global)", async () => {
    const as = await nuevo("asistente", [c0]);
    const dueno = await nuevo("dueno");
    const deAsistente = await propias(as, { hace: 20, clienteId: c1 });
    const deDueno = await propias(dueno, { hace: 20, clienteId: c1 });
    expect((await lista(as)).body.items).toEqual([]);
    expect(await noLeidas(as)).toBe(0);
    expect((await post(as, `/notificaciones/${deAsistente.id}/leida`)).status).toBe(404);
    expect(ids(await lista(dueno))).toEqual([deDueno.id]);
    expect(await noLeidas(dueno)).toBe(1);
    expect((await post(dueno, `/notificaciones/${deDueno.id}/leida`)).status).toBe(204);
  });
});

describe("D-11 · acceso", () => {
  it("sin sesión las cuatro rutas son 401 sesion_invalida", async () => {
    const a = await nuevo("contador");
    expect((await get(a, "/notificaciones")).status).toBe(200); // control: con sesión responde
    const x = await propias(a);
    for (const [metodo, ruta, cuerpo] of [
      ["GET", "/notificaciones", undefined],
      ["GET", "/notificaciones/no-leidas", undefined],
      ["POST", "/notificaciones/leidas", { hasta: new Date().toISOString() }],
      ["POST", `/notificaciones/${x.id}/leida`, {}],
    ] as const) {
      const r = await b.h.pedir({ metodo, ruta, ...(cuerpo === undefined ? {} : { cuerpo }) });
      expect(r.status, `${metodo} ${ruta}`).toBe(401);
      expect(r.body).toEqual({ codigo: "sesion_invalida" });
    }
    expect(await leidaEn(x.id)).toBeNull();
  });

  it("cualquier rol del estudio lee las suyas (es @SoloEstudio, sin permiso aparte)", async () => {
    for (const rol of ["dueno", "admin", "contador", "asistente", "lectura"] as const) {
      const a = await nuevo(rol);
      const x = await propias(a, { hace: 15 });
      const r = await lista(a);
      expect(ids(r), rol).toEqual([x.id]);
      expect(await noLeidas(a), rol).toBe(1);
    }
  });

  it("con el X-Estudio de otro estudio no se llega al negocio (409 estudio_desfasado)", async () => {
    const a = await nuevo("contador");
    await propias(a);
    const r = await b.llamar(a, "GET", "/notificaciones", undefined, { estudio: F.tenantId });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "estudio_desfasado" });
    expect(r.text).not.toContain(a.id);
  });
});
