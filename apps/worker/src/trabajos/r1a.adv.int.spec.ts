/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD, eventos y logs dinámicos en pruebas adversariales */
// Spec 008, T13a (adversario, ronda 1a, caja negra): lista mínima de ataques contra el worker de trabajos con
// PostgreSQL, Redis y BullMQ reales. Solo usa el contrato público (`iniciarTrabajos` vía test/trabajos.ts,
// `@contapp/queue`, `@contapp/queue/worker` y las tablas). Prefijo de Redis propio (`r1a-…`); BD restaurada al final.
import { randomBytes } from "node:crypto";
import type { ContappDb } from "@contapp/db";
import {
  aPublicable,
  crearClaves,
  encolar,
  publicar,
  type ResultadoEncolar,
} from "@contapp/queue";
import { crearColas } from "@contapp/queue/worker";
import { tienePermiso, type Rol } from "@contapp/shared";
import { ErrorCredencial } from "@contapp/sunat";
import type { Redis } from "ioredis";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  arrancar,
  canario,
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
  opcionesBull,
  ProcesadorProgramable,
  registrarTiposDePrueba,
  restaurarConfig,
  rucNuevo,
  suscribirEventos,
  volcarPrefijo,
  type ProcesoWorker,
} from "../../test/trabajos.js";

vi.setConfig({ testTimeout: 150_000, hookTimeout: 60_000 });

registrarTiposDePrueba();

const TIPOS = [
  "prueba.eco",
  "prueba.no_idempotente",
  "prueba.credencial_sol",
] as const;
const MOTIVOS = new Set([
  "sunat_no_responde",
  "credencial_invalida",
  "datos_invalidos",
  "portal_cambio",
  "interrumpido",
  "acceso_retirado",
  "cancelado_usuario",
  "error_interno",
]);

let admin: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
const prefijo = `r1a-${randomBytes(4).toString("hex")}:`;
const k = crearClaves(prefijo);
let procesos: ProcesoWorker[] = [];

const mapa = (p: ProcesadorProgramable) =>
  Object.fromEntries(TIPOS.map((t) => [t, p.procesador]));
const sinReconciliarAjenos = { antiguedadSeg: 3600 };

async function iniciar(
  p: ProcesadorProgramable,
  extra: Record<string, unknown> = {},
): Promise<ProcesoWorker> {
  const w = await arrancar({
    prefijo,
    procesadores: mapa(p),
    ...sinReconciliarAjenos,
    ...extra,
  } as any);
  procesos.push(w);
  return w;
}

async function filasDe(tenantId: string): Promise<any[]> {
  return (
    await admin.pool.query(
      "select * from job_registro where tenant_id = $1 order by creado_en, id",
      [tenantId],
    )
  ).rows;
}

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend", 20);
  redis = conectarRedis();
  e = new Escenario(admin);
});

afterEach(async () => {
  await Promise.all(
    procesos.map((p) => p.detener({ esperaMs: 1000 }).catch(() => undefined)),
  );
  procesos = [];
  // Ningún en_cola propio queda vivo para los reconciliadores de otros procesos de prueba.
  await admin.pool
    .query(
      "delete from job_registro where tenant_id = any($1::uuid[]) and estado in ('en_cola','ejecutando')",
      [e.estudios],
    )
    .catch(() => undefined);
  await limpiarPrefijo(redis, prefijo).catch(() => undefined);
  await restaurarConfig(admin).catch(() => undefined);
});

