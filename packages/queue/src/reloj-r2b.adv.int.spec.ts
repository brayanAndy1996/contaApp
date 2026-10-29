// Spec 008 · T15b (ronda adversarial 2b, caja blanca): relojes desfasados contra la corrección de H-008-1b-2.
// T14 escribe los vencimientos de los cupos con max(hora local, TIME de Redis), pero poda (despachador) y decide
// "arriendo vencido" (reconciliador) con la hora LOCAL. PostgreSQL y Redis reales (base 15, un prefijo por escenario);
// sin BullMQ (`agregarACola` solo anota) ni config_sistema modificada. Cada escenario crea y borra sus estudios.
// El reconciliador de estas pruebas solo ve los estudios propios (filtro sobre `withSistema`): no toca datos ajenos.
// Mientras se espera el arriendo, los trabajos propios se "tocan" (actualizado_en) para que el reconciliador de otro
// proceso de pruebas no los considere; antes de reconciliar se envejecen.
//
// Hallazgos que fija (rojo):
//  1. Reconciliador con el reloj adelantado 40 s: un trabajo recién despachado (cupo reservado, el ejecutor aún no
//     tomó `ejec:`) se ve vencido y un tipo no idempotente queda en error/interrumpido sin haberse ejecutado (CA-10, D2).
//  2. Ejecutor con el reloj adelantado 40 s que muere: su latido dejó el cupo con vencimiento = local + 30 s (el max
//     elige el reloj adelantado). Vencido el arriendo según el reloj común (TTL de `ejec:`), el despachador sigue
//     contando el cupo y el reconciliador no recupera el trabajo hasta ~70 s (CA-10: ≤ 60 s; D5).
//  3. Líder / reconciliador con el reloj atrasado 40 s: podan y deciden con la hora local, así que el cupo de un
//     ejecutor muerto (reloj correcto) sigue "vivo" 40 s más de lo que dura su arriendo (CA-10).
//  Control (verde): con todos los relojes correctos, a los 35 s el cupo se libera y el trabajo se recupera.
import { randomUUID } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renovarArriendos, tomarEjecucion } from "./arriendos.js";
import { registrarTipo } from "./catalogo.js";
import { crearClaves, type ClavesCola } from "./claves.js";
import { Despachador } from "./despachador.js";
import { Reconciliador } from "./reconciliador.js";
import {
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  dormir,
  Escenario,
  limpiarPrefijo,
  RelojAjustable,
  type ClientePrueba,
} from "./soporte-pruebas/int.js";
import type { PayloadTrabajo, Reloj } from "./tipos.js";

const TIPO_NO_IDEMPOTENTE = "prueba.noidem_rdosb";
registrarTipo({
  tipo: TIPO_NO_IDEMPOTENTE,
  cola: "sire",
  canal: "sire",
  credencial: null,
  permiso: null,
  idempotente: false, // como `sire.reemplazo.enviar`: si se interrumpe, error/interrumpido y no se reenvía
  parametros: z.object({ n: z.number().optional() }),
});

const DESFASE_MS = 40_000;
const relojCorrecto: Reloj = { ahora: () => new Date() };
const relojCon = (ms: number): RelojAjustable => {
  const r = new RelojAjustable();
  r.avanzar(ms);
  return r;
};

let admin: ContappDb;
let worker: ContappDb;
let redis: Redis;
let e: Escenario;
let limite: number;
const prefijos: string[] = [];

