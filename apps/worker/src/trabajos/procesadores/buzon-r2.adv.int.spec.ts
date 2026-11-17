/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD dinámicas y dobles mínimos en pruebas */
// Spec 023 · T19 · ronda adversarial 2 (worker y BD; integración con PostgreSQL y Redis reales, el doble `PortalControlado` y un
// storage en memoria). Los procesadores se llaman directo (sin BullMQ) para cortar la captura y la apertura en el punto exacto.
// Caja negra (spec, plan): programador con tres workers, relojes de proceso desfasados y el que muere con el candado; tope y
// reserva con un estudio de 720 clientes y otro de 1; «Revisar ahora» contra el programador; captura cortada antes, durante y
// después del commit de un mensaje; `ErrorCredencial` en cada página; aviso de la primera sincronización en el borde de 30 días.
// Caja blanca: `revisar-buzon.ts` (el primer conocido termina la captura salvo `cursor_pendiente`, que solo se guarda en el
// `catch` y con `paginas > 0`; `ahora: new Date()` del proceso), `planificarCaptura` (`MAX_PAGINAS_CAPTURA` también en el
// relleno), `abrir-mensaje.ts` (borra lo escrito si `withTenant` lanza, aunque el COMMIT ya se hiciera), `programar-buzon.ts`
// (pista `programado` publicada tras el commit, sin mirar la prioridad actual), 0055 (`buzon_ciclo_tomar` exige el intervalo
// aunque el candado haya vencido) y 0054/0056 (la BD solo mira `critico`, no la categoría).
// Hallazgos H-023-2-n: marcados con `it.fails`.
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
import {
  ErrorCredencial,
  type CredencialSol,
  type PaginaMensajesSol,
  type SolPortal,
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
  comunes,
  encolarAbrir,
  encolarRevisar,
  estadoDeCaptura,
  insertarMensajeAdmin,
  mensajeDe,
  mensajesDe,
  terminarTrabajosBuzon,
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

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

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
 */
function dbCortada(base: ContappDb, n: number, modo: ModoCorte): ContappDb {
  let llamadas = 0;
  return new Proxy(base, {
    get(t, p, r) {
      if (p === "withTenant")
        return async (ctx: unknown, fn: (tx: Tx) => Promise<unknown>) => {
          llamadas += 1;
          if (llamadas !== n) return t.withTenant(ctx as never, fn as never);
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

// ---------------------------------------------------------------------------------------------------------------
// Captura cortada (D-9, P-4, CA-3, CA-7)
// ---------------------------------------------------------------------------------------------------------------

describe("H-023-2-1 · captura cortada antes, durante y después del commit de un mensaje (D-9, CA-3, CA-7)", () => {
  // Alta. `revisar-buzon.ts`: el `cursor_pendiente` solo se guarda en el `catch` y solo con `paginas > 0`; un corte en la
  // primera página (o la muerte del proceso en cualquiera) no deja relleno, y la captura siguiente termina en el primer
  // conocido (`planificarCaptura` sin `cursorPendiente`). Lo que venía detrás del mensaje cortado, incluida una coactiva,
  // no se captura nunca y nadie se entera.
  it.fails(
    "tras el corte, la captura siguiente guarda todo el buzón y avisa la coactiva que estaba detrás",
    async () => {
      const faltan: string[] = [];
      for (const modo of ["antes", "durante", "despues"] as const) {
        const m = await mundo();
        const portal = new PortalControlado().buzon(m.c.ruc, [
          ...comunes(6),
          {
            idSunat: "C-COAC",
            asunto: "Resolución de Ejecución Coactiva N° 0230",
            fecha: new Date(Date.now() - 3 * DIA_MS).toISOString(),
          },
        ]);
        // withTenant: 1 credencial/estado, 2 conocidos, 3 y 4 los dos más recientes, 5 el tercero.
        await expect(
          capturar(m, portal, dbCortada(worker, 5, modo)),
        ).rejects.toThrow();
        await capturar(m, portal);
        const filas = await mensajesDe(admin, m.c.id);
        const coac = filas.find((f) => f.id_sunat === "C-COAC");
        if (filas.length !== 7 || !coac?.avisado)
          faltan.push(
            `${modo}: ${filas.length} de 7, coactiva ${coac ? "sin aviso" : "ausente"}`,
          );
      }
      expect(faltan).toEqual([]);
    },
  );
});

describe("H-023-2-2 · un mensaje nuevo que llega durante la captura corre la paginación (D-1, CA-3)", () => {
  // Alta. Si entra un mensaje mientras se pagina (cursor por desplazamiento, el del mock), el último de la página 1 reaparece
  // como primero de la 2: ya es «conocido» (lo guardó ESTA captura) y, sin relleno, termina la captura sin cursor pendiente.
  // Las siguientes paran en el primer conocido: el resto del buzón no se captura nunca.
  it.fails(
    "con 250 mensajes y uno nuevo entre la página 1 y la 2, cuatro capturas los guardan todos",
    async () => {
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
      const portal = new PortalQueRecibe().buzon(m.c.ruc, serie(250));
      await capturasSeguidas(m, portal, 4);
      expect((await mensajesDe(admin, m.c.id)).length).toBe(251);
    },
  );
});

describe("H-023-2-3 · un portal con páginas de menos de 10 mensajes nunca termina la primera sincronización (P-5, CA-3)", () => {
  // Alta. `MAX_PAGINAS_CAPTURA = 20` también cuenta las páginas de relleno ya conocidas: con páginas de 10, la primera captura
  // guarda 200 y deja el cursor en la 21; la siguiente relee 20 páginas conocidas, corta en la misma y vuelve a guardar el
  // mismo cursor. El tamaño de página es del portal (D-1), no del worker: con SUNAT real el buzón queda a medias para siempre
  // y el cliente nunca pasa a sincronizado (los críticos antiguos que falten no se ven y los nuevos se avisan con la regla de
  // 30 días).
  it.fails(
    "con 450 mensajes en páginas de 10, cinco capturas guardan los 450 y el cliente queda sincronizado",
    async () => {
      const m = await mundo();
      const portal = new PortalControlado({ pagina: 10 }).buzon(
        m.c.ruc,
        serie(450),
      );
      await capturasSeguidas(m, portal, 5);
      expect((await mensajesDe(admin, m.c.id)).length).toBe(450);
      expect(
        (await estadoDeCaptura(admin, m.c.id))?.sincronizado_en,
      ).not.toBeNull();
    },
  );
});

describe("H-023-2-4 · reloj del proceso adelantado y el borde de 30 días de la primera sincronización (P-5, CA-6)", () => {
  // Media. `revisar-buzon.ts` decide `avisado` con `new Date()` del proceso y el trigger de 0056 lo exige con
  // `clock_timestamp()` de la BD. Con el reloj del worker 2 h adelantado, una coactiva de hace 29 días y 23 h (para la BD)
  // sale «sin aviso» y la BD la rechaza (42501): la captura entera falla, se reintenta y vuelve a fallar hasta que pasen las
  // 2 h; y entonces H-023-2-1 deja todo lo de detrás sin capturar. El plan pide que el tiempo salga de la BD.
  it.fails(
    "con el reloj del worker 2 h adelantado, la coactiva en el borde se guarda y se avisa, y la captura termina",
    async () => {
      const m = await mundo();
      const real = Date.now();
      const portal = new PortalControlado().buzon(m.c.ruc, [
        comun("N-1", 0.001),
        {
          idSunat: "C-BORDE",
          asunto: "Resolución de Ejecución Coactiva N° 0230",
          fecha: new Date(real - 30 * DIA_MS + 60 * 60_000).toISOString(),
        },
        comun("N-2", 31),
      ]);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(real + 2 * 60 * 60_000);
      const r = await capturar(m, portal).finally(() => vi.useRealTimers());
      expect(r.nuevos).toBe(3);
      expect((await mensajeDe(admin, m.c.id, "C-BORDE"))?.avisado).toBe(true);
      expect(await avisosBuzon(admin, m.T, m.c.id)).toHaveLength(1);
    },
  );
});

describe("H-023-2-5 · fecha ilegible en el listado (D-1, D-9, CA-3, CA-6)", () => {
  // Alta. `sanearPagina` (H-023-1-4) limpia textos e ids pero no valida `fecha`: `new Date("17/11/2026 10:00")` es Invalid Date,
  // el INSERT falla (22007/22008) y tumba la captura en ese mensaje. Como en H-023-2-1, la siguiente para en el primer conocido:
  // la coactiva de detrás no se guarda ni se avisa nunca, captura tras captura.
  it.fails(
    "un mensaje con fecha en formato dd/mm/aaaa no deja sin capturar ni sin aviso la coactiva que viene detrás",
    async () => {
      const m = await mundo();
      const portal = portalFijo([
        comun("N-1", 0.001),
        { idSunat: "X-FECHA", asunto: "Boletín", fecha: "17/11/2026 10:00" },
        {
          idSunat: "C-COAC",
          asunto: "Resolución de Ejecución Coactiva N° 0230",
          fecha: new Date(Date.now() - 2 * DIA_MS).toISOString(),
        },
      ]);
      await capturasSeguidas(m, portal, 3);
      const coac = await mensajeDe(admin, m.c.id, "C-COAC");
      expect(coac?.avisado).toBe(true);
    },
  );
});

describe("CA-7 · ErrorCredencial en cada página (P-4)", () => {
  it("cortada en la página 1, 2 o 3, la captura con la clave corregida deja todo una vez y cada crítico con un aviso", async () => {
    for (const k of [1, 2, 3]) {
      const m = await mundo();
      // Páginas de 60: las tres primeras caben en la primera captura (tope de 200 nuevos).
      const portal = new PortalControlado({ pagina: 60 }).buzon(
        m.c.ruc,
        serie(253, [50, 150, 240]),
      );
      portal.fallar("credencial", { despuesDe: k - 1, veces: 1 });
      await expect(capturar(m, portal)).rejects.toBeInstanceOf(ErrorCredencial);
      const guardadosAntes = (await mensajesDe(admin, m.c.id)).length;
      expect(guardadosAntes, `página ${k}`).toBe((k - 1) * 60);
      // Con la clave corregida: dos capturas (tope de 200 nuevos por captura, P-5), sin errores.
      await capturar(m, portal);
      await capturar(m, portal);
      const filas = await mensajesDe(admin, m.c.id);
      expect(filas.length, `página ${k}`).toBe(253);
      expect(new Set(filas.map((f) => f.id_sunat)).size).toBe(253);
      const avisos = await avisosBuzon(admin, m.T, m.c.id);
      expect(avisos, `página ${k}`).toHaveLength(3);
      expect(new Set(avisos.map((a) => a.clave_dedupe)).size).toBe(3);
      expect(
        (await estadoDeCaptura(admin, m.c.id))?.sincronizado_en,
      ).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Apertura cortada entre storage y commit (D-4, P-1, CA-4, CA-8)
// ---------------------------------------------------------------------------------------------------------------

describe("H-023-2-6 · apertura con el COMMIT hecho y la respuesta perdida (D-3, D-4, CA-4, CA-8)", () => {
  // Media. `abrir-mensaje.ts` borra todo lo escrito en storage si `withTenant` lanza, sin saber si el COMMIT se hizo. Si la
  // conexión cae tras el COMMIT, la fila queda con `contenido_ruta` y el adjunto apuntando a archivos borrados; como el contenido
  // «ya se obtuvo», un nuevo «Abrir» termina sin llamar al portal y el contenido (ya marcado como leído en SUNAT) no se puede
  // leer nunca más.
  it.fails(
    "si la BD confirmó, el contenido y el adjunto siguen en storage",
    async () => {
      const m = await mundo();
      const mensajeId = await insertarMensajeAdmin(admin, m.T, m.c.id, {
        idSunat: "AB-1",
        adjuntosDeclarados: 1,
      });
      const bytes = Buffer.concat([
        Buffer.from("%PDF-1.7\n"),
        randomBytes(800),
      ]);
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
      // withTenant: 1 lectura del mensaje, 2 la transacción del contenido y los adjuntos.
      await expect(proc(dbCortada(worker, 2, "despues"))).rejects.toThrow();
      await proc(worker); // el reintento del ejecutor
      const fila = await mensajeDe(admin, m.c.id, "AB-1");
      const adj = await admin.pool.query(
        "select ruta from buzon_adjunto where mensaje_id = $1 and ruta is not null",
        [mensajeId],
      );
      const rutas = [fila?.contenido_ruta, ...adj.rows.map((f: any) => f.ruta)];
      expect(rutas.every((x) => typeof x === "string")).toBe(true);
      expect(
        rutas.filter((x) => !almacen.rutas().includes(x as string)),
      ).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// Programador (D-5, CA-1, CA-2, CA-11)
// ---------------------------------------------------------------------------------------------------------------

describe("H-023-2-7 · el worker muere con el candado a mitad de un ciclo (D-5, CA-1)", () => {
  // Baja. `buzon_ciclo_tomar` (0055) exige el candado vencido Y el intervalo cumplido desde el INICIO del ciclo muerto. Con el
  // intervalo de 15 min y el candado de 5, si el dueño muere tras el primer estudio nadie retoma el ciclo al vencer el candado
  // (CA-1: «otro lo toma al vencer el candado») sino 10 min después: los estudios que faltaban esperan un intervalo entero.
  it.fails(
    "candado vencido hace 1 s de un ciclo que empezó hace 6 min: uno de tres workers lo toma y encola",
    async () => {
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
    },
  );
});

describe("CA-1 · tres workers con ticks simultáneos y relojes de proceso desfasados", () => {
  it("el reloj del proceso (+26 h, −26 h, +7 min) no cambia quién toma el ciclo ni qué franja venció: manda la BD", async () => {
    const S = await e.estudioConSub(); // plan de 1440 min
    const reciente = await e.clienteBuzon(S);
    const nunca = await e.clienteBuzon(S);
    await admin.pool.query(
      `insert into buzon_estado_cliente (tenant_id, cliente_id) values ($1, $2)`,
      [S, reciente.id],
    );
    await admin.pool.query(
      "update buzon_estado_cliente set ultima_programada_en = clock_timestamp() - interval '1 minute' where cliente_id = $1",
      [reciente.id],
    );
    const real = Date.now();
    const esperados = [1, 0, 0];
    const desfases = [26 * 3_600_000, -26 * 3_600_000, 7 * 60_000];
    for (const [i, d] of desfases.entries()) {
      await terminarTrabajosBuzon(admin, [S]);
      await prog.listoParaTomar(15);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(real + d);
      const ciclos = [instancia(), instancia(), instancia()];
      const rs = await Promise.all(ciclos.map((f) => f())).finally(() =>
        vi.useRealTimers(),
      );
      expect(
        rs.filter((r) => r.tomado),
        `desfase ${d}`,
      ).toHaveLength(1);
      expect(
        rs.reduce((n, r) => n + r.encolados, 0),
        `desfase ${d}`,
      ).toBe(esperados[i]);
      // Otro tick con el intervalo sin cumplir: nadie.
      const otra = await Promise.all(ciclos.map((f) => f()));
      expect(otra.filter((r) => r.tomado)).toHaveLength(0);
    }
    expect(
      await trabajosRevisar(admin, { clienteId: reciente.id }),
    ).toHaveLength(0);
    expect(await trabajosRevisar(admin, { clienteId: nunca.id })).toHaveLength(
      1,
    );
  });
});

describe("CA-2 · cola al tope: un estudio de 720 clientes, otro de 1 y «Revisar ahora» con la reserva", () => {
  it("el programador deja la reserva libre, 50 interactivos caben, el 51 no, y el ciclo siguiente no encola más", async () => {
    await fijarConfig(admin, "sol", { ...CONFIG_SOL, maxPendientes: 150 });
    const grande = await e.estudioConSub();
    const u = await e.usuario(grande, "contador");
    const ids = await e.clientesMasivos(grande, 720);
    const chico = await e.estudioConSub();
    const uno = await e.clienteBuzon(chico);
    await prog.listoParaTomar(15);
    const r = await instancia()();
    expect(r.encolados).toBe(101);
    expect(await trabajosRevisar(admin, { clienteId: uno.id })).toHaveLength(1);

    const enCola = new Set(
      (await trabajosRevisar(admin, { tenantId: grande })).map(
        (t) => t.cliente_id,
      ),
    );
    expect(enCola.size).toBe(100);
    const libres = ids.filter((id) => !enCola.has(id));
    const interactivos = await Promise.allSettled(
      libres.slice(0, 51).map((id) =>
        encolarRevisar(backend, redis, prefijo, {
          T: grande,
          u,
          c: { id, ruc: "20000000001" },
        }),
      ),
    );
    expect(interactivos.filter((x) => x.status === "fulfilled")).toHaveLength(
      50,
    );
    expect(interactivos.filter((x) => x.status === "rejected")).toHaveLength(1);

    await prog.listoParaTomar(15);
    expect((await instancia()()).encolados).toBe(0);
    const vivos = await admin.pool.query(
      "select count(*)::int as n from job_registro where tenant_id = $1 and cola = 'sol' and estado = 'en_cola'",
      [grande],
    );
    expect(vivos.rows[0].n).toBe(150);
  });
});

describe("H-023-2-8 · «Revisar ahora» entre el commit del programador y su pista (D-6, CA-2)", () => {
  // Media. `programar-buzon.ts` publica la pista con prioridad `programado` fija DESPUÉS del commit. Si en ese hueco llega
  // «Revisar ahora» (50 pedidos), el backend eleva el trabajo a `interactivo` y publica su pista; luego el programador la pisa
  // con el puntaje de programado (ZADD sin condición). La BD dice interactivo pero el despachador lo ordena detrás de todas
  // las programadas del estudio (CA-2: «sale antes que todas ellas»), y el reconciliador no corrige pistas existentes.
  it.fails(
    "con 50 pedidos en el hueco, queda un trabajo interactivo y su pista en Redis tiene puntaje interactivo",
    async () => {
      const S = await e.estudioConSub();
      const u = await e.usuario(S, "contador");
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
      expect(new Set(devueltos)).toEqual(new Set([t.id]));
      expect(t.prioridad).toBe("interactivo");
      const puntaje = Number(
        await redis.zscore(crearClaves(prefijo).pend("sol", S), t.id),
      );
      expect(puntaje).toBeLessThan(1e13);
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// La BD frente a un worker que silencia un crítico (0054, 0056, CA-6)
// ---------------------------------------------------------------------------------------------------------------

describe("H-023-2-9 · el worker guarda una coactiva reciente como no crítica y sin aviso (CA-6, D-7, plan «la BD lo exige»)", () => {
  // Media. El trigger `buzon_mensaje_aviso_obligatorio` (0056) y el CHECK `avisado -> critico` (0054) solo miran la columna
  // `critico`: nada ata `categoria` (o `motivo_critico`) con `critico`. Un worker con un error o comprometido inserta
  // `categoria = 'coactiva'`, `critico = false`, `avisado = false` de hoy y la BD lo acepta sin notificación; reclasificar
  // después no avisa (D-7).
  it.fails(
    "la BD rechaza una categoría crítica con critico = false, o un motivo sin crítico",
    async () => {
      const m = await mundo();
      const insertar = (categoria: string, motivo: string | null) =>
        worker.withTenant({ tenantId: m.T, trabajoId: randomUUID() }, (tx) =>
          tx.query(
            `insert into buzon_mensaje (cliente_id, id_sunat, asunto, remitente, fecha, codigo_tipo, categoria, critico,
                                        motivo_critico, version_catalogo, avisado, leido_sunat, adjuntos_declarados)
             values ($1, $2, 'Aviso', 'SUNAT', now(), 'REC', $3, false, $4, 1, false, false, 0)`,
            [m.c.id, `S-${randomBytes(4).toString("hex")}`, categoria, motivo],
          ),
        );
      const aceptadas: string[] = [];
      for (const [cat, mot] of [
        ["coactiva", null],
        ["resolucion_multa", null],
        ["otro", "codigo"],
      ] as const) {
        const ok = await insertar(cat, mot).then(
          () => true,
          () => false,
        );
        if (ok) aceptadas.push(`${cat}/${mot}`);
      }
      expect(aceptadas).toEqual([]);
      expect(await avisosBuzon(admin, m.T, m.c.id)).toHaveLength(0);
    },
  );
});
