// Spec 008 · T15a (ronda adversarial 2a): reintenta por otra vía la corrección de H-008-1b-6 (SIGTERM con tope). Allí
// se cayó Redis; aquí la que no responde es la BD (partición de red: la conexión TCP sigue abierta pero nada pasa).
// Se lanza el worker COMPILADO (`dist/main.js`) en un proceso hijo, con un redis-server propio en un puerto libre y
// `DATABASE_URL` apuntando a un proxy TCP de la prueba que, en cuanto el worker arranca, deja de reenviar sin cerrar las
// conexiones. Como en la ronda 1, antes se espera a que la BD compartida no tenga trabajos vivos viejos de otras suites
// (el reconciliador del hijo los tocaría en el instante previo al corte); si no se despejan, la prueba se omite.
//
// Hallazgo que fija (rojo):
//  1. `detener` ya tiene plazo, pero luego `TrabajosService.onApplicationShutdown` hace `await db.close()` (pg
//     `pool.end()`), que espera a las conexiones prestadas y a las que cierra: con la BD sin responder no termina nunca.
//     El proceso sigue vivo tras SIGTERM hasta el SIGKILL del orquestador (plan "Worker": ≤ 30 s).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import type { ContappDb } from "@contapp/db";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { crearDbAdmin, dormir } from "../../test/trabajos.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const dirWorker = fileURLToPath(new URL("../../", import.meta.url));
const mainJs = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
const hayRedisServer = spawnSync("redis-server", ["--version"]).status === 0;
const PLAZO_CIERRE_MS = 35_000; // 30 s del plan + margen

const hijos = new Set<ChildProcess>();
const sockets = new Set<Socket>();
let agujero: Server | null = null;

afterAll(async () => {
  for (const h of hijos) if (h.exitCode === null && h.signalCode === null) h.kill("SIGKILL");
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => (agujero ? agujero.close(() => r()) : r()));
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

/**
 * Proxy TCP hacia la BD real con interruptor de partición: hasta `cortar()` reenvía en los dos sentidos; desde entonces
 * acepta conexiones y bytes pero no reenvía ni cierra nada (tampoco al recibir FIN), como una red partida.
 */
async function proxyBd(host: string, puerto: number): Promise<{ puerto: number; cortar: () => void; conexiones: () => number }> {
  let cortado = false;
  let n = 0;
  agujero = createServer({ allowHalfOpen: true }, (cli) => {
    n++;
    sockets.add(cli);
    cli.on("error", () => undefined);
    if (cortado) return;
    const bd = connect({ host, port: puerto, allowHalfOpen: true });
    sockets.add(bd);
    bd.on("error", () => undefined);
    cli.on("data", (d) => {
      if (!cortado) bd.write(d);
    });
    bd.on("data", (d) => {
      if (!cortado) cli.write(d);
    });
    cli.on("end", () => {
      if (!cortado) bd.end();
    });
    bd.on("end", () => {
      if (!cortado) cli.end();
    });
  });
  const p = await new Promise<number>((ok) => agujero!.listen(0, "127.0.0.1", () => ok((agujero!.address() as { port: number }).port)));
  return { puerto: p, cortar: () => (cortado = true), conexiones: () => n };
}

/** Espera a que no haya trabajos vivos de más de 20 s sin cambios (de otras suites): el hijo no debe tocarlos. */
async function bdDespejada(admin: ContappDb): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    const r = await admin.pool.query(
      "select count(*)::int as n from job_registro where estado in ('en_cola','ejecutando') and actualizado_en < now() - interval '20 seconds'",
    );
    if (r.rows[0].n === 0) return true;
    await dormir(1000);
  }
  return false;
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

describe.skipIf(!hayRedisServer || !existsSync(mainJs))("H-008-1b-6 por otra vía: SIGTERM con la BD sin responder", () => {
  it("el worker compilado termina en ≤ 35 s tras SIGTERM aunque la BD deje de responder (partición de red)", async (ctx) => {
    const admin = crearDbAdmin();
    const despejada = await bdDespejada(admin).finally(() => admin.close());
    if (!despejada) ctx.skip();
    const puertoRedis = await puertoLibre();
    const redis = await levantarRedis(puertoRedis);
    // La URL real solo se usa para cambiarle el host y el puerto; nunca se imprime.
    const url = new URL(String(process.env.DATABASE_URL));
    const bd = await proxyBd(url.hostname === "localhost" ? "127.0.0.1" : url.hostname, Number(url.port || 5432));
    url.hostname = "127.0.0.1";
    url.port = String(bd.puerto);
    let texto = "";
    const proc = spawn(process.execPath, [mainJs], {
      cwd: dirWorker,
      env: { ...process.env, NODE_ENV: "test", REDIS_URL: `redis://127.0.0.1:${puertoRedis}`, DATABASE_URL: url.toString() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    hijos.add(proc);
    proc.stdout!.on("data", (d: Buffer) => (texto += d.toString("utf8")));
    proc.stderr!.on("data", (d: Buffer) => (texto += d.toString("utf8")));
    const salio = new Promise<number>((r) => proc.once("exit", () => r(Date.now())));
    try {
      for (let i = 0; i < 300 && !texto.includes('"trabajos_iniciados"'); i++) {
        if (proc.exitCode !== null) break;
        await dormir(100);
      }
      expect(texto.includes('"trabajos_iniciados"'), "el worker no arrancó").toBe(true);
      bd.cortar(); // la red hacia la BD se parte con el worker en marcha
      await dormir(12_000); // > 10 s: el despachador ya releyó config_sistema y espera a la BD (consulta colgada)
      expect(bd.conexiones(), "control: el worker usó la BD a través del proxy").toBeGreaterThan(0);
      const t0 = Date.now();
      proc.kill("SIGTERM");
      const fin = await Promise.race([salio, dormir(PLAZO_CIERRE_MS + 5_000).then(() => null)]);
      const ms = fin === null ? null : fin - t0;
      expect(ms, `el worker seguía vivo ${PLAZO_CIERRE_MS + 5_000} ms después de SIGTERM; trabajos_detenidos: ${texto.includes('"trabajos_detenidos"')}`).not.toBeNull();
      expect(ms!).toBeLessThanOrEqual(PLAZO_CIERRE_MS);
    } finally {
      await terminar(proc);
      await terminar(redis);
    }
  });
});
