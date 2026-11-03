/* eslint-disable @typescript-eslint/no-unused-vars -- stub: T7 usa los parámetros */
import type { AuthRepo, Tx } from "@contapp/db";
import type { CupoUsuarios } from "../../acceso/cupo/cupo-usuarios.js";

// STUB de T2 (006, pruebas primero): T7 implementa el adaptador real de `CupoUsuarios` (D7).
export class CupoUsuariosPlanes implements CupoUsuarios {
  async alInvitar(_tx: Tx, _tenantId: string): Promise<void> {
    throw new Error("no implementado (006 T7)");
  }
  async alReactivar(_tx: Tx, _tenantId: string): Promise<void> {
    throw new Error("no implementado (006 T7)");
  }
  async alAceptar(_a: AuthRepo, _tenantId: string): Promise<void> {
    throw new Error("no implementado (006 T7)");
  }
}
