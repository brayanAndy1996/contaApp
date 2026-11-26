// Spec 028 · T8: hora de Lima (UTC−5, sin horario de verano) para el correo (R-5, R-13). El dominio no lee reloj: el instante llega como `Date`.
import { ErrorCorreo } from "./errores";

const MS_LIMA = 5 * 3600_000;

/** Desplaza el instante a «hora de Lima» para leerlo con los getters UTC. Lanza con algo que no sea una `Date` válida. */
function enLima(instante: Date): Date {
  if (Object.prototype.toString.call(instante) !== "[object Date]" || !Number.isFinite(instante.getTime())) throw new ErrorCorreo("fecha");
  return new Date(instante.getTime() - MS_LIMA);
}

const dos = (n: number): string => String(n).padStart(2, "0");
const cuatro = (n: number): string => String(n).padStart(4, "0");

/** Día calendario de Lima del instante: «AAAA-MM-DD». */
export function diaLima(instante: Date): string {
  const l = enLima(instante);
  return `${cuatro(l.getUTCFullYear())}-${dos(l.getUTCMonth() + 1)}-${dos(l.getUTCDate())}`;
}

/** Fecha y hora de Lima del instante: «dd/mm/aaaa hh:mm» (24 h). */
export function fechaHoraLima(instante: Date): string {
  const l = enLima(instante);
  return `${dos(l.getUTCDate())}/${dos(l.getUTCMonth() + 1)}/${cuatro(l.getUTCFullYear())} ${dos(l.getUTCHours())}:${dos(l.getUTCMinutes())}`;
}

/** Periodo del mes anterior al mes de Lima del instante: «AAAAMM» (enero → diciembre del año anterior). */
export function periodoAnteriorLima(instante: Date): string {
  const l = enLima(instante);
  const mes0 = l.getUTCMonth();
  return mes0 === 0 ? `${cuatro(l.getUTCFullYear() - 1)}12` : `${cuatro(l.getUTCFullYear())}${dos(mes0)}`;
}
