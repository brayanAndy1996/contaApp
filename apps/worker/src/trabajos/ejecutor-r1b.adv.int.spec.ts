// Spec 008 · T13b (ronda adversarial 1b, caja blanca): el ejecutor contra arriendos vencidos, event loop bloqueado,
// reintentos que chocan con el job BullMQ anterior, credencial reemplazada en mitad del trabajo y el token SIRE de
// otro proceso. PostgreSQL, Redis (base 15, prefijo propio) y BullMQ reales.
// - Cada prueba crea sus estudios/clientes y los borra (Escenario.limpiar); Redis: solo el prefijo de este archivo.
// - El reconciliador de los workers de esta prueba solo ve los estudios propios (withSistema filtrado): no toca trabajos
//   de otras suites que corran en paralelo sobre la misma BD.
// - `config_sistema` solo se cambia en la prueba de reintento y se devuelve a D12 al terminar.
//
// Hallazgos que fija (rojo):
//  1. Los arriendos no tienen dueño por ejecución: `ejec:{jobId}` y `lock:ruc:*` guardan el jobId (igual en cada intento) y
//     la transición final es `WHERE estado = 'ejecutando'`. Un ejecutor cuyo arriendo venció (event loop bloqueado más
//     que el arriendo, con el latido cada 10 s basta un bloqueo de 21-30 s) y cuyo trabajo ya re-despachó otro proceso,
//     al terminar escribe el resultado de la ejecución ajena y BORRA el `ejec` y el lock del RUC de la ejecución viva:
//     queda el mismo RUC sin lock mientras la segunda ejecución sigue en curso (CA-3) y el estado final no es el suyo (D2).
//  2. Event loop bloqueado > lockDuration de BullMQ (10 s) en un procesador que falla con ErrorTransitorio: el job
//     BullMQ queda en `active` sin lock (moveToFinished falla) hasta que el chequeo de stalled lo saca; el reintento
//     (mismo jobId) llega antes y BullMQ lo ignora como duplicado. El trabajo queda `ejecutando` sin nadie que lo corra
//     hasta que el reconciliador lo recupera (~30 s después y con un intento extra consumido).
//  3. Credencial reemplazada mientras el trabajo corre: el trigger la deja `configurada`, pero el `ErrorCredencial` del
//     intento con la credencial VIEJA la marca `invalida` igual (marcarCredencialInvalida no mira qué versión falló):
//     la credencial nueva queda bloqueada y sus trabajos se cancelan hasta que el contador la guarde otra vez (CA-9).
import { randomBytes, randomUUID } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import {
  CacheConfig,
  crearClaves,
  Despachador,
  Reconciliador,
  type PayloadTrabajo,
} from "@contapp/queue";
import {
  ErrorCredencial,
  ErrorTransitorio,
  type SireAuth,
} from "@contapp/sunat";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  compuerta,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  encolarYPublicar,
  Escenario,
  esperarHasta,
  fijarConfig,
  limpiarPrefijo,
  opcionesBull,
  registrarTiposDePrueba,
  restaurarConfig,
  volcarPrefijo,
} from "../../test/trabajos.js";
import { Ejecutor, type Procesador } from "./ejecutor.js";
import { iniciarTrabajos } from "./iniciar.js";
import type { EventoLog, LoggerTrabajos } from "./registro.js";
import { CacheTokenSire } from "./token-sire/cache-token.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
registrarTiposDePrueba();

const prefijo = `r1b-w-${randomBytes(4).toString("hex")}:`;
const k = crearClaves(prefijo);
let admin: ContappDb;
let backend: ContappDb;
let worker: ContappDb;
let redis: Redis;
let e: Escenario;
const parar: Array<() => Promise<void>> = [];

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  worker = crearDbRol("contapp_worker", 6);
  redis = conectarRedis();
  e = new Escenario(admin);
});

afterAll(async () => {
  for (const p of parar.splice(0)) await p().catch(() => undefined);
  await restaurarConfig(admin).catch(() => undefined);
  await e?.limpiar();
  await limpiarPrefijo(redis, prefijo).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([worker?.close(), backend?.close(), admin?.close()]);
});

