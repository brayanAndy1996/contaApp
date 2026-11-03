import { HttpException, HttpStatus } from "@nestjs/common";

// STUB de T2 (006, pruebas primero): T7 lo corrige a 409 `{ codigo: "sin_plan" }`.
/** El estudio no tiene suscripción: los cupos fallan cerrado (D1). */
export class PlanNoDisponibleError extends HttpException {
  constructor() {
    super({}, HttpStatus.INTERNAL_SERVER_ERROR);
  }
}
