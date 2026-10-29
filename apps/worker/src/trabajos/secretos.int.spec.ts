import type { ContappDb } from "@contapp/db";
import { MOTIVOS_TRABAJO } from "@contapp/shared";
import { ErrorCredencial, ErrorDatos, ErrorPortal, ErrorTransitorio, type CredencialSire, type SireAuth, type TokenSire } from "@contapp/sunat";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loggerEspia, volcado } from "../../test/soporte.js";
import {
  arrancar,
  canario,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  encolarYPublicar,
  Escenario,
  esperarHasta,
  fijarConfig,
  limpiarPrefijo,
  notificadorEspia,
  nuevoPrefijo,
  ProcesadorProgramable,
  registrarTiposDePrueba,
  restaurarConfig,
  suscribirEventos,
  volcarPrefijo,
} from "../../test/trabajos.js";

// Spec 008, T5 (rojo; integración con PostgreSQL y Redis reales): sin fugas de secretos (CA-16, RNF-004, RNF-083). Un client_secret, una
// clave SOL y un token SIRE canario no aparecen en logs, en job_registro (parámetros, resultado, motivo), en Redis (claves y valores,
// incluidos los jobs de BullMQ), en los eventos publicados ni en lo que recibe el Notificador, aunque los errores del adaptador y
// de los procesadores los lleven en su mensaje, en su `cause` o en propiedades. Los motivos son códigos del catálogo, nunca el mensaje.
//
// CONTRATO que fija (T10), además del de ejecutor.int.spec.ts:
// - `deps.logger: LoggerTrabajos`, objeto con `debug?`, `info`, `warn` y `error`, cada uno `(evento: EventoLog) => void` con
//   `EventoLog = { evento: string; tenant_id?; job_id?; tipo?; codigo?; …campos planos }`. El worker NUNCA pasa un `Error`, su `message`,
//   su `stack` ni sus propiedades: solo códigos y ids. Todo evento que menciona un trabajo lleva los tres campos `tenant_id`, `job_id` y `tipo`.
//   Sin logger inyectado, el valor por defecto escribe lo mismo en consola (esta prueba también vigila console y stdout/stderr).
// - El evento SSE es exactamente la vista pública (shared `trabajoVistaSchema`): sin RUC, tenantId, parámetros ni resultado.

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

registrarTiposDePrueba();

const TOKEN = canario("token_sire");
const SECRETO = canario("client_secret");
const CLAVE_SOL = canario("clave_sol");
const TODOS = [TOKEN, SECRETO, CLAVE_SOL];
const VISTA = ["clienteId", "creadoEn", "creadoPor", "estado", "id", "intentos", "iniciadoEn", "motivo", "posicion", "terminadoEn", "tipo"];

class SireAuthCanario implements SireAuth {
  async obtenerToken(c: CredencialSire): Promise<TokenSire> {
    expect(c.clientSecret).toBe(SECRETO); // el adaptador sí recibe el secreto (no se espía su contenido, solo que no se fuga)
    return { token: TOKEN, expiraEn: new Date(Date.now() + 600_000) };
  }
}

let admin: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
const prefijo = nuevoPrefijo();

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  redis = conectarRedis();
  e = new Escenario(admin);
  await fijarConfig(admin, "sire", { global: 4, tenant: 2, espera: 0, reintentos: 2, base: 100 });
});