/** El worker real, pero `withSistema` solo devuelve el estudio del escenario (el reconciliador no toca ajenos). */
function soloPropios(db: ContappDb, propios: ReadonlySet<string>): ContappDb {
  return new Proxy(db, {
    get(t, p, rcv) {
      if (p === "withSistema")
        return async (fn: (tx: unknown) => Promise<unknown>) => {
          const r = await (t.withSistema as (f: typeof fn) => Promise<unknown>).call(t, fn);
          return Array.isArray(r) && r.every((x) => typeof x === "string") ? r.filter((x) => propios.has(x)) : r;
        };
      const v = Reflect.get(t, p, rcv);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as ContappDb;
}

interface Banco {
  prefijo: string;
  k: ClavesCola;
  T: string;
  clientes: ClientePrueba[];
  ids: string[];
}

async function banco(n: number, tipo = "prueba.eco"): Promise<Banco> {
  const prefijo = `r2b-q-${randomUUID().slice(0, 8)}:`;
  prefijos.push(prefijo);
  const k = crearClaves(prefijo);
  const T = await e.estudio();
  const clientes: ClientePrueba[] = [];
  for (let i = 0; i < n; i++) clientes.push(await e.cliente(T));
  const ids = await e.trabajosEnMasa(T, clientes, n, { tipo });
  await redis.sadd(k.tenants("sire"), T);
  return { prefijo, k, T, clientes, ids };
}

const anotar = (lista: PayloadTrabajo[]) => async (_c: string, p: PayloadTrabajo) => {
  lista.push(p);
};

function despachador(b: Banco, reloj: Reloj): Despachador {
  return new Despachador({ db: worker, redis, reloj, prefijo: b.prefijo, agregarACola: anotar([]) });
}

function reconciliador(b: Banco, reloj: Reloj): Reconciliador {
  return new Reconciliador({ db: soloPropios(worker, new Set([b.T])), redis, reloj, prefijo: b.prefijo });
}

async function estadosDe(T: string): Promise<Map<string, { estado: string; motivo: string | null; intentos: number }>> {
  const r = await admin.pool.query("select id, estado, motivo, intentos from job_registro where tenant_id = $1", [T]);
  return new Map(r.rows.map((f) => [f.id as string, { estado: f.estado, motivo: f.motivo, intentos: Number(f.intentos) }]));
}

async function enEjecucion(T: string): Promise<string[]> {
  return [...(await estadosDe(T))].filter(([, v]) => v.estado === "ejecutando").map(([id]) => id);
}

/** Despacha hasta llenar el cupo del estudio (`limite`) con relojes correctos. */
async function llenarCupo(b: Banco): Promise<string[]> {
  await redis.del(b.k.lider("sire"));
  const d = despachador(b, relojCorrecto);
  for (let i = 0; i < limite + 2; i++) await d.ciclo();
  const vivos = await enEjecucion(b.T);
  expect(vivos.length).toBe(limite);
  return vivos;
}

/** Ejecutor de otro proceso: toma `ejec:` y hace un latido con SU reloj; luego muere (deja vencer todo). */
async function ejecutorQueMuere(b: Banco, id: string, ahoraEjecutorMs: number): Promise<void> {
  const fila = (await admin.pool.query("select ruc from job_registro where id = $1", [id])).rows[0];
  const ejecucion = randomUUID();
  expect(await tomarEjecucion(redis, b.k, id, ejecucion)).toBe(true);
  await renovarArriendos(
    redis,
    b.k,
    { id, tenantId: b.T, cola: "sire", canal: "sire", ruc: fila.ruc as string, ejecucion },
    ahoraEjecutorMs,
  );
}

beforeAll(async () => {
  admin = crearDbAdmin();
  worker = crearDbRol("contapp_worker", 6);
  redis = conectarRedis();
  e = new Escenario(admin);
  const r = await admin.pool.query("select concurrencia_tenant from config_sistema where cola = 'sire'");
  limite = Number(r.rows[0].concurrencia_tenant);
}, 30_000);

afterAll(async () => {
  await e?.limpiar();
  for (const p of prefijos) await limpiarPrefijo(redis, p).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([worker?.close(), admin?.close()]);
});

describe("reconciliador con el reloj adelantado (sin espera)", () => {
  it("no da por vencido un trabajo recién despachado cuyo ejecutor todavía no tomó `ejec:`", async () => {
    const b = await banco(2, TIPO_NO_IDEMPOTENTE);
    await redis.del(b.k.lider("sire"));
    await despachador(b, relojCorrecto).ciclo();
    const [recien] = await enEjecucion(b.T);
    expect(recien).toBeDefined();
    // Otro trabajo del estudio lleva > 30 s sin cambios (estudio con cola acumulada): el reconciliador lo atiende.
    await e.envejecer(b.ids.filter((x) => x !== recien));
    await reconciliador(b, relojCon(DESFASE_MS)).ciclo();
    const f = (await estadosDe(b.T)).get(recien!)!;
    expect(f, "un trabajo despachado hace milisegundos quedó resuelto como interrumpido").toEqual({
      estado: "ejecutando",
      motivo: null,
      intentos: 0,
    });
  });
});

describe("ejecutores que mueren con relojes desfasados (espera real del arriendo de 30 s)", () => {
  let adelantado: Banco; // ejecutor +40 s
  let atrasado: Banco; // ejecutor correcto; líder y reconciliador −40 s
  let control: Banco; // todos correctos
  const muertos = new Map<Banco, string[]>();

  beforeAll(async () => {
    adelantado = await banco(limite + 1);
    atrasado = await banco(limite + 1);
    control = await banco(limite + 1);
    for (const [b, desfase] of [
      [adelantado, DESFASE_MS],
      [atrasado, 0],
      [control, 0],
    ] as const) {
      const vivos = await llenarCupo(b);
      for (const id of vivos) await ejecutorQueMuere(b, id, Date.now() + desfase);
      muertos.set(b, vivos);
    }
    // 35 s: vence el TTL de `ejec:` (30 s, reloj de Redis) y el arriendo de los cupos escritos con el reloj común.
    const mios = [adelantado.T, atrasado.T, control.T];
    const fin = Date.now() + 35_000;
    while (Date.now() < fin) {
      await admin.pool.query("update job_registro set actualizado_en = now() where tenant_id = any($1::uuid[])", [mios]);
      await dormir(2_000);
    }
    const r = await admin.pool.query("select id from job_registro where tenant_id = any($1::uuid[])", [mios]);
    await e.envejecer(r.rows.map((x) => x.id as string));
    for (const b of [adelantado, atrasado, control]) {
      for (const id of muertos.get(b)!) expect(await redis.exists(b.k.ejec(id))).toBe(0);
    }
  }, 90_000);

  it("control: con relojes correctos, vencido el arriendo se despacha el pendiente y se recuperan los muertos", async () => {
    await redis.del(control.k.lider("sire"));
    await despachador(control, relojCorrecto).ciclo();
    const pendiente = control.ids.find((x) => !muertos.get(control)!.includes(x))!;
    expect((await estadosDe(control.T)).get(pendiente)!.estado).toBe("ejecutando");
    const r = await reconciliador(control, relojCorrecto).ciclo();
    expect(r.reencolados).toBe(limite);
  });

  it("ejecutor adelantado 40 s: el despachador (reloj correcto) libera su cupo al vencer el arriendo", async () => {
    await redis.del(adelantado.k.lider("sire"));
    await despachador(adelantado, relojCorrecto).ciclo();
    const pendiente = adelantado.ids.find((x) => !muertos.get(adelantado)!.includes(x))!;
    expect(
      (await estadosDe(adelantado.T)).get(pendiente)!.estado,
      "el cupo del ejecutor muerto sigue ocupado: su latido lo fechó con el reloj adelantado",
    ).toBe("ejecutando");
  });

  it("ejecutor adelantado 40 s: el reconciliador (reloj correcto) recupera sus trabajos al vencer el arriendo", async () => {
    const r = await reconciliador(adelantado, relojCorrecto).ciclo();
    const estados = await estadosDe(adelantado.T);
    const sinRecuperar = muertos.get(adelantado)!.filter((id) => estados.get(id)!.estado === "ejecutando");
    expect(r.reencolados + r.interrumpidos, `sin recuperar: ${sinRecuperar.length}`).toBe(limite);
  });

  it("líder atrasado 40 s: poda el cupo de un ejecutor muerto en cuanto vence su arriendo", async () => {
    await redis.del(atrasado.k.lider("sire"));
    await despachador(atrasado, relojCon(-DESFASE_MS)).ciclo();
    const pendiente = atrasado.ids.find((x) => !muertos.get(atrasado)!.includes(x))!;
    expect(
      (await estadosDe(atrasado.T)).get(pendiente)!.estado,
      "el líder atrasado sigue contando el cupo vencido (poda con su hora local)",
    ).toBe("ejecutando");
  });

  it("reconciliador atrasado 40 s: recupera los trabajos de un ejecutor muerto en cuanto vence su arriendo", async () => {
    const r = await reconciliador(atrasado, relojCon(-DESFASE_MS)).ciclo();
    expect(r.reencolados + r.interrumpidos).toBe(limite);
  });
});
