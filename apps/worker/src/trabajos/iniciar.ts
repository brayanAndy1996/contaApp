// Ensamblado del worker de trabajos (spec 008, plan "Worker"): despachador (líder por cola), reconciliador, un Worker
// BullMQ por cola de `config_sistema` (concurrency = concurrencia global, ajustada en caliente, CA-4), el ejecutor y el
// worker de trabajos de sistema (`kek.rotar`, `auth.purgar` repetible a las 03:30 de Lima; D10, sin job_registro).
// `detener`: cierre ordenado (deja de despachar y de tomar trabajos, espera a los en curso hasta `esperaMs`, libera
// arriendos). `abortar`: muerte del proceso (kill -9): desde ese instante no escribe en la BD ni emite comandos por el
// Redis recibido, no libera arriendos y abandona lo que está en curso.
import { CorreoConsola, type Correo } from "@contapp/correo";
import type { KeyUnwrapper, KeyWrapper } from "@contapp/crypto/descifrado";
import { leerConfig, type ContappDb } from "@contapp/db";
import {
  CacheConfig,
  Despachador,
  LATIDO_MS,
  PREFIJO_POR_DEFECTO,
  Reconciliador,
  type NombreCola,
  type Reloj,
} from "@contapp/queue";
import {
  crearColas,
  crearColaSistema,
  crearWorkerSistema,
  crearWorkers,
  type ConexionBull,
  type PayloadSistema,
} from "@contapp/queue/worker";
import { crearStorage, type StorageProvider } from "@contapp/storage";
import {
  MockConsultaRuc,
  MockSireApiClient,
  MockSireAuth,
  MockSolAuth,
  MockSolPortal,
  MockXmlProvider,
  type ConsultaRuc,
  type SireApiClient,
  type SireAuth,
  type SolAuth,
  type SolPortal,
  type XmlProvider,
} from "@contapp/sunat";
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { crearServicioCredenciales } from "../credenciales/descifrar-credencial.js";
import { Ejecutor, type Procesador } from "./ejecutor.js";
import { dbGuardada, redisGuardado } from "./guardia.js";
import { NotificadorEventos } from "./notificador.js";
import { abrirMensaje } from "./procesadores/abrir-mensaje.js";
import { authPurgar } from "./procesadores/auth-purgar.js";
import { consultarRuc } from "./procesadores/consultar-ruc.js";
import { descargarPropuesta } from "./procesadores/descargar-propuesta.js";
import { enviarCorreo } from "./procesadores/enviar-correo.js";
import { generarArchivo } from "./procesadores/generar-archivo.js";
import { importarHistorial } from "./procesadores/importar-historial.js";
import { kekRotar } from "./procesadores/kek-rotar.js";
import { obtenerDeclaraciones } from "./procesadores/obtener-declaraciones.js";
import { obtenerXml } from "./procesadores/obtener-xml.js";
import { programarBuzon } from "./procesadores/programar-buzon.js";
import { programarCorreo } from "./procesadores/programar-correo.js";
import { reevaluarPeriodo } from "./procesadores/reevaluar-periodo.js";
import { revisarBuzon } from "./procesadores/revisar-buzon.js";
import {
  verificarSire,
  verificarSol,
} from "./procesadores/verificar-credencial.js";
import {
  loggerConsola,
  registrar,
  type LoggerTrabajos,
  type Notificador,
} from "./registro.js";
import {
  CacheTokenSire,
  type CredencialesSire,
} from "./token-sire/cache-token.js";
import { crearCredencialesSire } from "./token-sire/credenciales-sire.js";

export interface IntervalosTrabajos {
  despachadorMs?: number;
  reconciliadorMs?: number;
  latidoMs?: number;
}

export interface LlavesKek {
  activa: KeyUnwrapper & KeyWrapper;
  anterior(desde: string): KeyUnwrapper;
}

