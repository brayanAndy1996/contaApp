import type { ContappDb } from "@contapp/db";
import {
  ErrorCredencial,
  ErrorTransitorio,
  MockConsultaRuc,
} from "@contapp/sunat";
import type { Redis } from "ioredis";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  AlmacenEspia,
  ctxDe,
  encolarGenerar,
  huellaDe,
  sembrarVentaSire,
  ventaBoleta,
  ventaFactura,
  PERIODO as PERIODO_ARCHIVO,
} from "../../test/archivos.js";
import {
  asignarResponsable,
  auditoriaDe,
  avisados,
  cancelarEnCola,
  limpiarFilas017,
  notificacionesDe,
  notificadorEspia,
  ordenados,
  volcarTablas017,
} from "../../test/notificaciones.js";
import { arrancar007b, esperarTerminal } from "../../test/procesadores-007b.js";
import { canario, loggerEspia, volcado } from "../../test/soporte.js";
import {
  arrancar,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  dormir,
  encolarYPublicar,
  Escenario,
  esperarHasta,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  ProcesadorProgramable,
  registrarTiposDePrueba,
  restaurarConfig,
  suscribirEventos,
  volcarPrefijo,
  type ProcesoWorker,
} from "../../test/trabajos.js";
import {
  encolarDescarga,
  mundoVentas,
  RUC_FIXTURE,
  SireApiControlado,
  sembrarManual,
  sembrarPropuesta,
  type MundoVentas,
} from "../../test/ventas.js";
import { generarArchivo } from "./procesadores/generar-archivo.js";

// Spec 017 · T4 (rojo; integración con PostgreSQL, Redis y BullMQ reales): el worker guarda la notificación en la MISMA
// transacción del hecho y avisa por Redis DESPUÉS del commit (D-3, D-9, D-14; CA-4, CA-6, CA-8, CA-9). Requiere REDIS_URL,
// DATABASE_URL y MIGRATIONS_DATABASE_URL, y las migraciones 0041–0043.
//
// CONTRATO que fija (T9). El puerto y el adaptador están en notificador.spec.ts y test/notificaciones.ts; aquí:
// - `transicionFinal` (ejecutor) lee `destinatariosNuevos(tx)` antes del commit; tras el commit el ejecutor llama
//   `notificador.avisar(tenantId, destinatarios)` (sin esperarlo) con TODOS los usuarios a los que esa transacción les creó una
//   notificación (la de `credencial_invalida` y la de `trabajo_terminado`), sin repetir y solo ellos. Reintento (`en_cola`) o
//   sin creador/`programado` = no hay destinatarios = no hay aviso.
// - Todo `withTenant` de un trabajo pasa `trabajoId` (ejecutor, `descargar-propuesta`, `persistidores/compras`, `verificar-credencial`,
//   `generar-archivo`, `obtener-xml`, `consultar-ruc`, `encolar-xml`, `token-sire/credenciales-sire`): así la BD registra el actor
//   `trabajo` con `trabajo_id` y `usuario_id = job_registro.creado_por` (CA-4). Los de sistema (`auth.purgar`, `kek.rotar`) no.
// - El aviso de una invalidación hecha DENTRO del procesador (`credencial.verificar_*`) no está cubierto por el plan: aquí solo
//   se exige la notificación y la fila de auditoría.
// - Los `actor_tipo = 'trabajo'` de `auditoria` solo se ven con el rol worker (`current_setting('role')`); por eso las pruebas ejecutan
//   los procesadores con `contapp_worker` y no con la conexión administrativa.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

registrarTiposDePrueba();

let admin: ContappDb;
let backend: ContappDb;
let dbWorker: ContappDb;
let redis: Redis;
let e: Escenario;
let prefijo = nuevoPrefijo();
const prefijos = [prefijo];
const procesos: ProcesoWorker[] = [];

