import type { CupoUsuarios } from "./cupo-usuarios.js";

/** `CupoUsuarios` por defecto de 005: no limita (006 lo reemplaza). */
export class CupoSinLimite implements CupoUsuarios {
  async alInvitar(): Promise<void> {}
  async alReactivar(): Promise<void> {}
  async alAceptar(): Promise<void> {}
}
