// Spec 023 (D-5, CA-1, P-2): franjas de captura programada en hora de Lima (UTC−5, sin horario
// de verano). Todo el tiempo llega en `ahora`: el dominio no lee el reloj.

export interface CandidatoCaptura {
  readonly clienteId: string;
  /** `null` = nunca se programó una captura. */
  readonly ultimaProgramadaEn: Date | null;
}

const MINUTO_MS = 60_000;
const DIA_MS = 1_440 * MINUTO_MS;
/** Lima = UTC−5 todo el año. */
const DESFASE_LIMA_MS = 5 * 60 * MINUTO_MS;
/** Las franjas del día empiezan a las 02:00 de Lima más el desfase del cliente. */
const ANCLA_BASE_MIN = 120;
const VENTANA_DESFASE_MIN = 180;

const FNV_BASE = 0x811c9dc5;
const FNV_PRIMO = 0x01000193;

/** Bytes UTF-8 de un punto de código (el uuid es ASCII; el resto, por estabilidad). */
function bytesUtf8(cp: number): number[] {
  if (cp < 0x80) return [cp];
  if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
  if (cp < 0x10000)
    return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
  return [
    0xf0 | (cp >> 18),
    0x80 | ((cp >> 12) & 0x3f),
    0x80 | ((cp >> 6) & 0x3f),
    0x80 | (cp & 0x3f),
  ];
}

/** FNV-1a de 32 bits sobre el uuid en minúsculas, módulo 180: 0..179 minutos. */
export function desfaseCliente(clienteId: string): number {
  let h = FNV_BASE;
  for (const caracter of clienteId.toLowerCase()) {
    for (const b of bytesUtf8(caracter.codePointAt(0) ?? 0)) {
      h = Math.imul(h ^ b, FNV_PRIMO) >>> 0;
    }
  }
  return h % VENTANA_DESFASE_MIN;
}

function validarFrecuencia(frecuenciaMin: number): void {
  if (!Number.isInteger(frecuenciaMin) || frecuenciaMin <= 0) {
    throw new RangeError("frecuenciaMin debe ser un entero positivo");
  }
}

function validarFecha(fecha: Date, nombre: string): number {
  const t = fecha.getTime();
  if (Number.isNaN(t)) throw new RangeError(`${nombre} no es una fecha válida`);
  return t;
}

/**
 * Última franja ≤ `ahora`: hora de Lima (UTC−5), 02:00 + desfase + k·frecuencia, sin pasar a la
 * ancla del día siguiente.
 */
export function ultimaFranja(p: {
  readonly ahora: Date;
  readonly frecuenciaMin: number;
  readonly desfaseMin: number;
}): Date {
  validarFrecuencia(p.frecuenciaMin);
  if (
    !Number.isInteger(p.desfaseMin) ||
    p.desfaseMin < 0 ||
    p.desfaseMin >= VENTANA_DESFASE_MIN
  ) {
    throw new RangeError("desfaseMin debe ser un entero entre 0 y 179");
  }
  const limaMs = validarFecha(p.ahora, "ahora") - DESFASE_LIMA_MS;
  const inicioDia = Math.floor(limaMs / DIA_MS) * DIA_MS;
  let ancla = inicioDia + (ANCLA_BASE_MIN + p.desfaseMin) * MINUTO_MS;
  if (limaMs < ancla) ancla -= DIA_MS;
  // limaMs − ancla < 1 día, así que k·frecuencia nunca llega a la ancla siguiente.
  const pasoMs = p.frecuenciaMin * MINUTO_MS;
  const k = Math.floor((limaMs - ancla) / pasoMs);
  return new Date(ancla + k * pasoMs + DESFASE_LIMA_MS);
}

function franjaDe(
  clienteId: string,
  ahora: Date,
  frecuenciaMin: number,
): Date {
  return ultimaFranja({
    ahora,
    frecuenciaMin,
    desfaseMin: desfaseCliente(clienteId),
  });
}

export function capturaVencida(p: {
  readonly ahora: Date;
  readonly frecuenciaMin: number;
  readonly clienteId: string;
  readonly ultimaProgramadaEn: Date | null;
}): boolean {
  const franja = franjaDe(p.clienteId, p.ahora, p.frecuenciaMin);
  if (p.ultimaProgramadaEn === null) return true;
  return (
    validarFecha(p.ultimaProgramadaEn, "ultimaProgramadaEn") < franja.getTime()
  );
}

function compararTexto(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Ids de los vencidos: primero los nunca capturados, luego por franja más antigua e id; hasta `cupo`. */
export function seleccionarVencidos(
  candidatos: readonly CandidatoCaptura[],
  p: {
    readonly ahora: Date;
    readonly frecuenciaMin: number;
    readonly cupo: number;
  },
): string[] {
  validarFrecuencia(p.frecuenciaMin);
  const cupo = Number.isFinite(p.cupo) ? Math.max(0, Math.floor(p.cupo)) : 0;
  if (cupo === 0) return [];
  const vencidos: { id: string; nunca: boolean; franja: number }[] = [];
  for (const c of candidatos) {
    const franja = franjaDe(c.clienteId, p.ahora, p.frecuenciaMin).getTime();
    const nunca = c.ultimaProgramadaEn === null;
    if (
      nunca ||
      validarFecha(c.ultimaProgramadaEn, "ultimaProgramadaEn") < franja
    ) {
      vencidos.push({ id: c.clienteId, nunca, franja });
    }
  }
  vencidos.sort((a, b) => {
    if (a.nunca !== b.nunca) return a.nunca ? -1 : 1;
    if (a.franja !== b.franja) return a.franja - b.franja;
    return compararTexto(a.id, b.id);
  });
  return vencidos.slice(0, cupo).map((v) => v.id);
}