export interface DepsTrabajos {
  /** Rol contapp_worker (withTenant y withSistema). */
  db: ContappDb;
  redis: Redis;
  conexionBull: ConexionBull;
  prefijo?: string;
  reloj?: Reloj;
  /** Se suman a los por defecto (solo `prueba.eco` con NODE_ENV=test). */
  procesadores?: Record<string, Procesador>;
  notificador?: Notificador;
  /** Puerto de `credencial.verificar_sire` (directo, sin la caché de token) y del token SIRE; por defecto el mock. */
  sireAuth?: SireAuth;
  /** Puerto de `sire.propuesta.descargar` (013); por defecto el mock. */
  sireApi?: SireApiClient;
  /** Puerto de `cliente.consultar_ruc`; por defecto el mock. */
  consultaRuc?: ConsultaRuc;
  /** Puerto de `credencial.verificar_sol`; por defecto el mock. */
  solAuth?: SolAuth;
  /** Puerto de `sol.buzon.revisar`, `sol.buzon.abrir` (023) y `sol.declaraciones.descargar` (026); por defecto el mock. */
  solPortal?: SolPortal;
  credencialesSire?: CredencialesSire;
  /** Puerto de `xml.obtener` (016); por defecto el mock. */
  xmlProvider?: XmlProvider;
  /** Almacenamiento de los XML (016) y de los ZIP generados (012b); por defecto el de `STORAGE` (se crea al primer uso). */
  storage?: StorageProvider;
  /** Puerto de `notificacion.enviar` (028); por defecto `consola` (imprime y no entrega). */
  correo?: Correo;
  /** `APP_ORIGIN` (028): origen de los enlaces de los correos (`/ir`, `/baja`); por defecto el de desarrollo. */
  appOrigin?: string;
  /** `XML_SIMULADO_EN_REGLAS` (016, P-4): si el XML simulado entra en las reglas; apagada por defecto. */
  xmlSimuladoEnReglas?: boolean;
  kek?: LlavesKek;
  logger?: LoggerTrabajos;
  proceso?: string;
  intervalos?: IntervalosTrabajos;
  /** Antigüedad mínima (s) que usa el reconciliador (por defecto 30). */
  antiguedadSeg?: number;
}

export interface TrabajosEnMarcha {
  detener(o?: { esperaMs?: number }): Promise<void>;
  abortar(): Promise<void>;
}

export const INTERVALOS_POR_DEFECTO: Required<IntervalosTrabajos> = {
  despachadorMs: 500,
  reconciliadorMs: 30_000,
  latidoMs: LATIDO_MS,
};
const ESPERA_CIERRE_MS = 30_000;
/** Mismo valor por omisión que el backend fuera de producción. */
const APP_ORIGIN_POR_DEFECTO = "http://localhost:3000";
const ESPERA_ABORTO_MS = 2_000;
/**
 * Tope de la espera al ciclo en curso del despachador y del reconciliador, y al cierre de BullMQ sin trabajos en curso
 * (H-008-1b-6): con Redis o la BD caídos sus comandos reintentan mucho más que el plazo de cierre. Lo que quede a
 * medias lo resuelve el reconciliador.
 */
const ESPERA_BUCLES_MS = 5_000;

/** Procesador de `prueba.eco` (solo NODE_ENV=test): no hace nada y termina bien. */
const eco: Procesador = async () => ({ ok: true });

/** Storage por defecto: el de `STORAGE`, creado al primer uso (así un worker sin XML no exige configurarlo). */
function storagePorDefecto(): StorageProvider {
  let real: StorageProvider | undefined;
  const dar = (): StorageProvider => (real ??= crearStorage(process.env));
  return {
    guardar: (ruta, bytes) => dar().guardar(ruta, bytes),
    leer: (ruta) => dar().leer(ruta),
    eliminar: (ruta) => dar().eliminar(ruta),
  };
}

class SinCredencialesSireError extends Error {
  readonly codigo = "credenciales_sire_no_configuradas";
  constructor() {
    super("El worker no tiene cómo descifrar credenciales SIRE");
  }
}

interface Bucle {
  detener(): Promise<void>;
  abortar(): void;
}