beforeEach(() => {
  prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
});

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  dbWorker = crearDbRol("contapp_worker", 4);
  redis = conectarRedis();
  e = new Escenario(admin);
  for (const cola of ["sire", "sol", "xml"])
    await fijarConfig(admin, cola, {
      global: 4,
      tenant: 2,
      espera: 0,
      reintentos: 3,
      base: 100,
    });
});

// Las pruebas que llaman al procesador directo dejan el trabajo `en_cola`: se cancelan (UPDATE, nunca DELETE) para que el
// reconciliador de otra prueba no los adopte (lección de 012b).
afterEach(async () => {
  await cancelarEnCola(admin, e?.estudios ?? []);
});

afterAll(async () => {
  await Promise.all(
    procesos.map((p) => p.detener({ esperaMs: 1000 }).catch(() => undefined)),
  );
  await restaurarConfig(admin).catch(() => undefined);
  await limpiarFilas017(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos)
    await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), dbWorker?.close(), admin?.close()]);
});

// ---------------------------------------------------------------------------------------------------------------
// Soporte local
// ---------------------------------------------------------------------------------------------------------------

/** Un estudio con un contador (creador) asignado a un cliente. */
async function estudio() {
  const T = await e.estudio();
  const creador = await e.usuario(T, "contador");
  const c = await e.cliente(T);
  await e.asignar(T, c.id, creador);
  return { T, creador, c };
}

type Mundo = Awaited<ReturnType<typeof estudio>>;

/** Arranca el worker con los tipos de prueba programables; devuelve lo necesario para encolar y esperar. */
async function conTipos(
  m: Mundo,
  o: {
    notificador?: unknown;
    logger?: unknown;
  } = {},
) {
  const prog = new ProcesadorProgramable();
  const p = await arrancar({
    prefijo,
    procesadores: {
      "prueba.eco": prog.procesador,
      "prueba.credencial_sol": prog.procesador,
    },
    ...(o.notificador === undefined
      ? {}
      : { notificador: o.notificador as never }),
    ...(o.logger === undefined ? {} : { logger: o.logger as never }),
  });
  procesos.push(p);
  const encolar = (
    tipo: "prueba.eco" | "prueba.credencial_sol",
    x: {
      creadoPor?: string | null;
      prioridad?: "interactivo" | "programado";
    } = {},
  ) =>
    encolarYPublicar(backend, redis, prefijo, m.T, {
      tipo,
      clienteId: m.c.id,
      parametros: { n: 1 },
      prioridad: x.prioridad ?? "interactivo",
      creadoPor: x.creadoPor === undefined ? m.creador : x.creadoPor,
    }).then((r) => r.trabajo.id);
  return { prog, p, encolar };
}

const terminal = (id: string, ms = 30_000) => esperarTerminal(e, id, ms);

/**
 * `config_sistema` es global y otras suites la restauran a D12 (backoff de 5 s) mientras corren en paralelo: antes de una prueba de
 * reintentos se vuelve a fijar el backoff corto y los reintentos que la prueba necesita.
 */
const reintentosRapidos = () =>
  fijarConfig(admin, "sire", { reintentos: 3, base: 100, espera: 0 });

// ---------------------------------------------------------------------------------------------------------------
// CA-9: una notificación por trabajo
// ---------------------------------------------------------------------------------------------------------------

