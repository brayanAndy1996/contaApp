// Spec 027 (R-3 S4; plan, Contratos: domain `feriados.ts`): feriados nacionales 2025–2027 y fin de semana. Aritmética de
// calendario pura: sin reloj, sin `Date` ni zona horaria.

const FECHA = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

const FIJOS: readonly string[] = [
  "01-01", "05-01", "06-07", "06-29", "07-23", "07-28", "07-29", "08-06", "08-30", "10-08", "11-01", "12-08", "12-09", "12-25",
];
/** Jueves y Viernes Santo de cada año de la lista. */
const SEMANA_SANTA: Readonly<Record<string, readonly string[]>> = {
  "2025": ["04-17", "04-18"],
  "2026": ["04-02", "04-03"],
  "2027": ["03-25", "03-26"],
};

/** Por año (AAAA), las fechas AAAA-MM-DD de feriado nacional. Un año sin lista solo cuenta el fin de semana. */
export const FERIADOS_NACIONALES: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(SEMANA_SANTA).map(([anio, santos]) => [anio, new Set([...FIJOS, ...santos].map((md) => `${anio}-${md}`))]),
);

const DIAS_MES = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** Sakamoto: desplazamiento por mes para el día de la semana. */
const DESPLAZAMIENTO = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];

const esBisiesto = (a: number): boolean => (a % 4 === 0 && a % 100 !== 0) || a % 400 === 0;

function partes(fecha: string): [number, number, number] | null {
  if (typeof fecha !== "string") return null;
  const m = FECHA.exec(fecha);
  if (m === null) return null;
  const [anio, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mes < 1 || mes > 12) return null;
  const maximo = mes === 2 && esBisiesto(anio) ? 29 : (DIAS_MES[mes - 1] as number);
  return dia >= 1 && dia <= maximo ? [anio, mes, dia] : null;
}

/** ¿Es una fecha de calendario AAAA-MM-DD válida? */
export function esFechaIso(fecha: string): boolean {
  return partes(fecha) !== null;
}

/** 0 = domingo … 6 = sábado (calendario gregoriano proléptico). */
function diaDeLaSemana(anio: number, mes: number, dia: number): number {
  const a = mes < 3 ? anio - 1 : anio;
  return (a + Math.floor(a / 4) - Math.floor(a / 100) + Math.floor(a / 400) + (DESPLAZAMIENTO[mes - 1] as number) + dia) % 7;
}

/** Sábado, domingo o feriado nacional de la lista del año. Una fecha que no es AAAA-MM-DD válida lanza RangeError. */
export function esDiaNoLaborable(fecha: string): boolean {
  const p = partes(fecha);
  if (p === null) throw new RangeError("Fecha inválida: se espera AAAA-MM-DD");
  const dia = diaDeLaSemana(...p);
  if (dia === 0 || dia === 6) return true;
  return FERIADOS_NACIONALES.get(fecha.slice(0, 4))?.has(fecha) === true;
}
