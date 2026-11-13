// Spec 022 · T3 · ADVERSARIO: lectura acotada de la lista de pistas (`pistasPrevias` con ZRANGE 0..K-1) frente a las
// garantías G1 a G4 de `cerrarEstudioVacio` con N > K. No repite A1 a A12 de `despachador-t11c.adv.int.spec.ts`.
// PostgreSQL y Redis reales (base 15, un prefijo propio por prueba).
//
// Las carreras se fijan de forma determinista: un Redis-proxy ejecuta al «intruso» antes o después de un comando
// concreto del despachador, y `leerTrabajo` (mock fino sobre @contapp/db) puede hacerlo antes de leer un id dado.
// Puntaje de las pistas: `publicar` usa creado_en del trabajo (ms). Los restos sembrados con VIEJO quedan DELANTE de
// cualquier trabajo real (dentro del tramo) y los sembrados con NUEVO quedan DETRÁS (un trabajo real cae en el tramo).
//
// `it.fails` = hallazgo abierto (H-022-n): la prueba reproduce el defecto; T4 quita la anotación al corregirlo.
import { randomUUID } from "node:crypto";
import { transicionar, type ContappDb, type TrabajoFila } from "@contapp/db";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { liberarArriendos } from "./arriendos.js";
import { crearClaves, type ClavesCola } from "./claves.js";
import { Despachador, TRAMO_PISTAS as K } from "./despachador.js";
import { publicar } from "./encolado.js";
import { Reconciliador, type ResumenReconciliacion } from "./reconciliador.js";
import {
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  Escenario,
  limpiarPrefijo,
  type ClientePrueba,
} from "./soporte-pruebas/int.js";
import type { PayloadTrabajo } from "./tipos.js";

// `leerTrabajo` contado y con un gancho de un solo uso antes de leer un id dado; el resto de @contapp/db es el real.
const ctl = vi.hoisted(() => ({
  leidos: 0,
  gancho: null as null | { id: string; accion: () => Promise<void> },
}));
vi.mock("@contapp/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@contapp/db")>();
  return {
    ...real,
    leerTrabajo: async (...a: Parameters<typeof real.leerTrabajo>) => {
      ctl.leidos++;
      const g = ctl.gancho;
      if (g !== null && a[1] === g.id) {
        ctl.gancho = null;
        // El intruso es otro proceso: corre fuera del contexto de withTenant del despachador (si no, «anidado»).
        const als = (globalThis as Record<symbol, unknown>)[
          Symbol.for("@contapp/db/with-tenant/als")
        ] as { exit<R>(f: () => R): R };
        await als.exit(() => g.accion());
      }
      return real.leerTrabajo(...a);
    },
  };
});

const COLAS = ["sire", "sol", "xml", "archivos"] as const;
/** Restos delante de cualquier trabajo real (creado_en en ms es ≈ 1,7e12). */
const VIEJO = 1_000_000;
/** Restos detrás de cualquier interactivo de hoy y delante de los programados (1e13 + creado_en). */
const NUEVO = 9e12;

let admin: ContappDb;
let worker: ContappDb;
let redis: Redis;
let e: Escenario;
let leerReal: (typeof import("@contapp/db"))["leerTrabajo"];
const prefijos: string[] = [];

beforeAll(async () => {
  admin = crearDbAdmin();
  worker = crearDbRol("contapp_worker", 6);
  redis = conectarRedis();
  e = new Escenario(admin);
  leerReal = (
    await vi.importActual<typeof import("@contapp/db")>("@contapp/db")
  ).leerTrabajo;
}, 30_000);

afterAll(async () => {
  await e?.limpiar();
  for (const p of prefijos)
    await limpiarPrefijo(redis, p).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([worker?.close(), admin?.close()]);
});

interface Caso {
  prefijo: string;
  k: ClavesCola;
  T: string;
  c: ClientePrueba;
  pend: string;
}

