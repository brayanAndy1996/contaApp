import type { ContappDb } from "@contapp/db";
import { crearClaves } from "@contapp/queue";
import { ErrorCredencial, ErrorTransitorio, type CredencialSire, type SireAuth, type TokenSire } from "@contapp/sunat";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  arrancar,
  canario,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  dormir,
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
  volcarPrefijo,
  type ProcesoWorker,
} from "../../../test/trabajos.js";
import { CacheTokenSire, TokenRechazadoError } from "./cache-token.js";

// Spec 008, T5 (rojo; integración con Redis y PostgreSQL reales): token SIRE por RUC (RF-045, D14, CA-11).
//
// CONTRATO que fija (T10), en apps/worker/src/trabajos/token-sire/cache-token.ts:
// - `new CacheTokenSire({ redis, sireAuth, credenciales, reloj?, prefijo?, proceso?, margenMs? })`:
//     `credenciales({ tenantId, clienteId, ruc }) → Promise<CredencialSire>` entrega lo descifrado (003); solo se llama cuando hay que
//     pedir un token nuevo (con la caché vigente no se descifra nada). `proceso` identifica al proceso en la clave (por defecto un id
//     aleatorio por instancia); `margenMs` = 60_000 por defecto.
// - `obtener({ tenantId, clienteId, ruc }) → Promise<string>`: devuelve el token de la caché o lo pide a `SireAuth.obtenerToken`
//     (single-flight por (tenantId, clienteId) en memoria: N llamadas simultáneas = una sola petición, todas reciben el mismo resultado
//     o el mismo error; un error NO se guarda en la caché).
// - Caché en Redis, clave `crearClaves(prefijo).tokenSire(proceso, tenantId, clienteId)`: el valor es binario opaco `nonce‖ct‖tag`
//     de AES-256-GCM con una llave de 32 B aleatoria que solo vive en la memoria del proceso y AAD = el nombre de la clave; TTL =
//     expiraEn − margen − ahora. Un valor ilegible, alterado o copiado de otra clave (AAD distinta) se trata como ausente: se pide un
//     token nuevo y nunca se devuelve el de otro cliente.
// - `conToken(ctx, usar)`: ejecuta `usar(token)`; si lanza `TokenRechazadoError` (el servicio respondió 401 con ese token) invalida la
//     caché, pide un token nuevo y llama a `usar` UNA vez más; si vuelve a ser rechazado lanza `ErrorCredencial` (sunat). Otros errores
//     se propagan tal cual.
// - Integración con el ejecutor: `ContextoProcesador.conToken(usar)` es `cache.conToken({ tenantId, clienteId, ruc }, usar)` del trabajo
//     en curso; un `ErrorCredencial` al obtener el token tiene el mismo efecto que uno lanzado por el procesador (CA-9).

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

registrarTiposDePrueba();

/** SireAuth de la prueba: cuenta llamadas, tarda lo que se le diga y devuelve tokens canario distintos. */
class SireAuthEspia implements SireAuth {
  llamadas = 0;
  retardoMs = 0;
  vigenciaMs = 600_000;
  falla: Error | null = null;
  readonly credenciales: CredencialSire[] = [];
  readonly tokens: string[] = [];
  constructor(readonly etiqueta: string) {}
  async obtenerToken(c: CredencialSire): Promise<TokenSire> {
    this.llamadas += 1;
    this.credenciales.push(c);
    if (this.retardoMs > 0) await dormir(this.retardoMs);
    if (this.falla) throw this.falla;
    const token = `${this.etiqueta}-TOKEN-${this.llamadas}`;
    this.tokens.push(token);
    return { token, expiraEn: new Date(Date.now() + this.vigenciaMs) };
  }
}

const SECRETO = canario("client_secret");
const CLAVE_SOL = canario("clave_sol");
const credencialesDe = (ruc: string): CredencialSire => ({ clientId: "client-id-prueba", clientSecret: SECRETO, usuarioSol: "USUARIOPRUEBA", claveSol: CLAVE_SOL, ruc });

let admin: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
const prefijos: string[] = [];
const procesos: ProcesoWorker[] = [];

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  redis = conectarRedis();
  e = new Escenario(admin);
  await fijarConfig(admin, "sire", { global: 4, tenant: 2, espera: 0, reintentos: 3, base: 100 });
});

