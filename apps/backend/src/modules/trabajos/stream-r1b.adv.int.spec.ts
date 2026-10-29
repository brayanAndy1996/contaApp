// Spec 008 · T13b (ronda adversarial 1b, caja blanca): el SSE de `/trabajos/stream` frente a Redis que se reinicia, a un
// evento inyectado en `eventos:{tenantId}` con un cliente de OTRO estudio, y al SIGTERM del proceso backend.
// PG y Redis reales. Para reiniciar Redis sin tocar el compartido, la app de la primera prueba apunta a un redis-server
// propio en un puerto libre (se omite si no hay `redis-server`). Cada banco borra sus estudios y su prefijo.
//
// Hallazgos que fija (rojo):
//  1. StreamService.recibir solo filtra por `clienteId` para roles con alcance asignado; para Dueño/Administrador
//     (`global`) reenvía cualquier evento válido del canal, aunque el `clienteId` no sea de su estudio. Quien pueda
//     publicar en Redis (o un bug de publicación con el tenantId equivocado) filtra trabajos de otro estudio por SSE (CA-5,
//     "nunca llegan eventos de otro estudio"; defensa en profundidad: el backend conoce los clientes del estudio).
//  2. El backend no registra hooks de apagado (`main.ts` sin enableShutdownHooks): con SIGTERM el proceso muere sin
//     `onModuleDestroy`/`onApplicationShutdown`, así que los streams abiertos se cortan sin terminar (no hay cierre
//     ordenado del stream ni del suscriptor Redis, plan "Archivos": app.ts "suscriptor Redis con cierre ordenado").
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { publicarEvento } from "@contapp/queue";
import type { TrabajoVista } from "@contapp/shared";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ipUnica } from "../../../test/soporte.js";
import {
  abrirBancoTrabajos,
  abrirSse,
  cerrarSseAbiertos,
  esEventoId,
  esperarSuscripcion,
  vistaCon,
  type BancoTrabajos,
} from "../../../test/soporte-trabajos.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const hayRedisServer = spawnSync("redis-server", ["--version"]).status === 0;
const mainJs = fileURLToPath(new URL("../../../dist/main.js", import.meta.url));
const dirBackend = fileURLToPath(new URL("../../../", import.meta.url));
const pausa = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hijos = new Set<ChildProcess>();
const bancos: BancoTrabajos[] = [];

afterAll(async () => {
  cerrarSseAbiertos();
  for (const b of bancos) await b.cerrar().catch(() => undefined);
  for (const h of hijos) if (h.exitCode === null && h.signalCode === null) h.kill("SIGKILL");
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
    if (spawnSync("redis-cli", ["-p", String(puerto), "ping"], { encoding: "utf8" }).stdout.trim() === "PONG") return r;
    await pausa(50);
  }
  throw new Error("redis-server propio no arrancó");
}

async function terminar(h: ChildProcess, senal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  if (h.exitCode !== null || h.signalCode !== null) return;
  const fin = new Promise<void>((r) => h.once("exit", () => r()));
  h.kill(senal);
  await fin;
}

describe.skipIf(!hayRedisServer)("re-suscripción del SSE tras reiniciar Redis (Ratificaciones de T10/T11 (9))", () => {
  it("tras reiniciar Redis, el stream abierto vuelve a recibir eventos (o se cierra para reconectar)", async () => {
    const puerto = await puertoLibre();
    const url = `redis://127.0.0.1:${puerto}`;
    let redis = await levantarRedis(puerto);
    const b = await abrirBancoTrabajos({ redisApp: url });
    bancos.push(b);
    const E = await b.estudio();
    const [c] = await b.clientes(E.tenantId, 1);
    const T = await b.sembrar(E.tenantId, c!, { creadoPor: E.titular.id });
    const s = await abrirSse(b.h, { cookie: E.titular.cookie, estudio: E.tenantId });
    expect(s.status).toBe(200);
    let emisor = new Redis(url, { maxRetriesPerRequest: 1 });
    try {
      await esperarSuscripcion(emisor, b.prefijo, E.tenantId);
      await publicarEvento(emisor, E.tenantId, vistaCon(T, { estado: "ejecutando", intentos: 1 }), { prefijo: b.prefijo });
      expect(await s.esperar(esEventoId(T.id), 2500), "control: antes del reinicio llega").not.toBeNull();

      // Reinicio de Redis (se pierden las suscripciones del servidor).
      emisor.disconnect();
      await terminar(redis);
      await pausa(1500);
      redis = await levantarRedis(puerto);
      emisor = new Redis(url, { maxRetriesPerRequest: 1 });
      await esperarSuscripcion(emisor, b.prefijo, E.tenantId, 10_000).catch(() => undefined);
      const id = randomUUID();
      await publicarEvento(emisor, E.tenantId, vistaCon(T, { id, estado: "completado" }), { prefijo: b.prefijo });
      const llego = await s.esperar(esEventoId(id), 3000);
      expect(llego !== null || s.cerrado, "el stream sigue abierto pero ya no recibe eventos").toBe(true);
    } finally {
      s.cerrar();
      emisor.disconnect();
      await terminar(redis);
    }
  });
});