async function caso(): Promise<Caso> {
  const prefijo = `t022-adv-${randomUUID().slice(0, 8)}:`;
  prefijos.push(prefijo);
  const k = crearClaves(prefijo);
  const T = await e.estudio();
  const c = await e.cliente(T);
  return { prefijo, k, T, c, pend: k.pend("sire", T) };
}

/** `n` restos (ids sin fila en BD) con puntajes base+1..base+n y el estudio anotado en tenants:sire. */
async function restos(x: Caso, n: number, base: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 5000) {
    const args: (string | number)[] = [];
    for (let j = i; j < Math.min(n, i + 5000); j++) {
      const id = randomUUID();
      ids.push(id);
      args.push(base + j + 1, id);
    }
    await redis.zadd(x.pend, ...args);
  }
  await redis.sadd(x.k.tenants("sire"), x.T);
  return ids;
}

const leer = (x: Caso, id: string): Promise<TrabajoFila | null> =>
  worker.withTenant({ tenantId: x.T }, (tx) => leerReal(tx, id));

/** Publica como el ejecutor/encolar: ZADD con creado_en del trabajo + SADD tenants. */
async function pista(x: Caso, id: string): Promise<void> {
  const f = await leer(x, id);
  if (f === null) throw new Error("sin fila");
  await publicar(
    redis,
    [
      {
        id,
        tenantId: x.T,
        cola: f.cola,
        prioridad: f.prioridad,
        creadoEn: f.creadoEn,
      },
    ],
    { prefijo: x.prefijo },
  );
}

/** Trabajo nuevo `en_cola` (sin pista). */
async function trabajo(x: Caso): Promise<string> {
  const [id] = await e.trabajosEnMasa(x.T, x.c, 1);
  return id!;
}

/** Trabajos `ejecutando` (sin cupo ni `ejec:` en Redis) con su pista vieja en la lista: restos de un despacho. */
async function ejecutandoConPista(x: Caso, n: number): Promise<string[]> {
  const ids = await e.trabajosEnMasa(x.T, x.c, n);
  await admin.pool.query(
    "update job_registro set estado = 'ejecutando', iniciado_en = now(), actualizado_en = now() where id = any($1::uuid[])",
    [ids],
  );
  const filas = await worker.withTenant({ tenantId: x.T }, async (tx) => {
    const r: TrabajoFila[] = [];
    for (const id of ids) r.push((await leerReal(tx, id))!);
    return r;
  });
  for (let i = 0; i < filas.length; i += 2000)
    await publicar(
      redis,
      filas.slice(i, i + 2000).map((f) => ({
        id: f.id,
        tenantId: x.T,
        cola: f.cola,
        prioridad: f.prioridad,
        creadoEn: f.creadoEn,
      })),
      { prefijo: x.prefijo },
    );
  return ids;
}

/** Reintento del ejecutor con el MISMO id (ejecutor.ts): commit ejecutando -> en_cola, suelta arriendos y publica. */
async function reintento(x: Caso, id: string): Promise<void> {
  const f = await leer(x, id);
  if (f === null) throw new Error("sin fila");
  const ok = await worker.withTenant({ tenantId: x.T }, (tx) =>
    transicionar(
      tx,
      id,
      "ejecutando",
      "en_cola",
      { intentos: f.intentos + 1, disponibleDesde: new Date() },
      { intentos: f.intentos },
    ),
  );
  if (!ok) throw new Error("reintento perdido");
  await liberarArriendos(redis, x.k, f, 0);
  await pista(x, id);
}

