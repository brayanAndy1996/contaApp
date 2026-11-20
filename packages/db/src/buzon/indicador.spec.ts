// Spec 024 (T3, rojo): indicador de mensajes nuevos por cliente y filtro «con mensajes nuevos» del listado (CA-8, D-9, D-12) contra la
// BD real. Mismo estudio sembrado que bandeja.spec.ts (120 clientes; algunos sin mensajes, otros solo con atendidos o históricos y otros
// solo con críticos pendientes). Necesita DATABASE_URL y MIGRATIONS_DATABASE_URL: si faltan, FALLA (no se salta).
//
// CONTRATO que fijan estas pruebas (lo implementa T7 en `packages/db/src/buzon/indicador.ts` y `clientes/repositorio.ts`):
//   indicadorBuzon(tx, clienteIds: string[]) -> Map<clienteId, { nuevos, criticosNuevos }>
//     «nuevo» = pendiente: sin atender y no histórico (D-12), sea leído o no en SUNAT; `criticosNuevos` = los nuevos con `critico`.
//     Una sola consulta agregada para todos los clientes pedidos (no una por cliente). Un cliente sin nuevos puede faltar en el mapa o
//     venir con ceros (las pruebas aceptan ambos); la RLS deja fuera a los clientes de otro estudio. Lista vacía: mapa vacío.
//   listarClientesFiltrado(tx, alcance, { conMensajesNuevos: true, ... }) -> solo los clientes (del alcance y no archivados, salvo
//     `archivados`) con al menos un mensaje nuevo, en el orden de siempre (razón social, id); `false` o ausente no filtra.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContappDb } from "../client";
import { listarClientesFiltrado } from "../clientes/repositorio";
import { indicadorBuzon } from "./indicador";
import {
  abrirAdmin,
  abrirBackend,
  atenderDirecto,
  contarConsultas,
  desatenderDirecto,
  esNuevo,
  exigirEntorno,
  oraculoIndicador,
  sembrarEstudio,
  type Alcance,
  type Estudio,
} from "./soporte-prueba";

let admin: Pool;
let db: ContappDb;
let A: Estudio;
let B: Estudio;
const limpiezas: Array<() => Promise<void>> = [];

beforeAll(async () => {
  exigirEntorno();
  admin = abrirAdmin();
  db = abrirBackend();
  A = await sembrarEstudio(admin, { clientes: 120, semilla: 5 });
  limpiezas.push(A.limpiar);
  B = await sembrarEstudio(admin, { clientes: 20, semilla: 77 });
  limpiezas.push(B.limpiar);
}, 120_000);

afterAll(async () => {
  for (const l of limpiezas) await l().catch(() => undefined);
  await db?.close();
  await admin?.end();
});

const GLOBAL: Alcance = { tipo: "global" };
const CERO = { nuevos: 0, criticosNuevos: 0 };
const ctx = (e: Estudio) => ({ tenantId: e.tenantId, userId: e.dueno.id });
const de = (
  m: Map<string, { nuevos: number; criticosNuevos: number }>,
  id: string,
) => m.get(id) ?? CERO;
const todosLosIds = (e: Estudio) => e.clientes.map((c) => c.id);