afterAll(async () => {
  await e?.limpiar();
  await limpiarPrefijo(redis, prefijo).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

describe("CA-2 · 1,000 contra 1", () => {
  it("con global 4 y tenant 2, el único trabajo de B arranca de inmediato y A nunca pasa de 2 en ejecución", async () => {
    await fijarConfig(admin, "sire", {
      global: 4,
      tenant: 2,
      espera: 0,
      reintentos: 0,
      base: 100,
    });
    const A = await e.estudio();
    const B = await e.estudio();
    const clientesA = await Promise.all(
      Array.from({ length: 20 }, () => e.cliente(A)),
    );
    const clienteB = await e.cliente(B);

    const trabajosA = await backend.withTenant({ tenantId: A }, async (tx) => {
      const r: ResultadoEncolar[] = [];
      for (let i = 0; i < 1000; i++)
        r.push(
          await encolar(tx, {
            tipo: "prueba.eco",
            clienteId: clientesA[i % 20]!.id,
            parametros: { n: i },
            prioridad: "interactivo",
            creadoPor: null,
          }),
        );
      return r;
    });
    await publicar(
      redis,
      trabajosA.map((r) => aPublicable(A, r.trabajo, "interactivo")),
      { prefijo },
    );

    const fin = new Map<string, number>();
    const prog = new ProcesadorProgramable();
    prog.comportamiento = async (_ctx, l) => {
      await dormir(150);
      fin.set(l.id + ":" + l.intentos, Date.now());
      return { ok: true };
    };
    await iniciar(prog);
    await esperarHasta(
      () => prog.llamadas.filter((l) => l.tenantId === A).length >= 2,
      "A con 2 en ejecución",
    );

    const tB = Date.now();
    const rB = await encolarYPublicar(backend, redis, prefijo, B, {
      tipo: "prueba.eco",
      clienteId: clienteB.id,
      parametros: { n: 1 },
    });
    await esperarHasta(() => prog.de(rB.trabajo.id).length > 0, "B empieza", {
      timeoutMs: 10_000,
    });
    const inicioB = prog.de(rB.trabajo.id)[0]!.en;

    // Concurrencia de A en cada instante de inicio (intervalos [en, fin)).
    const intervalos = prog.llamadas.map((l) => ({
      t: l.tenantId,
      ini: l.en,
      fin: fin.get(l.id + ":" + l.intentos) ?? Number.POSITIVE_INFINITY,
    }));
    const enEjecucion = (t: number, quien?: string) =>
      intervalos.filter(
        (i) => (!quien || i.t === quien) && i.ini <= t && t < i.fin,
      ).length;
    const maxA = Math.max(...intervalos.map((i) => enEjecucion(i.ini, A)));
    const maxGlobal = Math.max(...intervalos.map((i) => enEjecucion(i.ini)));

    expect({
      maxA,
      maxGlobalMenorIgual4: maxGlobal <= 4,
      esperaDeB_menor_1s: inicioB - tB < 1000,
    }).toEqual({
      maxA: 2,
      maxGlobalMenorIgual4: true,
      esperaDeB_menor_1s: true,
    });
  });
});

describe("CA-3 · mismo RUC en dos estudios y dos procesos del worker", () => {
  it("20 trabajos del mismo RUC (10 por estudio) nunca se solapan y respetan la espera de 300 ms", async () => {
    await fijarConfig(admin, "sire", {
      global: 8,
      tenant: 4,
      espera: 300,
      reintentos: 0,
      base: 100,
    });
    const ruc = rucNuevo();
    const A = await e.estudio();
    const B = await e.estudio();
    const cA = await e.cliente(A, ruc);
    const cB = await e.cliente(B, ruc);

    const fin = new Map<string, number>();
    const prog = new ProcesadorProgramable();
    prog.comportamiento = async (_ctx, l) => {
      await dormir(40);
      fin.set(l.id, Date.now());
      return { ok: true };
    };
    await iniciar(prog);
    await iniciar(prog);

    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(
        (
          await encolarYPublicar(backend, redis, prefijo, A, {
            tipo: "prueba.eco",
            clienteId: cA.id,
            parametros: { n: i },
          })
        ).trabajo.id,
      );
      ids.push(
        (
          await encolarYPublicar(backend, redis, prefijo, B, {
            tipo: "prueba.eco",
            clienteId: cB.id,
            parametros: { n: i },
          })
        ).trabajo.id,
      );
    }
    await esperarHasta(
      () => ids.every((id) => fin.has(id)),
      "los 20 terminan",
      { timeoutMs: 40_000 },
    );

    const orden = [...prog.llamadas].sort((x, y) => x.en - y.en);
    const violaciones: string[] = [];
    for (let i = 1; i < orden.length; i++) {
      const prevFin = fin.get(orden[i - 1]!.id)!;
      const hueco = orden[i]!.en - prevFin;
      if (hueco < 295) violaciones.push(`#${i}: hueco ${hueco} ms`);
    }
    expect({ llamadas: prog.llamadas.length, violaciones }).toEqual({
      llamadas: 20,
      violaciones: [],
    });
  });
});

describe("CA-10 · el worker muere tras tomar el lock del RUC", () => {
  it("el no idempotente queda interrumpido sin reenviarse; el del otro estudio con el mismo RUC corre después y no quedan cupos ni arriendos", async () => {
    await fijarConfig(admin, "sire", {
      global: 8,
      tenant: 4,
      espera: 0,
      reintentos: 3,
      base: 100,
    });
    const ruc = rucNuevo();
    const A = await e.estudio();
    const B = await e.estudio();
    const cA = await e.cliente(A, ruc);
    const cB = await e.cliente(B, ruc);

    const colgado = new ProcesadorProgramable();
    const puerta = compuerta();
    colgado.comportamiento = async () => {
      await puerta.esperar();
      return { ok: true };
    };
    const p1 = await iniciar(colgado);
    const rA = await encolarYPublicar(backend, redis, prefijo, A, {
      tipo: "prueba.no_idempotente",
      clienteId: cA.id,
      parametros: { n: 1 },
    });
    await esperarHasta(
      () => colgado.de(rA.trabajo.id).length === 1,
      "A en curso",
    );
    const rB = await encolarYPublicar(backend, redis, prefijo, B, {
      tipo: "prueba.eco",
      clienteId: cB.id,
      parametros: { n: 1 },
    });
    await dormir(300);
    expect(colgado.de(rB.trabajo.id)).toHaveLength(0); // RUC bloqueado: B espera

    await p1.abortar();
    const tMuerte = Date.now();
    puerta.abrir();

    const sano = new ProcesadorProgramable();
    await iniciar(sano, { antiguedadSeg: 25 });
    await esperarHasta(
      async () => (await e.fila(rB.trabajo.id))?.estado === "completado",
      "B completa",
      { timeoutMs: 75_000 },
    );
    await esperarHasta(
      async () => (await e.fila(rA.trabajo.id))?.estado !== "ejecutando",
      "A resuelto",
      { timeoutMs: 75_000 },
    );
    const tB = sano.de(rB.trabajo.id)[0]!.en;
    await dormir(500);

    const fA = await e.fila(rA.trabajo.id);
    const residuos = {
      cupoA: await redis.zcard(k.cupoTenant("sire", A)),
      cupoB: await redis.zcard(k.cupoTenant("sire", B)),
      cupoGlobal: await redis.zcard(k.cupoGlobal("sire")),
      ejecA: await redis.exists(k.ejec(rA.trabajo.id)),
      ejecB: await redis.exists(k.ejec(rB.trabajo.id)),
    };
    expect({
      estadoA: fA.estado,
      motivoA: fA.motivo,
      reenviosA: sano.de(rA.trabajo.id).length,
      bAntesDe60s: tB - tMuerte <= 62_000,
      residuos,
    }).toEqual({
      estadoA: "error",
      motivoA: "interrumpido",
      reenviosA: 0,
      bAntesDe60s: true,
      residuos: { cupoA: 0, cupoB: 0, cupoGlobal: 0, ejecA: 0, ejecB: 0 },
    });
  });
});

describe("CA-15 · payload de BullMQ forjado", () => {
  it("jobId de otro estudio, tipo cambiado o trabajo aún en_cola: nada se ejecuta ni cambia, y el real corre una sola vez", async () => {
    await fijarConfig(admin, "sire", {
      global: 8,
      tenant: 4,
      espera: 0,
      reintentos: 0,
      base: 100,
    });
    const A = await e.estudio();
    const B = await e.estudio();
    const cA = await e.cliente(A);
    const cB = await e.cliente(B);
    const ja = (
      await backend.withTenant({ tenantId: A }, (tx) =>
        encolar(tx, {
          tipo: "prueba.eco",
          clienteId: cA.id,
          parametros: { n: 7 },
          prioridad: "interactivo",
          creadoPor: null,
        }),
      )
    ).trabajo;
    const jb = (
      await backend.withTenant({ tenantId: B }, (tx) =>
        encolar(tx, {
          tipo: "prueba.eco",
          clienteId: cB.id,
          parametros: { n: 8 },
          prioridad: "interactivo",
          creadoPor: null,
        }),
      )
    ).trabajo;

    const prog = new ProcesadorProgramable();
    await iniciar(prog);
    const colas = crearColas({ conexion: opcionesBull(), prefijo });
    try {
      await colas.agregarACola("sire", {
        jobId: jb.id,
        tenantId: A,
        tipo: "prueba.eco",
      });
      await dormir(600);
      await colas.agregarACola("sire", {
        jobId: ja.id,
        tenantId: A,
        tipo: "prueba.no_idempotente",
      });
      await dormir(600);
      await colas.agregarACola("sire", {
        jobId: jb.id,
        tenantId: B,
        tipo: "prueba.eco",
      });
      await dormir(1500);
    } finally {
      await colas.cerrar();
    }
    const fa = await e.fila(ja.id);
    const fb = await e.fila(jb.id);
    const forjados = {
      llamadas: prog.llamadas.length,
      a: [fa.estado, fa.intentos, fa.iniciado_en],
      b: [fb.estado, fb.intentos, fb.iniciado_en],
    };

    await publicar(redis, [aPublicable(A, ja, "interactivo")], { prefijo });
    await esperarHasta(
      async () => (await e.fila(ja.id))?.estado === "completado",
      "el real completa",
      { timeoutMs: 10_000 },
    );
    expect({ ...forjados, realUnaVez: prog.de(ja.id).length }).toEqual({
      llamadas: 0,
      a: ["en_cola", 0, null],
      b: ["en_cola", 0, null],
      realUnaVez: 1,
    });
  });
});

describe("D8 · encolar 50 veces el mismo trabajo en paralelo", () => {
  it("las 50 llamadas responden (ninguna explota por la carrera), todas con el mismo id, una sola nueva y una sola fila", async () => {
    const A = await e.estudio();
    const c = await e.cliente(A);
    const entrada = {
      tipo: "prueba.eco",
      clienteId: c.id,
      parametros: { n: 50, rango: "2026-09" },
      prioridad: "interactivo" as const,
      creadoPor: null,
    };
    const r = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        backend.withTenant({ tenantId: A }, (tx) => encolar(tx, entrada)),
      ),
    );
    const ok = r
      .filter(
        (x): x is PromiseFulfilledResult<ResultadoEncolar> =>
          x.status === "fulfilled",
      )
      .map((x) => x.value);
    const fallos = r
      .filter((x): x is PromiseRejectedResult => x.status === "rejected")
      .map((x) =>
        String(
          (x.reason as any)?.codigo ??
            (x.reason as any)?.code ??
            (x.reason as any)?.name,
        ),
      );
    const filas = await filasDe(A);
    expect({
      fallos: [...new Set(fallos)],
      cumplidas: ok.length,
      ids: new Set(ok.map((x) => x.trabajo.id)).size,
      nuevos: ok.filter((x) => x.nuevo).length,
      filas: filas.length,
    }).toEqual({ fallos: [], cumplidas: 50, ids: 1, nuevos: 1, filas: 1 });
  });
});