afterAll(async () => {
  await restaurarConfig(admin).catch(() => undefined);
  await e?.limpiar();
  await limpiarPrefijo(redis, prefijo).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

/** Error con el canario en el mensaje, en la causa, en propiedades y en un AggregateError. */
function errorSucio(): Error {
  const causa = Object.assign(new Error(`causa con ${CLAVE_SOL}`), { detail: `detalle ${SECRETO}`, where: TOKEN });
  const e1 = new Error(`fallo del adaptador con ${TOKEN}`, { cause: causa });
  return Object.assign(new AggregateError([e1, new Error(SECRETO)], `varios fallos ${CLAVE_SOL}`), { token: TOKEN });
}

describe("CA-16: canarios de secretos ausentes de logs, job_registro, Redis, eventos y notificaciones", () => {
  it("con éxitos y con todos los tipos de error, ningún rastro de los canarios; los logs llevan tenant_id, job_id y tipo; los motivos son códigos", async () => {
    const T = await e.estudio();
    const usuario = await e.usuario(T, "contador");
    const clientes = await Promise.all(Array.from({ length: 6 }, () => e.cliente(T)));
    for (const c of clientes) await e.asignar(T, c.id, usuario);
    await e.credencial(T, clientes[3]!.id, "sol");

    const prog = new ProcesadorProgramable();
    prog.comportamiento = async (ctx, l) => {
      switch (clientes.findIndex((c) => c.id === l.clienteId)) {
        case 0: // éxito usando el token
          await ctx.conToken(async (t) => t.length);
          return { ok: true };
        case 1: // transitorio con el canario en todas partes
          throw new ErrorTransitorio(errorSucio());
        case 2: // error crudo no clasificado
          throw errorSucio();
        case 3: // credencial inválida
          throw new ErrorCredencial(errorSucio());
        case 4:
          throw new ErrorDatos(errorSucio());
        default:
          throw new ErrorPortal(errorSucio());
      }
    };
    const { logger, llamadas } = loggerEspia();
    const notificador = notificadorEspia();

    // Vigila también lo que el worker escriba por consola o por stdout/stderr.
    const capturado: string[] = [];
    const espias = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void capturado.push(volcado(a))));
    const escribir = (original: typeof process.stdout.write) =>
      ((chunk: unknown, ...resto: unknown[]) => {
        capturado.push(String(chunk));
        return (original as (...a: unknown[]) => boolean).call(process.stdout, chunk, ...resto);
      }) as typeof process.stdout.write;
    const stdoutOrig = process.stdout.write;
    const stderrOrig = process.stderr.write;
    process.stdout.write = escribir(stdoutOrig);
    process.stderr.write = escribir(stderrOrig);

    const ev = await suscribirEventos(prefijo, [T]);
    const p = await arrancar({
      prefijo,
      procesadores: { "prueba.eco": prog.procesador, "prueba.credencial_sol": prog.procesador },
      sireAuth: new SireAuthCanario(),
      credencialesSire: async (c: { ruc: string }) => ({ clientId: "id-prueba", clientSecret: SECRETO, usuarioSol: "USUARIOPRUEBA", claveSol: CLAVE_SOL, ruc: c.ruc }),
      notificador: notificador as never,
      logger: logger as never,
    });
    try {
      const ids: string[] = [];
      for (const [i, c] of clientes.entries()) {
        ids.push((await encolarYPublicar(backend, redis, prefijo, T, { tipo: i === 3 ? "prueba.credencial_sol" : "prueba.eco", clienteId: c.id, parametros: { n: i + 1 }, creadoPor: usuario })).trabajo.id);
      }
      await esperarHasta(
        async () => (await Promise.all(ids.map((id) => e.fila(id).then((f) => f.estado)))).every((s) => s === "completado" || s === "error"),
        "los 6 trabajos terminan",
        { timeoutMs: 60_000 },
      );
      await esperarHasta(() => ev.estadosDe(ids[5]!).includes("error"), "eventos publicados");

      // Estados y motivos: códigos del catálogo.
      const filas = await Promise.all(ids.map((id) => e.fila(id)));
      expect(filas[0]).toMatchObject({ estado: "completado" });
      expect(filas.slice(1).map((f) => [f.estado, f.motivo])).toEqual([
        ["error", "sunat_no_responde"],
        ["error", "sunat_no_responde"],
        ["error", "credencial_invalida"],
        ["error", "datos_invalidos"],
        ["error", "portal_cambio"],
      ]);
      for (const f of filas) if (f.motivo !== null) expect(MOTIVOS_TRABAJO as readonly string[]).toContain(f.motivo);

      // job_registro: nada de los canarios en ninguna columna.
      const jobs = await e.volcarJobs();
      for (const s of TODOS) expect(jobs, "job_registro").not.toContain(s);

      // Redis: ni en claves ni en valores (incluye los jobs de BullMQ y el token cifrado).
      const todoRedis = await volcarPrefijo(redis, prefijo);
      for (const s of TODOS) expect(todoRedis, "Redis").not.toContain(s);

      // Eventos: solo la vista pública.
      expect(ev.mensajes.length).toBeGreaterThan(0);
      for (const m of ev.mensajes) {
        for (const s of TODOS) expect(m.texto, "evento").not.toContain(s);
        expect(Object.keys(m.evento).sort()).toEqual([...VISTA].sort());
      }

      // Notificador.
      expect(notificador.llamadas).toHaveLength(1);
      for (const s of TODOS) expect(volcado(notificador.llamadas)).not.toContain(s);

      // Logs: del logger inyectado y de consola/stdout/stderr.
      expect(llamadas.length).toBeGreaterThan(0);
      const todoLogs = volcado(llamadas) + "\n" + capturado.join("\n");
      for (const s of TODOS) expect(todoLogs, "logs").not.toContain(s);
      for (const l of llamadas) {
        const cuerpo = l.args[0] as Record<string, unknown> | undefined;
        expect(typeof cuerpo, `el logger recibe un objeto plano (${l.metodo})`).toBe("object");
        expect(cuerpo instanceof Error).toBe(false);
        const campos = ["tenant_id", "job_id", "tipo"].filter((c) => cuerpo && c in cuerpo);
        if (campos.length > 0) expect(campos, `un evento que menciona un trabajo lleva los tres campos: ${JSON.stringify(cuerpo)}`).toHaveLength(3);
      }
      for (const [i, id] of ids.entries()) {
        const propios = llamadas.filter((l) => {
          const c = l.args[0] as Record<string, unknown>;
          return c?.job_id === id && c?.tenant_id === T && c?.tipo === (i === 3 ? "prueba.credencial_sol" : "prueba.eco");
        });
        expect(propios.length, `el trabajo ${i + 1} deja al menos un log con tenant_id, job_id y tipo`).toBeGreaterThan(0);
      }
    } finally {
      process.stdout.write = stdoutOrig;
      process.stderr.write = stderrOrig;
      for (const s of espias) s.mockRestore();
      await ev.cerrar();
      await p.detener({ esperaMs: 2000 });
    }
  });
});
