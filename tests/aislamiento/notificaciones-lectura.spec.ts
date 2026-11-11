// Spec 017 (T3, rojo): lecturas y escrituras de notificaciones de packages/db contra la BD real (D-10, D-12, P-7; CA-11, CA-13,
// CA-15): listar, contar, marcar leidas, visibilidad por alcance, purga a 90 dias y resolucion de autores.
// Contrato (firmas) en notificaciones-soporte.ts. Falla hoy por export ausente de @contapp/db o tabla `notificacion` ausente.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { intentar, type ContappDb } from "./soporte";
import { abrirAdmin, crearDb, EscenarioNotif, exportado, UUID } from "./notificaciones-soporte";

type Fn = (...a: any[]) => Promise<any>;
const f = (nombre: string) => exportado<Fn>(nombre);
const GLOBAL = { tipo: "global" } as const;
const asignado = (usuarioId: string) => ({ tipo: "asignado", usuarioId }) as const;
const DIA = 86400;

let admin: Pool;
let en: EscenarioNotif;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;

beforeAll(async () => {
  admin = abrirAdmin(6);
  en = new EscenarioNotif(admin);
  X = (await en.estudio()).id;
  Y = (await en.estudio()).id;
  backend = crearDb("contapp_backend", 6);
  worker = crearDb("contapp_worker", 4);
});
afterAll(async () => {
  await en?.limpiar();
  await backend?.close().catch(() => undefined);
  await worker?.close().catch(() => undefined);
  await admin?.end();
});

/** Usuario nuevo de X con su contexto de backend. */
async function usuario(tenant = X, rol: "contador" | "asistente" | "dueno" = "contador") {
  const id = (await en.et.miembro(tenant, rol)).id;
  const como = <T>(fn: (tx: any) => Promise<T>) => backend.withTenant({ tenantId: tenant, userId: id }, fn);
  return { id, como };
}
const listar = (u: { como: Function }, alcance: object = GLOBAL, o: object = {}): Promise<any[]> =>
  u.como((tx: any) => f("listarNotificaciones")(tx, alcance, o));
const contar = (u: { como: Function }, alcance: object = GLOBAL, tope?: number): Promise<number> =>
  u.como((tx: any) => (tope === undefined ? f("contarNoLeidas")(tx, alcance) : f("contarNoLeidas")(tx, alcance, tope)));

