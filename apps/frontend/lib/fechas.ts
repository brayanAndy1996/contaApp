// Fechas con hora para la pantalla (spec 017, T18a): siempre en hora de Lima (`America/Lima`, UTC-5, sin horario de
// verano), sin depender de la zona del navegador. Una fecha que no se puede leer sale como «—», nunca «Invalid Date».

export const ZONA_LIMA = "America/Lima";

const FORMATO_FECHA_HORA = new Intl.DateTimeFormat("es-PE", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: ZONA_LIMA,
});

/** «2026-11-11T17:28:00.000Z» → «11/11/26, 12:28 p. m.» (hora de Lima). */
export function fechaHoraLima(iso: string): string {
  const fecha = new Date(iso);
  return Number.isNaN(fecha.getTime()) ? "—" : FORMATO_FECHA_HORA.format(fecha);
}

const FORMATO_FECHA = new Intl.DateTimeFormat("es-PE", { timeZone: ZONA_LIMA });

const FECHA_PURA = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Fecha sin hora, «20/10/2026» (spec 020, D-8, P-7). Una fecha pura `AAAA-MM-DD` (emisión, periodo, vencimiento) se
 * formatea desde el texto, sin objetos de fecha: no cambia de día. Un instante muestra el día de Lima, sin la hora.
 */
export function fechaCorta(valor: string): string {
  const pura = FECHA_PURA.exec(valor);
  if (pura) return `${Number(pura[3])}/${Number(pura[2])}/${pura[1]}`;
  const fecha = new Date(valor);
  return Number.isNaN(fecha.getTime()) ? "—" : FORMATO_FECHA.format(fecha);
}