/** Pasada del reconciliador solo sobre el estudio de la prueba (como en T11c). */
async function reconciliar(x: Caso): Promise<ResumenReconciliacion> {
  const rec = new Reconciliador({
    db: worker,
    redis,
    reloj: { ahora: () => new Date() },
    prefijo: x.prefijo,
    antiguedadSeg: 0,
  });
  const resumen: ResumenReconciliacion = {
    estudios: 1,
    repuestos: 0,
    reencolados: 0,
    interrumpidos: 0,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- se aísla la pasada a un estudio
  const r = rec as any;
  await r.atenderEstudio(x.T, await r.config.obtener(), resumen);
  return resumen;
}

const cancelar = (x: Caso, id: string): Promise<boolean> =>
  worker.withTenant({ tenantId: x.T }, (tx) =>
    transicionar(tx, id, "en_cola", "cancelado", {
      motivo: "cancelado_usuario",
    }),
  );

interface Gancho {
  comando: string;
  clave?: string;
  momento: "antes" | "despues";
  accion?: () => Promise<void>;
  lanzar?: boolean;
}

interface Registro {
  /** ZRANGE sobre listas de pistas: cuántos ids devolvió cada uno y si pidió la lista entera. */
  zrange: { clave: string; fin: string; devueltos: number }[];
  /** ZREM sobre listas de pistas: cuántos ids pidió quitar cada uno. */
  zrem: { clave: string; n: number }[];
}

/** Redis-proxy: registra ZRANGE/ZREM sobre `pend:` y dispara cada gancho una sola vez en la primera coincidencia. */
function instrumentar(ganchos: Gancho[] = []): {
  redis: Redis;
  reg: Registro;
  disparados: () => number;
} {
  const pendientes = [...ganchos];
  const reg: Registro = { zrange: [], zrem: [] };
  let n = 0;
  const proxy = new Proxy(redis, {
    get(t, p, rcv) {
      const v = Reflect.get(t, p, rcv);
      if (typeof v !== "function") return v;
      const observado = p === "zrange" || p === "zrem";
      if (!observado && !pendientes.some((g) => g.comando === p))
        return v.bind(t);
      return async (...a: unknown[]) => {
        const i = pendientes.findIndex(
          (g) => g.comando === p && (g.clave === undefined || a[0] === g.clave),
        );
        const g = i >= 0 ? pendientes.splice(i, 1)[0] : undefined;
        if (g !== undefined) n++;
        if (g?.lanzar) throw new Error("redis caído (simulado)");
        if (g?.momento === "antes") await g.accion?.();
        const r = await (v as (...x: unknown[]) => Promise<unknown>).apply(
          t,
          a,
        );
        if (g?.momento === "despues") await g.accion?.();
        const clave = String(a[0]);
        if (clave.includes("pend:")) {
          if (p === "zrange")
            reg.zrange.push({
              clave,
              fin: String(a[2]),
              devueltos: (r as string[]).length,
            });
          if (p === "zrem") reg.zrem.push({ clave, n: a.length - 1 });
        }
        return r;
      };
    },
  }) as Redis;
  return { redis: proxy, reg, disparados: () => n };
}

type Despachos = Array<{ cola: string; jobId: string }>;

function despachador(
  x: Caso,
  rd: Redis = redis,
  lista: Despachos = [],
): Despachador {
  return new Despachador({
    db: worker,
    redis: rd,
    reloj: { ahora: () => new Date() },
    prefijo: x.prefijo,
    agregarACola: async (cola: string, p: PayloadTrabajo) => {
      lista.push({ cola, jobId: p.jobId });
    },
  });
}

async function soltarLiderazgo(k: ClavesCola): Promise<void> {
  await redis.del(...COLAS.map((c) => k.lider(c)));
}

async function ciclo(x: Caso, d: Despachador): Promise<void> {
  await soltarLiderazgo(x.k);
  await d.ciclo();
}

const enTenants = async (x: Caso): Promise<number> =>
  redis.sismember(x.k.tenants("sire"), x.T);
const enPend = async (x: Caso, id: string): Promise<boolean> =>
  (await redis.zscore(x.pend, id)) !== null;

/** Ciclos hasta que el estudio sale de tenants (falla si pasa de `tope`); luego 2 ciclos más sin tocar su lista (G4). */
async function converger(
  x: Caso,
  d: Despachador,
  reg: Registro,
  tope: number,
): Promise<number> {
  let ciclos = 0;
  while ((await enTenants(x)) === 1) {
    expect(++ciclos, "no converge (G4)").toBeLessThanOrEqual(tope);
    await ciclo(x, d);
  }
  expect(await redis.zcard(x.pend)).toBe(0);
  const antes = reg.zrange.filter((z) => z.clave === x.pend).length;
  await ciclo(x, d);
  await ciclo(x, d);
  expect(
    reg.zrange.filter((z) => z.clave === x.pend).length,
    "sin bucle posterior",
  ).toBe(antes);
  for (const z of reg.zrange) {
    expect(z.fin).not.toBe("-1");
    expect(z.devueltos).toBeLessThanOrEqual(K);
  }
  for (const q of reg.zrem) expect(q.n).toBeLessThanOrEqual(K);
  return ciclos;
}

const ciclosCA4 = (n: number): number => Math.ceil(n / K) + 1;

describe("022 T3 ADV · G1: publicación entre la lectura acotada y la lectura en BD", () => {
  it("B1 · trabajo nuevo FUERA del tramo (N = 2K + 50 restos delante): no se borra, sale despachado y luego converge", async () => {
    const x = await caso();
    const N = 2 * K + 50;
    await restos(x, N, VIEJO);
    let X = "";
    const {
      redis: rd,
      reg,
      disparados,
    } = instrumentar([
      {
        comando: "zrange",
        clave: x.pend,
        momento: "despues",
        accion: async () => {
          X = await trabajo(x);
          await pista(x, X);
        },
      },
    ]);
    const lista: Despachos = [];
    const d = despachador(x, rd, lista);
    await ciclo(x, d);
    expect(disparados()).toBe(1);
    expect(
      lista.some((l) => l.jobId === X) || (await enPend(x, X)),
      "la pista publicada tras el ZRANGE no se borra",
    ).toBe(true);
    expect(await enTenants(x)).toBe(1);
    await converger(x, d, reg, ciclosCA4(N) + 3);
    expect(lista.filter((l) => l.jobId === X)).toHaveLength(1);
  });

  it.each([
    ["DENTRO del tramo (restos detrás)", NUEVO],
    ["FUERA del tramo (2K restos delante)", VIEJO],
  ])(
    "B2 · el mismo id ya en la lista (resto de un `ejecutando`) se reintenta entre el ZRANGE y la BD, %s: se despacha una vez",
    async (_d, base) => {
      const x = await caso();
      const [X] = await ejecutandoConPista(x, 1);
      await restos(x, 2 * K, base);
      const rango = await redis.zrank(x.pend, X!);
      expect(rango! < K).toBe(base === NUEVO);
      const {
        redis: rd,
        reg,
        disparados,
      } = instrumentar([
        {
          comando: "zrange",
          clave: x.pend,
          momento: "despues",
          accion: () => reintento(x, X!),
        },
      ]);
      const lista: Despachos = [];
      const d = despachador(x, rd, lista);
      await ciclo(x, d);
      expect(disparados()).toBe(1);
      expect(lista.some((l) => l.jobId === X) || (await enPend(x, X!))).toBe(
        true,
      );
      expect(await enTenants(x)).toBe(1);
      await converger(x, d, reg, ciclosCA4(2 * K + 1) + 3);
      expect(lista.filter((l) => l.jobId === X)).toHaveLength(1);
    },
  );
});

describe("022 T3 ADV · G2: `ejecutando` que se reintenta con el mismo id", () => {
  it.each([
    ["DENTRO del tramo", NUEVO],
    ["FUERA del tramo", VIEJO],
  ])(
    "B3 · reintento entre la lectura en BD y el ZREM, pista vieja %s (N = 2K + 1): la pista nueva sobrevive y se despacha",
    async (_d, base) => {
      const x = await caso();
      const [X] = await ejecutandoConPista(x, 1);
      await restos(x, 2 * K, base);
      const {
        redis: rd,
        reg,
        disparados,
      } = instrumentar([
        {
          comando: "zrem",
          clave: x.pend,
          momento: "antes",
          accion: () => reintento(x, X!),
        },
      ]);
      const lista: Despachos = [];
      const d = despachador(x, rd, lista);
      await ciclo(x, d);
      expect(disparados()).toBe(1);
      expect((await leer(x, X!))?.estado).toBe("en_cola");
      expect({
        pend: await enPend(x, X!),
        tenants: await enTenants(x),
      }).toEqual({ pend: true, tenants: 1 });
      await converger(x, d, reg, ciclosCA4(2 * K + 1) + 3);
      expect(lista).toEqual([{ cola: "sire", jobId: X }]);
    },
  );

  // H-022-1 (media, preexistente desde 018 T11c): la «lectura en BD» no es atómica (READ COMMITTED, varias sentencias).
  // Si el reintento hace commit DESPUÉS de `contarPendientes` (0) y ANTES del `leerTrabajo` de su id, ese id se lee
  // `en_cola`: no entra en `ejecutando` (solo se releen los `ejecutando`), su pista recién publicada se borra en el ZREM
  // y, si el tramo vacía la lista (N = K), el estudio sale de `tenants` con el trabajo en_cola: queda varado hasta el
  // reconciliador (≥ 30 s). despachador.ts:214-218 y :357-386.
  it.fails.each([
    ["el ejecutor", "ejecutor"],
    ["el reconciliador", "reconciliador"],
  ] as const)(
    "H-022-1 · tramo exactamente K: %s re-encola X entre contarPendientes y leerTrabajo(X); X no debe quedar varado",
    async (_d, actor) => {
      const x = await caso();
      const [X] = await ejecutandoConPista(x, 1);
      await restos(x, K - 1, NUEVO);
      expect(await redis.zcard(x.pend)).toBe(K);
      ctl.gancho = {
        id: X!,
        accion: async () => {
          if (actor === "ejecutor") await reintento(x, X!);
          else expect((await reconciliar(x)).reencolados).toBe(1);
        },
      };
      await ciclo(x, despachador(x));
      const disparado = ctl.gancho === null;
      ctl.gancho = null;
      expect({
        disparado,
        estado: (await leer(x, X!))?.estado,
        pend: await enPend(x, X!),
        tenants: await enTenants(x),
      }).toEqual({
        disparado: true,
        estado: "en_cola",
        pend: true,
        tenants: 1,
      });
    },
  );

  it("B4 · la misma carrera con N > K: el paso 4 (ZCARD > 0) repone al estudio y X sale en el ciclo siguiente", async () => {
    const x = await caso();
    const [X] = await ejecutandoConPista(x, 1);
    await restos(x, 2 * K, NUEVO);
    ctl.gancho = { id: X!, accion: () => reintento(x, X!) };
    const lista: Despachos = [];
    const { redis: rd, reg } = instrumentar();
    const d = despachador(x, rd, lista);
    await ciclo(x, d);
    expect(ctl.gancho, "el gancho se disparó").toBeNull();
    expect(await enTenants(x)).toBe(1);
    await converger(x, d, reg, ciclosCA4(2 * K + 1) + 3);
    expect(lista).toEqual([{ cola: "sire", jobId: X }]);
  });

  it.each(["zrem", "srem"])(
    "B5 · el reconciliador re-encola X (pista vieja dentro del tramo, N = 2K + 1) justo antes del %s: X sigue publicado y se despacha",
    async (comando) => {
      const x = await caso();
      const [X] = await ejecutandoConPista(x, 1);
      await restos(x, 2 * K, NUEVO);
      let resumen: ResumenReconciliacion | undefined;
      const {
        redis: rd,
        reg,
        disparados,
      } = instrumentar([
        {
          comando,
          clave: comando === "zrem" ? x.pend : x.k.tenants("sire"),
          momento: "antes",
          accion: async () => {
            resumen = await reconciliar(x);
          },
        },
      ]);
      const lista: Despachos = [];
      const d = despachador(x, rd, lista);
      await ciclo(x, d);
      expect(disparados()).toBe(1);
      expect(resumen?.reencolados).toBe(1);
      expect({
        pend: await enPend(x, X!),
        tenants: await enTenants(x),
      }).toEqual({ pend: true, tenants: 1 });
      await converger(x, d, reg, ciclosCA4(2 * K + 1) + 3);
      expect(lista).toEqual([{ cola: "sire", jobId: X }]);
    },
  );

  // H-022-2 (baja): CA-2 y D-1 dicen «como máximo K lecturas de `leerTrabajo`» por atención. Con un tramo de ids
  // `ejecutando` se leen dos veces (despachador.ts:216-218 y la relectura de :364-367): 2K por atención.
  it.fails(
    "H-022-2 · CA-2 con N = 2.000 pistas de trabajos `ejecutando`: una atención hace ≤ K leerTrabajo",
    async () => {
      const x = await caso();
      await ejecutandoConPista(x, 2_000);
      const { redis: rd, reg } = instrumentar();
      ctl.leidos = 0;
      await ciclo(x, despachador(x, rd));
      const leidos = ctl.leidos;
      expect(reg.zrange.filter((z) => z.clave === x.pend)).toHaveLength(1);
      expect(leidos).toBeLessThanOrEqual(K);
    },
    60_000,
  );
});

describe("022 T3 ADV · G3: nunca un trabajo en la lista con el estudio fuera de tenants", () => {
  it.each([
    ["después del ZREM", "zrem", "despues"],
    ["antes del SREM", "srem", "antes"],
    ["entre el SREM y el ZCARD", "srem", "despues"],
    ["después del ZCARD", "zcard", "despues"],
  ] as const)(
    "B6 · tramo exactamente K y publicación de Y %s: Y sigue en la lista, el estudio en tenants y Y se despacha",
    async (_d, comando, momento) => {
      const x = await caso();
      await restos(x, K, VIEJO);
      let Y = "";
      const {
        redis: rd,
        reg,
        disparados,
      } = instrumentar([
        {
          comando,
          clave: comando === "srem" ? x.k.tenants("sire") : x.pend,
          momento,
          accion: async () => {
            Y = await trabajo(x);
            await pista(x, Y);
          },
        },
      ]);
      const lista: Despachos = [];
      const d = despachador(x, rd, lista);
      await ciclo(x, d);
      expect(disparados()).toBe(1);
      expect({ pend: await enPend(x, Y), tenants: await enTenants(x) }).toEqual(
        { pend: true, tenants: 1 },
      );
      await converger(x, d, reg, 4);
      expect(lista).toEqual([{ cola: "sire", jobId: Y }]);
    },
  );

  it("B7 · muchos estudios (20 × (2K + 1) restos) y uno con un trabajo real: cada estudio lee ≤ K por ciclo, el trabajo sale en el primer ciclo y todos convergen", async () => {
    const x = await caso();
    const N = 2 * K + 1;
    const otros: Caso[] = [];
    for (let i = 0; i < 20; i++) {
      const T = await e.estudio();
      const o: Caso = { ...x, T, pend: x.k.pend("sire", T) };
      await restos(o, N, VIEJO);
      otros.push(o);
    }
    const X = await trabajo(x);
    await pista(x, X);
    const { redis: rd, reg } = instrumentar();
    const lista: Despachos = [];
    const d = despachador(x, rd, lista);
    let ciclos = 0;
    while ((await redis.scard(x.k.tenants("sire"))) > 0) {
      expect(++ciclos, "no converge").toBeLessThanOrEqual(ciclosCA4(N) + 1);
      const enCurso = await redis.smembers(x.k.tenants("sire"));
      const antes = reg.zrange.length;
      await ciclo(x, d);
      expect(reg.zrange.length - antes, "un ZRANGE por estudio y ciclo").toBe(
        enCurso.length,
      );
      if (ciclos === 1) expect(lista).toEqual([{ cola: "sire", jobId: X }]);
    }
    for (const o of otros) expect(await redis.zcard(o.pend)).toBe(0);
    for (const z of reg.zrange) expect(z.devueltos).toBeLessThanOrEqual(K);
    for (const q of reg.zrem) expect(q.n).toBeLessThanOrEqual(K);
  }, 60_000);
});

describe("022 T3 ADV · G4 y bordes: convergencia sin bucle", () => {
  it("B8 · N = 3K + 7 trabajos que siguen `ejecutando`: converge en ≤ ⌈N/K⌉ + 1 ciclos y no los republica", async () => {
    const x = await caso();
    const N = 3 * K + 7;
    const ids = await ejecutandoConPista(x, N);
    const { redis: rd, reg } = instrumentar();
    const lista: Despachos = [];
    const d = despachador(x, rd, lista);
    expect(await converger(x, d, reg, ciclosCA4(N))).toBeLessThanOrEqual(
      ciclosCA4(N),
    );
    expect(lista).toEqual([]);
    const est = await e.estados(ids);
    expect([...est.values()].every((s) => s.estado === "ejecutando")).toBe(
      true,
    );
  }, 60_000);

  it("B9 · cancelación de X (fuera del tramo) entre el ZRANGE y la BD con N = 2K restos: X no se despacha y todo converge", async () => {
    const x = await caso();
    await restos(x, 2 * K, VIEJO);
    const X = await trabajo(x);
    await pista(x, X);
    expect(await redis.zrank(x.pend, X)).toBe(2 * K);
    const {
      redis: rd,
      reg,
      disparados,
    } = instrumentar([
      {
        comando: "zrange",
        clave: x.pend,
        momento: "despues",
        accion: async () => {
          expect(await cancelar(x, X)).toBe(true);
        },
      },
    ]);
    const lista: Despachos = [];
    const d = despachador(x, rd, lista);
    await ciclo(x, d);
    expect(disparados()).toBe(1);
    expect(await enPend(x, X), "fuera del tramo: no se borró").toBe(true);
    expect(await enTenants(x)).toBe(1);
    await converger(x, d, reg, ciclosCA4(2 * K + 1));
    expect(lista).toEqual([]);
  });

  it("B10 · el ZRANGE falla una vez con N = 2K + 1: no se borra nada, el estudio sigue en tenants y luego converge", async () => {
    const x = await caso();
    const N = 2 * K + 1;
    await restos(x, N, VIEJO);
    const {
      redis: rd,
      reg,
      disparados,
    } = instrumentar([
      { comando: "zrange", clave: x.pend, momento: "antes", lanzar: true },
    ]);
    const d = despachador(x, rd);
    await ciclo(x, d);
    expect(disparados()).toBe(1);
    expect({
      n: await redis.zcard(x.pend),
      tenants: await enTenants(x),
    }).toEqual({ n: N, tenants: 1 });
    await converger(x, d, reg, ciclosCA4(N));
  });

  it("B11 · dos despachadores (cambio de líder) sobre el mismo tramo y publicación de Y antes del ZREM del líder viejo: Y no se pierde", async () => {
    const x = await caso();
    const N = 2 * K + 10;
    await restos(x, N, VIEJO);
    const lista: Despachos = [];
    let Y = "";
    const {
      redis: rd,
      reg,
      disparados,
    } = instrumentar([
      {
        comando: "zrange",
        clave: x.pend,
        momento: "despues",
        accion: async () => {
          await soltarLiderazgo(x.k);
          await despachador(x, redis, lista).ciclo(); // D2 cierra el mismo tramo
        },
      },
      {
        comando: "zrem",
        clave: x.pend,
        momento: "antes",
        accion: async () => {
          Y = await trabajo(x);
          await pista(x, Y);
        },
      },
    ]);
    await despachador(x, rd, lista).ciclo(); // D1 (líder viejo)
    expect(disparados()).toBe(2);
    expect({
      n: await redis.zcard(x.pend),
      y: await enPend(x, Y),
      tenants: await enTenants(x),
    }).toEqual({ n: N - K + 1, y: true, tenants: 1 });
    await converger(x, despachador(x, rd, lista), reg, ciclosCA4(N) + 2);
    expect(lista).toEqual([{ cola: "sire", jobId: Y }]);
  });

  it.each([
    [0, 1],
    [K, 1],
    [K + 1, 2],
  ])(
    "B12 · lista con %i restos: sale de tenants en %i ciclo(s), sin ZREM vacío ni bucle",
    async (n, esperados) => {
      const x = await caso();
      await restos(x, n, VIEJO);
      const { redis: rd, reg } = instrumentar();
      const d = despachador(x, rd);
      expect(await converger(x, d, reg, esperados)).toBe(esperados);
      expect(reg.zrem.every((q) => q.n > 0)).toBe(true);
      expect(reg.zrem.length).toBe(Math.ceil(n / K));
    },
  );

  it("B13 · Redis cae en el ZREM del tramo (N = 2K): el ciclo se aborta sin perder al estudio ni a los restos, y converge", async () => {
    const x = await caso();
    await restos(x, 2 * K, VIEJO);
    const {
      redis: rd,
      reg,
      disparados,
    } = instrumentar([
      { comando: "zrem", clave: x.pend, momento: "antes", lanzar: true },
    ]);
    const d = despachador(x, rd);
    await ciclo(x, d);
    expect(disparados()).toBe(1);
    expect({
      n: await redis.zcard(x.pend),
      tenants: await enTenants(x),
    }).toEqual({ n: 2 * K, tenants: 1 });
    await converger(x, d, reg, ciclosCA4(2 * K));
  });

  it("B14 · Redis cae en el ZCARD tras el SREM (N = 2K + 5): el estudio sale con K + 5 restos huérfanos; la próxima publicación lo repone y todo converge", async () => {
    const x = await caso();
    await restos(x, 2 * K + 5, VIEJO);
    const {
      redis: rd,
      reg,
      disparados,
    } = instrumentar([
      { comando: "zcard", clave: x.pend, momento: "antes", lanzar: true },
    ]);
    const lista: Despachos = [];
    const d = despachador(x, rd, lista);
    await ciclo(x, d);
    expect(disparados()).toBe(1);
    // Solo restos (ningún trabajo en_cola) quedan sin estudio en tenants: G3 se cumple; son basura hasta la próxima pista.
    expect({
      n: await redis.zcard(x.pend),
      tenants: await enTenants(x),
    }).toEqual({ n: K + 5, tenants: 0 });
    const Y = await trabajo(x);
    await pista(x, Y);
    await converger(x, d, reg, ciclosCA4(K + 6) + 1);
    expect(lista).toEqual([{ cola: "sire", jobId: Y }]);
  });

  // H-022-3 (baja, preexistente): un miembro de la lista que no es un uuid hace fallar `leerTrabajo` dentro de la
  // transacción (22P02); la atención termina en «nada» antes del cierre y el estudio se atiende para siempre sin
  // limpiar nada (G4): ni ese id ni los N − 1 restos que tiene detrás. despachador.ts:216-217 y :307-310.
  it.fails(
    "H-022-3 · un resto corrupto (no uuid) al frente de N = 2K restos no impide converger (G4)",
    async () => {
      const x = await caso();
      await redis.zadd(x.pend, 1, "no-es-un-uuid");
      await restos(x, 2 * K, VIEJO);
      const { redis: rd, reg } = instrumentar();
      await converger(x, despachador(x, rd), reg, ciclosCA4(2 * K + 1));
    },
  );
});
