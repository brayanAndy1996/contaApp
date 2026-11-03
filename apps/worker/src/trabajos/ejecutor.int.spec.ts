import type { ContappDb } from "@contapp/db";
import { crearClaves, encolar } from "@contapp/queue";
import { crearColas } from "@contapp/queue/worker";
import {
  ErrorCredencial,
  ErrorDatos,
  ErrorPortal,
  ErrorTransitorio,
} from "@contapp/sunat";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  arrancar,
  compuerta,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  dormir,
  encolarYPublicar,
  Escenario,
  esperarHasta,
  fijarConfig,
  limpiarPrefijo,
  minimoTx,
  notificadorEspia,
  nuevoPrefijo,
  opcionesBull,
  ProcesadorProgramable,
  RelojAjustable,
  restaurarConfig,
  registrarTiposDePrueba,
  suscribirEventos,
  type ClientePrueba,
  type ProcesoWorker,
} from "../../test/trabajos.js";

// Spec 008, T5 (rojo; integración con PostgreSQL, Redis y BullMQ reales): el ejecutor del worker y el ensamblado del módulo de
// trabajos. CA-8, CA-9, CA-14, CA-15, CA-4 (reintentos) y D6. Requiere REDIS_URL, DATABASE_URL y MIGRATIONS_DATABASE_URL.
//
// CONTRATO que fija (T10), en apps/worker/src/trabajos/:
// - `iniciar.ts`: `iniciarTrabajos(deps): Promise<TrabajosEnMarcha>` con
//     deps = { db: ContappDb (rol contapp_worker; withTenant y withSistema), redis (ioredis), conexionBull (host, port, db, …),
//              prefijo? ('contapp:'), reloj? ({ ahora(): Date }; real por defecto; lo usan despachador, reconciliador, ejecutor y caché),
//              procesadores?: Record<tipo, Procesador> (se suman a los por defecto, que solo incluyen `prueba.eco` con NODE_ENV=test),
//              notificador?: Notificador (NotificadorLog por defecto), sireAuth?: SireAuth (MockSireAuth por defecto),
//              credencialesSire?: (c: { tenantId, clienteId, ruc }) => Promise<CredencialSire>,
//              kek?: { activa, anterior(desde) } (para `kek.rotar`), logger?: LoggerTrabajos, proceso?: string (id del proceso en la clave del token),
//              intervalos?: { despachadorMs (500), reconciliadorMs (30_000), latidoMs (10_000) }, antiguedadSeg? (30, del reconciliador) }
//   Arranca: el bucle del despachador, el del reconciliador, un Worker BullMQ por cola de `config_sistema` (payload estricto
//   { jobId, tenantId, tipo }, concurrency = concurrencia global, attempts 1), el ejecutor y el worker de trabajos de sistema.
//   `TrabajosEnMarcha.detener({ esperaMs = 30_000 })`: cierre ordenado: deja de despachar y de tomar trabajos nuevos, espera a los
//   que están en curso (hasta esperaMs), libera sus arriendos y cierra BullMQ. `TrabajosEnMarcha.abortar()`: muerte del proceso
//   (kill -9): desde ese instante NO escribe en la BD, NO emite comandos por el `redis` recibido ni libera arriendos; abandona
//   los procesadores en curso y cierra sus propias conexiones de BullMQ sin esperar.
// - `ejecutor.ts`: `type Procesador = (ctx: ContextoProcesador) => Promise<unknown>`;
//     `ContextoProcesador = { trabajo: { id, tenantId, clienteId, ruc, tipo, parametros, intentos, creadoPor }, conToken<T>(usar: (token: string) => Promise<T>): Promise<T> }`.
//   El valor devuelto (JSON ≤ 4 KB) se guarda en `job_registro.resultado`; lo lanzado se clasifica con `clasificarError` (sunat) y
//   `decidirTrasError` (queue) con la `config_sistema` VIGENTE (no `max_intentos`).
//   Ejecutor: (1) `withTenant(payload.tenantId)` corto: carga la fila; si no existe, el tipo no coincide o el estado no es `ejecutando`,
//   termina SIN efectos y sin llamar al procesador (CA-15); (2) toma `ejec:{jobId}` (`tomarEjecucion`); si no la obtiene, termina;
//   (3) ejecuta el procesador SIN transacción abierta (D6) con latido de arriendos; (4) `withTenant` corto con el resultado:
//   completado | reintento (`en_cola`, `intentos + 1`, `disponible_desde = ahora + base·2^(n−1) ± 20 %`, se vuelve a `publicar`) |
//   error con motivo (`sunat_no_responde`, `datos_invalidos`, `portal_cambio`, `credencial_invalida`); (5) libera cupos y deja el lock
//   del RUC con PX = espera_ruc_ms; (6) publica el evento del nuevo estado en `eventos:{tenantId}` (después del commit).
//   Con `ErrorCredencial`, en la MISMA transacción del cambio de estado: `marcarCredencialInvalida` y, solo si cambió, llama una vez a
//   `Notificador.credencialInvalida({ tenantId, clienteId, tipo, trabajoId })` (después del commit; si el notificador falla, el
//   trabajo igual queda en error).

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