const silencio: LoggerTrabajos = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** withSistema que solo devuelve los estudios de este escenario (el reconciliador no toca otras suites). */
function soloMios(db: ContappDb): ContappDb {
  return new Proxy(db, {
    get(t, p, rcv) {
      if (p === "withSistema")
        return async (fn: (tx: unknown) => Promise<unknown>) => {
          const r = await (
            t.withSistema as (f: typeof fn) => Promise<unknown>
          ).call(t, fn);
          return Array.isArray(r)
            ? r.filter((x) => typeof x === "string" && e.estudios.includes(x))
            : r;
        };
      const v = Reflect.get(t, p, rcv);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as ContappDb;
}

/** Worker completo (`iniciarTrabajos`) con BullMQ real, intervalos cortos y el reconciliador acotado a lo propio. */
async function arrancarWorker(
  procesadores: Record<string, Procesador>,
  eventos: EventoLog[] = [],
) {
  // El liderazgo que dejó el despachador suelto de otra prueba de este archivo no debe retrasar a este worker.
  await redis.del(k.lider("sire"), k.lider("sol"), k.lider("xml"));
  const dbReal = crearDbRol("contapp_worker", 8);
  const r = conectarRedis();
  const logger: LoggerTrabajos = {
    info: (x) => eventos.push(x),
    warn: (x) => eventos.push(x),
    error: (x) => eventos.push(x),
  };
  const en = await iniciarTrabajos({
    db: soloMios(dbReal),
    redis: r,
    conexionBull: opcionesBull(),
    prefijo,
    procesadores,
    logger,
    notificador: { credencialInvalida: async () => undefined },
    intervalos: { despachadorMs: 20, reconciliadorMs: 500, latidoMs: 200 },
  });
  const detener = async () => {
    await en.detener({ esperaMs: 3000 }).catch(() => undefined);
    r.disconnect();
    await dbReal.close().catch(() => undefined);
  };
  parar.push(detener);
  return { detener };
}

async function clavesVivas(patron: string): Promise<string[]> {
  return redis.keys(`${prefijo}${patron}`);
}

function bloquear(ms: number): void {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    // event loop bloqueado (cálculo síncrono largo en el procesador)
  }
}

describe("arriendo vencido con el ejecutor aún vivo (event loop bloqueado más que el arriendo)", () => {
  it("el ejecutor viejo no escribe el resultado de la ejecución nueva ni le borra el ejec y el lock del RUC", async () => {
    const T = await e.estudio();
    const c = await e.cliente(T);
    const r = await encolarYPublicar(backend, redis, prefijo, T, {
      tipo: "prueba.eco",
      clienteId: c.id,
      parametros: { n: 1 },
    });
    const id = r.trabajo.id;
    const reloj = { ahora: () => new Date() };
    const capturados: PayloadTrabajo[] = [];
    const desp = new Despachador({
      db: worker,
      redis,
      reloj,
      prefijo,
      agregarACola: async (_c, p) => {
        capturados.push(p);
      },
    });
    const llamadas: number[] = [];
    const ejecutor = (puerta: { esperar(): Promise<void> }, n: number) =>
      new Ejecutor({
        db: worker,
        redis,
        reloj,
        prefijo,
        procesadores: {
          "prueba.eco": async () => {
            llamadas.push(n);
            await puerta.esperar();
            return { de: n };
          },
        },
        config: new CacheConfig(worker, reloj),
        tokens: {
          conToken: async () => {
            throw new Error("sin token en esta prueba");
          },
        },
        notificador: { credencialInvalida: async () => undefined },
        logger: silencio,
        latidoMs: 60_000,
      });

    // Ejecución 1 (proceso A).
    await desp.ciclo();
    expect(capturados.length).toBe(1);
    const g1 = compuerta();
    const run1 = ejecutor(g1, 1).ejecutar("sire", capturados[0]!);
    await esperarHasta(() => llamadas.length === 1, "procesador 1");

    // A se bloquea más que el arriendo: ejec, cupos y lock vencen (lo que haría Redis con su TTL).
    await redis.del(k.ejec(id), k.lockRuc("sire", c.ruc));
    await redis.zrem(k.cupoGlobal("sire"), id);
    await redis.zrem(k.cupoTenant("sire", T), id);

    // Proceso B: el reconciliador lo recupera (idempotente) y el despachador lo vuelve a lanzar.
    const rec = new Reconciliador({
      db: soloMios(worker),
      redis,
      reloj,
      prefijo,
      antiguedadSeg: 0,
    });
    const res = await rec.ciclo();
    expect(res.reencolados).toBe(1);
    await desp.ciclo();
    expect(capturados.length).toBe(2);
    const g2 = compuerta();
    const run2 = ejecutor(g2, 2).ejecutar("sire", capturados[1]!);
    await esperarHasta(() => llamadas.length === 2, "procesador 2");
    expect(await redis.exists(k.ejec(id))).toBe(1);

    // A despierta y termina mientras B sigue en curso.
    g1.abrir();
    await run1;
    const fila = await e.fila(id);
    const ejecVivo = await redis.exists(k.ejec(id));
    const lockPttl = await redis.pttl(k.lockRuc("sire", c.ruc));
    g2.abrir();
    await run2;

    // Con la ejecución 2 aún en curso: estado sin cerrar, su arriendo ejec vivo y el lock del RUC con el arriendo largo.
    expect(
      {
        estado: fila.estado,
        resultado: fila.resultado,
        ejecVivo,
        lockLargo: lockPttl > 5_000,
      },
      `la ejecución vieja cerró o soltó lo de la nueva (PTTL del lock: ${lockPttl} ms)`,
    ).toEqual({
      estado: "ejecutando",
      resultado: null,
      ejecVivo: 1,
      lockLargo: true,
    });
  });
});

describe("event loop bloqueado entre 10 y 30 s (lockDuration de BullMQ = 10 s)", () => {
  it("bloqueo de 12 s: una sola ejecución, completado y sin ejec, lock, cupos ni job BullMQ huérfanos", async () => {
    const T = await e.estudio();
    const c = await e.cliente(T);
    let llamadas = 0;
    const w = await arrancarWorker({
      "prueba.eco": async () => {
        llamadas++;
        bloquear(12_000);
        return { ok: true };
      },
    });
    const r = await encolarYPublicar(backend, redis, prefijo, T, {
      tipo: "prueba.eco",
      clienteId: c.id,
      parametros: { n: 2 },
    });
    const id = r.trabajo.id;
    await esperarHasta(
      async () => (await e.fila(id))?.estado === "completado",
      "completado",
      { timeoutMs: 40_000 },
    );
    // Espera por RUC (≤ 2 s por defecto) + dos chequeos de stalled de BullMQ (≤ 10 s).
    await esperarHasta(
      async () =>
        (await clavesVivas("ejec:*")).length === 0 &&
        (await clavesVivas("lock:ruc:*")).length === 0 &&
        (await redis.zcard(k.cupoGlobal("sire"))) === 0 &&
        (await redis.zcard(k.cupoTenant("sire", T))) === 0 &&
        (await redis.exists(`${prefijo}bull:sire:${id}`)) === 0,
      "sin arriendos ni job BullMQ huérfanos",
      { timeoutMs: 15_000 },
    ).catch(() => undefined);
    await dormir(1500); // por si el job se reentregara
    const fila = await e.fila(id);
    const huerfanos = {
      ejec: await clavesVivas("ejec:*"),
      lock: await clavesVivas("lock:ruc:*"),
      cupoGlobal: await redis.zcard(k.cupoGlobal("sire")),
      cupoEstudio: await redis.zcard(k.cupoTenant("sire", T)),
      jobBull: await redis.exists(`${prefijo}bull:sire:${id}`),
    };
    await w.detener();
    expect({ llamadas, estado: fila.estado, intentos: fila.intentos }).toEqual({
      llamadas: 1,
      estado: "completado",
      intentos: 0,
    });
    expect(huerfanos).toEqual({
      ejec: [],
      lock: [],
      cupoGlobal: 0,
      cupoEstudio: 0,
      jobBull: 0,
    });
  });

  it("bloqueo de 12 s y ErrorTransitorio: el reintento (mismo jobId) se ejecuta enseguida y no lo ignora BullMQ", async () => {
    await fijarConfig(admin, "sire", { espera: 0, base: 100, reintentos: 3 });
    try {
      const T = await e.estudio();
      const c = await e.cliente(T);
      const marcas: Array<{ inicio: number; fin: number }> = [];
      const eventos: EventoLog[] = [];
      const w = await arrancarWorker(
        {
          "prueba.eco": async () => {
            const m = { inicio: Date.now(), fin: 0 };
            marcas.push(m);
            if (marcas.length === 1) {
              bloquear(12_000);
              m.fin = Date.now();
              throw new ErrorTransitorio();
            }
            m.fin = Date.now();
            return { ok: true };
          },
        },
        eventos,
      );
      await dormir(1200); // la config nueva (base 100 ms) ya está en la caché del worker
      const r = await encolarYPublicar(backend, redis, prefijo, T, {
        tipo: "prueba.eco",
        clienteId: c.id,
        parametros: { n: 3 },
      });
      const id = r.trabajo.id;
      await esperarHasta(
        () => marcas.length >= 1 && marcas[0]!.fin > 0,
        "primer intento",
        { timeoutMs: 30_000 },
      );
      const finPrimero = marcas[0]!.fin;
      // Con backoff de ~100 ms, el segundo intento debería arrancar en pocos segundos (no a los ~30 s del reconciliador).
      await esperarHasta(
        async () => (await e.fila(id))?.estado === "completado",
        "reintento completado",
        { timeoutMs: 10_000 },
      ).catch(() => undefined);
      const fila = await e.fila(id);
      const demora = marcas[1] ? marcas[1].inicio - finPrimero : null;
      const bull = await redis.hgetall(`${prefijo}bull:sire:${id}`);
      const rastro = eventos
        .filter((x) => x.job_id === id)
        .map((x) => x.evento);
      await w.detener();
      expect(
        {
          estado: fila.estado,
          intentos: fila.intentos,
          llamadas: marcas.length,
        },
        `segundo intento a los ${demora ?? "∞"} ms del primero; ejecutor: ${rastro.join(",")}; job BullMQ con el mismo id: ${Object.keys(bull).length > 0 ? "sigue" : "no"}`,
      ).toEqual({ estado: "completado", intentos: 1, llamadas: 2 });
    } finally {
      await restaurarConfig(admin);
    }
  });
});

describe("credencial reemplazada mientras el trabajo corre (CA-9, D13)", () => {
  it("el ErrorCredencial del intento con la credencial vieja no deja 'invalida' a la credencial nueva", async () => {
    const T = await e.estudio();
    const c = await e.cliente(T);
    const credId = await e.credencial(T, c.id, "sol");
    const puerta = compuerta();
    let llamadas = 0;
    const w = await arrancarWorker({
      "prueba.credencial_sol": async () => {
        llamadas++;
        await puerta.esperar();
        throw new ErrorCredencial(); // SUNAT rechazó la clave con la que empezó el trabajo
      },
    });
    const r = await encolarYPublicar(backend, redis, prefijo, T, {
      tipo: "prueba.credencial_sol",
      clienteId: c.id,
      parametros: { n: 4 },
    });
    await esperarHasta(() => llamadas === 1, "procesador en curso");
    // El contador guarda la clave nueva (UPDATE de ciphertext): el trigger la deja 'configurada'.
    await admin.pool.query(
      "update credencial set ciphertext = $2, updated_at = now() where id = $1",
      [credId, randomBytes(64)],
    );
    expect((await e.credencialEstado(c.id, "sol"))?.estado).toBe("configurada");
    puerta.abrir();
    await esperarHasta(
      async () => (await e.fila(r.trabajo.id))?.estado === "error",
      "trabajo en error",
    );
    const fila = await e.fila(r.trabajo.id);
    const estado = await e.credencialEstado(c.id, "sol");
    await w.detener();
    expect(fila.motivo).toBe("credencial_invalida");
    expect(
      estado?.estado,
      "la credencial reemplazada durante el trabajo quedó bloqueada",
    ).toBe("configurada");
  });
});

describe("token SIRE de un proceso leído por otro (CA-11, D14)", () => {
  it("otro proceso, aun con el mismo identificador de proceso, no obtiene el token: ni en claro en Redis ni descifrándolo", async () => {
    const T = randomUUID();
    const cliente = randomUUID();
    const ctx = { tenantId: T, clienteId: cliente, ruc: "20000000001" };
    const canario = `CANARIO-TOKEN-${randomBytes(8).toString("hex")}`;
    const auth = (token: string, contador: { n: number }): SireAuth => ({
      obtenerToken: async () => {
        contador.n++;
        return { token, expiraEn: new Date(Date.now() + 3_600_000) };
      },
    });
    const nA = { n: 0 };
    const nB = { n: 0 };
    const credenciales = async () => ({
      clientId: "id",
      clientSecret: "CANARIO-SECRET-x",
      usuarioSol: "u",
      claveSol: "CANARIO-SOL-x",
      ruc: ctx.ruc,
    });
    const proceso = `p-${randomBytes(4).toString("hex")}`;
    const A = new CacheTokenSire({
      redis,
      sireAuth: auth(canario, nA),
      credenciales,
      prefijo,
      proceso,
    });
    const B = new CacheTokenSire({
      redis,
      sireAuth: auth("token-de-B", nB),
      credenciales,
      prefijo,
      proceso,
    });
    expect(await A.obtener(ctx)).toBe(canario);
    expect(await A.obtener(ctx)).toBe(canario);
    const volcado = await volcarPrefijo(redis, prefijo);
    const tokenB = await B.obtener(ctx);
    expect({
      nA: nA.n,
      nB: nB.n,
      tokenB,
      enRedis: volcado.includes(canario),
    }).toEqual({
      nA: 1,
      nB: 1,
      tokenB: "token-de-B",
      enRedis: false,
    });
    await redis.del(k.tokenSire(proceso, T, cliente));
  });
});