describe("CA-9: trabajo_terminado, una vez por trabajo", () => {
  it("ErrorTransitorio dos veces y luego éxito: una sola notificación `completado` al creador y un solo aviso", async () => {
    await reintentosRapidos();
    const m = await estudio();
    const notificador = notificadorEspia();
    const w = await conTipos(m, { notificador });
    try {
      w.prog.comportamiento = async (_c, l) => {
        if (l.intentos < 2) throw new ErrorTransitorio();
        return { ok: true };
      };
      const id = await w.encolar("prueba.eco");
      const f = await terminal(id, 90_000);
      expect([f.estado, f.intentos]).toEqual(["completado", 2]);
      await esperarHasta(() => notificador.llamadas.length >= 1, "aviso");
      await dormir(400); // si hubiera otro aviso por un reintento, ya habría llegado

      const notifs = await notificacionesDe(admin, m.T, {
        tipo: "trabajo_terminado",
      });
      expect(notifs).toHaveLength(1);
      expect(notifs[0]).toMatchObject({
        usuario_id: m.creador,
        trabajo_id: id,
        leida_en: null,
        params: {
          tipoTrabajo: "prueba.eco",
          estado: "completado",
          motivo: null,
        },
      });
      expect(await notificacionesDe(admin, m.T)).toHaveLength(1);
      expect(notificador.llamadas).toEqual([
        { tenantId: m.T, usuarioIds: [m.creador] },
      ]);
    } finally {
      await w.p.detener({ esperaMs: 2000 });
    }
  });

  it("reintentos agotados: una sola notificación `error` con el motivo del catálogo", async () => {
    await reintentosRapidos();
    const m = await estudio();
    const notificador = notificadorEspia();
    const w = await conTipos(m, { notificador });
    try {
      w.prog.comportamiento = async () => {
        throw new ErrorTransitorio();
      };
      const id = await w.encolar("prueba.eco");
      const f = await terminal(id, 90_000);
      expect([f.estado, f.motivo]).toEqual(["error", "sunat_no_responde"]);
      expect(w.prog.de(id)).toHaveLength(4);
      await esperarHasta(() => notificador.llamadas.length >= 1, "aviso");
      await dormir(300);
      const notifs = await notificacionesDe(admin, m.T);
      expect(notifs).toHaveLength(1);
      expect(notifs[0]).toMatchObject({
        tipo: "trabajo_terminado",
        usuario_id: m.creador,
        trabajo_id: id,
        params: {
          tipoTrabajo: "prueba.eco",
          estado: "error",
          motivo: "sunat_no_responde",
        },
      });
      expect(notificador.llamadas).toHaveLength(1);
    } finally {
      await w.p.detener({ esperaMs: 2000 });
    }
  });

  it("un trabajo programado y sin creador termina sin notificación y sin aviso", async () => {
    const m = await estudio();
    const notificador = notificadorEspia();
    const w = await conTipos(m, { notificador });
    try {
      const id = await w.encolar("prueba.eco", {
        creadoPor: null,
        prioridad: "programado",
      });
      expect((await terminal(id)).estado).toBe("completado");
      await dormir(500);
      expect(await notificacionesDe(admin, m.T)).toEqual([]);
      expect(notificador.llamadas).toEqual([]);
    } finally {
      await w.p.detener({ esperaMs: 2000 });
    }
  });

  it("si la transacción final se revierte (resultado de más de 4 KB) la primera no deja nada: una sola notificación, la de error_interno", async () => {
    const m = await estudio();
    const notificador = notificadorEspia();
    const w = await conTipos(m, { notificador });
    try {
      w.prog.comportamiento = async () => ({ grande: "x".repeat(6000) });
      const id = await w.encolar("prueba.eco");
      const f = await terminal(id);
      expect([f.estado, f.motivo]).toEqual(["error", "error_interno"]);
      await esperarHasta(() => notificador.llamadas.length >= 1, "aviso");
      await dormir(300);
      const notifs = await notificacionesDe(admin, m.T);
      expect(notifs).toHaveLength(1);
      expect(notifs[0]).toMatchObject({
        tipo: "trabajo_terminado",
        trabajo_id: id,
        params: { estado: "error", motivo: "error_interno" },
      });
      expect(notificador.llamadas).toHaveLength(1);
    } finally {
      await w.p.detener({ esperaMs: 2000 });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-8: credencial inválida
// ---------------------------------------------------------------------------------------------------------------

describe("CA-8: ErrorCredencial en el ejecutor (credencial del catálogo)", () => {
  it("sin responsable: una notificación a cada Dueño y Administrador activo (no al desactivado) y otra de trabajo al creador; el aviso sale tras el commit con solo esos destinatarios", async () => {
    const m = await estudio();
    const dueno = await e.usuario(m.T, "dueno");
    const administrador = await e.usuario(m.T, "admin");
    await e.usuario(m.T, "dueno", { desactivada: true });
    await e.credencial(m.T, m.c.id, "sol");
    let existentesAlAvisar = -1;
    const notificador = notificadorEspia(false, {
      alAvisar: async () => {
        existentesAlAvisar = (await notificacionesDe(admin, m.T)).length;
      },
    });
    const w = await conTipos(m, { notificador });
    try {
      w.prog.comportamiento = async () => {
        throw new ErrorCredencial();
      };
      const id = await w.encolar("prueba.credencial_sol");
      const f = await terminal(id);
      expect([f.estado, f.motivo]).toEqual(["error", "credencial_invalida"]);
      await esperarHasta(() => notificador.llamadas.length >= 1, "aviso");
      await dormir(300);

      const cred = await notificacionesDe(admin, m.T, {
        tipo: "credencial_invalida",
      });
      expect(ordenados(cred.map((n) => n.usuario_id))).toEqual(
        ordenados([dueno, administrador]),
      );
      for (const n of cred)
        expect(n).toMatchObject({
          cliente_id: m.c.id,
          trabajo_id: id,
          leida_en: null,
          params: { credencial: "sol" },
        });
      const term = await notificacionesDe(admin, m.T, {
        tipo: "trabajo_terminado",
      });
      expect(term).toHaveLength(1);
      expect(term[0]).toMatchObject({
        usuario_id: m.creador,
        trabajo_id: id,
        params: {
          tipoTrabajo: "prueba.credencial_sol",
          estado: "error",
          motivo: "credencial_invalida",
        },
      });

      expect(notificador.llamadas).toHaveLength(1);
      expect(notificador.llamadas[0]!.tenantId).toBe(m.T);
      expect(ordenados(notificador.llamadas[0]!.usuarioIds)).toEqual(
        ordenados([dueno, administrador, m.creador]),
      );
      expect(
        notificador.args[0]!,
        "el puerto recibe solo (tenantId, usuarioIds): nada de contenido",
      ).toHaveLength(2);
      expect(
        existentesAlAvisar,
        "al avisar las tres notificaciones ya están confirmadas (D-9)",
      ).toBe(3);

      const aud = await auditoriaDe(admin, m.T, "credencial.invalidada");
      expect(aud).toHaveLength(1);
      expect(aud[0]).toMatchObject({
        actor_tipo: "trabajo",
        trabajo_id: id,
        usuario_id: m.creador,
        cliente_id: m.c.id,
        datos: { tipo: "sol", motivo: "credencial_invalida" },
      });
    } finally {
      await w.p.detener({ esperaMs: 2000 });
    }
  });

  it("con responsable: solo a él (no a los Dueños)", async () => {
    const m = await estudio();
    const dueno = await e.usuario(m.T, "dueno");
    const responsable = await e.usuario(m.T, "contador");
    await asignarResponsable(admin, m.T, m.c.id, responsable);
    await e.credencial(m.T, m.c.id, "sol");
    const notificador = notificadorEspia();
    const w = await conTipos(m, { notificador });
    try {
      w.prog.comportamiento = async () => {
        throw new ErrorCredencial();
      };
      const id = await w.encolar("prueba.credencial_sol");
      await terminal(id);
      await esperarHasta(() => notificador.llamadas.length >= 1, "aviso");
      const cred = await notificacionesDe(admin, m.T, {
        tipo: "credencial_invalida",
      });
      expect(cred.map((n) => n.usuario_id)).toEqual([responsable]);
      expect(avisados(notificador.llamadas)).toEqual(
        ordenados([responsable, m.creador]),
      );
      expect(avisados(notificador.llamadas)).not.toContain(dueno);
    } finally {
      await w.p.detener({ esperaMs: 2000 });
    }
  });

  it("si el aviso falla, la notificación y el cierre del trabajo ya existen y el fallo solo deja códigos en el log (sin el canario del error)", async () => {
    const m = await estudio();
    const dueno = await e.usuario(m.T, "dueno");
    await e.credencial(m.T, m.c.id, "sol");
    const veneno = canario("canal");
    const notificador = notificadorEspia(`canal caído ${veneno}`);
    const { logger, llamadas } = loggerEspia();
    const w = await conTipos(m, { notificador, logger });
    try {
      w.prog.comportamiento = async () => {
        throw new ErrorCredencial();
      };
      const id = await w.encolar("prueba.credencial_sol");
      const f = await terminal(id);
      expect([f.estado, f.motivo]).toEqual(["error", "credencial_invalida"]);
      await esperarHasta(() => notificador.llamadas.length >= 1, "aviso");
      await esperarHasta(
        () =>
          llamadas.some((l) =>
            JSON.stringify(l.args).includes("notificador_fallo"),
          ),
        "log notificador_fallo",
      );
      const cred = await notificacionesDe(admin, m.T, {
        tipo: "credencial_invalida",
      });
      expect(cred.map((n) => n.usuario_id)).toEqual([dueno]);
      expect((await e.credencialEstado(m.c.id))?.estado).toBe("invalida");
      expect(volcado(llamadas)).not.toContain(veneno);
      expect(await e.volcarJobs()).not.toContain(veneno);
      expect(await volcarTablas017(admin, [m.T])).not.toContain(veneno);
    } finally {
      await w.p.detener({ esperaMs: 2000 });
    }
  });

  it("un aviso colgado no retiene el cierre: el trabajo y la notificación quedan, y el worker se detiene", async () => {
    const m = await estudio();
    const dueno = await e.usuario(m.T, "dueno");
    await e.credencial(m.T, m.c.id, "sol");
    const notificador = notificadorEspia(false, { colgado: true });
    const w = await conTipos(m, { notificador });
    try {
      w.prog.comportamiento = async () => {
        throw new ErrorCredencial();
      };
      const id = await w.encolar("prueba.credencial_sol");
      expect((await terminal(id)).motivo).toBe("credencial_invalida");
      await esperarHasta(() => notificador.llamadas.length >= 1, "aviso");
      expect(
        (
          await notificacionesDe(admin, m.T, { tipo: "credencial_invalida" })
        ).map((n) => n.usuario_id),
      ).toEqual([dueno]);
    } finally {
      await w.p.detener({ esperaMs: 2000 });
    }
  });

  it("el proceso muere justo al avisar (tras el commit): la notificación existe y no queda nada a medias", async () => {
    const m = await estudio();
    const dueno = await e.usuario(m.T, "dueno");
    await e.credencial(m.T, m.c.id, "sol");
    const proceso: { w?: ProcesoWorker } = {};
    const notificador = notificadorEspia(false, {
      alAvisar: async () => {
        await proceso.w?.abortar();
      },
    });
    const w = await conTipos(m, { notificador });
    proceso.w = w.p;
    try {
      w.prog.comportamiento = async () => {
        throw new ErrorCredencial();
      };
      const id = await w.encolar("prueba.credencial_sol");
      await esperarHasta(
        () => notificador.llamadas.length >= 1,
        "el worker llega al aviso",
      );
      await dormir(500);
      expect(
        (
          await notificacionesDe(admin, m.T, { tipo: "credencial_invalida" })
        ).map((n) => n.usuario_id),
      ).toEqual([dueno]);
      expect((await e.fila(id))?.estado).toBe("error");
      expect(
        await notificacionesDe(admin, m.T, { trabajoId: id }),
      ).toHaveLength(2);
    } finally {
      await w.p.detener({ esperaMs: 1000 }).catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-4 / D-3: procesadores reales, actor `trabajo`
// ---------------------------------------------------------------------------------------------------------------

async function mundoReal(): Promise<MundoVentas & { responsable: string }> {
  const m = await mundoVentas(e, backend);
  const responsable = await e.usuario(m.T, "contador");
  await asignarResponsable(admin, m.T, m.c.id, responsable);
  return { ...m, responsable };
}

describe("CA-4 y CA-8: sire.propuesta.descargar con el worker real", () => {
  it("401 (ErrorCredencial): notificación al responsable, aviso a él y al creador, y `credencial.invalidada` con actor `trabajo`", async () => {
    const m = await mundoReal();
    const notificador = notificadorEspia();
    const api = new SireApiControlado();
    api.fallar("401");
    const p = await arrancar007b({
      prefijo,
      sireApi: api,
      notificador: notificador as never,
    });
    procesos.push(p);
    try {
      const id = await encolarDescarga(backend, redis, prefijo, m);
      const f = await terminal(id);
      expect([f.estado, f.motivo]).toEqual(["error", "credencial_invalida"]);
      await esperarHasta(() => notificador.llamadas.length >= 1, "aviso");

      const cred = await notificacionesDe(admin, m.T, {
        tipo: "credencial_invalida",
      });
      expect(cred).toHaveLength(1);
      expect(cred[0]).toMatchObject({
        usuario_id: m.responsable,
        cliente_id: m.c.id,
        trabajo_id: id,
        params: { credencial: "sire_api" },
      });
      expect(ordenados(notificador.llamadas[0]!.usuarioIds)).toEqual(
        ordenados([m.responsable, m.u]),
      );
      const aud = await auditoriaDe(admin, m.T, "credencial.invalidada");
      expect(aud).toHaveLength(1);
      expect(aud[0]).toMatchObject({
        actor_tipo: "trabajo",
        trabajo_id: id,
        usuario_id: m.u,
        cliente_id: m.c.id,
        datos: { tipo: "sire_api", motivo: "credencial_invalida" },
      });
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });

  it("éxito: `propuesta.cargada` con actor `trabajo`, el trabajo y el creador del trabajo", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const p = await arrancar007b({ prefijo, sireApi: new SireApiControlado() });
    procesos.push(p);
    try {
      const id = await encolarDescarga(backend, redis, prefijo, m);
      const f = await terminal(id);
      expect([f.estado, f.motivo]).toEqual(["completado", null]);
      const aud = await auditoriaDe(admin, m.T, "propuesta.cargada");
      expect(aud).toHaveLength(1);
      expect(aud[0]).toMatchObject({
        actor_tipo: "trabajo",
        trabajo_id: id,
        usuario_id: m.u,
        cliente_id: m.c.id,
        datos: {
          libro: "ventas",
          periodo: "202610",
          fuente: "api",
          filasRecibidas: 11,
        },
      });
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });
});

describe("CA-4 y CA-8: credencial.verificar_* con el worker real", () => {
  const encolarVerificar = (m: MundoVentas, tipo: string) =>
    encolarYPublicar(backend, redis, prefijo, m.T, {
      tipo,
      clienteId: m.c.id,
      parametros: {},
      prioridad: "interactivo",
      creadoPor: m.u,
    }).then((r) => r.trabajo.id);

  it("rechazo de la clave SOL: el procesador invalida la credencial con actor `trabajo`; notificación al responsable", async () => {
    const m = await mundoReal();
    const solAuth = {
      verificar: async () => {
        throw new ErrorCredencial(new Error(`rechazo con ${m.secretos.clave}`));
      },
    };
    const p = await arrancar007b({ prefijo, solAuth: solAuth as never });
    procesos.push(p);
    try {
      const id = await encolarVerificar(m, "credencial.verificar_sol");
      const f = await terminal(id);
      expect([f.estado, f.motivo]).toEqual(["error", "credencial_invalida"]);
      const aud = await auditoriaDe(admin, m.T, "credencial.invalidada");
      expect(aud).toHaveLength(1);
      expect(aud[0]).toMatchObject({
        actor_tipo: "trabajo",
        trabajo_id: id,
        usuario_id: m.u,
        cliente_id: m.c.id,
        datos: { tipo: "sol" },
      });
      const cred = await notificacionesDe(admin, m.T, {
        tipo: "credencial_invalida",
      });
      expect(cred).toHaveLength(1);
      expect(cred[0]).toMatchObject({
        usuario_id: m.responsable,
        trabajo_id: id,
        params: { credencial: "sol" },
      });
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });

  it("verificación correcta: `credencial.verificada` con actor `trabajo`", async () => {
    const m = await mundoReal();
    const solAuth = { verificar: async () => undefined };
    const p = await arrancar007b({ prefijo, solAuth: solAuth as never });
    procesos.push(p);
    try {
      const id = await encolarVerificar(m, "credencial.verificar_sol");
      expect((await terminal(id)).estado).toBe("completado");
      const aud = await auditoriaDe(admin, m.T, "credencial.verificada");
      expect(aud).toHaveLength(1);
      expect(aud[0]).toMatchObject({
        actor_tipo: "trabajo",
        trabajo_id: id,
        usuario_id: m.u,
        cliente_id: m.c.id,
        datos: { tipo: "sol" },
      });
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });
});

describe("CA-4: cliente.consultar_ruc con el worker real", () => {
  it("completar la razón social deja `cliente.editado` con actor `trabajo`", async () => {
    const T = await e.estudio();
    const u = await e.usuario(T, "admin");
    const c = await e.cliente(T);
    await admin.pool.query(
      "update cliente set razon_social = 'RUC ' || ruc where id = $1",
      [c.id],
    );
    const p = await arrancar007b({
      prefijo,
      consultaRuc: new MockConsultaRuc(),
    });
    procesos.push(p);
    try {
      const id = await encolarYPublicar(backend, redis, prefijo, T, {
        tipo: "cliente.consultar_ruc",
        clienteId: c.id,
        parametros: {},
        prioridad: "programado",
        creadoPor: u,
      }).then((r) => r.trabajo.id);
      expect((await terminal(id)).estado).toBe("completado");
      const aud = await auditoriaDe(admin, T, "cliente.editado", {
        actor: "trabajo",
      });
      expect(aud).toHaveLength(1);
      expect(aud[0]).toMatchObject({
        trabajo_id: id,
        usuario_id: u,
        entidad_id: c.id,
      });
    } finally {
      await p.detener({ esperaMs: 2000 });
    }
  });
});

describe("CA-4: archivo.generar (procesador llamado directo con el rol worker)", () => {
  it("`archivo.generado` queda con actor `trabajo`, el trabajo y su creador", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const prop = await sembrarPropuesta(admin, m, { filas: 2 });
    await sembrarVentaSire(admin, m, prop, ventaBoleta("290"));
    await sembrarVentaSire(
      admin,
      m,
      prop,
      ventaBoleta("292", {
        fechaEmision: "2026-10-06",
        baseGravada: "50.00",
        igv: "9.00",
        total: "59.00",
      }),
    );
    await sembrarManual(admin, m, ventaFactura("F001", "77"));
    const params = {
      periodo: PERIODO_ARCHIVO,
      libro: "ventas" as const,
      estadoVisto: "abierto" as const,
      huella: await huellaDe(admin, m, "ventas", PERIODO_ARCHIVO),
    };
    const id = await encolarGenerar(admin, backend, redis, prefijo, m, params);
    const proc = generarArchivo({ db: dbWorker, storage: new AlmacenEspia() });
    await proc(ctxDe(m, id, params));

    const aud = await auditoriaDe(admin, m.T, "archivo.generado");
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({
      actor_tipo: "trabajo",
      trabajo_id: id,
      usuario_id: m.u,
      cliente_id: m.c.id,
      datos: { libro: "ventas", periodo: PERIODO_ARCHIVO, version: 1 },
    });
    const periodo = await auditoriaDe(admin, m.T, "periodo.estado_cambiado");
    for (const f of periodo)
      expect(
        f,
        "todo lo que hace el procesador lleva el actor trabajo",
      ).toMatchObject({ actor_tipo: "trabajo", trabajo_id: id });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-6: centinelas, con el notificador real (Redis)
// ---------------------------------------------------------------------------------------------------------------

describe("CA-6: ningún centinela llega a notificaciones, auditoría, avisos de Redis ni logs", () => {
  it("rechazo con la clave SOL y el client_secret en el error: el aviso real es { evento, destinatarios } y nada más", async () => {
    const m = await mundoReal();
    const razon = (
      await admin.pool.query("select razon_social from cliente where id = $1", [
        m.c.id,
      ])
    ).rows[0].razon_social as string;
    const secretos = [
      m.secretos.clave,
      m.secretos.clientSecret,
      m.secretos.clientId,
    ];
    const sucio = new Error(`rechazo ${secretos.join(" ")}`, {
      cause: new Error(secretos[0]),
    });
    const api = new SireApiControlado();
    api.descargarPropuesta = (async () => {
      throw new ErrorCredencial(sucio);
    }) as typeof api.descargarPropuesta;
    const { logger, llamadas } = loggerEspia();
    const capturado: string[] = [];
    const espias = (["log", "info", "warn", "error", "debug"] as const).map(
      (n) =>
        vi
          .spyOn(console, n)
          .mockImplementation(
            (...a: unknown[]) => void capturado.push(volcado(a)),
          ),
    );
    const ev = await suscribirEventos(prefijo, [m.T]);
    // Sin `notificador`: el worker usa `NotificadorEventos` sobre su Redis y su prefijo.
    const p = await arrancar007b({
      prefijo,
      sireApi: api,
      logger: logger as never,
    });
    procesos.push(p);
    try {
      const id = await encolarDescarga(backend, redis, prefijo, m);
      const f = await terminal(id);
      expect([f.estado, f.motivo]).toEqual(["error", "credencial_invalida"]);
      await esperarHasta(
        () => ev.mensajes.some((x) => x.evento?.evento === "notificacion"),
        "aviso de notificación en Redis",
      );
      await dormir(300);

      const avisos = ev.mensajes
        .map((x) => x.evento)
        .filter((x) => x?.evento === "notificacion");
      expect(avisos).toHaveLength(1);
      expect(Object.keys(avisos[0]).sort()).toEqual([
        "destinatarios",
        "evento",
      ]);
      expect(ordenados(avisos[0].destinatarios)).toEqual(
        ordenados([m.responsable, m.u]),
      );
      // Los eventos de estado del trabajo siguen siendo la vista pública de 008 (sin la clave `evento`).
      for (const x of ev.mensajes.filter(
        (y) => y.evento?.evento !== "notificacion",
      ))
        expect(x.evento).not.toHaveProperty("destinatarios");

      const todo = [
        await volcarTablas017(admin, [m.T]),
        await e.volcarJobs(),
        await volcarPrefijo(redis, prefijo),
        ev.mensajes.map((x) => x.texto).join("\n"),
        volcado(llamadas),
        capturado.join("\n"),
      ].join("\n");
      for (const s of [...secretos, razon]) expect(todo, s).not.toContain(s);
      expect(llamadas.length, "el worker sí registra eventos").toBeGreaterThan(
        0,
      );
    } finally {
      for (const s of espias) s.mockRestore();
      await ev.cerrar();
      await p.detener({ esperaMs: 2000 });
    }
  });
});
