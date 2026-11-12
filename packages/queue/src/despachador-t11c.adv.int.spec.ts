// Spec 018 · T11c · ADVERSARIO: cierre de un estudio «vacío» (ZRANGE pend antes de la BD; ZREM de esos ids, SREM
// tenants y SADD de vuelta si ZCARD pend > 0) frente a publicaciones concurrentes.
// PostgreSQL y Redis reales (base 15, un prefijo propio por prueba: cupos y locks no se cruzan entre pruebas).
//
// Las carreras se fijan de forma determinista con un Redis-proxy que ejecuta al «intruso» justo antes (o después) de
// un comando concreto del despachador. Rojas = defecto real; verdes = regresión del escenario que la corrección cubre.
import { randomUUID } from "node:crypto";
import {
  leerTrabajo,
  transicionar,
  type ContappDb,
  type TrabajoFila,
} from "@contapp/db";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liberarArriendos } from "./arriendos.js";
import { crearClaves, type ClavesCola } from "./claves.js";
import { Despachador } from "./despachador.js";
import { Reconciliador, type ResumenReconciliacion } from "./reconciliador.js";
import {
  anunciar,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  Escenario,
  limpiarPrefijo,
  type ClientePrueba,
} from "./soporte-pruebas/int.js";
import type { PayloadTrabajo } from "./tipos.js";

const COLAS = ["sire", "sol", "xml", "archivos"] as const;
let admin: ContappDb;
let worker: ContappDb;
let redis: Redis;
let e: Escenario;
const prefijos: string[] = [];

beforeAll(async () => {
  admin = crearDbAdmin();
  worker = crearDbRol("contapp_worker", 6);
  redis = conectarRedis();
  e = new Escenario(admin);
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
}

/** Estudio nuevo con su prefijo de Redis propio y el estudio ya anotado en tenants:sire (sin trabajos en BD). */
async function caso(): Promise<Caso> {
  const prefijo = `t11c-adv-${randomUUID().slice(0, 8)}:`;
  prefijos.push(prefijo);
  const k = crearClaves(prefijo);
  const T = await e.estudio();
  const c = await e.cliente(T);
  await redis.sadd(k.tenants("sire"), T);
  return { prefijo, k, T, c };
}

type Despachos = Array<{ cola: string; jobId: string }>;

function despachador(
  prefijo: string,
  rd: Redis,
  lista: Despachos = [],
): Despachador {
  return new Despachador({
    db: worker,
    redis: rd,
    reloj: { ahora: () => new Date() },
    prefijo,
    agregarACola: async (cola: string, p: PayloadTrabajo) => {
      lista.push({ cola, jobId: p.jobId });
    },
  });
}

/** Simula que otro proceso tomó el liderazgo: borra las claves de líder de todas las colas. */
async function soltarLiderazgo(k: ClavesCola): Promise<void> {
  await redis.del(...COLAS.map((c) => k.lider(c)));
}

interface Gancho {
  comando: string;
  clave?: string;
  momento: "antes" | "despues";
  /** Lo que hace el intruso; con `lanzar`, el comando falla en lugar de ejecutarse. */
  accion?: () => Promise<void>;
  lanzar?: boolean;
}

/** Redis-proxy: cada gancho se dispara una sola vez, en la primera llamada que coincida con comando (y clave). */
function interceptar(ganchos: Gancho[]): {
  redis: Redis;
  disparados: () => number;
} {
  const pendientes = [...ganchos];
  let n = 0;
  const proxy = new Proxy(redis, {
    get(t, p, rcv) {
      const v = Reflect.get(t, p, rcv);
      if (typeof v !== "function") return v;
      if (!pendientes.some((g) => g.comando === p)) return v.bind(t);
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
        return r;
      };
    },
  }) as Redis;
  return { redis: proxy, disparados: () => n };
}

const leer = (T: string, id: string): Promise<TrabajoFila | null> =>
  worker.withTenant({ tenantId: T }, (tx) => leerTrabajo(tx, id));

const aEjecutando = (T: string, id: string): Promise<boolean> =>
  worker.withTenant({ tenantId: T }, (tx) =>
    transicionar(tx, id, "en_cola", "ejecutando"),
  );

