/* eslint-disable @typescript-eslint/no-unused-vars -- stub en rojo de T4 (spec 028): T10 lo reemplaza */
// STUB (spec 028, T4 rojo): lo reemplaza T10. Preferencias de correo del usuario de la sesión (R-15, R-10, CA-1, CA-12).
import type { TxConsulta } from "./errores";

/** Vista cruda del usuario de la sesión en el estudio activo (el backend la convierte a `PreferenciasCorreoVista`). */
export interface PreferenciasLeidas {
  /** Efectivas: la fila si existe; si no, la inicial por rol (U-1, U-8): `planLimite` solo para Dueño, `resumen` apagado. */
  buzonCritico: boolean;
  credencialInvalida: boolean;
  planLimite: boolean;
  resumen: boolean;
  /** Valor guardado de «todos los clientes» (false sin fila); `todosIgnorado` dice si hoy no rige. */
  todosClientes: boolean;
  /** Dueño o Administrador sin ninguna asignación. */
  todosDisponible: boolean;
  /** Marcada pero hoy sin efecto (con asignaciones o sin rol Dueño o Administrador). */
  todosIgnorado: boolean;
  /** Todavía no existe la fila del resumen (R-15). */
  invitacionResumen: boolean;
  /** `creado_en` del último envío del usuario en el estudio si está `fallido`; null si no hay envíos o el último no falló (R-9). */
  ultimoEnvioFallido: Date | null;
}

export interface PreferenciasAFijar {
  buzonCritico: boolean;
  credencialInvalida: boolean;
  planLimite: boolean;
  resumen: boolean;
  todosClientes: boolean;
}

export async function leerPreferencias(
  _tx: TxConsulta,
): Promise<PreferenciasLeidas> {
  throw new Error("no implementado: leerPreferencias");
}

/** `correo_preferencias_fijar(p jsonb)`; devuelve lo mismo que `leerPreferencias` justo después, en la misma transacción. */
export async function fijarPreferencias(
  _tx: TxConsulta,
  _p: PreferenciasAFijar,
): Promise<PreferenciasLeidas> {
  throw new Error("no implementado: fijarPreferencias");
}
