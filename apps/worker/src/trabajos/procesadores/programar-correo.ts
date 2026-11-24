// Programador del correo `correo.programar` (spec 028, plan «Worker»; R-1, R-5, R-12, R-14; CA-4, CA-9, CA-10, CA-11). Mismo patrón que
// `programar-buzon.ts`: cada tick (repetible de BullMQ cada 60 s) solo PIDE el ciclo; el candado, la hora del resumen y el reloj son de
// la BD, así que con N workers:
//  (1) `sistema.correo_ciclo_tomar(dueno)`: uno gana y los demás reciben vacío y terminan sin efectos. Trae `resumenDia` (el día de
//      Lima si ya pasó la hora del resumen, es día hábil y el ciclo de ese día no se cerró) o null.
//  (2) `sistema.estudios_correo()`: estudios con suscripción activa o prueba vigente y si su plan permite avisos y resumen.
//  (3) Por estudio, en su propio `withTenant`: `encolar_correo_avisos` (envíos vencidos → `notificacion.enviar`, solo si el plan admite
//      avisos) y, si hay `resumenDia` y el plan admite resumen, `crear_correo_resumenes`. Tras el commit, la pista de cada trabajo nuevo
//      (si se pierde, el reconciliador repone).
//  (4) Tras cada estudio, `correo_ciclo_renovar`; `false` = perdió el candado: se detiene sin encolar más ni cerrar el día.
//  (5) El día (`correo_resumen_cerrar`) se cierra solo si había `resumenDia` y TODOS los estudios se atendieron sin fallo. Al final, en
//      `finally`, `correo_ciclo_soltar` (no toca un candado ajeno), aun si `detener` venció mientras tanto (`dbCandado`, H-028-1-1).
//      El candado dura 90 s y se renueva tras cada estudio (0075, H-028-1-2): un worker muerto lo bloquea a lo sumo 90 s.
// El fallo de un estudio no tumba el ciclo. Los logs llevan solo el estudio, conteos y códigos (nunca correos, clientes ni nombres).
import { randomUUID } from "node:crypto";
import {
  cerrarResumenCorreo,
  crearResumenesCorreo,
  encolarAvisosCorreo,
  estudiosCorreo,
  leerTrabajo,
  renovarCicloCorreo,
  soltarCicloCorreo,
  tomarCicloCorreo,
  type ContappDb,
  type EstudioCorreo,
  type TrabajoFila,
} from "@contapp/db";
import { aPublicable, publicar, vistaDeFila } from "@contapp/queue";
import type { RedisEncolado } from "../encolar-xml.js";
import { loggerConsola, registrar, type LoggerTrabajos } from "../registro.js";

export interface DepsProgramarCorreo {
  db: Pick<ContappDb, "withSistema" | "withTenant">;
  redis?: RedisEncolado;
  prefijo?: string;
  logger?: LoggerTrabajos;
  /** Dueño del candado: por omisión, un uuid aleatorio de esta instancia (proceso). */
  dueno?: string;
  /** Tope de envíos que `encolarAvisosCorreo` pasa a la cola por estudio y ciclo (1000). */
  lote?: number;
  /**
   * BD con la que el `finally` suelta el candado (H-028-1-1). `iniciarTrabajos` pasa una que solo se corta con `abortar` (kill -9): tras un
   * `detener` vencido el tick en curso aún suelta su propio candado y el siguiente worker toma el ciclo enseguida. Por omisión, `db`.
   */
  dbCandado?: Pick<ContappDb, "withSistema">;
}

export interface ResultadoCicloCorreo {
  /** `false`: otro tiene el ciclo o aún no toca (sin efectos). */
  tomado: boolean;
  /** Estudios atendidos sin fallo. */
  estudios: number;
  avisosEncolados: number;
  resumenesCreados: number;
  /** AAAA-MM-DD de Lima del resumen que tocaba crear en este ciclo; null si no tocaba. */
  resumenDia: string | null;
  /** Se cerró el día del resumen (todos los estudios atendidos sin fallo y sin perder el candado). */
  diaCerrado: boolean;
  perdioCandado: boolean;
}

const LOTE = 1000;

// Trabajos `notificacion.enviar` que esta transacción dejó en cola: `creado_en` es el `now()` de la transacción (o posterior); los
// de ciclos anteriores nacieron en otra transacción, más vieja.
const SQL_NUEVOS =
  "select id from job_registro where tipo = 'notificacion.enviar' and estado = 'en_cola' and creado_en >= now()";

