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