describe("CA-16 · canarios en los errores del adaptador", () => {
  it("Error, ErrorCredencial con causa, string y objeto lanzados con secretos: ninguno llega a logs, BD, Redis ni eventos", async () => {
    await fijarConfig(admin, "sire", {
      global: 8,
      tenant: 4,
      espera: 0,
      reintentos: 0,
      base: 100,
    });
    const A = await e.estudio();
    const c1 = await e.cliente(A);
    const c2 = await e.cliente(A);
    const c3 = await e.cliente(A);
    const c4 = await e.cliente(A);
    await e.credencial(A, c2.id, "sol");
    const sol = canario("SOL");
    const secreto = canario("SECRET");
    const token = canario("TOKEN");
    const canarios = [sol, secreto, token];

    const logs: string[] = [];
    const logger = {
      debug: (x: unknown) => logs.push(JSON.stringify(x)),
      info: (x: unknown) => logs.push(JSON.stringify(x)),
      warn: (x: unknown) => logs.push(JSON.stringify(x)),
      error: (x: unknown) => logs.push(JSON.stringify(x)),
    };
    const salida: string[] = [];
    const espias = [
      vi
        .spyOn(process.stdout, "write")
        .mockImplementation(
          ((t: unknown) => (salida.push(String(t)), true)) as any,
        ),
      vi
        .spyOn(process.stderr, "write")
        .mockImplementation(
          ((t: unknown) => (salida.push(String(t)), true)) as any,
        ),
      ...(["log", "info", "warn", "error", "debug"] as const).map((m) =>
        vi
          .spyOn(console, m)
          .mockImplementation(
            (...a: unknown[]) => void salida.push(a.map(String).join(" ")),
          ),
      ),
    ];

    const ev = await suscribirEventos(prefijo, [A]);
    const prog = new ProcesadorProgramable();
    prog.comportamiento = async (ctx) => {
      const n = (ctx.trabajo as any).parametros?.n;
      const cid = ctx.trabajo.clienteId;
      if (cid === c1.id) {
        const err: any = new Error(`fallo ${sol}`);
        err.cause = { client_secret: secreto };
        err.response = { data: { access_token: token } };
        throw err;
      }
      if (cid === c2.id)
        throw new ErrorCredencial(new Error(`401 ${token} ${sol}`));
      if (cid === c3.id) throw `crudo ${secreto}`;
      if (cid === c4.id)
        throw { message: `obj ${token}`, toString: () => sol, clave: secreto };
      return { n };
    };
    let ids: string[] = [];
    try {
      await iniciar(prog, { logger });
      ids = [
        (
          await encolarYPublicar(backend, redis, prefijo, A, {
            tipo: "prueba.eco",
            clienteId: c1.id,
            parametros: { n: 1 },
          })
        ).trabajo.id,
        (
          await encolarYPublicar(backend, redis, prefijo, A, {
            tipo: "prueba.credencial_sol",
            clienteId: c2.id,
            parametros: { n: 2 },
          })
        ).trabajo.id,
        (
          await encolarYPublicar(backend, redis, prefijo, A, {
            tipo: "prueba.eco",
            clienteId: c3.id,
            parametros: { n: 3 },
          })
        ).trabajo.id,
        (
          await encolarYPublicar(backend, redis, prefijo, A, {
            tipo: "prueba.eco",
            clienteId: c4.id,
            parametros: { n: 4 },
          })
        ).trabajo.id,
      ];
      await esperarHasta(
        async () =>
          (await Promise.all(ids.map((id) => e.fila(id)))).every((f) =>
            ["error", "completado", "cancelado"].includes(f?.estado),
          ),
        "los 4 terminan",
        { timeoutMs: 20_000 },
      );
      await dormir(300);
    } finally {
      for (const s of espias) s.mockRestore();
    }
    const filas = await Promise.all(ids.map((id) => e.fila(id)));
    const bd = await e.volcarJobs();
    const enRedis = await volcarPrefijo(redis, prefijo);
    const eventos = ev.mensajes.map((m) => m.texto).join("\n");
    await ev.cerrar();
    const textos = {
      logs: logs.join("\n"),
      salida: salida.join("\n"),
      bd,
      enRedis,
      eventos,
    };
    const fugas = Object.entries(textos).flatMap(([donde, t]) =>
      canarios
        .filter((c) => t.includes(c))
        .map((c) => `${donde}:${c.split("-")[1]}`),
    );
    const conCampos = ids.every((id) =>
      logs.some(
        (l) =>
          l.includes(`"job_id":"${id}"`) &&
          l.includes(`"tenant_id":"${A}"`) &&
          l.includes('"tipo":"'),
      ),
    );
    expect({
      fugas,
      motivos: filas.map((f) => [f.estado, MOTIVOS.has(f.motivo)]),
      logsConTenantJobTipo: conCampos,
    }).toEqual({
      fugas: [],
      motivos: [
        ["error", true],
        ["error", true],
        ["error", true],
        ["error", true],
      ],
      logsConTenantJobTipo: true,
    });
  });
});

