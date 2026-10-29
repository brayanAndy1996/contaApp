// Spec 008 · T13b (ronda adversarial 1b): cierre ordenado del proceso worker con SIGTERM (plan "Worker": deja de tomar,
// espera hasta 30 s a lo que está en curso y libera arriendos; T12 observó que no terminaba y hubo que usar kill -9).
// Se lanza el worker COMPILADO (`dist/main.js`, como en producción) en un proceso hijo contra un redis-server propio
// en un puerto libre (no el compartido): así la prueba puede "reiniciar" o tirar Redis sin afectar a otras suites.
// La BD es la compartida: antes de lanzar el worker se espera a que no haya trabajos vivos viejos de otras suites
// (el reconciliador del hijo los tocaría); si no se despejan, la prueba se omite.
//
// Hallazgo que fija (rojo): con Redis caído, SIGTERM no termina el proceso en el plazo del plan (≤ 30 s + margen): el
// cierre espera al ciclo en curso del despachador (`bucleDespacho.detener()` sin tope), cuyos comandos Redis reintentan
// (ioredis por defecto: 20 reintentos por comando) en cada cola, y luego al cierre de BullMQ. Un orquestador manda
// SIGKILL al vencer su gracia: no hay cierre ordenado justo cuando más falta.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import type { ContappDb } from "@contapp/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { crearDbAdmin, dormir } from "../../test/trabajos.js";

vi.setConfig({ testTimeout: 150_000, hookTimeout: 60_000 });

const dirWorker = fileURLToPath(new URL("../../", import.meta.url));
const mainJs = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
const hayRedisServer = spawnSync("redis-server", ["--version"]).status === 0;
const PLAZO_CIERRE_MS = 35_000; // 30 s del plan + margen

let admin: ContappDb;
const hijos = new Set<ChildProcess>();

beforeAll(() => {
  admin = crearDbAdmin();
});
afterAll(async () => {
  for (const h of hijos) if (h.exitCode === null && h.signalCode === null) h.kill("SIGKILL");
  await admin?.close();
});

async function puertoLibre(): Promise<number> {
  return new Promise((ok, mal) => {
    const s = createServer();
    s.once("error", mal);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

async function levantarRedis(puerto: number): Promise<ChildProcess> {
  const r = spawn("redis-server", ["--port", String(puerto), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], {
    stdio: "ignore",
  });
  hijos.add(r);
  for (let i = 0; i < 100; i++) {
    const ping = spawnSync("redis-cli", ["-p", String(puerto), "ping"], { encoding: "utf8" });
    if (ping.stdout.trim() === "PONG") return r;
    await dormir(50);
  }
  throw new Error("redis-server propio no arrancó");
}

async function terminar(h: ChildProcess, senal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  if (h.exitCode !== null || h.signalCode !== null) return;
  const fin = new Promise<void>((r) => h.once("exit", () => r()));
  h.kill(senal);
  await fin;
}

/** Espera a que no haya trabajos vivos de más de 20 s sin cambios (de otras suites) en la BD compartida. */
async function bdDespejada(): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    const r = await admin.pool.query(
      "select count(*)::int as n from job_registro where estado in ('en_cola','ejecutando') and actualizado_en < now() - interval '20 seconds'",
    );
    if (r.rows[0].n === 0) return true;
    await dormir(1000);
  }
  return false;
}

interface Worker {
  proc: ChildProcess;
  salida: () => string;
  salio: Promise<{ code: number | null; signal: NodeJS.Signals | null; en: number }>;
}

async function lanzarWorker(puertoRedis: number): Promise<Worker> {
  let texto = "";
  const proc = spawn(process.execPath, [mainJs], {
    cwd: dirWorker,
    env: { ...process.env, NODE_ENV: "test", REDIS_URL: `redis://127.0.0.1:${puertoRedis}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  hijos.add(proc);
  proc.stdout!.on("data", (d: Buffer) => (texto += d.toString("utf8")));
  proc.stderr!.on("data", (d: Buffer) => (texto += d.toString("utf8")));
  const salio = new Promise<{ code: number | null; signal: NodeJS.Signals | null; en: number }>((r) =>
    proc.once("exit", (code, signal) => r({ code, signal, en: Date.now() })),
  );
  for (let i = 0; i < 300 && !texto.includes('"trabajos_iniciados"'); i++) {
    if (proc.exitCode !== null) break;
    await dormir(100);
  }
  if (!texto.includes('"trabajos_iniciados"')) {
    await terminar(proc);
    throw new Error("el worker no arrancó (sin trabajos_iniciados)");
  }
  return { proc, salida: () => texto, salio };
}

async function sigtermYMedir(w: Worker): Promise<{ ms: number | null; code: number | null; signal: string | null }> {
  const t0 = Date.now();
  w.proc.kill("SIGTERM");
  const r = await Promise.race([w.salio, dormir(PLAZO_CIERRE_MS + 5_000).then(() => null)]);
  if (r === null) {
    await terminar(w.proc, "SIGKILL");
    return { ms: null, code: null, signal: null };
  }
  return { ms: r.en - t0, code: r.code, signal: r.signal };
}

describe.skipIf(!hayRedisServer || !existsSync(mainJs))("SIGTERM al worker compilado", () => {
  it("con Redis arriba y sin trabajos: termina en ≤ 35 s con código 0 y registra trabajos_detenidos", async (ctx) => {
    if (!(await bdDespejada())) ctx.skip();
    const puerto = await puertoLibre();
    const redis = await levantarRedis(puerto);
    try {
      const w = await lanzarWorker(puerto);
      await dormir(1500);
      const r = await sigtermYMedir(w);
      expect(r.ms, "el worker no terminó tras SIGTERM").not.toBeNull();
      expect(r.ms!).toBeLessThanOrEqual(PLAZO_CIERRE_MS);
      expect({ code: r.code, signal: r.signal }).toEqual({ code: 0, signal: null });
      expect(w.salida()).toContain('"trabajos_detenidos"');
    } finally {
      await terminar(redis);
    }
  });

  it("con Redis caído: SIGTERM igual termina el proceso en ≤ 35 s (cierre con tope)", async (ctx) => {
    if (!(await bdDespejada())) ctx.skip();
    const puerto = await puertoLibre();
    const redis = await levantarRedis(puerto);
    let w: Worker | null = null;
    try {
      w = await lanzarWorker(puerto);
      await dormir(1500);
      await terminar(redis); // Redis se cae con el worker en marcha
      await dormir(2000);
      const r = await sigtermYMedir(w);
      expect(r.ms, `el worker seguía vivo ${PLAZO_CIERRE_MS + 5_000} ms después de SIGTERM (hubo que mandarle SIGKILL)`).not.toBeNull();
      expect(r.ms!).toBeLessThanOrEqual(PLAZO_CIERRE_MS);
    } finally {
      if (w) await terminar(w.proc);
      await terminar(redis);
    }
  });
});
