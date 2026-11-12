// Arranque, espera y apagado de backend, worker y frontend (spec 018, D-2; plan «Contratos: arranque»).
// Cada proceso va en su propio grupo (detached), con su salida en `<tmp>/<nombre>.log`. Listo cuando:
// backend responde 401 en /auth/sesion; frontend responde 200 en /login; worker tiene un worker en
// la cola `programados` (getWorkers), sin depender de logs.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import { scheduler } from "node:timers/promises";
import { Queue } from "bullmq";
import { COLA_SISTEMA, prefijoBull } from "@contapp/queue/worker";

export interface Proceso {
  readonly nombre: string;
  readonly pid: number;
  readonly log: string;
  terminado: boolean;
  salida: string;
}

export interface RegistroProceso {
  readonly nombre: string;
  readonly pid: number;
  readonly log: string;
}

/** Lo que la corrida necesita para apagar y limpiar. Sin secretos: PIDs, nombres y banderas. */
export interface EstadoPila {
  dir: string;
  bdCreada: boolean;
  conservarBd: boolean;
  procesos: RegistroProceso[];
}

const LISTO_TOPE_MS = 60_000;
const APAGADO_TOPE_MS = 10_000;
const SONDEO_MS = 250;

const arrancados: Proceso[] = [];
let limpiezaRegistrada = false;

/** Falla si el puerto ya lo usa otro proceso (otra corrida, o `pnpm dev`). */
export function comprobarPuertoLibre(puerto: number): Promise<void> {
  return new Promise((resolver, rechazar) => {
    const servidor = createServer();
    servidor.once("error", () => {
      rechazar(
        new Error(
          `El puerto ${puerto} ya está en uso. Probablemente otra corrida de pnpm e2e o pnpm dev; ciérrala y vuelve a correr.`,
        ),
      );
    });
    servidor.listen(puerto, () => {
      servidor.close(() => resolver());
    });
  });
}

/** Si el proceso de esta corrida sigue vivo al salir de Node, lo mata (no deja procesos huérfanos). */
function registrarLimpiezaAlSalir(): void {
  if (limpiezaRegistrada) return;
  limpiezaRegistrada = true;
  process.once("exit", () => {
    for (const proceso of arrancados) {
      if (!proceso.terminado) enviarAGrupo(proceso.pid, "SIGKILL");
    }
  });
}