describe("CA-14 · el que encoló pierde el permiso del tipo antes del despacho", () => {
  it("con la asignación intacta pero un rol sin el permiso, el trabajo queda cancelado/acceso_retirado sin ejecutarse", async () => {
    const sinPermiso = (["lectura", "asistente", "contador"] as Rol[]).find(
      (r) => !tienePermiso(r, "sire.descargar"),
    );
    expect(sinPermiso, "existe un rol sin sire.descargar").toBeDefined();
    const A = await e.estudio();
    const u = await e.usuario(A, "contador");
    expect(tienePermiso("contador", "sire.descargar")).toBe(true);
    const c = await e.cliente(A);
    await e.asignar(A, c.id, u);
    const r = await encolarYPublicar(backend, redis, prefijo, A, {
      tipo: "prueba.eco",
      clienteId: c.id,
      parametros: { n: 1 },
      creadoPor: u,
    });
    await admin.pool.query(
      "update membresia set rol = $3 where tenant_id = $1 and usuario_id = $2",
      [A, u, sinPermiso],
    );

    const prog = new ProcesadorProgramable();
    await iniciar(prog);
    await esperarHasta(
      async () => (await e.fila(r.trabajo.id))?.estado !== "en_cola",
      "se decide",
      { timeoutMs: 10_000 },
    );
    await dormir(300);
    const f = await e.fila(r.trabajo.id);
    expect({
      estado: f.estado,
      motivo: f.motivo,
      llamadas: prog.de(r.trabajo.id).length,
    }).toEqual({
      estado: "cancelado",
      motivo: "acceso_retirado",
      llamadas: 0,
    });
  });
});
