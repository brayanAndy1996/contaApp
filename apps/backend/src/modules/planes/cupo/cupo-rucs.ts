import { HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { bloquearCupo, contarRucs, leerLimites, type Tx } from "@contapp/db";
import { limiteEfectivoRucs } from "@contapp/shared";
import { PlanNoDisponibleError } from "./errores.js";

/**
 * Puerto del cupo de RUCs (D4, D6). `reservar` se llama antes de insertar o reactivar clientes (007) y conserva el
 * bloqueo del cupo hasta el commit de la transacción del llamador; no escribe nada.
 */
export interface CupoRucs {
  libres(tx: Tx, tenantId: string): Promise<number>;
  reservar(tx: Tx, tenantId: string, n: number): Promise<void>;
}

/** Token de inyección de `CupoRucs` (lo aporta `crearApp`). */
export const CUPO_RUCS = Symbol("PLANES_CUPO_RUCS");

/** Sin cupo de RUCs: 409 `cupo_rucs`, sin datos del estudio ni del plan. */
export class CupoRucsError extends HttpException {
  constructor() {
    super({ codigo: "cupo_rucs" }, HttpStatus.CONFLICT);
    this.name = "CupoRucsError";
  }
}

@Injectable()
export class CupoRucsPlanes implements CupoRucs {
  async libres(tx: Tx, tenantId: string): Promise<number> {
    const { limite, usados } = await this.medir(tx, tenantId);
    return Math.max(0, limite - usados);
  }

  async reservar(tx: Tx, tenantId: string, n: number): Promise<void> {
    const { limite, usados } = await this.medir(tx, tenantId);
    if (usados + n > limite) throw new CupoRucsError();
  }

  /** Bloquea antes de contar y relee el plan en cada llamada (CA-2). Sin suscripción falla cerrado. */
  private async medir(
    tx: Tx,
    tenantId: string,
  ): Promise<{ limite: number; usados: number }> {
    await bloquearCupo(tx, tenantId);
    const l = await leerLimites(tx, tenantId);
    if (l === null) throw new PlanNoDisponibleError();
    return {
      limite: limiteEfectivoRucs(l.maxRucs, l.maxRucsExtra, l.rucsExtraContratados),
      usados: await contarRucs(tx, tenantId),
    };
  }
}