afterAll(async () => {
  await Promise.all(procesos.map((p) => p.detener({ esperaMs: 1000 }).catch(() => undefined)));
  await restaurarConfig(admin).catch(() => undefined);
  await e?.limpiar();
  for (const p of prefijos) await limpiarPrefijo(redis, p).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

function cache(o: { sireAuth: SireAuth; proceso?: string; margenMs?: number; prefijo?: string }) {
  const prefijo = o.prefijo ?? nuevoPrefijo();
  if (!prefijos.includes(prefijo)) prefijos.push(prefijo);
  const credenciales = vi.fn(async (c: { tenantId: string; clienteId: string; ruc: string }) => credencialesDe(c.ruc));
  const c = new CacheTokenSire({ redis, sireAuth: o.sireAuth, credenciales, prefijo, proceso: o.proceso ?? "p1", margenMs: o.margenMs });
  return { c, credenciales, prefijo, k: crearClaves(prefijo) };
}
const ctx = (t = "00000000-0000-4000-8000-0000000000a1", cl = "00000000-0000-4000-8000-0000000000c1", ruc = "20100070970") => ({ tenantId: t, clienteId: cl, ruc });

describe("CA-11: obtención, caché y single-flight", () => {
  it("diez peticiones simultáneas del mismo cliente piden un solo token (y descifran una sola vez)", async () => {
    const auth = new SireAuthEspia("A");
    auth.retardoMs = 150;
    const { c, credenciales } = cache({ sireAuth: auth });
    const tokens = await Promise.all(Array.from({ length: 10 }, () => c.obtener(ctx())));
    expect(auth.llamadas).toBe(1);
    expect(credenciales).toHaveBeenCalledTimes(1);
    expect(new Set(tokens)).toEqual(new Set([auth.tokens[0]]));
    // El adaptador recibió las credenciales del cliente y su RUC.
    expect(auth.credenciales[0]).toMatchObject({ ruc: "20100070970", clientSecret: SECRETO });
  });

  it("con el token en caché no vuelve a llamar a SireAuth ni a descifrar", async () => {
    const auth = new SireAuthEspia("B");
    const { c, credenciales } = cache({ sireAuth: auth });
    const t1 = await c.obtener(ctx());
    const t2 = await c.obtener(ctx());
    expect(t2).toBe(t1);
    expect(auth.llamadas).toBe(1);
    expect(credenciales).toHaveBeenCalledTimes(1);
  });

  it("en Redis no hay token en claro: el valor es opaco (AES-GCM), con TTL = vencimiento − margen", async () => {
    const auth = new SireAuthEspia("CANARIO-token");
    auth.vigenciaMs = 600_000;
    const { c, prefijo, k } = cache({ sireAuth: auth });
    const x = ctx();
    const token = await c.obtener(x);
    const clave = k.tokenSire("p1", x.tenantId, x.clienteId);
    const valor = await redis.getBuffer(clave);
    expect(valor).not.toBeNull();
    for (const rastro of [token, Buffer.from(token).toString("hex"), Buffer.from(token).toString("base64"), Buffer.from(token).toString("base64url")]) {
      expect(valor!.toString("latin1"), "token legible en el valor").not.toContain(rastro);
      expect(valor!.toString("hex")).not.toContain(rastro);
      expect(valor!.toString("base64")).not.toContain(rastro);
    }
    expect(valor!.length, "nonce (12) + texto cifrado + etiqueta (16)").toBeGreaterThanOrEqual(12 + token.length + 16);
    const ttl = await redis.pttl(clave);
    expect(ttl).toBeGreaterThan(530_000);
    expect(ttl).toBeLessThanOrEqual(540_000);
    // Ni el token ni los secretos del cliente aparecen en ninguna parte de Redis.
    const todo = await volcarPrefijo(redis, prefijo);
    for (const secreto of [token, SECRETO, CLAVE_SOL]) expect(todo).not.toContain(secreto);
  });

  it("se renueva antes de vencer: con vigencia 1.5 s y margen 1 s la caché dura 0.5 s", async () => {
    const auth = new SireAuthEspia("C");
    auth.vigenciaMs = 1500;
    const { c } = cache({ sireAuth: auth, margenMs: 1000 });
    const t1 = await c.obtener(ctx());
    expect(await c.obtener(ctx())).toBe(t1);
    expect(auth.llamadas).toBe(1);
    await dormir(800);
    const t2 = await c.obtener(ctx());
    expect(auth.llamadas).toBe(2);
    expect(t2).not.toBe(t1);
  });

  it("cada cliente (y cada proceso) tiene su propia entrada: no se comparten tokens", async () => {
    const auth = new SireAuthEspia("D");
    const a = cache({ sireAuth: auth, proceso: "p1" });
    const b = cache({ sireAuth: auth, proceso: "p2", prefijo: a.prefijo });
    const x = ctx();
    const y = ctx(undefined, "00000000-0000-4000-8000-0000000000c2", "20100070971");
    const t1 = await a.c.obtener(x);
    const t2 = await a.c.obtener(y);
    const t3 = await b.c.obtener(x);
    expect(new Set([t1, t2, t3]).size).toBe(3);
    expect(auth.llamadas).toBe(3);
    expect((await redis.keys(`${a.prefijo}sire:token:*`)).length).toBe(3);
  });
});

describe("CA-11: 401, errores y valores alterados", () => {
  it("tras un 401 del servicio (TokenRechazadoError) invalida la caché, pide un token nuevo y reintenta una sola vez", async () => {
    const auth = new SireAuthEspia("E");
    const { c } = cache({ sireAuth: auth });
    const vistos: string[] = [];
    const r = await c.conToken(ctx(), async (token) => {
      vistos.push(token);
      if (vistos.length === 1) throw new TokenRechazadoError();
      return "listo";
    });
    expect(r).toBe("listo");
    expect(vistos).toHaveLength(2);
    expect(vistos[1]).not.toBe(vistos[0]);
    expect(auth.llamadas).toBe(2);
    // El token nuevo quedó en la caché.
    expect(await c.obtener(ctx())).toBe(vistos[1]);
    expect(auth.llamadas).toBe(2);
  });

  it("si el token nuevo también es rechazado, no hay más intentos: ErrorCredencial tras exactamente dos usos", async () => {
    const auth = new SireAuthEspia("F");
    const { c } = cache({ sireAuth: auth });
    let usos = 0;
    const usar = async (): Promise<never> => {
      usos += 1;
      throw new TokenRechazadoError();
    };
    await expect(c.conToken(ctx(), usar)).rejects.toBeInstanceOf(ErrorCredencial);
    expect(usos).toBe(2);
    expect(auth.llamadas).toBe(2);
  });

  it("otros errores del uso del token se propagan sin renovar", async () => {
    const auth = new SireAuthEspia("G");
    const { c } = cache({ sireAuth: auth });
    let usos = 0;
    const usar = async (): Promise<never> => {
      usos += 1;
      throw new ErrorTransitorio();
    };
    await expect(c.conToken(ctx(), usar)).rejects.toBeInstanceOf(ErrorTransitorio);
    expect(usos).toBe(1);
    expect(auth.llamadas).toBe(1);
  });

  it("un error de SireAuth llega a todas las peticiones simultáneas, no se guarda en la caché y la siguiente vuelve a intentar", async () => {
    const auth = new SireAuthEspia("H");
    auth.retardoMs = 100;
    auth.falla = new ErrorCredencial(new Error(`rechazada ${CLAVE_SOL}`));
    const { c, prefijo } = cache({ sireAuth: auth });
    const resultados = await Promise.allSettled(Array.from({ length: 5 }, () => c.obtener(ctx())));
    expect(auth.llamadas).toBe(1);
    for (const r of resultados) {
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ErrorCredencial);
    }
    expect(await redis.keys(`${prefijo}sire:token:*`)).toHaveLength(0);

    auth.falla = null;
    const token = await c.obtener(ctx());
    expect(token).toContain("H-TOKEN-");
    expect(auth.llamadas).toBe(2);
  });

  it("un valor copiado de la clave de otro cliente (AAD distinta) o alterado se trata como ausente: nunca se entrega el token de otro", async () => {
    const auth = new SireAuthEspia("I");
    const { c, prefijo, k } = cache({ sireAuth: auth });
    const x = ctx();
    const y = ctx(undefined, "00000000-0000-4000-8000-0000000000c2", "20100070971");
    const tokenX = await c.obtener(x);
    const valorX = (await redis.getBuffer(k.tokenSire("p1", x.tenantId, x.clienteId)))!;

    // Alguien con acceso a Redis copia el valor del cliente X a la clave del cliente Y.
    await redis.set(k.tokenSire("p1", y.tenantId, y.clienteId), valorX, "PX", 60_000);
    const tokenY = await c.obtener(y);
    expect(tokenY).not.toBe(tokenX);
    expect(auth.credenciales.at(-1)).toMatchObject({ ruc: y.ruc });

    // Un byte alterado en la clave de X: se descarta y se pide uno nuevo.
    const alterado = Buffer.from(valorX);
    alterado[alterado.length - 1] = alterado[alterado.length - 1]! ^ 0xff;
    await redis.set(k.tokenSire("p1", x.tenantId, x.clienteId), alterado, "PX", 60_000);
    const llamadasAntes = auth.llamadas;
    const nuevoX = await c.obtener(x);
    expect(nuevoX).not.toBe(tokenX);
    expect(auth.llamadas).toBe(llamadasAntes + 1);
    // Un valor basura corto tampoco rompe nada.
    await redis.set(k.tokenSire("p1", x.tenantId, x.clienteId), "basura", "PX", 60_000);
    await expect(c.obtener(x)).resolves.toEqual(expect.any(String));
    expect(await redis.keys(`${prefijo}sire:token:*`)).toHaveLength(2);
  });
});

describe("CA-11 y CA-9 con el worker completo", () => {
  async function mundo(auth: SireAuthEspia) {
    const prefijo = nuevoPrefijo();
    prefijos.push(prefijo);
    const T = await e.estudio();
    const usuario = await e.usuario(T, "contador");
    const cliente = await e.cliente(T);
    await e.asignar(T, cliente.id, usuario);
    const prog = new ProcesadorProgramable();
    const notificador = notificadorEspia();
    const p = await arrancar({
      prefijo,
      procesadores: { "prueba.eco": prog.procesador, "prueba.credencial_sol": prog.procesador },
      sireAuth: auth,
      credencialesSire: async (c: { ruc: string }) => credencialesDe(c.ruc),
      notificador: notificador as never,
    });
    procesos.push(p);
    const encolar = (n: number, tipo = "prueba.eco") =>
      encolarYPublicar(backend, redis, prefijo, T, { tipo, clienteId: cliente.id, parametros: { n }, creadoPor: usuario }).then((r) => r.trabajo.id);
    return { prefijo, T, cliente, prog, p, notificador, encolar, estado: async (id: string) => (await e.fila(id))?.estado as string };
  }

  it("diez trabajos del mismo cliente, uno tras otro, comparten el token: una sola llamada a SireAuth", async () => {
    const auth = new SireAuthEspia("W");
    const m = await mundo(auth);
    try {
      const vistos: string[] = [];
      m.prog.comportamiento = async (ctx) => {
        await ctx.conToken(async (token) => {
          vistos.push(token);
        });
        return { ok: true };
      };
      const ids: string[] = [];
      for (let n = 1; n <= 10; n++) ids.push(await m.encolar(n));
      await esperarHasta(async () => (await Promise.all(ids.map(m.estado))).every((s) => s === "completado"), "10 trabajos completados", { timeoutMs: 30_000 });
      expect(auth.llamadas).toBe(1);
      expect(new Set(vistos).size).toBe(1);
      expect(vistos).toHaveLength(10);
      // Nada del token ni de los secretos quedó en Redis ni en job_registro.
      const redisTodo = await volcarPrefijo(redis, m.prefijo);
      const jobs = await e.volcarJobs();
      for (const secreto of [vistos[0]!, SECRETO, CLAVE_SOL]) {
        expect(redisTodo).not.toContain(secreto);
        expect(jobs).not.toContain(secreto);
      }
    } finally {
      await m.p.detener({ esperaMs: 2000 });
    }
  });

  it("un 401 del servicio en mitad de un trabajo renueva el token una vez y el trabajo termina bien", async () => {
    const auth = new SireAuthEspia("X");
    const m = await mundo(auth);
    try {
      let intentos = 0;
      m.prog.comportamiento = async (ctx) =>
        ctx.conToken(async () => {
          intentos += 1;
          if (intentos === 1) throw new TokenRechazadoError();
          return { ok: true };
        });
      const id = await m.encolar(1);
      await esperarHasta(async () => (await m.estado(id)) === "completado", "trabajo completado");
      expect(auth.llamadas).toBe(2);
      expect(intentos).toBe(2);
      expect((await e.fila(id)).intentos).toBe(0);
    } finally {
      await m.p.detener({ esperaMs: 2000 });
    }
  });

  it("si SireAuth rechaza la credencial (401 al obtener el token): error/credencial_invalida, credencial marcada y una sola notificación, sin canarios en los motivos", async () => {
    const auth = new SireAuthEspia("Y");
    auth.falla = new ErrorCredencial(new Error(`401 con ${CLAVE_SOL} y ${SECRETO}`));
    const m = await mundo(auth);
    try {
      await e.credencial(m.T, m.cliente.id, "sol");
      m.prog.comportamiento = async (ctx) => ctx.conToken(async () => ({ ok: true }));
      const id = await m.encolar(1, "prueba.credencial_sol");
      await esperarHasta(async () => (await m.estado(id)) === "error", "trabajo en error");
      expect(await e.fila(id)).toMatchObject({ estado: "error", motivo: "credencial_invalida", intentos: 0 });
      expect((await e.credencialEstado(m.cliente.id))?.estado).toBe("invalida");
      expect(m.notificador.llamadas).toHaveLength(1);
      expect(auth.llamadas, "sin reintento").toBe(1);
      const jobs = await e.volcarJobs();
      expect(jobs).not.toContain(CLAVE_SOL);
      expect(jobs).not.toContain(SECRETO);
    } finally {
      await m.p.detener({ esperaMs: 2000 });
    }
  });
});