/** Repite `paso` cada `ms` sin solaparse; nunca lanza. */
function bucle(paso: () => Promise<unknown>, ms: number): Bucle {
  let activo = true;
  let reloj: NodeJS.Timeout | undefined;
  let actual: Promise<unknown> | null = null;
  const vuelta = async () => {
    actual = paso().catch(() => undefined);
    await actual;
    actual = null;
    if (activo) reloj = setTimeout(() => void vuelta(), ms);
  };
  reloj = setTimeout(() => void vuelta(), 0);
  return {
    detener: async () => {
      activo = false;
      clearTimeout(reloj);
      await actual;
    },
    abortar: () => {
      activo = false;
      clearTimeout(reloj);
    },
  };
}

/** Espera con tope; nunca lanza. true si `p` terminó (bien o mal) antes del tope. */
async function conTope(p: Promise<unknown>, ms: number): Promise<boolean> {
  let reloj: NodeJS.Timeout | undefined;
  const termino = await Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<false>((r) => (reloj = setTimeout(() => r(false), ms))),
  ]);
  clearTimeout(reloj);
  return termino;
}

export async function iniciarTrabajos(
  deps: DepsTrabajos,
): Promise<TrabajosEnMarcha> {
  const estado = { muerto: false, cerrando: false };
  const muerto = () => estado.muerto;
  const db = dbGuardada(deps.db, muerto);
  const redis = redisGuardado(deps.redis, muerto);
  const reloj: Reloj = deps.reloj ?? { ahora: () => new Date() };
  const prefijo = deps.prefijo ?? PREFIJO_POR_DEFECTO;
  const logger = deps.logger ?? loggerConsola;
  const intervalos = { ...INTERVALOS_POR_DEFECTO, ...deps.intervalos };
  const conexion = deps.conexionBull;

  // Las colas que existen son las de config_sistema (si no se puede leer, el worker no arranca).
  const inicial = await db.withSistema((tx) => leerConfig(tx));

  // Servicio auditado de descifrado (003): solo existe si el worker tiene la KEK.
  const servicio = deps.kek
    ? crearServicioCredenciales({
        db,
        unwrapper: deps.kek.activa,
        logger: {
          log: (e) =>
            registrar(logger, "debug", {
              evento: "credencial_descifrada",
              credencial_id: e.credencialId,
              resultado: e.resultado,
            }),
          warn: (e) =>
            registrar(logger, "warn", {
              evento: "credencial_no_descifrada",
              credencial_id: e.credencialId,
              resultado: e.resultado,
              codigo: e.codigo,
            }),
        },
      })
    : undefined;
  const credenciales: CredencialesSire =
    deps.credencialesSire ??
    (servicio
      ? crearCredencialesSire({ db, servicio })
      : async () => {
          throw new SinCredencialesSireError();
        });
  const sireAuth = deps.sireAuth ?? new MockSireAuth();
  const tokens = new CacheTokenSire({
    redis,
    sireAuth,
    credenciales,
    reloj,
    prefijo,
    proceso: deps.proceso ?? randomUUID(),
  });
  const config = new CacheConfig(db, reloj);
  const storage = deps.storage ?? storagePorDefecto();
  const notificador =
    deps.notificador ?? new NotificadorEventos(redis, { prefijo, logger });
  const solPortal = deps.solPortal ?? new MockSolPortal();
  const ejecutor = new Ejecutor({
    db,
    redis,
    reloj,
    prefijo,
    procesadores: {
      ...(process.env.NODE_ENV === "test" ? { "prueba.eco": eco } : {}),
      "cliente.consultar_ruc": consultarRuc({
        db,
        consultaRuc: deps.consultaRuc ?? new MockConsultaRuc(),
      }),
      "sire.propuesta.descargar": descargarPropuesta({
        db,
        sireApi: deps.sireApi ?? new MockSireApiClient(),
        redis,
        prefijo,
        logger,
      }),
      // 025: importación del historial (cola `sire`, credencial `sire_api`): lee fuera de transacción y escribe una vez.
      "reglas.historial.importar": importarHistorial({
        db,
        sireApi: deps.sireApi ?? new MockSireApiClient(),
        config,
      }),
      "xml.obtener": obtenerXml({
        db,
        xmlProvider: deps.xmlProvider ?? new MockXmlProvider(),
        storage,
        xmlSimuladoEnReglas: deps.xmlSimuladoEnReglas ?? false,
        // 027 (R-14): el CIIU del proveedor y del cliente se consulta al llegar cada XML.
        consultaRuc: deps.consultaRuc ?? new MockConsultaRuc(),
      }),
      // 027 (R-12): «Volver a evaluar» el periodo abierto con el diccionario y el contexto de AHORA (cola `xml`, sin credenciales).
      "compras.reevaluar": reevaluarPeriodo({ db, logger }),
      // 028: correo de avisos y resumen (cola `notificaciones`, sin credenciales ni cliente): lee, arma y envía fuera de transacción.
      "notificacion.enviar": enviarCorreo({
        db,
        correo: deps.correo ?? new CorreoConsola(),
        appOrigin: deps.appOrigin ?? APP_ORIGIN_POR_DEFECTO,
        logger,
        reloj,
      }),
      // 012b: cola `archivos`; sin credenciales. `permiteProvisional` usa el NODE_ENV del proceso (D2).
      "archivo.generar": generarArchivo({ db, storage, logger }),
      ...(servicio
        ? {
            "credencial.verificar_sol": verificarSol({
              db,
              servicio,
              solAuth: deps.solAuth ?? new MockSolAuth(),
              notificador,
            }),
            "credencial.verificar_sire": verificarSire({
              db,
              servicio,
              sireAuth,
              notificador,
            }),
            // 023: buzón SOL (descifran la credencial SOL del cliente).
            "sol.buzon.revisar": revisarBuzon({
              db,
              servicio,
              solPortal,
              notificador,
            }),
            "sol.buzon.abrir": abrirMensaje({
              db,
              servicio,
              solPortal,
              storage,
            }),
            // 026: PDT 621 de los 12 periodos (cola `sol`, credencial SOL): lee fuera de transacción y escribe una vez.
            "sol.declaraciones.descargar": obtenerDeclaraciones({
              db,
              servicio,
              solPortal,
            }),
          }
        : {}),
      ...deps.procesadores,
    },
    config,
    tokens,
    notificador,
    logger,
    latidoMs: intervalos.latidoMs,
  });

  const colas = crearColas({ conexion, prefijo });
  const workers = crearWorkers({
    conexion,
    prefijo,
    colas: [...inicial].map(([cola, c]) => ({
      cola: cola as NombreCola,
      concurrencia: c.concurrenciaGlobal,
    })),
    procesar: (cola, payload) => ejecutor.ejecutar(cola, payload),
  });
  const despachador = new Despachador({
    db,
    redis,
    reloj,
    prefijo,
    agregarACola: (...a) => colas.agregarACola(...a),
  });
  const reconciliador = new Reconciliador({
    db,
    redis,
    reloj,
    prefijo,
    ...(deps.antiguedadSeg === undefined
      ? {}
      : { antiguedadSeg: deps.antiguedadSeg }),
  });

  const sistema = crearColaSistema({ conexion, prefijo });
  // 023 (D-5): un tick del programador del buzón; el dueño del candado es aleatorio por proceso.
  const tickBuzon = programarBuzon({ db, redis, prefijo, logger });
  // 028 (R-5): un tick del ciclo de correo (avisos vencidos y resumen del día); mismo patrón y candado propio en la BD.
  const tickCorreo = programarCorreo({ db, redis, prefijo, logger });
  const procesarSistema = async (data: PayloadSistema): Promise<void> => {
    try {
      if (data.tipo === "auth.purgar") {
        await authPurgar({ db, reloj, logger });
      } else if (data.tipo === "buzon.programar") {
        await tickBuzon();
      } else if (data.tipo === "correo.programar") {
        await tickCorreo();
      } else if (deps.kek === undefined) {
        registrar(logger, "error", {
          evento: "kek_rotar_sin_llaves",
          codigo: "kek_no_configurada",
        });
      } else {
        await kekRotar({
          db,
          activa: deps.kek.activa,
          anterior: deps.kek.anterior(data.desde),
          desde: data.desde,
          logger,
        });
      }
    } catch (e) {
      const codigo = (e as { codigo?: unknown } | null)?.codigo;
      registrar(logger, "error", {
        evento: "trabajo_sistema_fallo",
        trabajo: data.tipo,
        codigo: typeof codigo === "string" ? codigo : "desconocido",
      });
    }
  };
  const workerSistema = crearWorkerSistema({
    conexion,
    prefijo,
    procesar: procesarSistema,
  });
  await sistema.programarPurga();
  // 023 (D-5): repetible de 1 min con id fijo (N workers dejan uno). `BUZON_PROGRAMADOR=off` lo apaga (E2E y pruebas).
  if (process.env.BUZON_PROGRAMADOR !== "off") await sistema.programarBuzon();
  // 028 (R-5): repetible de 1 min con id fijo. `CORREO_PROGRAMADOR=off` lo apaga (E2E y pruebas).
  if (process.env.CORREO_PROGRAMADOR !== "off") await sistema.programarCorreo();

  const bucleDespacho = bucle(async () => {
    await despachador.ciclo();
    // Concurrencia de BullMQ = concurrencia global vigente (CA-4).
    for (const [cola, c] of await config.obtener())
      workers.ajustarConcurrencia(cola, c.concurrenciaGlobal);
  }, intervalos.despachadorMs);
  const bucleReconciliacion = bucle(
    () => reconciliador.ciclo(),
    intervalos.reconciliadorMs,
  );
  registrar(logger, "info", { evento: "trabajos_iniciados" });

  const cerrarBull = (forzar: boolean) =>
    Promise.allSettled([
      workers.cerrar(forzar),
      workerSistema.cerrar(forzar),
      colas.cerrar(),
      sistema.cerrar(),
    ]);

  return {
    detener: async ({ esperaMs = ESPERA_CIERRE_MS } = {}) => {
      if (estado.cerrando || estado.muerto) return;
      estado.cerrando = true;
      // Todo el cierre cabe en `esperaMs` (+ ≤ 2 × ESPERA_ABORTO_MS si hay que forzar), aun con Redis caído (H-008-1b-6).
      const fin = Date.now() + esperaMs;
      const restante = () => Math.max(0, fin - Date.now());
      // 1) No se despacha ni se reconcilia más; 2) BullMQ deja de tomar jobs; 3) se espera a los en curso.
      await conTope(
        Promise.all([bucleDespacho.detener(), bucleReconciliacion.detener()]),
        Math.min(restante(), ESPERA_BUCLES_MS),
      );
      const cierre = cerrarBull(false);
      if (!(await ejecutor.esperar(restante()))) {
        // Tiempo agotado: se sueltan los arriendos de lo que sigue en curso (lo resuelve el reconciliador) y desde
        // aquí el proceso no escribe más.
        await conTope(ejecutor.soltarEnCurso(), ESPERA_ABORTO_MS);
        estado.muerto = true;
        await conTope(cerrarBull(true), ESPERA_ABORTO_MS);
      } else if (
        !(await conTope(cierre, Math.min(restante(), ESPERA_BUCLES_MS)))
      ) {
        // Sin trabajos en curso BullMQ cierra enseguida; si no (p. ej. Redis caído), se fuerza y el proceso no escribe más.
        estado.muerto = true;
        await conTope(cerrarBull(true), ESPERA_ABORTO_MS);
      }
      registrar(logger, "info", { evento: "trabajos_detenidos" });
    },
    abortar: async () => {
      estado.muerto = true;
      estado.cerrando = true;
      bucleDespacho.abortar();
      bucleReconciliacion.abortar();
      ejecutor.abandonar();
      await conTope(cerrarBull(true), ESPERA_ABORTO_MS);
    },
  };
}