describe("indicadorBuzon (CA-8, D-9, D-12)", () => {
  it("el estudio sembrado es no trivial: hay clientes con nuevos, sin mensajes, solo atendidos o históricos y solo críticos", () => {
    const esperado = oraculoIndicador(A);
    const conNuevos = [...esperado.values()].filter((x) => x.nuevos > 0);
    expect(conNuevos.length).toBeGreaterThan(60);
    expect(conNuevos.some((x) => x.criticosNuevos > 0)).toBe(true);
    expect(conNuevos.some((x) => x.criticosNuevos === 0)).toBe(true);
    const sinMensajes = A.clientes.filter(
      (c) => !A.mensajes.some((m) => m.clienteId === c.id),
    );
    expect(sinMensajes.length).toBeGreaterThan(5);
    const soloAtendidosOHistoricos = A.clientes.filter(
      (c) =>
        A.mensajes.some((m) => m.clienteId === c.id) &&
        !A.mensajes.some((m) => m.clienteId === c.id && esNuevo(m)),
    );
    expect(soloAtendidosOHistoricos.length).toBeGreaterThan(3);
    expect(A.mensajes.some((m) => m.historico && m.atendidoEn === null)).toBe(
      true,
    );
    expect(A.mensajes.some((m) => m.atendidoEn !== null)).toBe(true);
  });

  it("devuelve por cliente los nuevos y los críticos nuevos; atendidos e históricos no cuentan", async () => {
    const esperado = oraculoIndicador(A);
    const r = await db.withTenant(ctx(A), (tx) =>
      indicadorBuzon(tx, todosLosIds(A)),
    );
    for (const c of A.clientes)
      expect(de(r, c.id), `cliente ${c.idx}`).toEqual(esperado.get(c.id));
    // Un cliente solo con atendidos o históricos no cuenta nada.
    const sin = A.clientes.find(
      (c) =>
        A.mensajes.some((m) => m.clienteId === c.id) &&
        !A.mensajes.some((m) => m.clienteId === c.id && esNuevo(m)),
    )!;
    expect(de(r, sin.id)).toEqual(CERO);
  });

  it("los críticos nuevos son un subconjunto de los nuevos y un crítico pendiente cuenta aunque ya esté leído en SUNAT", async () => {
    const r = await db.withTenant(ctx(A), (tx) =>
      indicadorBuzon(tx, todosLosIds(A)),
    );
    for (const x of r.values())
      expect(x.criticosNuevos).toBeLessThanOrEqual(x.nuevos);
    const c = A.clientes.find((k) =>
      A.mensajes.some(
        (m) => m.clienteId === k.id && esNuevo(m) && m.critico && m.leido,
      ),
    )!;
    expect(c).toBeDefined();
    const esperado = A.mensajes.filter(
      (m) => m.clienteId === c.id && esNuevo(m) && m.critico,
    ).length;
    expect(de(r, c.id).criticosNuevos).toBe(esperado);
  });

  it("los clientes que solo tienen críticos pendientes tienen nuevos = críticos nuevos", async () => {
    const r = await db.withTenant(ctx(A), (tx) =>
      indicadorBuzon(tx, todosLosIds(A)),
    );
    const soloCriticos = A.clientes.filter((c) => {
      const suyos = A.mensajes.filter((m) => m.clienteId === c.id);
      return suyos.length > 0 && suyos.every((m) => esNuevo(m) && m.critico);
    });
    expect(soloCriticos.length).toBeGreaterThan(5);
    for (const c of soloCriticos) {
      const x = de(r, c.id);
      expect(x.nuevos).toBeGreaterThan(0);
      expect(x.criticosNuevos).toBe(x.nuevos);
    }
  });

  it("una sola consulta para 120 clientes (y para uno)", async () => {
    const todos = await db.withTenant(ctx(A), async (tx) => {
      const { tx: contada, consultas } = contarConsultas(tx);
      await indicadorBuzon(contada, todosLosIds(A));
      return consultas();
    });
    expect(todos).toBe(1);
    const uno = await db.withTenant(ctx(A), async (tx) => {
      const { tx: contada, consultas } = contarConsultas(tx);
      await indicadorBuzon(contada, [A.clientes[1]!.id]);
      return consultas();
    });
    expect(uno).toBe(1);
  });

  it("una lista vacía devuelve un mapa vacío con a lo sumo una consulta", async () => {
    const [mapa, n] = await db.withTenant(ctx(A), async (tx) => {
      const { tx: contada, consultas } = contarConsultas(tx);
      const m = await indicadorBuzon(contada, []);
      return [m, consultas()] as const;
    });
    expect(mapa.size).toBe(0);
    expect(n).toBeLessThanOrEqual(1);
  });

  it("solo cuenta los clientes pedidos", async () => {
    const dos = [A.clientes[1]!.id, A.clientes[2]!.id];
    const r = await db.withTenant(ctx(A), (tx) => indicadorBuzon(tx, dos));
    const esperado = oraculoIndicador(A);
    expect(de(r, dos[0]!)).toEqual(esperado.get(dos[0]!));
    expect(de(r, dos[1]!)).toEqual(esperado.get(dos[1]!));
    expect([...r.keys()].every((k) => dos.includes(k))).toBe(true);
  });

  it("los clientes de otro estudio no aparecen (RLS), pedidos o no", async () => {
    const r = await db.withTenant(ctx(A), (tx) =>
      indicadorBuzon(tx, [...todosLosIds(A), ...todosLosIds(B)]),
    );
    const idsB = new Set(todosLosIds(B));
    expect([...r.keys()].some((k) => idsB.has(k))).toBe(false);
    for (const c of B.clientes) expect(de(r, c.id)).toEqual(CERO);
    const soloB = await db.withTenant(ctx(A), (tx) =>
      indicadorBuzon(tx, todosLosIds(B)),
    );
    expect([...soloB.values()].every((x) => x.nuevos === 0)).toBe(true);
    // Y B ve lo suyo.
    const propio = await db.withTenant(ctx(B), (tx) =>
      indicadorBuzon(tx, todosLosIds(B)),
    );
    const esperadoB = oraculoIndicador(B);
    for (const c of B.clientes)
      expect(de(propio, c.id)).toEqual(esperadoB.get(c.id));
  });

  it("atender y deshacer cambian el número al recargar; un histórico atendido que se deshace sigue sin contar", async () => {
    const e = await sembrarEstudio(admin, { clientes: 30, semilla: 21 });
    limpiezas.push(e.limpiar);
    const cliente = e.clientes[1]!;
    const leer = async () =>
      de(
        await db.withTenant(ctx(e), (tx) => indicadorBuzon(tx, [cliente.id])),
        cliente.id,
      );
    const antes = await leer();
    expect(antes).toEqual(oraculoIndicador(e).get(cliente.id));
    expect(antes.nuevos).toBeGreaterThan(2);
    const pendientes = e.mensajes.filter(
      (m) => m.clienteId === cliente.id && esNuevo(m),
    );
    const criticoPend = pendientes.find((m) => m.critico);
    const noCritico = pendientes.find((m) => !m.critico)!;
    // Atender uno no crítico: baja `nuevos`, no los críticos.
    await atenderDirecto(admin, e, [noCritico.id], e.dueno.id);
    expect(await leer()).toEqual({
      nuevos: antes.nuevos - 1,
      criticosNuevos: antes.criticosNuevos,
    });
    // Atender un crítico: bajan los dos.
    if (criticoPend !== undefined) {
      await atenderDirecto(admin, e, [criticoPend.id], e.dueno.id);
      expect(await leer()).toEqual({
        nuevos: antes.nuevos - 2,
        criticosNuevos: antes.criticosNuevos - 1,
      });
      await desatenderDirecto(admin, e, [criticoPend.id]);
      expect(await leer()).toEqual({
        nuevos: antes.nuevos - 1,
        criticosNuevos: antes.criticosNuevos,
      });
    }
    await desatenderDirecto(admin, e, [noCritico.id]);
    expect(await leer()).toEqual(antes);
    // Un histórico (sin atender) no cuenta; atenderlo y deshacerlo lo deja histórico: sigue sin contar.
    const historico = e.mensajes.find(
      (m) => m.historico && m.atendidoEn === null && m.clienteId === cliente.id,
    );
    const delHistorico =
      historico ??
      e.mensajes.find((m) => m.historico && m.atendidoEn === null)!;
    const c2 = delHistorico.clienteId;
    const base = de(
      await db.withTenant(ctx(e), (tx) => indicadorBuzon(tx, [c2])),
      c2,
    );
    await atenderDirecto(admin, e, [delHistorico.id], e.dueno.id);
    await desatenderDirecto(admin, e, [delHistorico.id]);
    expect(
      de(await db.withTenant(ctx(e), (tx) => indicadorBuzon(tx, [c2])), c2),
    ).toEqual(base);
  }, 60_000);
});

