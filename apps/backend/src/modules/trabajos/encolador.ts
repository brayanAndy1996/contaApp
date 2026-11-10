import { Inject, Injectable } from "@nestjs/common";
import { contarPendientes, leerConfig, type ContappDb, type Tx } from "@contapp/db";
import {
  aPublicable,
  ColaLlenaError,
  definicionDe,
  encolar,
  publicar,
  publicarEvento,
  type EntradaEncolar,
  type ResultadoEncolar,
} from "@contapp/queue";
import type { TrabajoVista } from "@contapp/shared";
import { DB } from "../auth/inyeccion.js";
import { RedisTrabajos } from "./redis.js";

/** Contexto del caso de uso que encola: el estudio (y el usuario) de la sesión o del proceso programado. */
export interface ContextoEncolar {
  tenantId: string;
  userId?: string;
}

/** Trabajos por transacción de `encolarLote` (plan 007b: Carga de la cola). */
export const TAMANO_LOTE = 100;

/** Opciones de `encolarLote`. */
export interface OpcionesLote {
  /**
   * Fracción (0..1] de `max_pendientes_tenant` de la cola hasta la que el lote puede llenar los pendientes del estudio:
   * lo que pase de ahí no se encola (se cuenta como omitido) para dejar el resto del tope a los trabajos interactivos.
   * Sin ella, solo manda el tope atómico de `encolar`.
   */
  reserva?: number;
}

/** Cuántos trabajos del lote se encolaron y cuántos no (tope de la reserva, cola llena o fallo del lote). */
export interface ResultadoLote {
  encoladas: number;
  omitidas: number;
}

/**
 * Encolado con outbox (D3, CA-1) para 007 y las specs siguientes, cada una con su propio `@Permiso`: abre un
 * `withTenant`, llama a `encolar` (solo BD), hace commit y SOLO ENTONCES publica la pista y el evento `en_cola`, fuera
 * del callback. Con dedupe (`nuevo: false`, D8) no publica nada. Los errores de `encolar` se propagan sin envolver
 * (nada en Redis); los de Redis no se propagan (el reconciliador repone).
 */
@Injectable()
export class Encolador {
  constructor(
    @Inject(DB) private readonly db: Pick<ContappDb, "withTenant">,
    @Inject(RedisTrabajos) private readonly redis: RedisTrabajos,
  ) {}

  async encolar(
    ctx: ContextoEncolar,
    e: EntradaEncolar,
  ): Promise<ResultadoEncolar> {
    const r = await this.db.withTenant(ctx, (tx) => encolar(tx, e));
    if (r.nuevo) await this.publicar(ctx.tenantId, r.trabajo, e);
    return r;
  }

  /**
   * Como `encolar`, pero ejecuta `antes(tx)` en la MISMA transacción, antes de encolar: lo que `antes` valide o escriba (el
   * estado `pendiente` del XML de 016, por ejemplo) y el trabajo se confirman juntos o ninguno. Si `antes` lanza, o `encolar`
   * rechaza (cola llena, parámetros), no queda nada escrito. La publicación sigue siendo posterior al commit.
   */
  async encolarCon(
    ctx: ContextoEncolar,
    e: EntradaEncolar,
    antes: (tx: Tx) => Promise<void>,
  ): Promise<ResultadoEncolar> {
    const r = await this.db.withTenant(ctx, async (tx) => {
      await antes(tx);
      return encolar(tx, e);
    });
    if (r.nuevo) await this.publicar(ctx.tenantId, r.trabajo, e);
    return r;
  }

  /**
   * Encola muchos trabajos del mismo tipo (misma cola), de `TAMANO_LOTE` en `TAMANO_LOTE`, cada lote en su propia
   * `withTenant`, y publica la pista y el evento de cada lote tras su commit. Nunca lanza: un lote que falla (cola llena,
   * cliente inexistente, BD) deja sus trabajos como omitidos y se sigue con el resto sin propagar nada.
   */
  async encolarLote(
    ctx: ContextoEncolar,
    entradas: readonly EntradaEncolar[],
    opciones: OpcionesLote = {},
  ): Promise<ResultadoLote> {
    let encoladas = 0;
    let omitidas = 0;
    for (let i = 0; i < entradas.length; i += TAMANO_LOTE) {
      const lote = entradas.slice(i, i + TAMANO_LOTE);
      try {
        const nuevos = await this.db.withTenant(ctx, (tx) =>
          this.insertarLote(tx, lote, opciones),
        );
        await this.publicarLote(ctx.tenantId, nuevos);
        encoladas += nuevos.length;
        omitidas += lote.length - nuevos.length;
      } catch {
        // Sin causa ni datos: los clientes ya existen y el informe solo cuenta la omisión.
        omitidas += lote.length;
      }
    }
    return { encoladas, omitidas };
  }

  private async insertarLote(
    tx: Tx,
    lote: readonly EntradaEncolar[],
    opciones: OpcionesLote,
  ): Promise<Array<{ trabajo: TrabajoVista; entrada: EntradaEncolar }>> {
    let cabe = lote.length;
    if (opciones.reserva !== undefined) {
      // Todas las entradas del lote son del mismo tipo (y por tanto de la misma cola); `encolarLote` no pasa lotes vacíos.
      const cola = definicionDe((lote[0] as EntradaEncolar).tipo).cola;
      const config = (await leerConfig(tx)).get(cola);
      if (config === undefined) return [];
      const tope = Math.floor(config.maxPendientesTenant * opciones.reserva);
      cabe = Math.max(0, tope - (await contarPendientes(tx, cola)));
    }
    const nuevos: Array<{ trabajo: TrabajoVista; entrada: EntradaEncolar }> = [];
    for (const entrada of lote.slice(0, cabe)) {
      try {
        const r = await encolar(tx, entrada);
        if (r.nuevo) nuevos.push({ trabajo: r.trabajo, entrada });
      } catch (e) {
        // Cola llena: solo hubo lecturas (o el INSERT ya volvió a su savepoint), la transacción sigue sana.
        if (e instanceof ColaLlenaError) break;
        throw e;
      }
    }
    return nuevos;
  }

  private async publicarLote(
    tenantId: string,
    nuevos: ReadonlyArray<{ trabajo: TrabajoVista; entrada: EntradaEncolar }>,
  ): Promise<void> {
    const redis = this.redis.publicador();
    if (redis === null || nuevos.length === 0) return;
    const opciones = { prefijo: this.redis.prefijo };
    // En paralelo: con Redis caído cada comando cede en ~1 s y el lote no espera la suma.
    await Promise.all(
      nuevos.flatMap(({ trabajo, entrada }) => [
        publicar(redis, [aPublicable(tenantId, trabajo, entrada.prioridad)], opciones),
        publicarEvento(redis, tenantId, { ...trabajo, posicion: null }, opciones),
      ]),
    );
  }

  private async publicar(
    tenantId: string,
    trabajo: TrabajoVista,
    e: EntradaEncolar,
  ): Promise<void> {
    const redis = this.redis.publicador();
    if (redis === null) return;
    const opciones = { prefijo: this.redis.prefijo };
    // En paralelo: con Redis caído cada comando cede en ~1 s y la petición no espera la suma.
    await Promise.all([
      publicar(redis, [aPublicable(tenantId, trabajo, e.prioridad)], opciones),
      publicarEvento(redis, tenantId, { ...trabajo, posicion: null }, opciones),
    ]);
  }
}
