// Spec 008 · T15b (ronda adversarial 2b, caja blanca): carreras contra las correcciones de la ronda 1.
// PostgreSQL y Redis reales (base 15, prefijo propio); sin BullMQ. Las interleavings se fuerzan con puertas sobre el
// Redis o la transacción reales (Proxy), sin tocar producción. Cada prueba crea sus estudios y los borra; no cambia
// config_sistema.
//
// Hallazgos que fija (rojo):
//  1. H-008-1b-1 por otra vía: con dos líderes y un tipo de canal `ninguno` (sin lock de RUC), el líder tardío pierde
//     la transición del candidato que el otro ya despachó y `soltar(fila, true)` le quita del ZSET el cupo VIVO de esa
//     ejecución: el estudio supera su concurrencia (CA-2, D5).
//  2. H-008-1a-2 por otra vía: el vivo con la misma clave termina entre el `ON CONFLICT DO NOTHING` y la relectura; las
//     dos transacciones insertan "normal" y la segunda propaga 23505 en vez de devolver el trabajo (D8).
//  3. H-008-1b-5 por otra vía: el trigger fecha `estado_at` con now() (inicio de la transacción que reemplaza la
//     credencial). Si esa transacción empezó antes del despacho y confirma durante el trabajo, `estado_at <= iniciado_en`
//     y el ErrorCredencial del intento viejo marca `invalida` la credencial nueva (CA-9).
import { randomBytes, randomUUID } from "node:crypto";
import { leerTrabajo, marcarCredencialInvalida, transicionar, type ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registrarTipo } from "./catalogo.js";
import { crearClaves } from "./claves.js";
import { Despachador } from "./despachador.js";
import { encolar, type EntradaEncolar } from "./encolado.js";
import {
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  dormir,
  esperarHasta,
  Escenario,
  limpiarPrefijo,
  type ClientePrueba,
} from "./soporte-pruebas/int.js";
import type { PayloadTrabajo } from "./tipos.js";

const TIPO_SIN_CANAL = "prueba.ninguno_rdosb";
registrarTipo({
  tipo: TIPO_SIN_CANAL,
  cola: "sire",
  canal: "ninguno", // sin lock de RUC (plan: "Los trabajos con canal `ninguno` no usan lock")
  credencial: null,
  permiso: null,
  idempotente: true,
  parametros: z.object({ n: z.number().optional() }),
});

const prefijo = `r2b-c-${randomUUID().slice(0, 8)}:`;
const k = crearClaves(prefijo);
let admin: ContappDb;
let worker: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
let limite: number;

beforeAll(async () => {
  admin = crearDbAdmin();
  worker = crearDbRol("contapp_worker", 6);
  backend = crearDbRol("contapp_backend", 6);
  redis = conectarRedis();
  e = new Escenario(admin);
  const r = await admin.pool.query("select concurrencia_tenant, concurrencia_global from config_sistema where cola = 'sire'");
  limite = Number(r.rows[0].concurrencia_tenant);
  expect(limite).toBeLessThan(Number(r.rows[0].concurrencia_global));
}, 30_000);

afterAll(async () => {
  await e?.limpiar();
  await limpiarPrefijo(redis, prefijo).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([worker?.close(), backend?.close(), admin?.close()]);
});

interface Puerta {
  abrir(): void;
  esperar: Promise<void>;
}
function puerta(): Puerta {
  let abrir!: () => void;
  const esperar = new Promise<void>((r) => (abrir = r));
  return { abrir, esperar };
}