describe("conMensajesNuevos en el listado de clientes (CA-8)", () => {
  const nombres = (cs: Array<{ id: string }>) => cs.map((c) => c.id);

  it("deja solo los clientes del alcance con nuevos, en el orden de siempre (razón social, id)", async () => {
    const esperado = oraculoIndicador(A);
    const todos = await db.withTenant(ctx(A), (tx) =>
      listarClientesFiltrado(tx, GLOBAL, {}),
    );
    const r = await db.withTenant(ctx(A), (tx) =>
      listarClientesFiltrado(tx, GLOBAL, { conMensajesNuevos: true }),
    );
    const quiere = todos.filter(
      (c) => (esperado.get(c.id)?.nuevos ?? 0) > 0 && !c.archivado,
    );
    expect(r.length).toBeGreaterThan(30);
    expect(r.length).toBeLessThan(todos.length);
    expect(nombres(r)).toEqual(nombres(quiere));
  });

  it("sin el filtro (ausente o false) el listado no cambia", async () => {
    const base = await db.withTenant(ctx(A), (tx) =>
      listarClientesFiltrado(tx, GLOBAL, {}),
    );
    const falso = await db.withTenant(ctx(A), (tx) =>
      listarClientesFiltrado(tx, GLOBAL, { conMensajesNuevos: false }),
    );
    expect(nombres(falso)).toEqual(nombres(base));
    expect(base.length).toBe(A.clientes.filter((c) => !c.archivado).length);
  });

  it("excluye a los clientes sin mensajes y a los que solo tienen atendidos o históricos", async () => {
    const r = await db.withTenant(ctx(A), (tx) =>
      listarClientesFiltrado(tx, GLOBAL, { conMensajesNuevos: true }),
    );
    const ids = new Set(nombres(r));
    for (const c of A.clientes) {
      const tiene = A.mensajes.some((m) => m.clienteId === c.id && esNuevo(m));
      if (!tiene)
        expect(ids.has(c.id), `cliente ${c.idx} sin nuevos`).toBe(false);
      else if (!c.archivado)
        expect(ids.has(c.id), `cliente ${c.idx} con nuevos`).toBe(true);
    }
  });

  it("con `archivados` suma los archivados que tienen nuevos", async () => {
    const sin = await db.withTenant(ctx(A), (tx) =>
      listarClientesFiltrado(tx, GLOBAL, { conMensajesNuevos: true }),
    );
    const con = await db.withTenant(ctx(A), (tx) =>
      listarClientesFiltrado(tx, GLOBAL, {
        conMensajesNuevos: true,
        archivados: true,
      }),
    );
    const archivadosConNuevos = A.clientes.filter(
      (c) =>
        c.archivado &&
        A.mensajes.some((m) => m.clienteId === c.id && esNuevo(m)),
    );
    expect(archivadosConNuevos.length).toBeGreaterThan(0);
    expect(con.length).toBe(sin.length + archivadosConNuevos.length);
  });

  it("respeta el alcance asignado: solo los clientes del Contador con nuevos", async () => {
    const alcance: Alcance = { tipo: "asignado", usuarioId: A.contador.id };
    const esperado = oraculoIndicador(A);
    const r = await db.withTenant(
      { tenantId: A.tenantId, userId: A.contador.id },
      (tx) => listarClientesFiltrado(tx, alcance, { conMensajesNuevos: true }),
    );
    const suyos = A.clientes.filter(
      (c) =>
        c.asignados.has(A.contador.id) &&
        !c.archivado &&
        (esperado.get(c.id)?.nuevos ?? 0) > 0,
    );
    expect(suyos.length).toBeGreaterThan(3);
    expect(new Set(nombres(r))).toEqual(new Set(suyos.map((c) => c.id)));
  });

  it("se combina con los demás filtros (responsable) con AND", async () => {
    const esperado = oraculoIndicador(A);
    const r = await db.withTenant(ctx(A), (tx) =>
      listarClientesFiltrado(tx, GLOBAL, {
        conMensajesNuevos: true,
        responsable: A.dueno.id,
      }),
    );
    const quiere = A.clientes.filter(
      (c) =>
        c.responsableId === A.dueno.id &&
        !c.archivado &&
        (esperado.get(c.id)?.nuevos ?? 0) > 0,
    );
    expect(quiere.length).toBeGreaterThan(5);
    expect(new Set(nombres(r))).toEqual(new Set(quiere.map((c) => c.id)));
  });

  it("atender los nuevos de un cliente lo saca del filtro y deshacer lo devuelve", async () => {
    const e = await sembrarEstudio(admin, { clientes: 30, semilla: 33 });
    limpiezas.push(e.limpiar);
    const cliente = e.clientes.find(
      (c) =>
        !c.archivado &&
        e.mensajes.some((m) => m.clienteId === c.id && esNuevo(m)),
    )!;
    const lista = async () =>
      nombres(
        await db.withTenant(ctx(e), (tx) =>
          listarClientesFiltrado(tx, GLOBAL, { conMensajesNuevos: true }),
        ),
      );
    expect(await lista()).toContain(cliente.id);
    const nuevos = e.mensajes
      .filter((m) => m.clienteId === cliente.id && esNuevo(m))
      .map((m) => m.id);
    await atenderDirecto(admin, e, nuevos, e.dueno.id);
    expect(await lista()).not.toContain(cliente.id);
    await desatenderDirecto(admin, e, nuevos);
    expect(await lista()).toContain(cliente.id);
  }, 60_000);
});