// =================================================================================================
describe("listarNotificaciones: orden, cursor y maximo de 50 (CA-12)", () => {
  it("devuelve solo las del usuario, de la mas nueva a la mas vieja, con la forma del contrato", async () => {
    const u = await usuario();
    const otro = await usuario();
    const vieja = await en.notificar(X, u.id, { hace: 300 });
    const media = await en.notificar(X, u.id, { hace: 200, leida: true });
    const nueva = await en.notificar(X, u.id, { hace: 100, tipo: "plan_limite", params: { recurso: "rucs", umbral: 90, usado: 9, limite: 10 } });
    await en.notificar(X, otro.id, { hace: 50 });
    const filas = await listar(u);
    expect(filas.map((x) => x.id)).toEqual([nueva, media, vieja]);
    expect(filas[0]).toMatchObject({
      id: nueva,
      tipo: "plan_limite",
      clienteId: null,
      trabajoId: null,
      leidaEn: null,
      params: { recurso: "rucs", umbral: 90, usado: 9, limite: 10 },
    });
    expect(filas[0].creadaEn).toBeInstanceOf(Date);
    expect(filas[1].leidaEn).toBeInstanceOf(Date);
    expect(filas[0].id).toMatch(UUID);
  });

  it("con la misma fecha desempata por id, de mayor a menor", async () => {
    const u = await usuario();
    const base = randomUUID().slice(0, 24);
    const ids = ["000000000001", "000000000002", "000000000003"].map((s) => `${base}${s}`);
    const instante = new Date(Date.now() - 60_000);
    for (const id of ids) await en.notificar(X, u.id, { id, creadaEn: instante });
    expect((await listar(u)).map((x) => x.id)).toEqual([...ids].reverse());
  });

  it("el cursor continua exactamente donde quedo la pagina anterior, sin repetir ni saltar", async () => {
    const u = await usuario();
    const creadas: string[] = [];
    for (let i = 7; i >= 1; i--) creadas.push(await en.notificar(X, u.id, { hace: i * 100 })); // la 7a es la mas nueva
    const esperadas = [...creadas].reverse();
    const p1 = await listar(u, GLOBAL, { limite: 3 });
    expect(p1.map((x) => x.id)).toEqual(esperadas.slice(0, 3));
    const p2 = await listar(u, GLOBAL, { limite: 3, antes: { en: p1[2].creadaEn, id: p1[2].id } });
    expect(p2.map((x) => x.id)).toEqual(esperadas.slice(3, 6));
    const p3 = await listar(u, GLOBAL, { limite: 3, antes: { en: p2[2].creadaEn, id: p2[2].id } });
    expect(p3.map((x) => x.id)).toEqual(esperadas.slice(6));
    const p4 = await listar(u, GLOBAL, { limite: 3, antes: { en: p3[0].creadaEn, id: p3[0].id } });
    expect(p4).toEqual([]);
  });

  it("nunca devuelve mas de 50, aunque se pida mas o no se indique limite", async () => {
    const u = await usuario();
    await en.notificarVarias(X, u.id, 60);
    expect(await listar(u, GLOBAL, { limite: 500 })).toHaveLength(50);
    expect(await listar(u)).toHaveLength(50);
    expect(await listar(u, GLOBAL, { limite: 5 })).toHaveLength(5);
  });

  it("una notificacion de otro estudio con el mismo usuario no aparece (aislamiento)", async () => {
    const u = await usuario();
    const enY = (await en.et.miembro(Y, "contador")).id;
    await en.notificar(Y, enY);
    expect(await listar(u)).toHaveLength(0);
    const comoYenX = await backend.withTenant({ tenantId: X, userId: enY }, (tx) => f("listarNotificaciones")(tx, GLOBAL, {}));
    expect(comoYenX).toEqual([]);
  });
});

// =================================================================================================
describe("listarNotificaciones: cursor con precision de milisegundos frente a filas con microsegundos (CA-12)", () => {
  // `antes.en` es un Date (ms) y `creada_en` tiene us. Las filas del mismo ms que la ultima de una pagina no deben saltarse ni
  // repetirse. Se insertan con el superusuario porque el DEFAULT trunca a ms: es la peor entrada posible para el cursor.
  it.each([1, 2, 3, 4, 7])(
    "con limite %i, la union de las paginas es exactamente el conjunto sembrado, sin huecos ni duplicados",
    async (limite) => {
      const u = await usuario();
      const r = await admin.query(
        `with base as (select date_trunc('milliseconds', now()) - interval '2 hours' as t),
              mismo_ms as (select base.t + g * interval '100 microseconds' as en from base, generate_series(1, 8) g),
              otros_ms as (select base.t + g * interval '5 milliseconds' as en from base, unnest(array[-1, 1]) g),
              todos as (select en from mismo_ms union all select en from otros_ms)
         insert into notificacion (tenant_id, usuario_id, tipo, params, clave_dedupe, creada_en)
         select $1, $2, 'trabajo_terminado', '{"tipoTrabajo":"prueba.eco","estado":"completado","motivo":null}'::jsonb,
                'us:' || $3 || ':' || row_number() over (order by en), en
           from todos
         returning id`,
        [X, u.id, randomUUID()],
      );
      const sembradas = new Set<string>(r.rows.map((x) => x.id as string));
      expect(sembradas.size, "siembra: 8 filas dentro de un mismo ms y 2 en ms vecinos").toBe(10);

      const vistas: string[] = [];
      let antes: { en: Date; id: string } | undefined;
      for (let i = 0; i < 100; i++) {
        const pagina = await listar(u, GLOBAL, antes ? { antes, limite } : { limite });
        if (pagina.length === 0) break;
        expect(pagina.length).toBeLessThanOrEqual(limite);
        vistas.push(...pagina.map((x) => x.id));
        const ult = pagina[pagina.length - 1];
        antes = { en: ult.creadaEn, id: ult.id }; // igual que el servicio: el cursor viaja como Date
      }
      expect(new Set(vistas).size, "sin repetidas").toBe(vistas.length);
      expect(
        [...sembradas].filter((id) => !vistas.includes(id)).length,
        "filas sembradas que ninguna pagina entrego (saltadas por el cursor en ms)",
      ).toBe(0);
      expect(vistas).toHaveLength(sembradas.size);
    },
  );
});

