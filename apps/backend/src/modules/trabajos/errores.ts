import { HttpException, HttpStatus } from "@nestjs/common";
import {
  ClienteDesconocidoError,
  ColaLlenaError,
  ParametrosInvalidosError,
} from "@contapp/queue";

/** Códigos de error propios de `/trabajos` (plan 008: Contratos HTTP). */
export type CodigoTrabajos = "trabajo_iniciado" | "streams_excedidos";

const ESTADO: Record<CodigoTrabajos, number> = {
  trabajo_iniciado: HttpStatus.CONFLICT,
  streams_excedidos: HttpStatus.TOO_MANY_REQUESTS,
};

/** Error de `/trabajos`: cuerpo `{ codigo }` sin eco de la entrada; el filtro global lo responde tal cual. */
export class TrabajosError extends HttpException {
  readonly codigo: CodigoTrabajos;

  constructor(codigo: CodigoTrabajos) {
    super({ codigo }, ESTADO[codigo]);
    this.name = "TrabajosError";
    this.codigo = codigo;
  }
}

/**
 * Respuesta HTTP de los errores tipados de `@contapp/queue` que propaga el `Encolador` (sin envolver) hacia las
 * rutas que encolan (007 y siguientes). `ColaNoConfiguradaError`, `TipoDesconocidoError` y el resto son errores de
 * despliegue o de programación: devuelve `null` y el filtro responde el 500 genérico.
 */
export function respuestaDeErrorCola(
  e: unknown,
): { estado: number; codigo: string } | null {
  if (e instanceof ColaLlenaError) {
    return { estado: HttpStatus.TOO_MANY_REQUESTS, codigo: "cola_llena" };
  }
  if (e instanceof ClienteDesconocidoError) {
    return { estado: HttpStatus.NOT_FOUND, codigo: "no_encontrado" };
  }
  if (e instanceof ParametrosInvalidosError) {
    return { estado: HttpStatus.BAD_REQUEST, codigo: "solicitud_invalida" };
  }
  return null;
}
