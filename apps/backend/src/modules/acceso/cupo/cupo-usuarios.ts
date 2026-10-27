import { HttpException, HttpStatus } from "@nestjs/common";
import type { AuthRepo, Tx } from "@contapp/db";

/**
 * Puerto del límite de usuarios del plan (D11). 005 lo consulta al invitar, reactivar y aceptar, dentro
 * de la misma transacción de la acción; 006 aporta la implementación real. Si no hay cupo, lanza
 * `CupoUsuariosError` y la acción no se aplica.
 */
export interface CupoUsuarios {
  alInvitar(tx: Tx, tenantId: string): Promise<void>;
  alReactivar(tx: Tx, tenantId: string): Promise<void>;
  alAceptar(a: AuthRepo, tenantId: string): Promise<void>;
}

/** Token de inyección de `CupoUsuarios` (lo aporta `crearApp`). */
export const CUPO_USUARIOS = Symbol("ACCESO_CUPO_USUARIOS");

/** Sin cupo de usuarios: 409 `cupo_usuarios`, sin datos del estudio ni del plan. */
export class CupoUsuariosError extends HttpException {
  constructor() {
    super({ codigo: "cupo_usuarios" }, HttpStatus.CONFLICT);
    this.name = "CupoUsuariosError";
  }
}
