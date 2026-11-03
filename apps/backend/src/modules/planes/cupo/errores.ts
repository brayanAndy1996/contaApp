import { HttpException, HttpStatus } from "@nestjs/common";

/** El estudio no tiene suscripción: los cupos fallan cerrado (D1). 409 `sin_plan`, sin datos del estudio. */
export class PlanNoDisponibleError extends HttpException {
  constructor() {
    super({ codigo: "sin_plan" }, HttpStatus.CONFLICT);
    this.name = "PlanNoDisponibleError";
  }
}
