import { Inject, Injectable } from "@nestjs/common";
import type { ContappDb } from "@contapp/db";
import {
  aPublicable,
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
