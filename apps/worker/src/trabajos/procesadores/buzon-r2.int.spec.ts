/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD dinámicas y dobles mínimos en pruebas */
// Spec 023 · T20 · pruebas de las correcciones de la ronda adversarial 2 (worker; integración con PostgreSQL y Redis reales, el
// doble `PortalControlado` y un storage en memoria). En rojo hasta T21. Cada prueba fija el INVARIANTE que el hallazgo H-023-2-n
// viola, no la implementación que lo corrige; las cotas de capturas son las del plan de corrección (7 de 7 en 2; 251 en 3; 450 en 3).
//  - H-023-2-1/2/3 · captura sin pérdidas: con N capturas sucesivas todo mensaje del buzón queda guardado, cada crítico con UN aviso
//    y el cliente sincronizado, aunque la captura se corte en cualquier página (incluida la 1), el proceso muera a mitad, llegue un
//    mensaje nuevo entre páginas (paginación por desplazamiento) o el buzón supere el tope de 200 por captura y `MAX_PAGINAS_CAPTURA`.
//  - H-023-2-4 · el aviso se decide con el reloj de la BD, no con el del proceso.
//  - H-023-2-5 · una fecha ilegible no tumba la captura (DECISIÓN DE PRODUCTO que la spec no fija: se guarda con la fecha de captura
//    y el crítico se avisa; ver el informe de T20).
//  - H-023-2-6 · con el COMMIT hecho y su respuesta perdida, el storage conserva lo que la fila referencia.
//  - H-023-2-7 · el candado vencido de un ciclo muerto se retoma al vencer (CA-1).
//  - H-023-2-8 · un trabajo elevado a interactivo en BD queda con pista interactiva en Redis aunque el programador publique después.
// H-023-2-9 (BD), H-023-2-10 y H-023-2-11 (dominio) están en `tests/aislamiento/buzon-r2.spec.ts` y `packages/domain/src/buzon/`.
import { randomBytes, randomUUID } from "node:crypto";
import {
  bloquearEstadoBuzon,
  elevarPrioridadBuzon,
  trabajoVivoPorClave,
  type ContappDb,
  type Tx,
} from "@contapp/db";
import {
  aPublicable,
  claveDedupe,
  crearClaves,
  publicar,
} from "@contapp/queue";
import type {
  CredencialSol,
  PaginaMensajesSol,
  SolPortal,
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
  AlmacenControlado,
  DIA_MS,
  EscenarioBuzon,
  PortalControlado,
  ProgramacionGuardada,
  avisosBuzon,
  comun,
  encolarAbrir,
  estadoDeCaptura,
  insertarMensajeAdmin,
  mensajeDe,
  mensajesDe,
  trabajosRevisar,
  type MsgPrueba,
  type Mundo,
} from "../../../test/buzon.js";
import {
  asignarResponsable,
  limpiarFilas017,
} from "../../../test/notificaciones.js";
import {
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  restaurarConfig,
} from "../../../test/trabajos.js";
import { abrirMensaje } from "./abrir-mensaje.js";
import { programarBuzon, type ResultadoCicloBuzon } from "./programar-buzon.js";
import { revisarBuzon, type ResultadoRevisarBuzon } from "./revisar-buzon.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 60_000 });

let admin: ContappDb;
let backend: ContappDb;
let worker: ContappDb;
let redis: Redis;
let e: EscenarioBuzon;
let prog: ProgramacionGuardada;
let prefijo = nuevoPrefijo();
const prefijos = [prefijo];
let entornoAnterior: string | undefined;

const CONFIG_SOL = {
  global: 2,
  tenant: 1,
  espera: 0,
  reintentos: 2,
  base: 100,
  maxPendientes: 2000,
};

beforeAll(async () => {
  entornoAnterior = process.env.BUZON_PROGRAMADOR;
  process.env.BUZON_PROGRAMADOR = "off";
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend", 8);
  worker = crearDbRol("contapp_worker", 8);
  redis = conectarRedis();
  prog = new ProgramacionGuardada(admin);
  await prog.guardar();
});

beforeEach(async () => {
  prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
  e = new EscenarioBuzon(admin);
  await fijarConfig(admin, "sol", CONFIG_SOL);
});

afterEach(async () => {
  vi.useRealTimers();
  await limpiarFilas017(admin, e.estudios).catch(() => undefined);
  await e.limpiar();
  await prog.restaurar();
});

