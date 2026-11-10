// Encolado de los lotes de `xml.obtener` que el worker pide tras la descarga de la propuesta (spec 016, plan «Cola y worker»,
// D-7, CA-10). Mismo modelo que el `Encolador` del backend: por lote, `withTenant` -> encolar (solo BD) -> commit -> y solo
// entonces `publicar` la pista y el evento en Redis (que no se propaga: el reconciliador repone). Prioridad `programado`.
// El worker no tiene INSERT en job_registro (0018): encola con la función acotada `encolar_xml_obtener` de 0037 (T12b), que
// fija tipo, cola, canal, prioridad, max_intentos, clave de dedupe y tope. Con la cola llena (53400) se detiene sin error: lo
// que quede sin solicitar lo ofrece la lupa («Obtener»).
import { encolarLoteXml, TrabajosRepoError, type ContappDb } from "@contapp/db";
import {
  aPublicable,
  publicar,
  publicarEvento,
  type ClienteRedis,
} from "@contapp/queue";

/** Lo mínimo de Redis que usa la publicación. */
export type RedisEncolado = Pick<ClienteRedis, "zadd" | "sadd" | "publish">;

export interface DepsEncolarXml {
  db: Pick<ContappDb, "withTenant">;
  redis?: RedisEncolado;
  prefijo?: string;
}

export interface EntradaEncolarXml {
  tenantId: string;
  clienteId: string;
  /** Usuario que pidió la descarga: queda como `creado_por` de los lotes. */
  usuarioId: string;
  /** AAAAMM. */
  periodo: string;
  /** Lotes de ids de compra, en el orden de prioridad (los primeros se encolan primero). */
  lotes: readonly (readonly string[])[];
}

export interface ResultadoEncolarXml {
  encolados: number;
  /** La cola se llenó: el resto quedó sin solicitar. */
  colaLlena: boolean;
}

/** Los ids de un lote van ordenados y sin repetir (la forma canónica que exige el catálogo y usa el dedupe de 008). */
const canonico = (ids: readonly string[]): string[] =>
  [...new Set(ids.map((x) => x.toLowerCase()))].sort();

/** SQLSTATE con el que `encolar_xml_obtener` rechaza un lote por cola llena. */
const COLA_LLENA = "53400";

export async function encolarLotesXml(
  d: DepsEncolarXml,
  e: EntradaEncolarXml,
): Promise<ResultadoEncolarXml> {
  let encolados = 0;
  for (const lote of e.lotes) {
    const entrada = {
      clienteId: e.clienteId,
      periodo: e.periodo,
      compraIds: canonico(lote),
      creadoPor: e.usuarioId,
    };
    let r;
    try {
      r = await d.db.withTenant({ tenantId: e.tenantId }, (tx) =>
        encolarLoteXml(tx, entrada),
      );
    } catch (error) {
      if (error instanceof TrabajosRepoError && error.codigo === COLA_LLENA)
        return { encolados, colaLlena: true };
      throw error;
    }
    if (!r.nuevo) continue; // dedupe de 008: ya hay un lote vivo igual
    encolados += 1;
    if (d.redis === undefined) continue;
    const opciones = d.prefijo === undefined ? {} : { prefijo: d.prefijo };
    await Promise.all([
      publicar(
        d.redis,
        [aPublicable(e.tenantId, r.trabajo, "programado")],
        opciones,
      ),
      publicarEvento(
        d.redis,
        e.tenantId,
        { ...r.trabajo, posicion: null },
        opciones,
      ),
    ]);
  }
  return { encolados, colaLlena: false };
}