export function arrancarProceso(opciones: {
  nombre: string;
  cwd: string;
  args: string[];
  env: Record<string, string>;
  log: string;
}): Proceso {
  const fd = openSync(opciones.log, "a");
  let hijo: ChildProcess;
  try {
    hijo = spawn(process.execPath, opciones.args, {
      cwd: opciones.cwd,
      env: opciones.env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  if (hijo.pid === undefined) {
    throw new Error(`No se pudo arrancar ${opciones.nombre}.`);
  }
  const proceso: Proceso = {
    nombre: opciones.nombre,
    pid: hijo.pid,
    log: opciones.log,
    terminado: false,
    salida: "",
  };
  hijo.once("exit", (codigo, señal) => {
    proceso.terminado = true;
    proceso.salida = `código ${codigo ?? "—"}${señal ? `, señal ${señal}` : ""}`;
  });
  hijo.once("error", (error) => {
    proceso.terminado = true;
    proceso.salida = `error al arrancar: ${error.message}`;
  });
  arrancados.push(proceso);
  registrarLimpiezaAlSalir();
  return proceso;
}

/** Últimas `n` líneas de un texto (las que se muestran cuando un proceso no arranca). */
export function ultimasLineas(texto: string, n = 40): string {
  const lineas = texto.split("\n");
  if (lineas.at(-1) === "") lineas.pop();
  return lineas.slice(-n).join("\n");
}

function ultimasLineasDeArchivo(ruta: string): string {
  try {
    return ultimasLineas(readFileSync(ruta, "utf8"));
  } catch {
    return "(sin salida)";
  }
}

function errorDeArranque(proceso: Proceso, motivo: string): Error {
  return new Error(
    `${proceso.nombre} ${motivo}.\n--- últimas 40 líneas de ${basename(proceso.log)} ---\n${ultimasLineasDeArchivo(proceso.log)}`,
  );
}

/** Una comprobación con tope de 2 s: una respuesta colgada cuenta como «todavía no». */
async function probar(comprobar: () => Promise<boolean>): Promise<boolean> {
  try {
    return await Promise.race([
      comprobar(),
      scheduler.wait(2_000).then(() => false),
    ]);
  } catch {
    return false;
  }
}

/** Sondea hasta que `comprobar` dé true; falla si el proceso muere antes o si pasan 60 s. */
export async function esperarListo(
  proceso: Proceso,
  comprobar: () => Promise<boolean>,
): Promise<void> {
  const limite = Date.now() + LISTO_TOPE_MS;
  for (;;) {
    if (proceso.terminado) {
      throw errorDeArranque(
        proceso,
        `terminó antes de estar listo (${proceso.salida})`,
      );
    }
    if (await probar(comprobar)) return;
    if (Date.now() >= limite) {
      throw errorDeArranque(
        proceso,
        `no estuvo listo en ${LISTO_TOPE_MS / 1000} s`,
      );
    }
    await scheduler.wait(SONDEO_MS);
  }
}

/** `true` si la URL responde con el estado esperado. Cualquier error de red es «todavía no». */
export async function respondeCon(
  url: string,
  estadoEsperado: number,
): Promise<boolean> {
  const respuesta = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(2_000),
  });
  await respuesta.body?.cancel();
  return respuesta.status === estadoEsperado;
}

function opcionesRedis(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    db: Number(u.pathname.slice(1) || 0),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
  };
}

/** Listo cuando la cola `programados` (la que el worker siempre consume) tiene al menos un worker. */
export async function esperarWorker(
  proceso: Proceso,
  urlRedis: string,
): Promise<void> {
  const cola = new Queue(COLA_SISTEMA, {
    connection: opcionesRedis(urlRedis),
    prefix: prefijoBull(),
  });
  try {
    await esperarListo(
      proceso,
      async () => (await cola.getWorkers()).length > 0,
    );
  } finally {
    await cola.close();
  }
}

function enviarAGrupo(pid: number, señal: NodeJS.Signals): void {
  try {
    process.kill(-pid, señal);
  } catch {
    // El grupo ya no existe.
  }
}

function grupoVivo(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function apagarGrupo(pid: number): Promise<void> {
  if (!grupoVivo(pid)) return;
  enviarAGrupo(pid, "SIGTERM");
  const limite = Date.now() + APAGADO_TOPE_MS;
  while (grupoVivo(pid) && Date.now() < limite) {
    await scheduler.wait(SONDEO_MS);
  }
  if (grupoVivo(pid)) {
    enviarAGrupo(pid, "SIGKILL");
    const tope = Date.now() + 2_000;
    while (grupoVivo(pid) && Date.now() < tope) {
      await scheduler.wait(50);
    }
  }
}

/** SIGTERM a cada grupo, SIGKILL a los 10 s si sigue vivo. Idempotente: un PID muerto no hace nada. */
export async function apagarProcesos(
  registros: readonly RegistroProceso[],
): Promise<void> {
  await Promise.all(registros.map((registro) => apagarGrupo(registro.pid)));
}

export function guardarEstado(estado: EstadoPila): void {
  writeFileSync(
    join(estado.dir, "estado.json"),
    JSON.stringify(estado, null, 2),
  );
}

export function leerEstado(dir: string): EstadoPila | undefined {
  try {
    return JSON.parse(
      readFileSync(join(dir, "estado.json"), "utf8"),
    ) as EstadoPila;
  } catch {
    return undefined;
  }
}