afterAll(async () => {
  if (entornoAnterior === undefined) delete process.env.BUZON_PROGRAMADOR;
  else process.env.BUZON_PROGRAMADOR = entornoAnterior;
  await restaurarConfig(admin).catch(() => undefined);
  for (const x of prefijos)
    await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), worker?.close(), admin?.close()]);
});

// ---------------------------------------------------------------------------------------------------------------
// Soporte local
// ---------------------------------------------------------------------------------------------------------------

/** Estudio con suscripción, un Dueño, un contador responsable y un cliente con credencial SOL `configurada`. */
async function mundo(): Promise<Mundo> {
  const T = await e.estudioConSub();
  await e.usuario(T, "dueno");
  const u = await e.usuario(T, "contador");
  const c = await e.clienteBuzon(T);
  await asignarResponsable(admin, T, c.id, u);
  return { T, u, c };
}

/** Servicio de credenciales falso: la credencial descifrada es sintética (el portal es un doble). */
const servicio = {
  descifrarCredencial: async () => ({
    usar: <R>(f: (v: unknown) => R): R =>
      f({ usuario: "usuario-prueba", clave: "clave-prueba" }),
    destruir: () => undefined,
  }),
};

const trabajo = (
  m: Mundo,
  tipo: string,
  parametros: unknown,
  id: string = randomUUID(),
) => ({
  id,
  tenantId: m.T,
  clienteId: m.c.id,
  ruc: m.c.ruc,
  tipo,
  parametros,
  intentos: 0,
  creadoPor: null,
});

/** Una ejecución de `sol.buzon.revisar` (como la haría el ejecutor), con la BD que se le pase. */
async function capturar(
  m: Mundo,
  portal: SolPortal,
  db: ContappDb = worker,
): Promise<ResultadoRevisarBuzon> {
  const proc = revisarBuzon({
    db,
    servicio: servicio as never,
    solPortal: portal,
  });
  return (await proc({
    trabajo: trabajo(m, "sol.buzon.revisar", {}),
    conToken: async (f: (t: string) => Promise<unknown>) => f("t"),
  } as never)) as ResultadoRevisarBuzon;
}

/** Capturas seguidas (cada una como un trabajo nuevo); los errores se tragan, como los vería el ejecutor tras sus reintentos. */
async function capturasSeguidas(
  m: Mundo,
  portal: SolPortal,
  n: number,
): Promise<void> {
  for (let i = 0; i < n; i++) await capturar(m, portal).catch(() => undefined);
}

type ModoCorte = "antes" | "durante" | "despues";

/**
 * BD que se corta en la llamada `n` a `withTenant` (1 = la primera):
 * - antes: la conexión cae antes de abrir la transacción (nada se escribe);
 * - durante: la transacción hace su trabajo y se revierte (el error sale dentro, antes del COMMIT);
 * - despues: el COMMIT se hace y el error llega después (respuesta del COMMIT perdida).
 * Con `muere`, además TODA llamada posterior falla: el proceso murió y ni el `catch` del procesador puede guardar nada.
 */
