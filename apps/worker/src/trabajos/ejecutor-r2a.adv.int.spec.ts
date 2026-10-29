// Spec 008 · T15a (ronda adversarial 2a): reintenta por otra vía la corrección de H-008-1b-5 (credencial reemplazada
// mientras el trabajo corre). PostgreSQL, Redis (base 15, prefijo propio) y BullMQ reales; el worker completo
// (`iniciarTrabajos`) con el reconciliador acotado a los estudios de este archivo. Cada prueba borra lo suyo.
//
// Hallazgo que fija (rojo):
//  1. La guarda `estado_at <= iniciado_en` compara la hora de INICIO de la transacción que reemplazó la credencial (el
//     trigger usa now()) con la del despacho. Un guardado de credencial cuya transacción empezó antes del despacho pero
//     hizo commit cuando el trabajo ya corría con la credencial vieja deja `estado_at` < `iniciado_en`: el
//     `ErrorCredencial` del intento viejo marca `invalida` la credencial NUEVA (CA-9, D13), como en H-008-1b-5.
import { randomBytes } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import { crearClaves } from "@contapp/queue";
import { ErrorCredencial } from "@contapp/sunat";
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
  limpiarPrefijo,
  opcionesBull,
  registrarTiposDePrueba,
} from "../../test/trabajos.js";
import type { Procesador } from "./ejecutor.js";
import { iniciarTrabajos } from "./iniciar.js";
import type { LoggerTrabajos } from "./registro.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });
registrarTiposDePrueba();

const prefijo = `r2a-w-${randomBytes(4).toString("hex")}:`;
const k = crearClaves(prefijo);
let admin: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
const parar: Array<() => Promise<void>> = [];

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  redis = conectarRedis();
  e = new Escenario(admin);
});

afterAll(async () => {
  for (const p of parar.splice(0)) await p().catch(() => undefined);
  await e?.limpiar();
  await limpiarPrefijo(redis, prefijo).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

const silencio: LoggerTrabajos = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

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

async function arrancarWorker(procesadores: Record<string, Procesador>) {
  await redis.del(k.lider("sire"), k.lider("sol"), k.lider("xml"));
  const dbReal = crearDbRol("contapp_worker", 8);
  const r = conectarRedis();
  const en = await iniciarTrabajos({
    db: soloMios(dbReal),
    redis: r,
    conexionBull: opcionesBull(),
    prefijo,
    procesadores,
    logger: silencio,
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

describe("H-008-1b-5 por otra vía: guardado de credencial que empezó antes del despacho y termina durante el trabajo", () => {
  it("el ErrorCredencial del intento con la credencial vieja no deja 'invalida' a la credencial guardada después", async () => {
    const T = await e.estudio();
    const c = await e.cliente(T);
    const credId = await e.credencial(T, c.id, "sol");
    // El contador guarda la clave nueva: la transacción del guardado empieza (y escribe el sobre) pero aún no hace commit.
    const guardado = await admin.pool.connect();
    let enCurso = true;
    try {
      await guardado.query("begin");
      await guardado.query(
        "update credencial set ciphertext = $2, updated_at = now() where id = $1",
        [credId, randomBytes(64)],
      );

      const puerta = compuerta();
      let llamadas = 0;
      const w = await arrancarWorker({
        "prueba.credencial_sol": async () => {
          llamadas++;
          await puerta.esperar();
          throw new ErrorCredencial(); // SUNAT rechaza la clave con la que empezó el trabajo (la vieja: la nueva no existía)
        },
      });
      const r = await encolarYPublicar(backend, redis, prefijo, T, {
        tipo: "prueba.credencial_sol",
        clienteId: c.id,
        parametros: { n: 7 },
      });
      await esperarHasta(() => llamadas === 1, "procesador en curso");
      // Con el trabajo ya en curso, el guardado hace commit: la credencial nueva queda 'configurada'.
      await guardado.query("commit");
      enCurso = false;
      const tiempos = await admin.pool.query(
        "select c.estado, c.estado_at < j.iniciado_en as antes from credencial c, job_registro j where c.id = $1 and j.id = $2",
        [credId, r.trabajo.id],
      );
      expect(tiempos.rows[0].estado).toBe("configurada");
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
        `la credencial guardada (commit) mientras el trabajo corría quedó bloqueada; estado_at < iniciado_en: ${tiempos.rows[0].antes}`,
      ).toBe("configurada");
    } finally {
      if (enCurso) await guardado.query("rollback").catch(() => undefined);
      guardado.release();
    }
  });
});