registrarTiposDePrueba();

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
  await fijarConfig(admin, "sire", {
    global: 4,
    tenant: 2,
    espera: 0,
    reintentos: 3,
    base: 100,
  });
});

afterAll(async () => {
  await Promise.all(
    procesos.map((p) => p.detener({ esperaMs: 1000 }).catch(() => undefined)),
  );
  await restaurarConfig(admin).catch(() => undefined);
  await e?.limpiar();
  for (const p of prefijos)
    await limpiarPrefijo(redis, p).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

/** Un estudio, su cliente asignado a un contador, un procesador programable y el worker en marcha. */
async function mundo(
  o: {
    reloj?: RelojAjustable;
    notificador?: ReturnType<typeof notificadorEspia>;
    arrancarYa?: boolean;
  } = {},
) {
  const prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
  const T = await e.estudio();
  const usuario = await e.usuario(T, "contador");
  const c = await e.cliente(T);
  await e.asignar(T, c.id, usuario);
  const prog = new ProcesadorProgramable();
  const ev = await suscribirEventos(prefijo, [T]);
  const k = crearClaves(prefijo);
  let p!: ProcesoWorker;
  const iniciar = async () => {
    p = await arrancar({
      prefijo,
      reloj: o.reloj,
      notificador: o.notificador as never,
      procesadores: {
        "prueba.eco": prog.procesador,
        "prueba.no_idempotente": prog.procesador,
        "prueba.credencial_sol": prog.procesador,
      },
    });
    procesos.push(p);
    return p;
  };
  if (o.arrancarYa !== false) await iniciar();
  const encolar = (
    cl: ClientePrueba,
    n: number,
    extra: {
      tipo?: string;
      creadoPor?: string | null;
      prioridad?: "interactivo" | "programado";
    } = {},
  ) =>
    encolarYPublicar(backend, redis, prefijo, T, {
      tipo: extra.tipo ?? "prueba.eco",
      clienteId: cl.id,
      parametros: { n },
      prioridad: extra.prioridad ?? "interactivo",
      creadoPor: extra.creadoPor === undefined ? usuario : extra.creadoPor,
    }).then((r) => r.trabajo.id);
  const fila = (id: string) => e.fila(id);
  const estado = async (id: string) => (await e.fila(id))?.estado as string;
  const cerrar = async () => {
    await p?.detener({ esperaMs: 2000 });
    await ev.cerrar();
  };
  return {
    prefijo,
    T,
    usuario,
    c,
    prog,
    ev,
    k,
    iniciar,
    get p() {
      return p;
    },
    encolar,
    fila,
    estado,
    cerrar,
  };
}

const transitorio = () =>
  new ErrorTransitorio(new Error("ECONNRESET con datos de la conexión"));

describe("ejecución normal (flujo de punta a punta)", () => {
  it("encolado → ejecutando → completado: guarda el resultado, libera cupos y arriendos y emite los eventos en orden", async () => {
    const m = await mundo();
    try {
      m.prog.comportamiento = async () => ({ ok: true, filas: 3 });
      const id = await m.encolar(m.c, 1);
      await esperarHasta(
        async () => (await m.estado(id)) === "completado",
        "trabajo completado",
      );
      const fila = await m.fila(id);
      expect(fila).toMatchObject({
        estado: "completado",
        intentos: 0,
        motivo: null,
        resultado: { ok: true, filas: 3 },
      });
      expect(fila.iniciado_en).not.toBeNull();
      expect(fila.terminado_en).not.toBeNull();
      expect(m.prog.llamadas).toHaveLength(1);
      expect(m.prog.llamadas[0]).toMatchObject({
        id,
        tenantId: m.T,
        clienteId: m.c.id,
        ruc: m.c.ruc,
        tipo: "prueba.eco",
        intentos: 0,
      });
      await esperarHasta(
        () => m.ev.estadosDe(id).includes("completado"),
        "evento completado",
      );
      expect(m.ev.estadosDe(id)).toEqual(["ejecutando", "completado"]);
      expect(await redis.zcard(m.k.cupoTenant("sire", m.T))).toBe(0);
      expect(await redis.zcard(m.k.cupoGlobal("sire"))).toBe(0);
      expect(await redis.exists(m.k.ejec(id))).toBe(0);
    } finally {
      await m.cerrar();
    }
  });

  it("deja el lock del RUC vivo durante espera_ruc_ms después de terminar (D20)", async () => {
    await fijarConfig(admin, "sire", { espera: 1500 });
    const m = await mundo();
    try {
      const id = await m.encolar(m.c, 1);
      await esperarHasta(
        async () => (await m.estado(id)) === "completado",
        "trabajo completado",
      );
      const ttl = await redis.pttl(m.k.lockRuc("sire", m.c.ruc));
      expect(ttl, "el lock queda con PX = espera_ruc_ms").toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(1500);
    } finally {
      await m.cerrar();
      await fijarConfig(admin, "sire", { espera: 0 });
    }
  });

  it("D6: mientras corre el procesador no hay ninguna transacción de BD abierta del ejecutor", async () => {
    const m = await mundo();
    try {
      let minimo = Number.POSITIVE_INFINITY;
      m.prog.comportamiento = async () => {
        minimo = await minimoTx(m.p.dbEstado, 400);
        return { ok: true };
      };
      const id = await m.encolar(m.c, 1);
      await esperarHasta(
        async () => (await m.estado(id)) === "completado",
        "trabajo completado",
      );
      expect(
        minimo,
        "una transacción abierta durante el procesador dejaría el mínimo en ≥ 1",
      ).toBe(0);
    } finally {
      await m.cerrar();
    }
  });
});

describe("CA-8: reintentos con backoff y clasificación de errores", () => {
  it("un error transitorio se reintenta 3 veces con backoff exponencial (base·2^(n−1) ± 20 %) y luego queda en error/sunat_no_responde", async () => {
    const m = await mundo();
    try {
      m.prog.comportamiento = async () => {
        throw transitorio();
      };
      const id = await m.encolar(m.c, 1);
      await esperarHasta(
        async () => (await m.estado(id)) === "error",
        "trabajo en error",
        { timeoutMs: 20_000 },
      );
      const fila = await m.fila(id);
      expect(fila).toMatchObject({
        estado: "error",
        motivo: "sunat_no_responde",
        intentos: 3,
      });
      const llamadas = m.prog.de(id);
      expect(llamadas, "1 ejecución + 3 reintentos").toHaveLength(4);
      expect(llamadas.map((l) => l.intentos)).toEqual([0, 1, 2, 3]);
      const BASE = 100;
      for (let n = 1; n <= 3; n++) {
        const espera = llamadas[n]!.en - llamadas[n - 1]!.en;
        expect(
          espera,
          `espera antes del reintento ${n} (≥ 80 % de base·2^(n−1))`,
        ).toBeGreaterThanOrEqual(0.8 * BASE * 2 ** (n - 1) - 25);
        expect(
          espera,
          `espera antes del reintento ${n} (el despachador no la alarga más de lo razonable)`,
        ).toBeLessThanOrEqual(1.2 * BASE * 2 ** (n - 1) + 1500);
      }
      await esperarHasta(
        () => m.ev.estadosDe(id).includes("error"),
        "evento de error",
      );
      expect(m.ev.estadosDe(id)).toEqual([
        "ejecutando",
        "en_cola",
        "ejecutando",
        "en_cola",
        "ejecutando",
        "en_cola",
        "ejecutando",
        "error",
      ]);
      expect(m.ev.de(id).at(-1)).toMatchObject({
        motivo: "sunat_no_responde",
        intentos: 3,
      });
    } finally {
      await m.cerrar();
    }
  });

  it("un error no clasificado cuenta como transitorio (mismos 3 reintentos)", async () => {
    const m = await mundo();
    try {
      m.prog.comportamiento = async () => {
        throw new Error("algo inesperado");
      };
      const id = await m.encolar(m.c, 1);
      await esperarHasta(
        async () => (await m.estado(id)) === "error",
        "trabajo en error",
        { timeoutMs: 20_000 },
      );
      expect(await m.fila(id)).toMatchObject({
        estado: "error",
        motivo: "sunat_no_responde",
        intentos: 3,
      });
      expect(m.prog.de(id)).toHaveLength(4);
    } finally {
      await m.cerrar();
    }
  });

  it("si el reintento tiene éxito el trabajo queda completado con los intentos consumidos", async () => {
    const m = await mundo();
    try {
      m.prog.comportamiento = async (_c, l) => {
        if (l.intentos < 2) throw transitorio();
        return { ok: true };
      };
      const id = await m.encolar(m.c, 1);
      await esperarHasta(
        async () => (await m.estado(id)) === "completado",
        "trabajo completado",
        { timeoutMs: 20_000 },
      );
      expect(await m.fila(id)).toMatchObject({
        estado: "completado",
        intentos: 2,
        motivo: null,
      });
      expect(m.prog.de(id)).toHaveLength(3);
    } finally {
      await m.cerrar();
    }
  });

  it.each([
    [
      "ErrorDatos",
      () => new ErrorDatos(new Error("datos de entrada")),
      "datos_invalidos",
    ],
    [
      "ErrorPortal",
      () => new ErrorPortal(new Error("html distinto")),
      "portal_cambio",
    ],
  ])(
    "%s no se reintenta: error con su motivo a la primera",
    async (_n, fabrica, motivo) => {
      const m = await mundo();
      try {
        m.prog.comportamiento = async () => {
          throw fabrica();
        };
        const id = await m.encolar(m.c, 1);
        await esperarHasta(
          async () => (await m.estado(id)) === "error",
          "trabajo en error",
        );
        await dormir(600); // si hubiera reintento, aparecería aquí
        expect(await m.fila(id)).toMatchObject({
          estado: "error",
          motivo,
          intentos: 0,
        });
        expect(m.prog.de(id)).toHaveLength(1);
      } finally {
        await m.cerrar();
      }
    },
  );

  it("CA-4: los reintentos de config_sistema se aplican sin reiniciar (≤ 10 s): con reintentos = 1 son solo 2 ejecuciones", async () => {
    const reloj = new RelojAjustable();
    const m = await mundo({ reloj });
    try {
      // Un primer trabajo hace que el worker cargue la configuración vigente (reintentos = 3).
      const primero = await m.encolar(m.c, 1);
      await esperarHasta(
        async () => (await m.estado(primero)) === "completado",
        "primer trabajo",
      );
      await fijarConfig(admin, "sire", { reintentos: 1 });
      reloj.avanzar(10_500); // pasó el intervalo de recarga (10 s)

      m.prog.comportamiento = async () => {
        throw transitorio();
      };
      const id = await m.encolar(m.c, 2);
      await esperarHasta(
        async () => (await m.estado(id)) === "error",
        "trabajo en error",
        { timeoutMs: 20_000 },
      );
      expect(await m.fila(id)).toMatchObject({
        estado: "error",
        motivo: "sunat_no_responde",
        intentos: 1,
      });
      expect(m.prog.de(id)).toHaveLength(2);
    } finally {
      await m.cerrar();
      await fijarConfig(admin, "sire", { reintentos: 3 });
    }
  });
});

describe("CA-9: credencial inválida", () => {
  it("ErrorCredencial: sin reintento, error/credencial_invalida, marca la credencial, notifica una vez y cancela pendientes y nuevos del cliente; reemplazar ciphertext lo desbloquea", async () => {
    const notificador = notificadorEspia();
    const m = await mundo({ notificador });
    try {
      const c2 = await e.cliente(m.T);
      await e.asignar(m.T, c2.id, m.usuario);
      const cred1 = await e.credencial(m.T, m.c.id, "sol");
      await e.credencial(m.T, c2.id, "sol");
      m.prog.comportamiento = async (_c, l) => {
        if (l.clienteId === m.c.id)
          throw new ErrorCredencial(new Error("clave SOL rechazada"));
        return { ok: true };
      };
      // Cuatro del cliente 1 (comparten RUC: se ejecutan de a uno) y uno del cliente 2.
      const del1: string[] = [];
      for (let n = 1; n <= 4; n++)
        del1.push(await m.encolar(m.c, n, { tipo: "prueba.credencial_sol" }));
      const del2 = await m.encolar(c2, 9, { tipo: "prueba.credencial_sol" });

      await esperarHasta(
        async () => (await m.estado(del2)) === "completado",
        "el otro cliente completa",
      );
      await esperarHasta(async () => {
        const estados = await Promise.all(del1.map(m.estado));
        return estados.every((s) => s === "error" || s === "cancelado");
      }, "los trabajos del cliente 1 terminan");

      const filas = await Promise.all(del1.map((id) => m.fila(id)));
      const errores = filas.filter((f) => f.estado === "error");
      const cancelados = filas.filter((f) => f.estado === "cancelado");
      expect(errores, "solo uno llegó a ejecutarse").toHaveLength(1);
      expect(errores[0]).toMatchObject({
        motivo: "credencial_invalida",
        intentos: 0,
      });
      expect(cancelados).toHaveLength(3);
      for (const f of cancelados)
        expect(f).toMatchObject({ motivo: "credencial_invalida" });
      expect(
        m.prog.llamadas.filter((l) => l.clienteId === m.c.id),
        "sin reintentos y sin ejecutar los cancelados",
      ).toHaveLength(1);

      expect(await e.credencialEstado(m.c.id)).toEqual({
        estado: "invalida",
        estado_motivo: "credencial_invalida",
      });
      expect(await e.credencialEstado(c2.id)).toMatchObject({
        estado: "configurada",
      });
      expect(notificador.llamadas).toHaveLength(1);
      expect(notificador.llamadas[0]).toMatchObject({
        tenantId: m.T,
        clienteId: m.c.id,
        tipo: "sol",
        trabajoId: errores[0].id,
      });

      // Un trabajo nuevo del mismo cliente también se cancela sin ejecutarse.
      const nuevo = await m.encolar(m.c, 5, { tipo: "prueba.credencial_sol" });
      await esperarHasta(
        async () => (await m.estado(nuevo)) === "cancelado",
        "el nuevo se cancela",
      );
      expect(await m.fila(nuevo)).toMatchObject({
        motivo: "credencial_invalida",
      });
      expect(m.prog.de(nuevo)).toHaveLength(0);

      // Reemplazar el ciphertext devuelve la credencial a 'configurada' y el cliente vuelve a ejecutar.
      await admin.pool.query(
        "update credencial set ciphertext = decode(repeat('ab', 64), 'hex') where id = $1",
        [cred1],
      );
      expect(await e.credencialEstado(m.c.id)).toEqual({
        estado: "configurada",
        estado_motivo: null,
      });
      m.prog.comportamiento = async () => ({ ok: true });
      const tras = await m.encolar(m.c, 6, { tipo: "prueba.credencial_sol" });
      await esperarHasta(
        async () => (await m.estado(tras)) === "completado",
        "el cliente desbloqueado se ejecuta",
      );
    } finally {
      await m.cerrar();
    }
  });

  it("si el Notificador falla, el trabajo igual queda en error/credencial_invalida y la credencial marcada", async () => {
    const notificador = notificadorEspia(true);
    const m = await mundo({ notificador });
    try {
      await e.credencial(m.T, m.c.id, "sol");
      m.prog.comportamiento = async () => {
        throw new ErrorCredencial();
      };
      const id = await m.encolar(m.c, 1, { tipo: "prueba.credencial_sol" });
      await esperarHasta(
        async () => (await m.estado(id)) === "error",
        "trabajo en error",
      );
      expect(await m.fila(id)).toMatchObject({
        estado: "error",
        motivo: "credencial_invalida",
      });
      expect((await e.credencialEstado(m.c.id))?.estado).toBe("invalida");
      expect(notificador.llamadas).toHaveLength(1);
    } finally {
      await m.cerrar();
    }
  });

  it("un error transitorio no marca la credencial ni notifica", async () => {
    const notificador = notificadorEspia();
    const m = await mundo({ notificador });
    try {
      await e.credencial(m.T, m.c.id, "sol");
      m.prog.comportamiento = async () => {
        throw transitorio();
      };
      const id = await m.encolar(m.c, 1, { tipo: "prueba.credencial_sol" });
      await esperarHasta(
        async () => (await m.estado(id)) === "error",
        "trabajo en error",
        { timeoutMs: 20_000 },
      );
      expect((await e.credencialEstado(m.c.id))?.estado).toBe("configurada");
      expect(notificador.llamadas).toHaveLength(0);
    } finally {
      await m.cerrar();
    }
  });
});

describe("CA-14: revalidación al despachar con el worker completo", () => {
  it("si se desasigna al creador antes del despacho, el trabajo se cancela con acceso_retirado y el procesador no se invoca; un programado sin usuario sigue", async () => {
    const m = await mundo({ arrancarYa: false });
    try {
      const huerfano = await m.encolar(m.c, 1); // creado por el contador
      const programado = await m.encolar(m.c, 2, {
        creadoPor: null,
        prioridad: "programado",
      });
      await admin.pool.query(
        "delete from asignacion where tenant_id = $1 and usuario_id = $2",
        [m.T, m.usuario],
      );
      await m.iniciar();
      await esperarHasta(
        async () =>
          (await m.estado(huerfano)) === "cancelado" &&
          (await m.estado(programado)) === "completado",
        "cancelado y completado",
      );
      expect(await m.fila(huerfano)).toMatchObject({
        estado: "cancelado",
        motivo: "acceso_retirado",
      });
      expect(m.prog.de(huerfano)).toHaveLength(0);
      expect(m.prog.de(programado)).toHaveLength(1);
    } finally {
      await m.cerrar();
    }
  });
});

describe("CA-15: aislamiento en el worker (payload forjado)", () => {
  /** Encola directamente en BullMQ lo que quiera quien tenga acceso a Redis. */
  async function forjar(
    prefijo: string,
    payload: { jobId: string; tenantId: string; tipo: string },
  ) {
    const colas = crearColas({ conexion: opcionesBull(), prefijo });
    try {
      await colas.agregarACola("sire", payload);
    } finally {
      await colas.cerrar();
    }
  }

  it("un jobId de otro estudio con el tenantId propio no ejecuta nada ni toca el trabajo ajeno", async () => {
    const m = await mundo();
    try {
      const otroEstudio = await e.estudio();
      const cOtro = await e.cliente(otroEstudio);
      const [ajeno] = (
        await admin.pool.query(
          `insert into job_registro (tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, intentos, max_intentos, iniciado_en)
         values ($1, $2, $3, 'prueba.eco', 'sire', 'sire', 'interactivo', 'ejecutando', '{"n":7}', decode(repeat('cd', 32), 'hex'), 0, 4, now()) returning id`,
          [otroEstudio, cOtro.id, cOtro.ruc],
        )
      ).rows.map((r: { id: string }) => r.id);
      const antes = await m.fila(ajeno!);

      await forjar(m.prefijo, {
        jobId: ajeno!,
        tenantId: m.T,
        tipo: "prueba.eco",
      });
      await dormir(1200);
      expect(m.prog.llamadas).toHaveLength(0);
      expect(await m.fila(ajeno!)).toEqual(antes);
    } finally {
      await m.cerrar();
    }
  });

  it("un payload con el tipo distinto al de la fila no ejecuta nada", async () => {
    const m = await mundo({ arrancarYa: false });
    try {
      const [id] = (
        await admin.pool.query(
          `insert into job_registro (tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, intentos, max_intentos, iniciado_en)
         values ($1, $2, $3, 'prueba.eco', 'sire', 'sire', 'interactivo', 'ejecutando', '{"n":1}', decode(repeat('ce', 32), 'hex'), 0, 4, now()) returning id`,
          [m.T, m.c.id, m.c.ruc],
        )
      ).rows.map((r: { id: string }) => r.id);
      await m.iniciar();
      await forjar(m.prefijo, {
        jobId: id!,
        tenantId: m.T,
        tipo: "prueba.no_idempotente",
      });
      await dormir(1200);
      expect(m.prog.llamadas).toHaveLength(0);
      expect((await m.fila(id!)).estado).toBe("ejecutando");
    } finally {
      await m.cerrar();
    }
  });

  it("un payload de un trabajo que sigue en_cola (saltándose cupos y locks) no se ejecuta; lo despacha solo el despachador", async () => {
    const m = await mundo({ arrancarYa: false });
    try {
      // Fila en_cola que NO se publica en Redis: el despachador no la conoce todavía.
      const r = await backend.withTenant({ tenantId: m.T }, (tx) =>
        encolar(tx, {
          tipo: "prueba.eco",
          clienteId: m.c.id,
          parametros: { n: 1 },
          prioridad: "interactivo",
          creadoPor: m.usuario,
        }),
      );
      const id = r.trabajo.id;
      await m.iniciar();
      await forjar(m.prefijo, { jobId: id, tenantId: m.T, tipo: "prueba.eco" });
      await dormir(1200);
      expect(m.prog.llamadas).toHaveLength(0);
      expect((await m.fila(id)).estado).toBe("en_cola");
    } finally {
      await m.cerrar();
    }
  });

  it("repetir el payload de un trabajo ya completado, o que está en curso, no lo ejecuta dos veces", async () => {
    const m = await mundo();
    try {
      const puerta = compuerta();
      m.prog.comportamiento = async () => {
        await puerta.esperar();
        return { ok: true };
      };
      const id = await m.encolar(m.c, 1);
      await esperarHasta(
        () => m.prog.de(id).length === 1,
        "el procesador está en curso",
      );

      await forjar(m.prefijo, { jobId: id, tenantId: m.T, tipo: "prueba.eco" }); // repetido mientras corre
      await dormir(800);
      expect(
        m.prog.de(id),
        "el arriendo de ejecución impide la segunda ejecución",
      ).toHaveLength(1);

      puerta.abrir();
      await esperarHasta(
        async () => (await m.estado(id)) === "completado",
        "completado",
      );
      await forjar(m.prefijo, { jobId: id, tenantId: m.T, tipo: "prueba.eco" }); // repetido ya terminado
      await dormir(800);
      expect(m.prog.de(id)).toHaveLength(1);
      expect((await m.fila(id)).estado).toBe("completado");
    } finally {
      await m.cerrar();
    }
  });
});

describe("cierre ordenado", () => {
  it("detener() espera al trabajo en curso, libera sus arriendos y no toma trabajos nuevos", async () => {
    const m = await mundo();
    try {
      const puerta = compuerta();
      m.prog.comportamiento = async () => {
        await puerta.esperar();
        return { ok: true };
      };
      const enCurso = await m.encolar(m.c, 1);
      await esperarHasta(
        () => m.prog.de(enCurso).length === 1,
        "el trabajo está en curso",
      );

      let cerrado = false;
      const cierre = m.p.detener({ esperaMs: 10_000 }).then(() => {
        cerrado = true;
      });
      await dormir(150);
      // Llega un trabajo nuevo mientras se cierra: no debe despacharse.
      const c2 = await e.cliente(m.T);
      await e.asignar(m.T, c2.id, m.usuario);
      const nuevo = await m.encolar(c2, 2);
      await dormir(500);
      expect(cerrado, "sigue esperando al trabajo en curso").toBe(false);

      puerta.abrir();
      await cierre;
      expect(await m.estado(enCurso)).toBe("completado");
      expect(await redis.zcard(m.k.cupoGlobal("sire"))).toBe(0);
      expect(await redis.exists(m.k.ejec(enCurso))).toBe(0);
      await dormir(400);
      expect(await m.estado(nuevo)).toBe("en_cola");
      expect(m.prog.de(nuevo)).toHaveLength(0);
    } finally {
      await m.cerrar();
    }
  });
});