describe("dos líderes y un tipo sin lock de RUC (canal `ninguno`)", () => {
  it("el líder que pierde la transición no borra el cupo vivo de la ejecución del otro", async () => {
    const T = await e.estudio();
    const clientes: ClientePrueba[] = [];
    for (let i = 0; i < limite + 3; i++) clientes.push(await e.cliente(T));
    await e.trabajosEnMasa(T, clientes, limite + 3, { tipo: TIPO_SIN_CANAL, canal: "ninguno" });
    await redis.sadd(k.tenants("sire"), T);
    await redis.del(k.lider("sire"));

    // D1 se detiene en su primera reserva de cupo (dentro del withTenant, con la ventana ya leída).
    const alto = puerta();
    let detenido = false;
    const redisLento = new Proxy(redis, {
      get(t, p, rcv) {
        if (p === "time")
          return async () => {
            if (!detenido) {
              detenido = true;
              await alto.esperar;
            }
            return t.time();
          };
        const v = Reflect.get(t, p, rcv);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as Redis;
    const nada = async (_c: string, _p: PayloadTrabajo) => undefined;
    const d1 = new Despachador({ db: worker, redis: redisLento, reloj: { ahora: () => new Date() }, prefijo, agregarACola: nada });
    const d2 = new Despachador({ db: worker, redis, reloj: { ahora: () => new Date() }, prefijo, agregarACola: nada });

    const ciclo1 = d1.ciclo();
    await esperarHasta(() => detenido, "D1 en su reserva de cupo");
    // Vence el liderazgo de D1 (> 30 s detenido); D2 lo toma y despacha el mismo primer candidato.
    await redis.del(k.lider("sire"));
    await d2.ciclo();
    alto.abrir();
    await ciclo1;
    for (let i = 0; i < limite + 2; i++) await d2.ciclo();

    const r = await admin.pool.query("select id from job_registro where tenant_id = $1 and estado = 'ejecutando'", [T]);
    const enCupo = await redis.zcard(k.cupoTenant("sire", T));
    expect(r.rowCount, `ejecutando=${r.rowCount}, cupos en Redis=${enCupo}, concurrencia del estudio ${limite}`).toBeLessThanOrEqual(limite);
  });
});

describe("encolar concurrente cuando el vivo termina en ese instante (D8)", () => {
  it("dos encolar de lo mismo devuelven un solo trabajo; ninguno propaga 23505", async () => {
    const T = await e.estudio();
    const c = await e.cliente(T);
    const entrada: EntradaEncolar = {
      tipo: "prueba.eco",
      clienteId: c.id,
      parametros: { n: 4242 },
      prioridad: "interactivo",
      creadoPor: null,
    };
    // Puertas alrededor del INSERT ... ON CONFLICT DO NOTHING de cada transacción.
    const antes = puerta();
    const despues = puerta();
    let enAntes = 0;
    let enDespues = 0;
    const conPuertas = (tx: { query: (...a: never[]) => unknown }) => ({
      query: async (...a: unknown[]) => {
        const texto = String(a[0]);
        if (!/on conflict/i.test(texto)) return (tx.query as (...x: unknown[]) => unknown)(...a);
        enAntes++;
        await antes.esperar;
        const r = await (tx.query as (...x: unknown[]) => Promise<unknown>)(...a);
        enDespues++;
        await despues.esperar;
        return r;
      },
    });
    const intento = () =>
      backend.withTenant({ tenantId: T }, (tx) => encolar(conPuertas(tx as never) as never, entrada));
    const t1 = intento();
    const t2 = intento();
    await esperarHasta(() => enAntes === 2, "las dos transacciones pasaron la primera comprobación");
    // Otro encolar de lo mismo confirma primero: es el vivo con el que chocarán las dos.
    const vivo = await backend.withTenant({ tenantId: T }, (tx) => encolar(tx, entrada));
    expect(vivo.nuevo).toBe(true);
    antes.abrir();
    await esperarHasta(() => enDespues === 2, "las dos chocaron con el vivo (DO NOTHING)");
    // El vivo termina justo entonces (el worker lo completó).
    await admin.pool.query("update job_registro set estado = 'completado', terminado_en = now() where id = $1", [vivo.trabajo.id]);
    despues.abrir();

    const r = await Promise.allSettled([t1, t2]);
    const fallos = r.filter((x) => x.status === "rejected").map((x) => (x as PromiseRejectedResult).reason?.codigo ?? String((x as PromiseRejectedResult).reason));
    expect(fallos, "un encolar concurrente de lo mismo propagó un error de BD").toEqual([]);
    const ids = new Set(r.map((x) => (x as PromiseFulfilledResult<{ trabajo: { id: string } }>).value.trabajo.id));
    expect(ids.size).toBe(1);
  });
});

describe("credencial reemplazada por una transacción que empezó antes del despacho (H-008-1b-5)", () => {
  it("el ErrorCredencial del trabajo no marca invalida la credencial que se confirmó mientras corría", async () => {
    const T = await e.estudio();
    const c = await e.cliente(T);
    const credId = await e.credencial(T, c.id, "sol");
    const [id] = await e.trabajosEnMasa(T, c, 1);

    // El backend empieza a guardar la credencial nueva (transacción abierta: now() queda fijo en su inicio).
    const guardado = await admin.pool.connect();
    try {
      await guardado.query("begin");
      await guardado.query("select now()");
      await dormir(50);
      // Se despacha el trabajo (iniciado_en = now() del despacho, posterior) y lee la credencial VIEJA.
      expect(await worker.withTenant({ tenantId: T }, (tx) => transicionar(tx, id!, "en_cola", "ejecutando"))).toBe(true);
      const inicio = await worker.withTenant({ tenantId: T }, (tx) => leerTrabajo(tx, id!));
      expect(inicio?.estado).toBe("ejecutando");
      // El guardado confirma durante el trabajo: el trigger fija estado_at = now() de SU transacción.
      await guardado.query("update credencial set ciphertext = $2 where id = $1", [credId, randomBytes(64)]);
      await guardado.query("commit");
    } finally {
      guardado.release();
    }
    const f = (await admin.pool.query("select estado, estado_at from credencial where id = $1", [credId])).rows[0];
    expect(f.estado).toBe("configurada");

    // El adaptador rechaza la credencial vieja: el ejecutor marca con trabajoId (corrección de H-008-1b-5).
    const marco = await worker.withTenant({ tenantId: T }, (tx) =>
      marcarCredencialInvalida(tx, c.id, "sol", "credencial_invalida", id!),
    );
    const despues = (await admin.pool.query("select estado from credencial where id = $1", [credId])).rows[0];
    expect({ marco, estado: despues.estado }, "la credencial reemplazada durante el trabajo quedó invalida").toEqual({
      marco: false,
      estado: "configurada",
    });
  });
});
