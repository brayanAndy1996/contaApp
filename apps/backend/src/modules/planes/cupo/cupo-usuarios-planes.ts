import { Injectable } from "@nestjs/common";
import {
  bloquearCupo,
  contarUsuarios,
  leerLimites,
  type AuthRepo,
  type Tx,
} from "@contapp/db";
import {
  CupoUsuariosError,
  type CupoUsuarios,
} from "../../acceso/cupo/cupo-usuarios.js";
import { PlanNoDisponibleError } from "./errores.js";

/**
 * Adaptador real de `CupoUsuarios` (D7, D11). Invitar y reactivar toman el bloqueo del cupo antes de contar
 * (orden de bloqueo del plan) y exigen `activos + pendientes + 1 <= max_usuarios`; los límites se releen en cada
 * llamada (CA-2). Aceptar delega en la función SQL, que toma el mismo bloqueo y compara `activos + 1 <= max`
 * (la invitación ya estaba contada). Sin suscripción falla cerrado.
 */
@Injectable()
export class CupoUsuariosPlanes implements CupoUsuarios {
  async alInvitar(tx: Tx, tenantId: string): Promise<void> {
    await this.exigirCupo(tx, tenantId);
  }

  async alReactivar(tx: Tx, tenantId: string): Promise<void> {
    await this.exigirCupo(tx, tenantId);
  }

  async alAceptar(a: AuthRepo, tenantId: string): Promise<void> {
    if (!(await a.cupoUsuariosAceptar(tenantId))) throw new CupoUsuariosError();
  }

  private async exigirCupo(tx: Tx, tenantId: string): Promise<void> {
    await bloquearCupo(tx, tenantId);
    const limites = await leerLimites(tx, tenantId);
    if (limites === null) throw new PlanNoDisponibleError();
    if (limites.maxUsuarios === null) return;
    const { activos, pendientes } = await contarUsuarios(tx, tenantId);
    if (activos + pendientes + 1 > limites.maxUsuarios)
      throw new CupoUsuariosError();
  }
}
