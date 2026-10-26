import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import { ContrasenaInvalidaError } from "../modules/auth/errores.js";

export interface EventoError {
  clase: string;
  codigo: string;
}

const logger = new Logger("FiltroErrores");

const CODIGO_POR_ESTADO: Record<number, string> = {
  400: "solicitud_invalida",
  401: "sesion_invalida",
  403: "prohibido",
  404: "no_encontrado",
  413: "solicitud_demasiado_grande",
  429: "demasiados_intentos",
};

type Cuerpo = { codigo: string; motivo?: string };

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === "object" && valor !== null;
}

/**
 * CA-10: responde `{ codigo }` (más `motivo` solo en contrasena_invalida) sin eco de la entrada y
 * registra solo la clase y el código: nunca message, stack, cause, detail ni el cuerpo.
 */
@Catch()
export class FiltroErrores implements ExceptionFilter {
  private readonly registrar: (evento: EventoError) => void;

  constructor(
    registrar: (evento: EventoError) => void = (e) =>
      logger.warn(`${e.clase} ${e.codigo}`),
  ) {
    this.registrar = registrar;
  }

  catch(excepcion: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<{
      status(n: number): { json(cuerpo: unknown): unknown };
    }>();
    const { estado, cuerpo } = this.resolver(excepcion);
    this.registrar({ clase: this.clase(excepcion), codigo: cuerpo.codigo });
    res.status(estado).json(cuerpo);
  }

  private clase(excepcion: unknown): string {
    return excepcion instanceof Error
      ? excepcion.constructor.name
      : typeof excepcion;
  }

  private resolver(excepcion: unknown): { estado: number; cuerpo: Cuerpo } {
    if (excepcion instanceof ContrasenaInvalidaError) {
      return {
        estado: 400,
        cuerpo: { codigo: "contrasena_invalida", motivo: excepcion.motivo },
      };
    }
    if (excepcion instanceof HttpException) {
      const estado = excepcion.getStatus();
      const respuesta = excepcion.getResponse();
      if (esObjeto(respuesta) && typeof respuesta.codigo === "string") {
        const motivo = respuesta.motivo;
        if (
          respuesta.codigo === "contrasena_invalida" &&
          (motivo === "longitud" || motivo === "comun")
        ) {
          return { estado, cuerpo: { codigo: respuesta.codigo, motivo } };
        }
        return { estado, cuerpo: { codigo: respuesta.codigo } };
      }
      return {
        estado,
        cuerpo: { codigo: CODIGO_POR_ESTADO[estado] ?? "error" },
      };
    }
    // Errores del analizador de cuerpo (JSON mal formado o demasiado grande): `status` 400 o 413.
    if (
      esObjeto(excepcion) &&
      (excepcion.status === 400 || excepcion.status === 413)
    ) {
      return {
        estado: excepcion.status,
        cuerpo: { codigo: CODIGO_POR_ESTADO[excepcion.status] as string },
      };
    }
    return { estado: 500, cuerpo: { codigo: "error_interno" } };
  }
}