// =================================================================================================
describe("contarNoLeidas: solo no leidas, con tope (CA-12)", () => {
  it("cuenta las no leidas propias y visibles", async () => {
    const u = await usuario();
    const otro = await usuario();
    expect(await contar(u)).toBe(0);
    await en.notificar(X, u.id);
    await en.notificar(X, u.id);
    await en.notificar(X, u.id, { leida: true });
    await en.notificar(X, otro.id);
    expect(await contar(u)).toBe(2);
    expect(await contar(otro)).toBe(1);
  });

  it("tiene un tope de 100 por omision y acepta otro tope", async () => {
    const u = await usuario();
    await en.notificarVarias(X, u.id, 105);
    expect(await contar(u)).toBe(100);
    expect(await contar(u, GLOBAL, 7)).toBe(7);
    expect(await contar(u, GLOBAL, 200)).toBe(105);
  });
});

// =================================================================================================
describe("marcarLeida: idempotente y solo la propia (CA-11, CA-12)", () => {
  const leidaEn = async (id: string): Promise<Date | null> =>
    (await admin.query("select leida_en from notificacion where id = $1", [id])).rows[0].leida_en;

  it("la propia queda leida; repetir devuelve true y conserva la primera fecha", async () => {
    const u = await usuario();
    const id = await en.notificar(X, u.id);
    expect(await u.como((tx) => f("marcarLeida")(tx, id))).toBe(true);
    const primera = await leidaEn(id);
    expect(primera).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 30));
    expect(await u.como((tx) => f("marcarLeida")(tx, id))).toBe(true);
    expect((await leidaEn(id))?.getTime()).toBe(primera?.getTime());
    expect(await contar(u)).toBe(0);
  });

  it("la de otro usuario del estudio da false y no cambia", async () => {
    const u = await usuario();
    const otro = await usuario();
    const id = await en.notificar(X, u.id);
    expect(await otro.como((tx) => f("marcarLeida")(tx, id))).toBe(false);
    expect(await leidaEn(id)).toBeNull();
  });

  it("la de otro estudio y la inexistente dan false", async () => {
    const u = await usuario();
    const enY = await usuario(Y);
    const id = await en.notificar(Y, enY.id);
    expect(await u.como((tx) => f("marcarLeida")(tx, id))).toBe(false);
    expect(await u.como((tx) => f("marcarLeida")(tx, randomUUID()))).toBe(false);
    expect(await leidaEn(id)).toBeNull();
  });
});

