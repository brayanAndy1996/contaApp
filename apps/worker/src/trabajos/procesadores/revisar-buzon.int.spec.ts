import type { ContappDb } from "@contapp/db";
import type { Redis } from "ioredis";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  arrancar007b,
  esperarTerminal,
  guardarCredencial,
  type FilaTrabajo,
} from "../../../test/procesadores-007b.js";
import {
  ASUNTO_CRITICO,
  EscenarioBuzon,
  PortalControlado,
  avisosBuzon,
  buzonBase,
  comun,
  comunes,
  critico,
  descifradosDe,
  encolarRevisar,
  estadoDeCaptura,
  insertarMensajeAdmin,
  mensajeDe,
  mensajesDe,
  notificacionesTipo,
  volcarTrazas,
  type Mundo,
} from "../../../test/buzon.js";
import {
  asignarResponsable,
  auditoriaDe,
  avisados,
  limpiarFilas017,
  notificacionesDe,
  notificadorEspia,
} from "../../../test/notificaciones.js";
import { canario, fugas, loggerEspia, volcado } from "../../../test/soporte.js";
import {
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  esperarHasta,
  fijarConfig,
  limpiarPrefijo,
  minimoTx,
  nuevoPrefijo,
  restaurarConfig,
  volcarPrefijo,
  type ProcesoWorker,
} from "../../../test/trabajos.js";

// Spec 023, T5 (rojo; integración con PostgreSQL y Redis reales, BullMQ real y un doble de `SolPortal`): el procesador
// `sol.buzon.revisar` (D-1, D-3, D-7, D-9, D-10, P-1, P-4, P-5, P-8; CA-3, CA-4, CA-6, CA-7, CA-10, CA-11). Se encola como lo
// hace el backend (rol backend, `interactivo`) y lo ejecuta el worker, que es quien descifra con la KEK `mock`.
// CONTRATO que fija (T12): el de test/buzon.ts (cabecera). Lo esencial:
// - Primera captura: guarda los metadatos (hasta 200 nuevos, de lo reciente a lo antiguo) con categoría, `critico`, `motivo_critico`
//   y `version_catalogo` del dominio; avisa SOLO críticos de los últimos 30 días (cliente sin `sincronizado_en`) y siempre en un
//   cliente ya sincronizado; nunca llama a `obtenerMensaje` ni marca leído. `resultado` = {nuevos, criticos, avisados,
//   actualizados, pendientes}.
// - Cada mensaje nuevo, con su aviso, en su propia transacción: lo confirmado queda aunque la captura falle después (P-4).
// - `ErrorCredencial` -> `error/credencial_invalida`, sin reintento, credencial `invalida`, un aviso `credencial_invalida`;
//   `ErrorTransitorio` -> se reintenta y el estado final es el de una captura sin fallo.
// - Avisos `buzon_critico` {categoria, mensajeId}: al responsable; sin responsable, a Dueños y Administradores activos.
// - Ni usuario, clave, asunto, contenido, nombre de adjunto ni RUC en logs, `resultado`, `params` ni auditoría (D-10).

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const REINTENTOS = 2;
let admin: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: EscenarioBuzon;
let prefijo = nuevoPrefijo();
const prefijos = [prefijo];
let entornoAnterior: string | undefined;

beforeEach(() => {
  prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
});

beforeAll(async () => {
  // Este archivo prueba la captura: el repetible del programador no corre (los ciclos tienen su propio archivo).
  entornoAnterior = process.env.BUZON_PROGRAMADOR;
  process.env.BUZON_PROGRAMADOR = "off";
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  redis = conectarRedis();
  e = new EscenarioBuzon(admin);
  await fijarConfig(admin, "sol", {
    global: 4,
    tenant: 2,
    espera: 0,
    reintentos: REINTENTOS,
    base: 100,
  });
});