describe("evento inyectado en eventos:{tenantId} con un cliente de otro estudio (CA-5, CA-6)", () => {
  it("el Dueño del estudio no recibe por SSE un evento cuyo clienteId no es de su estudio", async () => {
    const b = await abrirBancoTrabajos();
    bancos.push(b);
    const E = await b.estudio();
    const ajeno = await b.estudio();
    const [cE] = await b.clientes(E.tenantId, 1);
    const [cAjeno] = await b.clientes(ajeno.tenantId, 1);
    const propio = await b.sembrar(E.tenantId, cE!, { creadoPor: E.titular.id });
    const s = await abrirSse(b.h, { cookie: E.titular.cookie, estudio: E.tenantId });
    expect(s.status).toBe(200);
    await esperarSuscripcion(b.redis, b.prefijo, E.tenantId);
    const intruso: TrabajoVista = vistaCon(propio, { id: randomUUID(), clienteId: cAjeno!, estado: "error", motivo: "credencial_invalida" });
    await publicarEvento(b.redis, E.tenantId, intruso, { prefijo: b.prefijo });
    // Control: un evento legítimo publicado después sí llega (el canal funciona).
    await publicarEvento(b.redis, E.tenantId, vistaCon(propio, { estado: "ejecutando", intentos: 1 }), { prefijo: b.prefijo });
    expect(await s.esperar(esEventoId(propio.id), 2500)).not.toBeNull();
    await pausa(300);
    s.cerrar();
    expect(
      s.eventos.filter((x) => x.json?.clienteId === cAjeno).map((x) => x.json?.clienteId),
      "llegó por SSE un trabajo de un cliente de otro estudio",
    ).toEqual([]);
  });
});

describe.skipIf(!existsSync(mainJs))("SIGTERM al backend compilado con un stream abierto", () => {
  it("cierra el stream de forma ordenada (fin del cuerpo, no corte) y termina en ≤ 10 s", async () => {
    const b = await abrirBancoTrabajos();
    bancos.push(b);
    const E = await b.estudio();
    const puerto = await puertoLibre();
    let salida = "";
    const proc = spawn(process.execPath, [mainJs], {
      cwd: dirBackend,
      env: { ...process.env, PORT: String(puerto) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    hijos.add(proc);
    proc.stdout!.on("data", (d: Buffer) => (salida += d.toString("utf8")));
    proc.stderr!.on("data", (d: Buffer) => (salida += d.toString("utf8")));
    const salio = new Promise<number>((r) => proc.once("exit", () => r(Date.now())));
    try {
      // Espera a que escuche (GET /trabajos sin sesión -> 401).
      let listo = false;
      for (let i = 0; i < 150 && !listo; i++) {
        listo = await new Promise<boolean>((r) => {
          const q = http.get({ host: "127.0.0.1", port: puerto, path: "/trabajos" }, (res) => {
            res.resume();
            r(true);
          });
          q.on("error", () => r(false));
        });
        if (!listo) await pausa(100);
      }
      expect(listo, `el backend hijo no arrancó: ${salida.slice(-300)}`).toBe(true);

      const fin = await new Promise<{ status: number; completo: boolean | null }>((r, mal) => {
        const q = http.request({
          host: "127.0.0.1",
          port: puerto,
          path: "/trabajos/stream",
          method: "GET",
          headers: { Accept: "text/event-stream", Cookie: E.titular.cookie, "X-Estudio": E.tenantId, "X-Forwarded-For": ipUnica() },
        });
        q.on("error", () => r({ status: 0, completo: false }));
        q.on("response", (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            mal(new Error(`stream ${res.statusCode}`));
            return;
          }
          res.on("data", () => undefined);
          res.on("end", () => r({ status: 200, completo: res.complete }));
          res.on("aborted", () => r({ status: 200, completo: false }));
          res.on("error", () => r({ status: 200, completo: false }));
          setTimeout(() => proc.kill("SIGTERM"), 300);
        });
        q.end();
      });
      const t0 = Date.now();
      const tSalida = await Promise.race([salio, pausa(10_000).then(() => null)]);
      expect(tSalida, "el backend no terminó tras SIGTERM").not.toBeNull();
      expect(tSalida! - t0).toBeLessThanOrEqual(10_000);
      expect(fin, "el stream se cortó sin cierre ordenado").toEqual({ status: 200, completo: true });
    } finally {
      await terminar(proc);
    }
  });
});