// =================================================================================================
describe("marcarLeidasHasta: todas las propias hasta un instante (CA-12)", () => {
  it("marca las propias, visibles y no leidas hasta el instante; devuelve cuantas; es idempotente", async () => {
    const u = await usuario();
    const otro = await usuario();
    const a = await en.notificar(X, u.id, { hace: 3 * 3600 });
    const b = await en.notificar(X, u.id, { hace: 2 * 3600 });
    await en.notificar(X, u.id, { hace: 3 * 3600 + 60, leida: true }); // ya leida: no se cuenta
    const c = await en.notificar(X, u.id, { hace: 3600 });
    const ajena = await en.notificar(X, otro.id, { hace: 3 * 3600 });
    const hasta = new Date(Date.now() - 90 * 60 * 1000); // incluye a y b, no c
    expect(await u.como((tx) => f("marcarLeidasHasta")(tx, GLOBAL, hasta))).toBe(2);
    const estado = async (id: string) =>
      (await admin.query("select leida_en from notificacion where id = $1", [id])).rows[0].leida_en as Date | null;
    expect(await estado(a)).toBeInstanceOf(Date);
    expect(await estado(b)).toBeInstanceOf(Date);
    expect(await estado(c)).toBeNull();
    expect(await estado(ajena)).toBeNull();
    expect(await u.como((tx) => f("marcarLeidasHasta")(tx, GLOBAL, hasta))).toBe(0);
    expect(await contar(u)).toBe(1);
  });
});

// =================================================================================================
describe("CA-11 · visibilidad por alcance (RF-026, D-10)", () => {
  it("un Asistente desasignado deja de ver y de contar la notificacion del cliente; volver a asignarlo la devuelve", async () => {
    const asis = await usuario(X, "asistente");
    const c1 = await en.et.cliente(X);
    const c2 = await en.et.cliente(X);
    await en.et.asignar(X, c1.id, asis.id, "colaborador");
    const delC1 = await en.notificar(X, asis.id, { clienteId: c1.id, tipo: "credencial_invalida", params: { credencial: "sol" }, hace: 30 });
    const delC2 = await en.notificar(X, asis.id, { clienteId: c2.id, tipo: "credencial_invalida", params: { credencial: "sol" }, hace: 20 });
    const sinCliente = await en.notificar(X, asis.id, { hace: 10 });
    const alcance = asignado(asis.id);

    expect((await listar(asis, alcance)).map((x) => x.id)).toEqual([sinCliente, delC1]); // c2 nunca fue suyo
    expect(await contar(asis, alcance)).toBe(2);

    await admin.query("delete from asignacion where tenant_id = $1 and cliente_id = $2 and usuario_id = $3", [X, c1.id, asis.id]);
    expect((await listar(asis, alcance)).map((x) => x.id)).toEqual([sinCliente]);
    expect(await contar(asis, alcance)).toBe(1);
    // no se borro nada: la fila sigue en la tabla
    expect((await en.notifs(X, { usuarioId: asis.id })).map((n) => n.id).sort()).toEqual([delC1, delC2, sinCliente].sort());

    await en.et.asignar(X, c1.id, asis.id, "colaborador");
    expect((await listar(asis, alcance)).map((x) => x.id)).toEqual([sinCliente, delC1]);
    expect(await contar(asis, alcance)).toBe(2);
  });

  it("con alcance global se ven todas las propias, tambien las de clientes sin asignar", async () => {
    const dueno = await usuario(X, "dueno");
    const c = await en.et.cliente(X);
    const id = await en.notificar(X, dueno.id, { clienteId: c.id, tipo: "credencial_invalida", params: { credencial: "sol" } });
    expect((await listar(dueno, GLOBAL)).map((x) => x.id)).toEqual([id]);
    expect(await contar(dueno, GLOBAL)).toBe(1);
  });

  it("marcarLeidasHasta con alcance asignado no marca las notificaciones de clientes ya no visibles", async () => {
    const asis = await usuario(X, "asistente");
    const c1 = await en.et.cliente(X);
    await en.et.asignar(X, c1.id, asis.id, "colaborador");
    const oculta = await en.notificar(X, asis.id, { clienteId: c1.id, tipo: "credencial_invalida", params: { credencial: "sol" }, hace: 120 });
    const visible = await en.notificar(X, asis.id, { hace: 60 });
    await admin.query("delete from asignacion where tenant_id = $1 and cliente_id = $2 and usuario_id = $3", [X, c1.id, asis.id]);
    const n = await asis.como((tx) => f("marcarLeidasHasta")(tx, asignado(asis.id), new Date(Date.now() + 3600_000)));
    expect(n).toBe(1);
    const filas = (await en.notifs(X, { usuarioId: asis.id })).reduce<Record<string, Date | null>>((a, x) => ({ ...a, [x.id]: x.leida_en }), {});
    expect(filas[visible]).toBeInstanceOf(Date);
    expect(filas[oculta]).toBeNull();
  });

  it("un alcance 'asignado' sin asignaciones solo ve las notificaciones sin cliente (falla cerrado)", async () => {
    const asis = await usuario(X, "asistente");
    const c = await en.et.cliente(X);
    await en.notificar(X, asis.id, { clienteId: c.id, tipo: "credencial_invalida", params: { credencial: "sol" } });
    const sin = await en.notificar(X, asis.id);
    expect((await listar(asis, asignado(asis.id))).map((x) => x.id)).toEqual([sin]);
  });
});