afterAll(async () => {
  if (entornoAnterior === undefined) delete process.env.BUZON_PROGRAMADOR;
  else process.env.BUZON_PROGRAMADOR = entornoAnterior;
  await restaurarConfig(admin).catch(() => undefined);
  await limpiarFilas017(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos)
    await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

// ---------------------------------------------------------------------------------------------------------------
// Soporte local
// ---------------------------------------------------------------------------------------------------------------

interface M extends Mundo {
  /** Dueño, Administrador activo y Administrador desactivado del estudio. */
  D: string;
  A: string;
  ADes: string;
  secretos: { usuario: string; clave: string };
}

/** Estudio con un cliente con credencial SOL real (canarios), responsable (salvo `responsable: false`) y miembros de P-8. */
async function mundo(o: { responsable?: boolean } = {}): Promise<M> {
  const T = await e.estudio();
  const D = await e.usuario(T, "dueno");
  const A = await e.usuario(T, "admin");
  const ADes = await e.usuario(T, "admin", { desactivada: true });
  const u = await e.usuario(T, "contador");
  const c = await e.cliente(T);
  // Sin responsable el contador igual ve al cliente (colaborador): el despachador cancela lo que pide quien no lo ve.
  if (o.responsable !== false) await asignarResponsable(admin, T, c.id, u);
  else await e.asignar(T, c.id, u);
  const secretos = {
    usuario: canario("usuario_sol"),
    clave: canario("clave_sol"),
  };
  await guardarCredencial(backend, T, c.id, "sol", secretos);
  return { T, u, c, D, A, ADes, secretos };
}

/** Otro cliente del mismo estudio con su propia credencial (para comparar contra una captura sin fallo). */
async function otroCliente(m: M): Promise<M> {
  const c = await e.cliente(m.T);
  await asignarResponsable(admin, m.T, c.id, m.u);
  await guardarCredencial(backend, m.T, c.id, "sol", m.secretos);
  return { ...m, c };
}

/** Arranca el worker con el portal de la prueba, corre `fn` y lo detiene. */
async function conWorker<T>(
  portal: PortalControlado,
  fn: (w: ProcesoWorker) => Promise<T>,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const w = await arrancar007b({
    prefijo,
    solPortal: portal,
    ...extra,
  } as Parameters<typeof arrancar007b>[0]);
  portal.contarTx = () => w.dbEstado.abiertas;
  try {
    return await fn(w);
  } finally {
    await w.detener({ esperaMs: 2000 });
  }
}

/** Encola una captura (como el backend) y espera su fin. */
async function correr(m: M, timeoutMs = 40_000): Promise<FilaTrabajo> {
  const id = await encolarRevisar(backend, redis, prefijo, m);
  return esperarTerminal(e, id, timeoutMs);
}

const resultadoDe = (f: FilaTrabajo): Record<string, unknown> =>
  (f as { resultado?: Record<string, unknown> }).resultado ?? {};

const idsDe = async (m: M): Promise<string[]> =>
  (await mensajesDe(admin, m.c.id)).map((f) => f.id_sunat);

// ---------------------------------------------------------------------------------------------------------------
// CA-3, CA-4, CA-6: la captura
// ---------------------------------------------------------------------------------------------------------------

describe("CA-3, CA-4, CA-6: primera captura", () => {
  it("guarda los metadatos con su categoría, avisa solo los críticos de los últimos 30 días y no abre nada", async () => {
    const m = await mundo();
    const portal = new PortalControlado().buzon(m.c.ruc, buzonBase());
    const vistas: number[] = [];
    const espia = notificadorEspia(false, {
      alAvisar: async (T) => {
        vistas.push(
          (await notificacionesDe(admin, T, { tipo: "buzon_critico" })).length,
        );
      },
    });
    const f = await conWorker(
      portal,
      async () => {
        const f = await correr(m);
        await esperarHasta(
          () => espia.llamadas.length > 0,
          "el aviso en vivo se publica",
        );
        return f;
      },
      { notificador: espia },
    );
    expect([f.estado, f.motivo]).toEqual(["completado", null]);
    expect(resultadoDe(f)).toEqual({
      nuevos: 12,
      criticos: 4,
      avisados: 3,
      actualizados: 0,
      pendientes: false,
    });

    const filas = await mensajesDe(admin, m.c.id);
    expect(filas).toHaveLength(12);
    const por = Object.fromEntries(filas.map((x) => [x.id_sunat, x]));
    expect(por["C-COAC"]).toMatchObject({
      categoria: "coactiva",
      critico: true,
      avisado: true,
      version_catalogo: 1,
    });
    expect(por["C-RD"]).toMatchObject({
      categoria: "resolucion_determinacion",
      critico: true,
      avisado: true,
    });
    expect(por["C-REQ"]).toMatchObject({
      categoria: "requerimiento_fiscalizacion",
      critico: true,
      avisado: true,
    });
    // De hace 45 días en la primera sincronización: se guarda crítico y sin aviso (P-5).
    expect(por["C-RM"]).toMatchObject({
      categoria: "resolucion_multa",
      critico: true,
      avisado: false,
    });
    for (const x of filas.filter((x) => !x.critico)) {
      expect(x).toMatchObject({
        categoria: "otro",
        avisado: false,
        motivo_critico: null,
        leido_sunat: false,
      });
    }

    // CA-4: la captura no abre ni marca nada.
    expect(portal.llamadasObtener()).toBe(0);
    expect(portal.leidosMarcados()).toEqual([]);

    // CA-6: un aviso por crítico reciente, para el responsable, con params estrictos y dedupe por mensaje.
    const avisos = await avisosBuzon(admin, m.T, m.c.id);
    expect(avisos).toHaveLength(3);
    expect(avisos.every((a) => a.usuario_id === m.u)).toBe(true);
    for (const a of avisos) {
      expect(Object.keys(a.params).sort()).toEqual(["categoria", "mensajeId"]);
      expect(a.clave_dedupe).toBe(`buzon_critico:${a.params.mensajeId}`);
    }
    expect(avisos.map((a) => a.params.mensajeId).sort()).toEqual(
      ["C-COAC", "C-RD", "C-REQ"].map((id) => por[id]!.id).sort(),
    );
    // El aviso en vivo sale tras el commit, al responsable, y la notificación ya estaba guardada.
    expect(avisados(espia.llamadas)).toEqual([m.u]);
    expect(Math.min(...vistas)).toBeGreaterThan(0);

    // El estado de captura: sincronizado y sin pendiente.
    const st = await estadoDeCaptura(admin, m.c.id);
    expect(st?.ultima_captura_en).not.toBeNull();
    expect(st?.sincronizado_en).not.toBeNull();
    expect(st?.cursor_pendiente ?? null).toBeNull();

    // Se descifró una sola vez, con auditoría, y el puerto recibió la credencial exacta en cada llamada.
    expect(await descifradosDe(admin, m.c.id)).toEqual([
      expect.objectContaining({ resultado: "ok" }),
    ]);
    expect(portal.llamadasListar()).toBeGreaterThanOrEqual(1);
    for (const c of portal.credenciales)
      expect(c).toEqual({
        ruc: m.c.ruc,
        usuarioSol: m.secretos.usuario,
        claveSol: m.secretos.clave,
      });
  });

  it("clasifica con el dominio: homoglifos y abreviaturas son críticos y lo dudoso gana crítico con motivo `duda` (D-7, CA-5)", async () => {
    const m = await mundo();
    const portal = new PortalControlado().buzon(m.c.ruc, [
      comun("S-RM", 1, { asunto: "Resоluciоn  de  MULTA N° 5" }),
      comun("S-RD", 2, { asunto: "R.D. N° 012-003-0004321" }),
      comun("S-REQ", 3, { asunto: "REQ. FISCALIZACIÓN - Carta 14" }),
      comun("S-DUDA", 4, { asunto: "Aviso: embargo" }),
      comun("S-OTRO", 5, { asunto: "Constancia de presentación de PDT 621" }),
    ]);
    await conWorker(portal, async () => {
      expect((await correr(m)).estado).toBe("completado");
    });
    const por = Object.fromEntries(
      (await mensajesDe(admin, m.c.id)).map((x) => [x.id_sunat, x]),
    );
    expect(por["S-RM"]).toMatchObject({
      categoria: "resolucion_multa",
      critico: true,
      motivo_critico: "asunto",
    });
    expect(por["S-RD"]).toMatchObject({
      categoria: "resolucion_determinacion",
      critico: true,
    });
    expect(por["S-REQ"]).toMatchObject({
      categoria: "requerimiento_fiscalizacion",
      critico: true,
    });
    expect(por["S-DUDA"]).toMatchObject({
      critico: true,
      motivo_critico: "duda",
    });
    expect(por["S-OTRO"]).toMatchObject({
      categoria: "otro",
      critico: false,
      motivo_critico: null,
    });
  });

  it("con 450 mensajes, tres capturas los guardan todos, de lo reciente a lo antiguo, sin huecos ni duplicados (CA-3, P-5)", async () => {
    const m = await mundo();
    const portal = new PortalControlado({ pagina: 100 }).buzon(
      m.c.ruc,
      comunes(450),
    );
    const esperado = [
      { nuevos: 200, pendientes: true, total: 200, minimo: 251 },
      { nuevos: 200, pendientes: true, total: 400, minimo: 51 },
      { nuevos: 50, pendientes: false, total: 450, minimo: 1 },
    ];
    await conWorker(portal, async () => {
      for (const [i, esp] of esperado.entries()) {
        const f = await correr(m);
        expect(f.estado, `captura ${i + 1}`).toBe("completado");
        expect(resultadoDe(f), `captura ${i + 1}`).toMatchObject({
          nuevos: esp.nuevos,
          pendientes: esp.pendientes,
        });
        const filas = await mensajesDe(admin, m.c.id);
        expect(filas, `captura ${i + 1}`).toHaveLength(esp.total);
        const numeros = filas
          .map((x) => Number(x.id_sunat.slice(2)))
          .sort((a, b) => a - b);
        // Siempre un tramo contiguo que llega hasta el más reciente (450): sin huecos.
        expect(numeros[0]).toBe(esp.minimo);
        expect(numeros[numeros.length - 1]).toBe(450);
        expect(numeros).toEqual(
          Array.from(
            { length: 450 - esp.minimo + 1 },
            (_, k) => esp.minimo + k,
          ),
        );
        const st = await estadoDeCaptura(admin, m.c.id);
        if (esp.pendientes) {
          expect(st?.cursor_pendiente, `captura ${i + 1}`).not.toBeNull();
          expect(st?.sincronizado_en ?? null).toBeNull();
        } else {
          expect(st?.cursor_pendiente ?? null).toBeNull();
          expect(st?.sincronizado_en).not.toBeNull();
        }
      }
    });
    expect(portal.llamadasObtener()).toBe(0);
    expect(portal.leidosMarcados()).toEqual([]);
  });

  it("repetir la captura no duplica nada: solo actualiza el leído en SUNAT y la última captura (CA-3)", async () => {
    const m = await mundo();
    const portal = new PortalControlado().buzon(m.c.ruc, buzonBase());
    await conWorker(portal, async () => {
      expect((await correr(m)).estado).toBe("completado");
      const antes = await mensajesDe(admin, m.c.id);
      const avisosAntes = await avisosBuzon(admin, m.T, m.c.id);
      portal.marcarLeidoExterno(m.c.ruc, "C-OTRO-1");

      const f = await correr(m);
      expect(f.estado).toBe("completado");
      expect(resultadoDe(f)).toMatchObject({ nuevos: 0, avisados: 0 });
      expect(Number(resultadoDe(f).actualizados)).toBeGreaterThanOrEqual(1);

      const despues = await mensajesDe(admin, m.c.id);
      expect(despues.map((x) => x.id)).toEqual(antes.map((x) => x.id));
      expect(despues.find((x) => x.id_sunat === "C-OTRO-1")?.leido_sunat).toBe(
        true,
      );
      expect(
        despues
          .filter((x) => x.id_sunat !== "C-OTRO-1")
          .every((x) => !x.leido_sunat),
      ).toBe(true);
      for (const x of despues) {
        const a = antes.find((y) => y.id === x.id)!;
        expect(x.primera_captura_en).toEqual(a.primera_captura_en);
        expect(x.ultima_captura_en.getTime()).toBeGreaterThan(
          a.ultima_captura_en.getTime(),
        );
        expect([x.categoria, x.critico, x.avisado]).toEqual([
          a.categoria,
          a.critico,
          a.avisado,
        ]);
      }
      expect(await avisosBuzon(admin, m.T, m.c.id)).toEqual(avisosAntes);
    });
    expect(portal.llamadasObtener()).toBe(0);
    expect(portal.leidosMarcados()).toEqual([]);
  });

  it("en un cliente ya sincronizado avisa todo crítico nuevo aunque sea antiguo, y nunca un común (CA-6)", async () => {
    const m = await mundo();
    // Mensajes comunes de hace más de un año: la primera sincronización los guarda sin avisos.
    const base = Array.from({ length: 5 }, (_, k) =>
      comun(`V-${k + 1}`, 400 + k),
    );
    const portal = new PortalControlado().buzon(m.c.ruc, base);
    await conWorker(portal, async () => {
      expect((await correr(m)).estado).toBe("completado");
      expect(
        (await estadoDeCaptura(admin, m.c.id))?.sincronizado_en,
      ).not.toBeNull();
      expect(await avisosBuzon(admin, m.T, m.c.id)).toHaveLength(0);

      // Llega una multa de hace 100 días (más allá de los 30) y un común nuevo.
      portal.agregar(m.c.ruc, [
        critico("V-MULTA", "resolucion_multa", 100),
        comun("V-NUEVO", 101),
      ]);
      const f = await correr(m);
      expect(f.estado).toBe("completado");
      expect(resultadoDe(f)).toMatchObject({
        nuevos: 2,
        criticos: 1,
        avisados: 1,
      });
    });
    const por = Object.fromEntries(
      (await mensajesDe(admin, m.c.id)).map((x) => [x.id_sunat, x]),
    );
    expect(por["V-MULTA"]).toMatchObject({ critico: true, avisado: true });
    expect(por["V-NUEVO"]).toMatchObject({ critico: false, avisado: false });
    const avisos = await avisosBuzon(admin, m.T, m.c.id);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]?.params).toEqual({
      categoria: "resolucion_multa",
      mensajeId: por["V-MULTA"]!.id,
    });
  });
});