/**
 * Reintento del ejecutor del worker con el MISMO id (ejecutor.ts): commit ejecutando -> en_cola con el intento
 * consumido, suelta los arriendos y SOLO ENTONCES publica (ZADD pend + SADD tenants).
 */
async function reintentoDelEjecutor(x: Caso, id: string): Promise<void> {
  const fila = await leer(x.T, id);
  if (fila === null) throw new Error("sin fila");
  const ok = await worker.withTenant({ tenantId: x.T }, (tx) =>
    transicionar(
      tx,
      id,
      "ejecutando",
      "en_cola",
      { intentos: fila.intentos + 1, disponibleDesde: new Date() },
      { intentos: fila.intentos },
    ),
  );
  if (!ok) throw new Error("reintento perdido");
  await liberarArriendos(redis, x.k, fila, 0);
  await anunciar(redis, x.prefijo, x.T, [id]);
}

/** Pasada del reconciliador SOLO sobre el estudio T (no toca trabajos de otras pruebas ni de la BD compartida). */
async function reconciliarEstudio(x: Caso): Promise<ResumenReconciliacion> {
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

const estado = async (x: Caso, id?: string, cola = "sire") => ({
  estudioEnTenants: await redis.sismember(x.k.tenants(cola), x.T),
  ...(id === undefined
    ? {}
    : { enPend: (await redis.zscore(x.k.pend(cola, x.T), id)) !== null }),
});

describe("T11c ADV: publicaciones concurrentes con el cierre de un estudio vacío", () => {
  it("A1 · publicación (tras commit) entre el ZRANGE y la lectura en BD: el estudio no se cierra y el trabajo sale a más tardar en el ciclo siguiente", async () => {
    const x = await caso();
    let nuevo = "";
    const { redis: rd, disparados } = interceptar([
      {
        comando: "zrange",
        clave: x.k.pend("sire", x.T),
        momento: "despues",
        accion: async () => {
          [nuevo] = await e.trabajosEnMasa(x.T, x.c, 1);
          await anunciar(redis, x.prefijo, x.T, [nuevo]);
        },
      },
    ]);
    const lista: Despachos = [];
    await despachador(x.prefijo, rd, lista).ciclo();
    expect(disparados()).toBe(1);
    // `ahora` (TIME de Redis) se tomó antes del ZRANGE y `disponible_desde` = now() de la inserción es posterior: la
    // ventana sale vacía pero `quedan` > 0, así que el estudio NO se cierra y el trabajo sale en el ciclo siguiente.
    if (lista.length === 0) {
      expect(await estado(x, nuevo)).toEqual({
        estudioEnTenants: 1,
        enPend: true,
      });
      await soltarLiderazgo(x.k);
      await despachador(x.prefijo, redis, lista).ciclo();
    }
    expect(lista).toEqual([{ cola: "sire", jobId: nuevo }]);
  });

  it("A2 · reintento del ejecutor con el MISMO id que estaba como resto en pend: el ZREM de los «previos» borra la pista nueva", async () => {
    // Resto natural: dos despachadores (solape de liderazgo). D1 lee pend = [X]; D2 despacha X (y quita X de pend);
    // D1 lee la BD con X `ejecutando` (ventana vacía, sin en_cola). X falla rápido y el ejecutor lo reintenta con el
    // mismo id (commit en_cola + ZADD X + SADD) ANTES del ZREM de D1, que borra justo esa pista y luego hace SREM.
    const x = await caso();
    const [X] = await e.trabajosEnMasa(x.T, x.c, 1);
    await anunciar(redis, x.prefijo, x.T, [X!]);
    const lista2: Despachos = [];
    const { redis: rd, disparados } = interceptar([
      {
        comando: "zrange",
        clave: x.k.pend("sire", x.T),
        momento: "despues",
        accion: async () => {
          await soltarLiderazgo(x.k);
          await despachador(x.prefijo, redis, lista2).ciclo(); // D2 despacha X
        },
      },
      {
        comando: "zrem",
        clave: x.k.pend("sire", x.T),
        momento: "antes",
        accion: () => reintentoDelEjecutor(x, X!),
      },
    ]);
    const lista1: Despachos = [];
    await despachador(x.prefijo, rd, lista1).ciclo();
    expect(disparados()).toBe(2);
    expect(lista2).toEqual([{ cola: "sire", jobId: X }]);
    expect((await leer(x.T, X!))?.estado).toBe("en_cola");
    expect(
      await estado(x, X),
      "el reintento publicado (en_cola en BD) debe seguir visible para el despachador",
    ).toEqual({ estudioEnTenants: 1, enPend: true });
    // Y el siguiente ciclo lo despacha (sin esperar 30-60 s al reconciliador).
    await soltarLiderazgo(x.k);
    const lista3: Despachos = [];
    await despachador(x.prefijo, redis, lista3).ciclo();
    expect(lista3).toEqual([{ cola: "sire", jobId: X }]);
  });

  it("A3 · reintento del ejecutor con el mismo id SIN resto previo en pend, entre la lectura y el SREM: no se pierde", async () => {
    const x = await caso();
    const [X] = await e.trabajosEnMasa(x.T, x.c, 1);
    expect(await aEjecutando(x.T, X!)).toBe(true);
    const { redis: rd, disparados } = interceptar([
      {
        comando: "srem",
        clave: x.k.tenants("sire"),
        momento: "antes",
        accion: () => reintentoDelEjecutor(x, X!),
      },
    ]);
    await despachador(x.prefijo, rd).ciclo();
    expect(disparados()).toBe(1);
    expect(await estado(x, X)).toEqual({ estudioEnTenants: 1, enPend: true });
  });

  it("A4 · el reconciliador re-encola un `ejecutando` vencido entre la lectura y el SREM: solo hace SADD (sin ZADD) y el SREM lo borra", async () => {
    const x = await caso();
    const [X] = await e.trabajosEnMasa(x.T, x.c, 1);
    expect(await aEjecutando(x.T, X!)).toBe(true); // sin ejec:{id} ni cupo en Redis: arriendo vencido
    let resumen: ResumenReconciliacion | undefined;
    const { redis: rd, disparados } = interceptar([
      {
        comando: "srem",
        clave: x.k.tenants("sire"),
        momento: "antes",
        accion: async () => {
          resumen = await reconciliarEstudio(x);
        },
      },
    ]);
    await despachador(x.prefijo, rd).ciclo();
    expect(disparados()).toBe(1);
    expect(resumen?.reencolados).toBe(1);
    expect((await leer(x.T, X!))?.estado).toBe("en_cola");
    expect(
      await estado(x),
      "el estudio con un en_cola recién repuesto por el reconciliador debe seguir en tenants",
    ).toEqual({ estudioEnTenants: 1 });
    await soltarLiderazgo(x.k);
    const lista: Despachos = [];
    await despachador(x.prefijo, redis, lista).ciclo();
    expect(lista).toEqual([{ cola: "sire", jobId: X }]);
  });

  it("A5 · reconciliador sin carrera: el re-encolado (solo SADD, pend vacía) se despacha en el ciclo siguiente", async () => {
    const x = await caso();
    await redis.srem(x.k.tenants("sire"), x.T);
    const [X] = await e.trabajosEnMasa(x.T, x.c, 1);
    expect(await aEjecutando(x.T, X!)).toBe(true);
    expect((await reconciliarEstudio(x)).reencolados).toBe(1);
    const lista: Despachos = [];
    await despachador(x.prefijo, redis, lista).ciclo();
    expect(lista).toEqual([{ cola: "sire", jobId: X }]);
  });

  it("A6 · dos despachadores: D2 atiende el estudio (publica X e Y, despacha X) mientras D1 cierra; Y no se pierde", async () => {
    const x = await caso();
    const c2 = await e.cliente(x.T); // otro RUC: el lock de X no frena a Y
    let X = "";
    let Y = "";
    const lista2: Despachos = [];
    const { redis: rd, disparados } = interceptar([
      {
        comando: "srem",
        clave: x.k.tenants("sire"),
        momento: "antes",
        accion: async () => {
          [X, Y] = (await e.trabajosEnMasa(x.T, [x.c, c2], 2)) as [
            string,
            string,
          ];
          await anunciar(redis, x.prefijo, x.T, [X, Y]);
          await soltarLiderazgo(x.k);
          await despachador(x.prefijo, redis, lista2).ciclo();
        },
      },
    ]);
    await despachador(x.prefijo, rd).ciclo();
    expect(disparados()).toBe(1);
    expect(lista2).toEqual([{ cola: "sire", jobId: X }]);
    expect(await estado(x, Y)).toEqual({ estudioEnTenants: 1, enPend: true });
    await soltarLiderazgo(x.k);
    const lista1: Despachos = [];
    await despachador(x.prefijo, redis, lista1).ciclo();
    expect(lista1).toEqual([{ cola: "sire", jobId: Y }]);
  });

  it("A7 · dos despachadores cerrando a la vez con una publicación entre el SREM de D2 y su ZCARD: el SREM tardío de D1 no la pierde", async () => {
    const x = await caso();
    let X = "";
    const d2 = interceptar([
      {
        comando: "zcard",
        clave: x.k.pend("sire", x.T),
        momento: "antes",
        accion: async () => {
          [X] = (await e.trabajosEnMasa(x.T, x.c, 1)) as [string];
          await anunciar(redis, x.prefijo, x.T, [X]);
        },
      },
    ]);
    const d1 = interceptar([
      {
        comando: "srem",
        clave: x.k.tenants("sire"),
        momento: "antes",
        accion: async () => {
          await soltarLiderazgo(x.k);
          await despachador(x.prefijo, d2.redis).ciclo();
        },
      },
    ]);
    await despachador(x.prefijo, d1.redis).ciclo();
    expect([d1.disparados(), d2.disparados()]).toEqual([1, 1]);
    expect(await estado(x, X)).toEqual({ estudioEnTenants: 1, enPend: true });
  });

  it("A8 · trabajo cancelado entre el ZRANGE y la lectura: el estudio sale de tenants, la pista queda vacía y no hay ciclos vacíos después", async () => {
    const x = await caso();
    const [X] = await e.trabajosEnMasa(x.T, x.c, 1);
    await anunciar(redis, x.prefijo, x.T, [X!]);
    const { redis: rd, disparados } = interceptar([
      {
        comando: "zrange",
        clave: x.k.pend("sire", x.T),
        momento: "despues",
        accion: async () => {
          await worker.withTenant({ tenantId: x.T }, (tx) =>
            transicionar(tx, X!, "en_cola", "cancelado", {
              motivo: "cancelado_usuario",
            }),
          );
        },
      },
    ]);
    const lista: Despachos = [];
    await despachador(x.prefijo, rd, lista).ciclo();
    expect(disparados()).toBe(1);
    expect(lista).toEqual([]);
    expect(await estado(x)).toEqual({ estudioEnTenants: 0 });
    expect(await redis.exists(x.k.pend("sire", x.T))).toBe(0);
  });

  it("A9 · cancelado en pend + publicación de otro trabajo justo antes del ZREM: se borra solo el cancelado y el nuevo se despacha", async () => {
    const x = await caso();
    const [X] = await e.trabajosEnMasa(x.T, x.c, 1);
    await anunciar(redis, x.prefijo, x.T, [X!]);
    await worker.withTenant({ tenantId: x.T }, (tx) =>
      transicionar(tx, X!, "en_cola", "cancelado", {
        motivo: "cancelado_usuario",
      }),
    );
    let Y = "";
    const { redis: rd, disparados } = interceptar([
      {
        comando: "zrem",
        clave: x.k.pend("sire", x.T),
        momento: "antes",
        accion: async () => {
          [Y] = (await e.trabajosEnMasa(x.T, x.c, 1)) as [string];
          await anunciar(redis, x.prefijo, x.T, [Y]);
        },
      },
    ]);
    await despachador(x.prefijo, rd).ciclo();
    expect(disparados()).toBe(1);
    expect(await estado(x)).toEqual({ estudioEnTenants: 1 });
    expect(await redis.zrange(x.k.pend("sire", x.T), "0", "-1")).toEqual([Y]);
    await soltarLiderazgo(x.k);
    const lista: Despachos = [];
    await despachador(x.prefijo, redis, lista).ciclo();
    expect(lista).toEqual([{ cola: "sire", jobId: Y }]);
  });

  it("A10 · otra cola del mismo estudio: publicar en `sol` mientras se cierra `sire` no toca las claves de `sol`", async () => {
    const x = await caso();
    let Z = "";
    const { redis: rd, disparados } = interceptar([
      {
        comando: "srem",
        clave: x.k.tenants("sire"),
        momento: "antes",
        accion: async () => {
          [Z] = (await e.trabajosEnMasa(x.T, x.c, 1, {
            cola: "sol",
            canal: "sol",
          })) as [string];
          await anunciar(redis, x.prefijo, x.T, [Z], "sol");
        },
      },
    ]);
    const lista: Despachos = [];
    await despachador(x.prefijo, rd, lista).ciclo();
    expect(disparados()).toBe(1);
    expect(await estado(x)).toEqual({ estudioEnTenants: 0 }); // sire sí se cerró
    // `sol` se atiende en el mismo ciclo (si va después de sire) o en el siguiente: Z nunca se pierde.
    if (lista.length === 0) {
      expect(await estado(x, Z, "sol")).toEqual({
        estudioEnTenants: 1,
        enPend: true,
      });
      await soltarLiderazgo(x.k);
      await despachador(x.prefijo, redis, lista).ciclo();
    }
    expect(lista).toEqual([{ cola: "sol", jobId: Z }]);
  });

  it("A11 · el ZRANGE previo falla una vez: el estudio queda con restos un ciclo más, pero converge (sin bucle de ciclos vacíos)", async () => {
    const x = await caso();
    await redis.zadd(x.k.pend("sire", x.T), 1, randomUUID(), 2, randomUUID());
    const { redis: rd, disparados } = interceptar([
      {
        comando: "zrange",
        clave: x.k.pend("sire", x.T),
        momento: "antes",
        lanzar: true,
      },
    ]);
    const d = despachador(x.prefijo, rd);
    await d.ciclo();
    expect(disparados()).toBe(1);
    await d.ciclo();
    await d.ciclo();
    expect(await estado(x)).toEqual({ estudioEnTenants: 0 });
    expect(await redis.exists(x.k.pend("sire", x.T))).toBe(0);
  });

  it("A12 · ZADD del backend ANTES del commit (fuera del contrato outbox D3): el cierre lo borra y solo el reconciliador lo repone", async () => {
    // Caracterización: la corrección asume «commit y luego publicar». Si alguien publica antes, el id entra en
    // `previos`, la lectura no lo ve y el ZREM lo borra. Queda documentado que la red de seguridad es el reconciliador.
    const x = await caso();
    const cli = await admin.pool.connect();
    let X = "";
    try {
      await cli.query("begin");
      const r = await cli.query(
        `insert into job_registro (tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros,
                                   clave_dedupe, intentos, max_intentos)
         values ($1, $2, $3, 'prueba.eco', 'sire', 'sire', 'interactivo', 'en_cola', '{}'::jsonb,
                 sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 0, 4)
         returning id`,
        [x.T, x.c.id, x.c.ruc],
      );
      X = r.rows[0].id as string;
      await anunciar(redis, x.prefijo, x.T, [X]); // publicado sin commit
      await despachador(x.prefijo, redis).ciclo();
      await cli.query("commit");
    } catch (err) {
      await cli.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      cli.release();
    }
    expect(await estado(x, X)).toEqual({ estudioEnTenants: 0, enPend: false });
    expect((await reconciliarEstudio(x)).repuestos).toBe(1);
    const lista: Despachos = [];
    await soltarLiderazgo(x.k);
    await despachador(x.prefijo, redis, lista).ciclo();
    expect(lista).toEqual([{ cola: "sire", jobId: X }]);
  });
});
