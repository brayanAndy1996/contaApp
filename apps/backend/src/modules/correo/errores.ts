import { HttpException, HttpStatus } from "@nestjs/common";

/** Códigos propios de 028 (plan, Contratos: HTTP); el resto reutiliza `AccesoError` y `AuthError`. */
export type CodigoCorreo = "todos_clientes_no_disponible" | "metodo_no_permitido" | "correo_ocupado";

const ESTADO: Record<CodigoCorreo, number> = {
  todos_clientes_no_disponible: HttpStatus.CONFLICT,
  metodo_no_permitido: HttpStatus.METHOD_NOT_ALLOWED,
  correo_ocupado: HttpStatus.SERVICE_UNAVAILABLE,
};

/** Error de `correo`: cuerpo `{ codigo }` sin eco de la entrada (el filtro global lo responde tal cual). */
export class CorreoError extends HttpException {
  readonly codigo: CodigoCorreo;

  constructor(codigo: CodigoCorreo) {
    super({ codigo }, ESTADO[codigo]);
    this.name = "CorreoError";
    this.codigo = codigo;
  }
}