describe("CA-6, P-8: destinatarios del aviso", () => {
  it("sin responsable avisa a los Dueños y Administradores activos (no a los desactivados ni a un contador)", async () => {
    const m = await mundo({ responsable: false });
    const portal = new PortalControlado().buzon(m.c.ruc, [
      critico("D-1", "coactiva", 2),
    ]);
    await conWorker(portal, async () => {
      expect((await correr(m)).estado).toBe("completado");
    });
    const avisos = await avisosBuzon(admin, m.T, m.c.id);
    expect(avisos.map((a) => a.usuario_id).sort()).toEqual([m.D, m.A].sort());
    expect(avisos.map((a) => a.usuario_id)).not.toContain(m.ADes);
    expect(avisos.map((a) => a.usuario_id)).not.toContain(m.u);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-7, D-9, P-4: fallos
// ---------------------------------------------------------------------------------------------------------------

describe("CA-7: credencial y fallos del portal", () => {
  it("ErrorCredencial antes del login: no guarda nada, la credencial queda `invalida`, se avisa una vez y no se reintenta", async () => {
    const m = await mundo();
    const portal = new PortalControlado().buzon(m.c.ruc, buzonBase());
    portal.fallar("credencial");
    const f = await conWorker(portal, () => correr(m));
    expect([f.estado, f.motivo]).toEqual(["error", "credencial_invalida"]);
    expect(portal.llamadasListar(), "sin reintento").toBe(1);
    expect(await mensajesDe(admin, m.c.id)).toHaveLength(0);
    expect(
      (await estadoDeCaptura(admin, m.c.id))?.sincronizado_en ?? null,
    ).toBeNull();
    expect(await e.credencialEstado(m.c.id)).toMatchObject({
      estado: "invalida",
      estado_motivo: "credencial_invalida",
    });
    expect(
      await notificacionesTipo(admin, m.T, m.c.id, "credencial_invalida"),
    ).toHaveLength(1);
    expect(await avisosBuzon(admin, m.T, m.c.id)).toHaveLength(0);
  });

  it("ErrorCredencial en la página 2: la página 1 queda con sus avisos, se avisa una vez, no se reintenta y la captura con la clave nueva continúa sin duplicar (P-4)", async () => {
    const m = await mundo();
    const criticos = [
      critico("P-COAC", "coactiva", 0.00005),
      critico("P-RD", "resolucion_determinacion", 0.00006),
    ];
    const portal = new PortalControlado({ pagina: 100 }).buzon(m.c.ruc, [
      ...criticos,
      ...comunes(250),
    ]);
    portal.fallar("credencial", { despuesDe: 1 });
    await conWorker(portal, async () => {
      const f = await correr(m);
      expect([f.estado, f.motivo]).toEqual(["error", "credencial_invalida"]);
      expect(
        portal.llamadasListar(),
        "página 1 y página 2, sin reintento",
      ).toBe(2);

      // Lo confirmado queda: toda la página 1, con los avisos de sus críticos (cada uno en su transacción).
      const filas = await mensajesDe(admin, m.c.id);
      expect(filas.length).toBe(portal.entregados);
      expect(filas.length).toBeGreaterThan(0);
      expect(filas.length).toBeLessThan(252);
      const porId = Object.fromEntries(filas.map((x) => [x.id_sunat, x]));
      expect(porId["P-COAC"]).toMatchObject({ critico: true, avisado: true });
      expect(porId["P-RD"]).toMatchObject({ critico: true, avisado: true });
      expect(await avisosBuzon(admin, m.T, m.c.id)).toHaveLength(2);
      expect(
        await notificacionesTipo(admin, m.T, m.c.id, "credencial_invalida"),
      ).toHaveLength(1);
      expect(await e.credencialEstado(m.c.id)).toMatchObject({
        estado: "invalida",
      });
      const st = await estadoDeCaptura(admin, m.c.id);
      expect(
        st?.cursor_pendiente,
        "guarda dónde quedó para que la siguiente continúe",
      ).not.toBeNull();
      expect(st?.sincronizado_en ?? null).toBeNull();

      // El contador corrige la clave: la credencial vuelve a `configurada` y la captura siguiente continúa.
      const nueva = {
        usuario: m.secretos.usuario,
        clave: canario("clave_nueva"),
      };
      await guardarCredencial(backend, m.T, m.c.id, "sol", nueva);
      expect(await e.credencialEstado(m.c.id)).toMatchObject({
        estado: "configurada",
      });
      portal.fallar(null);
      let pendientes = true;
      for (let i = 0; i < 4 && pendientes; i++) {
        const g = await correr(m);
        expect(g.estado).toBe("completado");
        pendientes = resultadoDe(g).pendientes === true;
      }
      expect(pendientes).toBe(false);
      expect(portal.credenciales.at(-1)?.claveSol).toBe(nueva.clave);
    });
    const ids = await idsDe(m);
    expect(ids).toHaveLength(252);
    expect(new Set(ids).size).toBe(252);
    expect(
      await avisosBuzon(admin, m.T, m.c.id),
      "sin avisos repetidos",
    ).toHaveLength(2);
    expect(await e.credencialEstado(m.c.id)).toMatchObject({
      estado: "configurada",
    });
  });

  it("ErrorTransitorio a mitad de la captura: se reintenta y el estado final es el de una captura sin fallo", async () => {
    const m = await mundo();
    const ref = await otroCliente(m);
    const buzon = [...buzonBase(), ...comunes(40)];
    const portal = new PortalControlado({ pagina: 25 })
      .buzon(m.c.ruc, buzon)
      .buzon(ref.c.ruc, buzon);
    await conWorker(portal, async () => {
      portal.fallar("transitorio", { despuesDe: 1, veces: 1 });
      const f = await correr(m);
      expect([f.estado, f.motivo]).toEqual(["completado", null]);
      expect(
        portal.llamadasListar(),
        "hubo un reintento",
      ).toBeGreaterThanOrEqual(4);
      portal.fallar(null);
      expect((await correr(ref)).estado).toBe("completado");
    });
    const resumen = async (x: M) =>
      (await mensajesDe(admin, x.c.id)).map((f) => [
        f.id_sunat,
        f.categoria,
        f.critico,
        f.avisado,
      ]);
    expect(await resumen(m)).toHaveLength(52);
    expect(await resumen(m)).toEqual(await resumen(ref));
    expect((await avisosBuzon(admin, m.T, m.c.id)).length).toBe(3);
    expect((await avisosBuzon(admin, ref.T, ref.c.id)).length).toBe(3);
    expect(
      (await estadoDeCaptura(admin, m.c.id))?.sincronizado_en,
    ).not.toBeNull();
    expect(await e.credencialEstado(m.c.id)).toMatchObject({
      estado: "configurada",
    });
    expect(portal.leidosMarcados()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-11, 008 D6: concurrencia y transacciones
// ---------------------------------------------------------------------------------------------------------------

describe("CA-11: dos capturas del mismo mensaje", () => {
  it("si otra captura lo insertó mientras esta leía el portal, queda una fila y un solo aviso", async () => {
    const m = await mundo();
    const portal = new PortalControlado().buzon(m.c.ruc, [
      critico("R-CARRERA", "coactiva", 1),
      comun("R-OTRO", 1),
    ]);
    portal.pausar();
    await conWorker(portal, async () => {
      const id = await encolarRevisar(backend, redis, prefijo, m);
      await esperarHasta(
        () => portal.enEspera() > 0,
        "el portal recibe el pedido",
      );
      // La otra captura guarda el mismo mensaje (con su aviso) antes de que esta termine de listar.
      await insertarMensajeAdmin(admin, m.T, m.c.id, {
        idSunat: "R-CARRERA",
        asunto: ASUNTO_CRITICO.coactiva,
        categoria: "coactiva",
        critico: true,
        avisado: true,
        fechaHaceDias: 1,
      });
      portal.abrir();
      const f = await esperarTerminal(e, id);
      expect(f.estado).toBe("completado");
      expect(resultadoDe(f)).toMatchObject({ nuevos: 1, avisados: 0 });
    });
    const filas = (await mensajesDe(admin, m.c.id)).filter(
      (x) => x.id_sunat === "R-CARRERA",
    );
    expect(filas).toHaveLength(1);
    const avisos = await avisosBuzon(admin, m.T, m.c.id);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]?.params.mensajeId).toBe(filas[0]!.id);
    expect(await idsDe(m)).toEqual(["R-CARRERA", "R-OTRO"]);
  });
});

describe("008 D6: sin transacción abierta mientras corre el portal", () => {
  it("el puerto se llama sin ninguna transacción del worker abierta", async () => {
    const m = await mundo();
    const portal = new PortalControlado().buzon(m.c.ruc, buzonBase());
    portal.pausar();
    await conWorker(portal, async (w) => {
      const id = await encolarRevisar(backend, redis, prefijo, m);
      await esperarHasta(
        () => portal.enEspera() > 0,
        "el portal recibe el pedido",
      );
      expect(
        await minimoTx(w.dbEstado, 400),
        "una transacción abierta dejaría el mínimo en ≥ 1",
      ).toBe(0);
      portal.abrir();
      expect((await esperarTerminal(e, id)).estado).toBe("completado");
    });
    expect(portal.txEnLlamada.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-10, D-10: sin secretos ni datos en trazas
// ---------------------------------------------------------------------------------------------------------------

describe("CA-10: canarios en usuario, clave, asunto y nombre de adjunto", () => {
  it("no aparecen en logs, `resultado`, trabajos, Redis, notificaciones ni auditoría, ni siquiera cuando el portal falla con ellos", async () => {
    const m = await mundo();
    const canAsunto = canario("asunto");
    const canAdjunto = canario("adjunto");
    const portal = new PortalControlado({ pagina: 3 }).buzon(m.c.ruc, [
      comun("K-1", 1, {
        asunto: `${ASUNTO_CRITICO.coactiva} ${canAsunto}`,
        adjuntos: [{ idSunat: "K-1-A", nombre: `${canAdjunto}.pdf` }],
      }),
      ...comunes(8).map((x, i) =>
        i === 0 ? { ...x, asunto: `Aviso ${canAsunto}` } : x,
      ),
    ]);
    // Un fallo transitorio cuyo mensaje trae todos los canarios: el ejecutor no debe copiarlo a ningún lado.
    portal.fallar("error", {
      despuesDe: 1,
      veces: 1,
      error: new Error(
        `portal: ${m.secretos.usuario} ${m.secretos.clave} ${canAsunto} ${canAdjunto}`,
      ),
    });
    const espiaLog = loggerEspia();
    const espiaAviso = notificadorEspia();
    const f = await conWorker(portal, () => correr(m), {
      logger: espiaLog.logger,
      notificador: espiaAviso,
    });
    expect([f.estado, f.motivo]).toEqual(["completado", null]);

    const secretos = [
      m.secretos.usuario,
      m.secretos.clave,
      canAsunto,
      canAdjunto,
    ];
    const dondeBuscar: Record<string, unknown> = {
      logs: volcado(espiaLog.llamadas),
      aviso: volcado(espiaAviso.args),
      trazasBd: await volcarTrazas(admin, e.estudios),
      redis: await volcarPrefijo(redis, prefijo),
      resultado: JSON.stringify((f as { resultado?: unknown }).resultado),
    };
    for (const [donde, texto] of Object.entries(dondeBuscar))
      expect(fugas(texto as string, secretos), donde).toEqual([]);

    // Ni el RUC ni el asunto en los `params` de la notificación ni en los `datos` de auditoría de buzón.
    const avisos = await avisosBuzon(admin, m.T, m.c.id);
    expect(avisos.length).toBeGreaterThan(0);
    const params = JSON.stringify(avisos.map((a) => a.params));
    expect(params).not.toContain(m.c.ruc);
    expect(params).not.toContain("Coactiva");
    const auditoria = JSON.stringify(
      (await auditoriaDe(admin, m.T))
        .filter((a) => a.accion.startsWith("buzon."))
        .map((a) => a.datos),
    );
    expect(auditoria).not.toContain(m.c.ruc);
    expect(JSON.stringify(espiaLog.llamadas)).not.toContain(m.c.ruc);
    expect(
      JSON.stringify((f as { resultado?: unknown }).resultado),
    ).not.toContain(m.c.ruc);
    // Lo guardado sí lleva el asunto (es el dato), pero solo en su tabla.
    expect((await mensajeDe(admin, m.c.id, "K-1")).asunto).toContain(canAsunto);
  });
});