// =================================================================================================
describe("CA-15 · notificacion_purgar y purgarNotificaciones (P-7: 90 dias, leidas o no)", () => {
  it("borra solo las de mas de 90 dias del estudio actual, leidas o no; deja las de 89 dias", async () => {
    const X = (await en.estudio()).id; // estudio propio: la purga mira todo el estudio
    const Y = (await en.estudio()).id;
    const u = await usuario(X);
    const enY = await usuario(Y);
    const vieja = await en.notificar(X, u.id, { hace: 91 * DIA });
    const viejaLeida = await en.notificar(X, u.id, { hace: 120 * DIA, leida: true });
    const reciente = await en.notificar(X, u.id, { hace: 89 * DIA });
    const hoy = await en.notificar(X, u.id);
    const viejaDeY = await en.notificar(Y, enY.id, { hace: 200 * DIA });
    const borradas = await worker.withTenant({ tenantId: X }, async (tx) => Number((await tx.query("select notificacion_purgar(90) as n")).rows[0].n));
    expect(borradas).toBe(2);
    const quedan = (await en.notifs(X, { usuarioId: u.id })).map((n) => n.id).sort();
    expect(quedan).toEqual([reciente, hoy].sort());
    expect(quedan).not.toContain(vieja);
    expect(quedan).not.toContain(viejaLeida);
    expect((await en.notifs(Y)).map((n) => n.id)).toEqual([viejaDeY]); // otro estudio: intacto
  });

  it("purgarNotificaciones(tx, dias) devuelve cuantas borro y respeta el estudio del contexto", async () => {
    const X = (await en.estudio()).id;
    const Y = (await en.estudio()).id;
    const u = await usuario(X);
    const enY = await usuario(Y);
    await en.notificar(X, u.id, { hace: 100 * DIA });
    await en.notificar(X, u.id, { hace: 40 * DIA });
    await en.notificar(Y, enY.id, { hace: 100 * DIA });
    expect(await worker.withTenant({ tenantId: X }, (tx) => f("purgarNotificaciones")(tx, 90))).toBe(1);
    expect(await worker.withTenant({ tenantId: X }, (tx) => f("purgarNotificaciones")(tx, 90))).toBe(0);
    expect(await worker.withTenant({ tenantId: X }, (tx) => f("purgarNotificaciones")(tx, 30))).toBe(1);
    expect(await en.notifs(X, { usuarioId: u.id })).toHaveLength(0);
    expect(await en.notifs(Y)).toHaveLength(1);
  });

  it("p_dias < 1 es un error 22023 y no borra nada", async () => {
    const X = (await en.estudio()).id;
    const u = await usuario(X);
    const id = await en.notificar(X, u.id, { hace: 500 * DIA });
    for (const dias of [0, -1]) {
      const r = await intentar(worker, { tenantId: X }, "select notificacion_purgar($1::int)", [dias]);
      expect(r.ok, `dias=${dias}`).toBe(false);
      if (!r.ok) expect(r.code).toBe("22023");
    }
    expect((await en.notifs(X, { usuarioId: u.id })).map((n) => n.id)).toContain(id);
  });

  it("el backend no puede purgar: sin EXECUTE (42501)", async () => {
    const r = await intentar(backend, { tenantId: X, userId: randomUUID() }, "select notificacion_purgar(90)");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("42501");
  });
});

