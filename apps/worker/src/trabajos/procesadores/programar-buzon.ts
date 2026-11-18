// Programador del buzón SOL `buzon.programar` (spec 023, plan «Programador»; D-5, P-2; CA-1, CA-2, CA-11). Cada tick (repetible
// de BullMQ cada 60 s) solo PIDE el ciclo; el intervalo real, el candado y el reloj son de la BD, así que con N workers:
//  (1) `sistema.buzon_ciclo_tomar(dueno)`: una sola sentencia; uno gana y los demás reciben vacío y terminan sin efectos.
//  (2) `sistema.estudios_buzon()`: estudios con suscripción activa o prueba vigente y su frecuencia (solo uuid y entero).
//  (3) Por estudio, en su propio `withTenant`: candidatos (elegibles sin captura viva), `seleccionarVencidos` con el reloj de la
//      BD y `cupo = min(lote, max_pendientes_tenant − pendientes − reserva)`, y `encolar_buzon_programados` (que revalida todo
//      y fija la franja); tras el commit, la pista (sin bajar la de un trabajo ya elevado a interactivo, H-023-2-8) y el
//      evento en Redis (si se pierden, el reconciliador repone).
//  (4) Tras cada estudio, `buzon_ciclo_renovar(dueno)`; `false` = perdió el candado: se detiene sin encolar más. Al final, en
//      `finally`, `buzon_ciclo_soltar(dueno)` (no toca un candado ajeno).
// Sin doble encolado: un solo ciclo vivo (candado), revalidación dentro de la función y el índice único de dedupe de 008.
// El fallo de un estudio no tumba el ciclo. Los logs llevan solo el estudio, conteos y códigos (nunca clientes, D-10).
import { randomUUID } from "node:crypto";
import {
  candidatosBuzon,
  contarPendientes,
  encolarBuzonProgramados,
  estudiosBuzon,
  leerConfig,
  leerTrabajo,
  renovarCiclo,
  soltarCiclo,
  tomarCiclo,
  type CicloBuzon,
  type ContappDb,
  type TrabajoFila,
} from "@contapp/db";
import { seleccionarVencidos } from "@contapp/domain";
import {
  aPublicable,
  publicar,
  publicarEvento,
  vistaDeFila,
} from "@contapp/queue";
import type { RedisEncolado } from "../encolar-xml.js";
import { loggerConsola, registrar, type LoggerTrabajos } from "../registro.js";

export interface DepsProgramarBuzon {
  db: Pick<ContappDb, "withSistema" | "withTenant">;
  redis?: RedisEncolado;
  prefijo?: string;
  logger?: LoggerTrabajos;
  /** Dueño del candado: por omisión, un uuid aleatorio de esta instancia (proceso). */
  dueno?: string;
}

export interface ResultadoCicloBuzon {
  /** `false`: otro tiene el ciclo o aún no toca por el intervalo (sin efectos). */
  tomado: boolean;
  /** Estudios atendidos sin fallo. */
  estudios: number;
  encolados: number;
  perdioCandado: boolean;
}

const COLA = "sol";

const codigoDe = (e: unknown): string => {
  const c = (e as { codigo?: unknown } | null)?.codigo;
  return typeof c === "string" ? c : "desconocido";
};

export function programarBuzon(
  d: DepsProgramarBuzon,
): () => Promise<ResultadoCicloBuzon> {
  const dueno = d.dueno ?? randomUUID();
  const logger = d.logger ?? loggerConsola;
  const opciones = d.prefijo === undefined ? {} : { prefijo: d.prefijo };

  /** Encola los vencidos de un estudio y publica lo encolado tras el commit. Devuelve cuántos encoló. */
  const atender = async (
    estudio: { tenantId: string; frecuenciaMin: number },
    ciclo: CicloBuzon,
    maxPendientes: number,
  ): Promise<number> => {
    const filas = await d.db.withTenant(
      { tenantId: estudio.tenantId },
      async (tx): Promise<TrabajoFila[]> => {
        const libres =
          maxPendientes -
          (await contarPendientes(tx, COLA)) -
          ciclo.reservaInteractiva;
        const cupo = Math.min(ciclo.loteEstudio, libres);
        if (cupo <= 0) return [];
        const ids = seleccionarVencidos(await candidatosBuzon(tx), {
          ahora: ciclo.ahora,
          frecuenciaMin: estudio.frecuenciaMin,
          cupo,
        });
        const salida: TrabajoFila[] = [];
        for (const id of await encolarBuzonProgramados(tx, ids)) {
          const f = await leerTrabajo(tx, id);
          if (f !== null) salida.push(f);
        }
        return salida;
      },
    );
    if (filas.length > 0 && d.redis !== undefined) {
      const redis = d.redis;
      const vistas = filas.map((f) =>
        vistaDeFila(f, { estado: "en_cola", motivo: null }),
      );
      // H-023-2-8: si «Revisar ahora» elevó el trabajo a interactivo entre el commit y aquí, su pista no se baja (ZADD LT).
      await publicar(
        redis,
        vistas.map((v) => aPublicable(estudio.tenantId, v, "programado")),
        { ...opciones, noBajarPrioridad: true },
      );
      for (const v of vistas)
        await publicarEvento(redis, estudio.tenantId, v, opciones);
    }
    return filas.length;
  };

  return async () => {
    const r: ResultadoCicloBuzon = {
      tomado: false,
      estudios: 0,
      encolados: 0,
      perdioCandado: false,
    };
    const ciclo = await d.db.withSistema((tx) => tomarCiclo(tx, dueno));
    if (ciclo === null) return r;
    r.tomado = true;
    try {
      const { estudios, maxPendientes } = await d.db.withSistema(
        async (tx) => ({
          estudios: await estudiosBuzon(tx),
          maxPendientes: (await leerConfig(tx)).get(COLA)?.maxPendientesTenant,
        }),
      );
      if (maxPendientes === undefined) {
        registrar(logger, "error", {
          evento: "buzon_ciclo_sin_cola",
          codigo: "cola_sin_configurar",
        });
        return r;
      }
      for (const estudio of estudios) {
        try {
          const n = await atender(estudio, ciclo, maxPendientes);
          r.estudios += 1;
          r.encolados += n;
          if (n > 0)
            registrar(logger, "info", {
              evento: "buzon_estudio_programado",
              tenant_id: estudio.tenantId,
              encolados: n,
            });
        } catch (e) {
          registrar(logger, "warn", {
            evento: "buzon_estudio_fallo",
            tenant_id: estudio.tenantId,
            codigo: codigoDe(e),
          });
        }
        if (!(await d.db.withSistema((tx) => renovarCiclo(tx, dueno)))) {
          r.perdioCandado = true;
          registrar(logger, "warn", {
            evento: "buzon_ciclo_candado_perdido",
            codigo: "candado_perdido",
          });
          break;
        }
      }
    } catch (e) {
      registrar(logger, "error", {
        evento: "buzon_ciclo_fallo",
        codigo: codigoDe(e),
      });
    } finally {
      await d.db
        .withSistema((tx) => soltarCiclo(tx, dueno))
        .catch(() => undefined);
    }
    registrar(logger, "info", {
      evento: "buzon_ciclo_terminado",
      estudios: r.estudios,
      encolados: r.encolados,
      perdio_candado: r.perdioCandado,
    });
    return r;
  };
}