const codigoDe = (e: unknown): string => {
  const c = (e as { codigo?: unknown } | null)?.codigo;
  return typeof c === "string" ? c : "desconocido";
};

export function programarCorreo(
  d: DepsProgramarCorreo,
): () => Promise<ResultadoCicloCorreo> {
  const dueno = d.dueno ?? randomUUID();
  const logger = d.logger ?? loggerConsola;
  const lote = d.lote ?? LOTE;
  const opciones = d.prefijo === undefined ? {} : { prefijo: d.prefijo };

  /** Atiende un estudio; devuelve los conteos y publica la pista de lo encolado tras el commit. */
  const atender = async (
    estudio: EstudioCorreo,
    resumenDia: string | null,
  ): Promise<{ avisos: number; resumenes: number }> => {
    const { avisos, resumenes, filas } = await d.db.withTenant(
      { tenantId: estudio.tenantId },
      async (tx) => {
        const avisos = estudio.avisos ? await encolarAvisosCorreo(tx, lote) : 0;
        const resumenes =
          resumenDia !== null && estudio.resumen
            ? await crearResumenesCorreo(tx, resumenDia)
            : 0;
        const filas: TrabajoFila[] = [];
        if (d.redis !== undefined && avisos + resumenes > 0) {
          const { rows } = await tx.query(SQL_NUEVOS);
          for (const r of rows as { id: string }[]) {
            const f = await leerTrabajo(tx, r.id);
            if (f !== null) filas.push(f);
          }
        }
        return { avisos, resumenes, filas };
      },
    );
    if (filas.length > 0 && d.redis !== undefined) {
      // Solo la pista: el trabajo no tiene cliente y no sale en el panel (el evento SSE exige uno).
      await publicar(
        d.redis,
        filas.map((f) =>
          aPublicable(
            estudio.tenantId,
            vistaDeFila(f, { estado: "en_cola", motivo: null }),
            "programado",
          ),
        ),
        { ...opciones, noBajarPrioridad: true },
      );
    }
    return { avisos, resumenes };
  };

  return async () => {
    const r: ResultadoCicloCorreo = {
      tomado: false,
      estudios: 0,
      avisosEncolados: 0,
      resumenesCreados: 0,
      resumenDia: null,
      diaCerrado: false,
      perdioCandado: false,
    };
    const ciclo = await d.db.withSistema((tx) => tomarCicloCorreo(tx, dueno));
    if (ciclo === null) return r;
    r.tomado = true;
    r.resumenDia = ciclo.resumenDia;
    let fallos = 0;
    try {
      const estudios = await d.db.withSistema((tx) => estudiosCorreo(tx));
      for (const estudio of estudios) {
        try {
          const n = await atender(estudio, ciclo.resumenDia);
          r.estudios += 1;
          r.avisosEncolados += n.avisos;
          r.resumenesCreados += n.resumenes;
          if (n.avisos + n.resumenes > 0)
            registrar(logger, "info", {
              evento: "correo_estudio_programado",
              tenant_id: estudio.tenantId,
              avisos: n.avisos,
              resumenes: n.resumenes,
            });
        } catch (e) {
          fallos += 1;
          registrar(logger, "warn", {
            evento: "correo_estudio_fallo",
            tenant_id: estudio.tenantId,
            codigo: codigoDe(e),
          });
        }
        if (!(await d.db.withSistema((tx) => renovarCicloCorreo(tx, dueno)))) {
          r.perdioCandado = true;
          registrar(logger, "warn", {
            evento: "correo_ciclo_candado_perdido",
            codigo: "candado_perdido",
          });
          break;
        }
      }
      if (ciclo.resumenDia !== null && fallos === 0 && !r.perdioCandado) {
        const dia = ciclo.resumenDia;
        await d.db.withSistema((tx) => cerrarResumenCorreo(tx, dueno, dia));
        r.diaCerrado = true;
      }
    } catch (e) {
      registrar(logger, "error", {
        evento: "correo_ciclo_fallo",
        codigo: codigoDe(e),
      });
    } finally {
      await (d.dbCandado ?? d.db)
        .withSistema((tx) => soltarCicloCorreo(tx, dueno))
        .catch(() => undefined);
    }
    registrar(logger, "info", {
      evento: "correo_ciclo_terminado",
      estudios: r.estudios,
      avisos_encolados: r.avisosEncolados,
      resumenes_creados: r.resumenesCreados,
      perdio_candado: r.perdioCandado,
    });
    return r;
  };
}