// =================================================================================================
describe("resolverAutores (D-12, CA-13)", () => {
  it("activo, desactivado y desconocido (otro estudio o inexistente), sin filtrar datos de mas", async () => {
    const activo = await usuario(X, "contador");
    const baja = (await en.et.miembro(X, "contador", { desactivada: true })).id;
    const deY = (await en.et.miembro(Y, "contador")).id;
    const fantasma = randomUUID();
    await en.nombrar(activo.id, "Ana Activa T3");
    await en.nombrar(baja, "Beto Baja T3");
    await en.nombrar(deY, "Yolanda De Otro Estudio T3");
    const m = (await activo.como((tx) => f("resolverAutores")(tx, [activo.id, baja, deY, fantasma]))) as Map<string, any>;
    expect(m).toBeInstanceOf(Map);
    expect(m.get(activo.id)).toEqual({ id: activo.id, nombre: "Ana Activa T3", activo: true });
    expect(m.get(baja)).toEqual({ id: baja, nombre: "Beto Baja T3", activo: false });
    expect(m.get(deY)).toEqual({ id: deY, nombre: null, activo: false });
    expect(m.get(fantasma)).toEqual({ id: fantasma, nombre: null, activo: false });
    expect(m.size).toBe(4);
    expect(JSON.stringify([...m.values()])).not.toContain("Otro Estudio");
  });

  it("la lista vacia da un mapa vacio y los ids repetidos dan una sola entrada", async () => {
    const u = await usuario();
    await en.nombrar(u.id, "Repetida T3");
    expect((await u.como((tx) => f("resolverAutores")(tx, []))).size).toBe(0);
    const m = await u.como((tx) => f("resolverAutores")(tx, [u.id, u.id, u.id]));
    expect(m.size).toBe(1);
    expect(m.get(u.id)).toEqual({ id: u.id, nombre: "Repetida T3", activo: true });
  });

  it("un autor de X no se resuelve desde Y: el mismo id es 'Usuario desconocido' en el otro estudio", async () => {
    const enX = (await en.et.miembro(X, "contador")).id;
    await en.nombrar(enX, "Solo de X T3");
    const desdeY = (await backend.withTenant({ tenantId: Y }, (tx) => f("resolverAutores")(tx, [enX]))) as Map<string, any>;
    expect(desdeY.get(enX)).toEqual({ id: enX, nombre: null, activo: false });
    const desdeX = (await backend.withTenant({ tenantId: X }, (tx) => f("resolverAutores")(tx, [enX]))) as Map<string, any>;
    expect(desdeX.get(enX)).toEqual({ id: enX, nombre: "Solo de X T3", activo: true });
  });

  it("un usuario con membresia en los dos estudios se resuelve en cada uno segun su estado en ese estudio", async () => {
    const u = await en.et.miembro(X, "contador");
    await en.et.ea.membresia(Y, u.id, "contador", { desactivada: true });
    await en.nombrar(u.id, "En Dos Estudios T3");
    const enX = await backend.withTenant({ tenantId: X }, (tx) => f("resolverAutores")(tx, [u.id]));
    const enYm = await backend.withTenant({ tenantId: Y }, (tx) => f("resolverAutores")(tx, [u.id]));
    expect(enX.get(u.id)).toEqual({ id: u.id, nombre: "En Dos Estudios T3", activo: true });
    expect(enYm.get(u.id)).toEqual({ id: u.id, nombre: "En Dos Estudios T3", activo: false });
  });
});