function dbCortada(
  base: ContappDb,
  n: number,
  modo: ModoCorte,
  muere = false,
): ContappDb {
  let llamadas = 0;
  let muerto = false;
  return new Proxy(base, {
    get(t, p, r) {
      if (p === "withTenant")
        return async (ctx: unknown, fn: (tx: Tx) => Promise<unknown>) => {
          if (muerto) throw new Error("proceso muerto (prueba)");
          llamadas += 1;
          if (llamadas !== n) return t.withTenant(ctx as never, fn as never);
          if (muere) muerto = true;
          if (modo === "antes") throw new Error("conexión perdida (prueba)");
          if (modo === "durante")
            return t.withTenant(ctx as never, async (tx: Tx) => {
              await fn(tx);
              throw new Error("conexión perdida antes del COMMIT (prueba)");
            });
          await t.withTenant(ctx as never, fn as never);
          throw new Error("conexión perdida tras el COMMIT (prueba)");
        };
      const v = Reflect.get(t, p, r);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as ContappDb;
}

/** `n` mensajes con ids `P-0001..` del más reciente al más antiguo (un minuto entre cada uno). */
function serie(n: number, criticosEn: readonly number[] = []): MsgPrueba[] {
  const ahora = Date.now();
  return Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    return {
      idSunat: `P-${String(i).padStart(4, "0")}`,
      asunto: criticosEn.includes(i)
        ? `Resolución de Ejecución Coactiva N° ${i}`
        : `Boletín informativo ${i}`,
      fecha: new Date(ahora - i * 60_000).toISOString(),
    };
  });
}

/** Portal de una sola página fija (el orden es el que se da, sin reordenar por fecha). */
function portalFijo(mensajes: MsgPrueba[]): SolPortal {
  return {
    async listarMensajes(): Promise<PaginaMensajesSol> {
      return {
        mensajes: mensajes.map((m) => ({
          idSunat: m.idSunat,
          asunto: m.asunto,
          remitente: "SUNAT",
          fecha: m.fecha,
          codigoTipo: m.codigoTipo ?? null,
          leidoEnSunat: false,
          adjuntos: [],
        })),
        siguiente: null,
      };
    },
    async obtenerMensaje(): Promise<never> {
      throw new Error("la captura nunca abre (prueba)");
    },
    async obtenerDeclaraciones621(): Promise<never> {
      throw new Error("el buzón no consulta declaraciones (prueba)");
    },
  };
}

/** Solo los estudios de esta prueba entran al ciclo (la BD de pruebas es compartida). */
function soloMisEstudios(base: ContappDb): ContappDb {
  const propios = (tx: Tx): Tx =>
    new Proxy(tx, {
      get(t, p, r) {
        if (p === "query")
          return async (texto: unknown, ...resto: unknown[]) => {
            const res = await (t.query as any)(texto, ...resto);
            if (typeof texto !== "string" || !texto.includes("estudios_buzon"))
              return res;
            const mios = new Set(e.estudios);
            return {
              ...res,
              rows: res.rows.filter((f: any) => mios.has(String(f.tenant_id))),
            };
          };
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  return new Proxy(base, {
    get(t, p, r) {
      if (p === "withSistema")
        return <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
          t.withSistema((tx) => fn(propios(tx)));
      const v = Reflect.get(t, p, r);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as ContappDb;
}

const instancia = (
  db: ContappDb = worker,
): (() => Promise<ResultadoCicloBuzon>) =>
  programarBuzon({ db: soloMisEstudios(db), redis, prefijo });

/** «Revisar ahora» del backend contra una captura viva (D-6): estado FOR UPDATE, viva → elevar, y la pista tras el commit. */
async function revisarAhoraSobreViva(
  T: string,
  u: string,
  clienteId: string,
): Promise<string | null> {
  let vivo: any = null;
  let elevado = false;
  await backend.withTenant({ tenantId: T, userId: u }, async (tx) => {
    await bloquearEstadoBuzon(tx, clienteId);
    vivo = await trabajoVivoPorClave(
      tx,
      claveDedupe("sol.buzon.revisar", clienteId, {}),
    );
    if (vivo !== null)
      elevado = await elevarPrioridadBuzon(tx, vivo.id as string);
  });
  if (vivo !== null && elevado)
    await publicar(redis, [aPublicable(T, vivo, "interactivo")], { prefijo });
  return vivo === null ? null : (vivo.id as string);
}

/** Lo que debe cumplir un buzón tras sus capturas: todos los ids guardados una vez, cada crítico con un aviso y el cliente sincronizado. */
async function revisarCaptura(
  m: Mundo,
  esperados: readonly string[],
  criticos: readonly string[],
): Promise<string | null> {
  const filas = await mensajesDe(admin, m.c.id);
  const ids = new Set(filas.map((f) => f.id_sunat));
  const faltan = esperados.filter((i) => !ids.has(i));
  const sincronizado =
    (await estadoDeCaptura(admin, m.c.id))?.sincronizado_en != null;
  const avisos = await avisosBuzon(admin, m.T, m.c.id);
  const avisados = new Set(avisos.map((a) => a.clave_dedupe)).size;
  if (
    faltan.length === 0 &&
    filas.length === esperados.length &&
    sincronizado &&
    avisos.length === criticos.length &&
    avisados === criticos.length
  )
    return null;
  return `${filas.length} de ${esperados.length} guardados (faltan ${faltan.length}), sincronizado=${sincronizado}, avisos ${avisos.length}/${criticos.length}`;
}

// ---------------------------------------------------------------------------------------------------------------
// H-023-2-1 · corte en cualquier punto
// ---------------------------------------------------------------------------------------------------------------

describe("H-023-2-1 · captura cortada en cualquier punto, con el proceso vivo o muerto (D-9, P-4, CA-3, CA-7)", () => {
  it("tras cualquier corte, dos capturas dejan los 7 mensajes, cada crítico con un solo aviso y el cliente sincronizado", async () => {
    // Siete mensajes: tres comunes de hoy, una coactiva (3 días), dos comunes (5 y 8 días) y una multa (10 días), de lo reciente a
    // lo antiguo. `withTenant` de una captura: 1 credencial y estado, 2 conocidos, 3..9 un mensaje cada uno, 10 estado final.
    const buzon = (): MsgPrueba[] => [
      comun("M-1", 0.001),
      comun("M-2", 0.002),
      comun("M-3", 0.003),
      {
        idSunat: "C-COAC",
        asunto: "Resolución de Ejecución Coactiva N° 0230",
        fecha: new Date(Date.now() - 3 * DIA_MS).toISOString(),
      },
      comun("M-5D", 5),
      comun("M-8D", 8),
      {
        idSunat: "C-RM",
        asunto: "Resolución de Multa N° 012-002-0000456",
        fecha: new Date(Date.now() - 10 * DIA_MS).toISOString(),
      },
    ];
    const ids = buzon().map((x) => x.idSunat);
    const problemas: string[] = [];
    for (const muere of [false, true])
      for (const modo of ["antes", "durante", "despues"] as const)
        for (let n = 1; n <= 10; n++) {
          const m = await mundo();
          const portal = new PortalControlado().buzon(m.c.ruc, buzon());
          await capturar(m, portal, dbCortada(worker, n, modo, muere)).catch(
            () => undefined,
          );
          await capturasSeguidas(m, portal, 2);
          const mal = await revisarCaptura(m, ids, ["C-COAC", "C-RM"]);
          if (mal !== null)
            problemas.push(
              `corte ${modo}${muere ? " (proceso muerto)" : ""} en withTenant ${n}: ${mal}`,
            );
        }
    expect(problemas).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// H-023-2-2 · mensaje nuevo entre páginas
// ---------------------------------------------------------------------------------------------------------------

describe("H-023-2-2 · un mensaje nuevo que llega entre páginas no deja huecos con paginación por desplazamiento (D-1, CA-3)", () => {
  it("con 250 mensajes y uno nuevo entre la página 1 y la 2 (que repite el último de la 1), tres capturas guardan los 251 y sincronizan", async () => {
    const m = await mundo();
    class PortalQueRecibe extends PortalControlado {
      private llego = false;
      override async listarMensajes(
        c: CredencialSol,
        o: { cursor: string | null; limite: number },
      ): Promise<PaginaMensajesSol> {
        const p = await super.listarMensajes(c, o);
        if (!this.llego) {
          this.llego = true;
          this.agregar(c.ruc, [
            {
              idSunat: "NUEVO-1",
              asunto: "Boletín recién llegado",
              fecha: new Date().toISOString(),
            },
          ]);
        }
        return p;
      }
    }
    const portal = new PortalQueRecibe().buzon(m.c.ruc, serie(250, [120, 240]));
    await capturasSeguidas(m, portal, 3);
    const esperados = ["NUEVO-1", ...serie(250).map((x) => x.idSunat)];
    expect(await revisarCaptura(m, esperados, ["P-0120", "P-0240"])).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// H-023-2-3 · buzones grandes
// ---------------------------------------------------------------------------------------------------------------

describe("H-023-2-3 · buzones por encima del tope de 200 por captura y de MAX_PAGINAS_CAPTURA, sea cual sea el tamaño de página (P-5, CA-3)", () => {
  it("251 en páginas de 100, 450 en páginas de 100 y 450 en páginas de 10: cada uno queda completo y sincronizado en 3 capturas", async () => {
    const escenarios = [
      { n: 251, pagina: 100, criticos: [10, 230] },
      { n: 450, pagina: 100, criticos: [10, 230, 445] },
      { n: 450, pagina: 10, criticos: [10, 230, 445] },
    ];
    const problemas: string[] = [];
    for (const s of escenarios) {
      const m = await mundo();
      const portal = new PortalControlado({ pagina: s.pagina }).buzon(
        m.c.ruc,
        serie(s.n, s.criticos),
      );
      await capturasSeguidas(m, portal, 3);
      const mal = await revisarCaptura(
        m,
        serie(s.n).map((x) => x.idSunat),
        s.criticos.map((i) => `P-${String(i).padStart(4, "0")}`),
      );
      if (mal !== null)
        problemas.push(`${s.n} mensajes en páginas de ${s.pagina}: ${mal}`);
    }
    expect(problemas).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// H-023-2-4 · reloj de la BD
// ---------------------------------------------------------------------------------------------------------------

describe("H-023-2-4 · la decisión de avisar usa el reloj de la BD, no el del proceso (P-5, CA-6)", () => {
  /** Captura con el reloj del proceso corrido `desfaseMs` respecto del de la BD. */
  async function conReloj(
    desfaseMs: number,
    m: Mundo,
    portal: SolPortal,
  ): Promise<{ r?: ResultadoRevisarBuzon; error?: unknown }> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + desfaseMs);
    try {
      return { r: await capturar(m, portal) };
    } catch (error) {
      return { error };
    } finally {
      vi.useRealTimers();
    }
  }

  it("con el reloj del worker 2 h adelantado, la coactiva de hace casi 30 días se guarda con su aviso; con 2 h atrasado, la de hace 30 días y 1 h no se avisa", async () => {
    const problemas: string[] = [];
    // Para la BD, la coactiva tiene 29 días y 23 h (dentro de los 30 de la primera sincronización): hay que avisarla.
    const adelantado = await mundo();
    const real = Date.now();
    const portalA = new PortalControlado().buzon(adelantado.c.ruc, [
      comun("N-1", 0.001),
      {
        idSunat: "C-BORDE",
        asunto: "Resolución de Ejecución Coactiva N° 0230",
        fecha: new Date(real - 30 * DIA_MS + 60 * 60_000).toISOString(),
      },
      comun("N-2", 31),
    ]);
    const a = await conReloj(2 * 60 * 60_000, adelantado, portalA);
    if (a.error !== undefined)
      problemas.push("reloj +2 h: la captura falló (no debe fallar)");
    const borde = await mensajeDe(admin, adelantado.c.id, "C-BORDE");
    if (borde?.avisado !== true)
      problemas.push("reloj +2 h: la coactiva no quedó guardada con aviso");
    if ((await avisosBuzon(admin, adelantado.T, adelantado.c.id)).length !== 1)
      problemas.push("reloj +2 h: no hay exactamente un aviso");

    // Para la BD, la coactiva tiene 30 días y 1 h (fuera de la ventana): una primera sincronización no la avisa.
    const atrasado = await mundo();
    const portalB = new PortalControlado().buzon(atrasado.c.ruc, [
      comun("N-1", 0.001),
      {
        idSunat: "C-VIEJA",
        asunto: "Resolución de Ejecución Coactiva N° 0231",
        fecha: new Date(real - 30 * DIA_MS - 60 * 60_000).toISOString(),
      },
    ]);
    const b = await conReloj(-2 * 60 * 60_000, atrasado, portalB);
    if (b.error !== undefined)
      problemas.push("reloj −2 h: la captura falló (no debe fallar)");
    const vieja = await mensajeDe(admin, atrasado.c.id, "C-VIEJA");
    if (vieja === undefined || vieja.avisado !== false)
      problemas.push("reloj −2 h: la coactiva de más de 30 días se avisó");
    if ((await avisosBuzon(admin, atrasado.T, atrasado.c.id)).length !== 0)
      problemas.push(
        "reloj −2 h: hay avisos de una coactiva fuera de la ventana",
      );
    expect(problemas).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// H-023-2-5 · fecha ilegible
// ---------------------------------------------------------------------------------------------------------------

describe("H-023-2-5 · una fecha ilegible del portal no tumba la captura (D-1, D-9, CA-3, CA-6)", () => {
  // DECISIÓN DE PRODUCTO no resuelta por la spec (D-1, D-9 no dicen qué hacer con un mensaje sin fecha utilizable): se fija
  // «guardar con la fecha de la captura, crítico si el asunto lo indica y avisado». El descarte con registro sin datos es la otra
  // opción posible; el orquestador debe ratificar o cambiar esta antes de T21.
  it("dd/mm/aaaa, texto libre y un año fuera del rango de la BD se guardan con la fecha de captura; la coactiva sin fecha y la de detrás se avisan", async () => {
    const m = await mundo();
    const portal = portalFijo([
      comun("N-1", 0.001),
      { idSunat: "X-FECHA", asunto: "Boletín", fecha: "17/11/2026 10:00" },
      {
        idSunat: "X-COAC",
        asunto: "Resolución de Ejecución Coactiva N° 0999",
        fecha: "ayer a las 10",
      },
      {
        idSunat: "X-FUERA",
        asunto: "Boletín de otro año",
        fecha: "-100000-01-01T00:00:00.000Z",
      },
      {
        idSunat: "C-COAC",
        asunto: "Resolución de Ejecución Coactiva N° 0230",
        fecha: new Date(Date.now() - 2 * DIA_MS).toISOString(),
      },
      comun("N-LAST", 40),
    ]);
    const antes = Date.now();
    const primera = await capturar(m, portal).then(
      () => null,
      (err) => err as Error,
    );
    const despues = Date.now();
    expect(primera, "la captura no debe fallar por una fecha").toBeNull();
    await capturasSeguidas(m, portal, 1);

    const filas = await mensajesDe(admin, m.c.id);
    expect(filas.map((f) => f.id_sunat).sort()).toEqual(
      ["C-COAC", "N-1", "N-LAST", "X-COAC", "X-FECHA", "X-FUERA"].sort(),
    );
    for (const id of ["X-FECHA", "X-COAC", "X-FUERA"]) {
      const f = (
        await admin.pool.query(
          "select fecha from buzon_mensaje where cliente_id = $1 and id_sunat = $2",
          [m.c.id, id],
        )
      ).rows[0];
      const t = new Date(f.fecha).getTime();
      expect(t, `${id}: fecha de captura`).toBeGreaterThanOrEqual(
        antes - 60_000,
      );
      expect(t, `${id}: fecha de captura`).toBeLessThanOrEqual(
        despues + 60_000,
      );
    }
    expect((await mensajeDe(admin, m.c.id, "X-COAC"))?.critico).toBe(true);
    expect((await mensajeDe(admin, m.c.id, "X-COAC"))?.avisado).toBe(true);
    expect((await mensajeDe(admin, m.c.id, "C-COAC"))?.avisado).toBe(true);
    expect(await avisosBuzon(admin, m.T, m.c.id)).toHaveLength(2);
    expect(
      (await estadoDeCaptura(admin, m.c.id))?.sincronizado_en,
    ).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// H-023-2-6 · COMMIT hecho y respuesta perdida
// ---------------------------------------------------------------------------------------------------------------

describe("H-023-2-6 · apertura con el COMMIT hecho y la respuesta perdida no borra lo que la fila referencia (D-3, D-4, CA-4, CA-8)", () => {
  it("el contenido y el adjunto que la fila referencia siguen legibles en el storage, también tras el reintento", async () => {
    const m = await mundo();
    const mensajeId = await insertarMensajeAdmin(admin, m.T, m.c.id, {
      idSunat: "AB-1",
      adjuntosDeclarados: 1,
    });
    const bytes = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(800)]);
    const portal = new PortalControlado().buzon(m.c.ruc, [
      comun("AB-1", 1, {
        contenido: { formato: "texto", cuerpo: "Cuerpo del mensaje" },
        adjuntos: [{ idSunat: "A1", nombre: "a.pdf" }],
        adjuntosBytes: [{ idSunat: "A1", nombre: "a.pdf", bytes }],
      }),
    ]);
    const almacen = new AlmacenControlado();
    // Un trabajo real: la auditoría `buzon.contenido_obtenido` (0056) lleva el trabajo del contexto como actor.
    const { id: trabajoId } = await encolarAbrir(
      backend,
      redis,
      prefijo,
      m,
      mensajeId,
    );
    const proc = (db: ContappDb) =>
      abrirMensaje({
        db,
        servicio: servicio as never,
        solPortal: portal,
        storage: almacen,
      })({
        trabajo: trabajo(m, "sol.buzon.abrir", { mensajeId }, trabajoId),
        conToken: async (f: (t: string) => Promise<unknown>) => f("t"),
      } as never);
    // withTenant: 1 lectura del mensaje, 2 la transacción del contenido y los adjuntos (se confirma y la respuesta se pierde).
    await expect(proc(dbCortada(worker, 2, "despues"))).rejects.toThrow();
    await proc(worker).catch(() => undefined); // el reintento del ejecutor

    const fila = await mensajeDe(admin, m.c.id, "AB-1");
    const adj = (
      await admin.pool.query(
        "select ruta, sha256 from buzon_adjunto where mensaje_id = $1 and ruta is not null",
        [mensajeId],
      )
    ).rows as { ruta: string; sha256: Buffer }[];
    // La BD confirmó: el contenido «ya se obtuvo» (y el mensaje quedó leído en SUNAT), así que sus archivos tienen que existir.
    expect(fila?.contenido_ruta).toEqual(expect.any(String));
    expect(adj).toHaveLength(1);
    const referenciadas = [fila!.contenido_ruta as string, adj[0]!.ruta];
    expect(
      referenciadas.filter((r) => !almacen.rutas().includes(r)),
      "rutas de la fila que ya no están en el storage",
    ).toEqual([]);
    const cuerpo = await almacen.leer(referenciadas[0]!);
    expect(Buffer.from(cuerpo).toString("utf8")).toBe("Cuerpo del mensaje");
    const guardado = await almacen.leer(referenciadas[1]!);
    expect(Buffer.from(guardado).equals(bytes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// H-023-2-7 · candado vencido de un ciclo muerto
// ---------------------------------------------------------------------------------------------------------------

describe("H-023-2-7 · un ciclo muerto se retoma al vencer su candado, sin esperar el intervalo (D-5, CA-1)", () => {
  it("candado vencido hace 1 s de un ciclo que empezó hace 6 min (intervalo 15): uno de tres workers lo toma y encola el cliente", async () => {
    const S = await e.estudioConSub();
    const c = await e.clienteBuzon(S);
    await admin.pool.query(
      `update buzon_programacion set intervalo_min = 15, ciclo_dueno = 'worker-muerto',
              ciclo_hasta = clock_timestamp() - interval '1 second',
              ultimo_ciclo_inicio = clock_timestamp() - interval '6 minutes'`,
    );
    const rs = await Promise.all(
      [instancia(), instancia(), instancia()].map((f) => f()),
    );
    expect(rs.filter((r) => r.tomado)).toHaveLength(1);
    expect(await trabajosRevisar(admin, { clienteId: c.id })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// H-023-2-8 · «Revisar ahora» entre el commit del programador y su pista
// ---------------------------------------------------------------------------------------------------------------

describe("H-023-2-8 · un trabajo elevado a interactivo en BD sale antes que las programadas aunque el programador publique después (D-6, CA-2)", () => {
  it("con 50 pedidos entre el commit y la pista, el trabajo es interactivo y está primero en Redis, delante de uno programado más antiguo", async () => {
    const S = await e.estudioConSub();
    const u = await e.usuario(S, "contador");
    const antiguo = await e.clienteBuzon(S);
    await prog.listoParaTomar(15);
    // Un trabajo programado más antiguo, ya publicado.
    expect((await instancia()()).encolados).toBe(1);
    const c = await e.clienteBuzon(S);
    await prog.listoParaTomar(15);

    const devueltos: (string | null)[] = [];
    const enElHueco = new Proxy(worker, {
      get(t, p, r) {
        if (p === "withTenant")
          return async (...args: unknown[]) => {
            const v = await (t.withTenant as any)(...args);
            devueltos.push(
              ...(await Promise.all(
                Array.from({ length: 50 }, () =>
                  revisarAhoraSobreViva(S, u, c.id),
                ),
              )),
            );
            return v;
          };
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as ContappDb;
    expect((await instancia(enElHueco)()).encolados).toBe(1);

    const ts = await trabajosRevisar(admin, { clienteId: c.id });
    expect(ts).toHaveLength(1);
    const t = ts[0]!;
    const viejo = (await trabajosRevisar(admin, { clienteId: antiguo.id }))[0]!;
    expect(new Set(devueltos)).toEqual(new Set([t.id]));
    expect(t.prioridad).toBe("interactivo");
    expect(viejo.prioridad).toBe("programado");
    const orden = await redis.zrange(
      crearClaves(prefijo).pend("sol", S),
      "0",
      "-1",
    );
    expect(orden).toContain(viejo.id);
    expect(orden[0], "el interactivo sale primero").toBe(t.id);
  });
});
