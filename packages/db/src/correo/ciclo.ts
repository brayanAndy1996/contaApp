/* eslint-disable @typescript-eslint/no-unused-vars -- stub en rojo de T4 (spec 028): T10 lo reemplaza */
// STUB (spec 028, T4 rojo): lo reemplaza T10. Ciclo programado de correo (R-5, R-14): funciones de 0074 con la `tx` del worker.
// `estudiosCorreo`, `tomarCicloCorreo`, `renovarCicloCorreo`, `soltarCicloCorreo` y `cerrarResumenCorreo` van con `withSistema`
// (sin estudio); `encolarAvisosCorreo`, `crearResumenesCorreo` y `purgarCorreo`, con `withTenant` del estudio (las dos primeras) o
// `withSistema` (la purga).
import type { TxConsulta } from "./errores";

export interface EstudioCorreo {
  tenantId: string;
  avisos: boolean;
  resumen: boolean;
}

export interface CicloCorreo {
  /** AAAA-MM-DD de Lima del resumen que toca crear en este ciclo; null si no toca. */
  resumenDia: string | null;
}

export async function estudiosCorreo(
  _tx: TxConsulta,
): Promise<EstudioCorreo[]> {
  throw new Error("no implementado: estudiosCorreo");
}
/** null si otro dueño tiene el candado. */
export async function tomarCicloCorreo(
  _tx: TxConsulta,
  _dueno: string,
): Promise<CicloCorreo | null> {
  throw new Error("no implementado: tomarCicloCorreo");
}
/** false si perdió el candado. */
export async function renovarCicloCorreo(
  _tx: TxConsulta,
  _dueno: string,
): Promise<boolean> {
  throw new Error("no implementado: renovarCicloCorreo");
}
export async function soltarCicloCorreo(
  _tx: TxConsulta,
  _dueno: string,
): Promise<void> {
  throw new Error("no implementado: soltarCicloCorreo");
}
/** Cierra el día del resumen (`dia` AAAA-MM-DD) solo si `dueno` sigue teniendo el candado. */
export async function cerrarResumenCorreo(
  _tx: TxConsulta,
  _dueno: string,
  _dia: string,
): Promise<void> {
  throw new Error("no implementado: cerrarResumenCorreo");
}
/** Cantidad de envíos `aviso` vencidos que pasaron a la cola (a lo sumo `limite`). */
export async function encolarAvisosCorreo(
  _tx: TxConsulta,
  _limite: number,
): Promise<number> {
  throw new Error("no implementado: encolarAvisosCorreo");
}
/** Cantidad de envíos de resumen o pendientes creados para el día (`dia` AAAA-MM-DD de Lima). */
export async function crearResumenesCorreo(
  _tx: TxConsulta,
  _dia: string,
): Promise<number> {
  throw new Error("no implementado: crearResumenesCorreo");
}
/** Filas borradas de envíos, avisos y tokens con más de `dias` días. */
export async function purgarCorreo(
  _tx: TxConsulta,
  _dias: number,
): Promise<number> {
  throw new Error("no implementado: purgarCorreo");
}
