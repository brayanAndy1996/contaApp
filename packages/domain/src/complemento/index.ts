// Planificación del complemento de una descarga o importación (spec 013, D16 y D18; CA-11). Genérica por
// libro (014 la reutiliza): no sabe qué campos son ni maneja montos; cada persistidor decide qué `campos`
// compara. Solo informa, nunca decide actualizar. Pura, idempotente y sin mutar las entradas.
import type { Entero } from "../texto/entero";

export type CamposComparables = Readonly<Record<string, string>>;
export type OrigenExistente = "sire" | "manual";

export interface ExistenteComplemento {
  readonly clave: string;
  readonly origen: OrigenExistente;
  readonly campos: CamposComparables;
}

export interface RecibidaComplemento {
  readonly clave: string;
  readonly campos: CamposComparables;
}

export interface DiferenciaComplemento {
  readonly clave: string;
  readonly origenExistente: OrigenExistente;
  /** Nombres de los campos que difieren, en orden alfabético. */
  readonly campos: readonly string[];
  /** Valor recibido de esos campos (si la recibida no trae el campo, no hay valor). */
  readonly valoresSire: Readonly<Record<string, string>>;
}

export interface PlanComplemento {
  /** Claves recibidas que no existen, en el orden de llegada. */
  readonly nuevas: readonly string[];
  readonly iguales: Entero;
  readonly distintas: readonly DiferenciaComplemento[];
}

function comparar(a: string, b: string): -1 | 0 | 1 {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Los valores deben ser cadenas: nunca number para dinero. */
function asegurarCadenas(campos: CamposComparables): void {
  for (const nombre of Object.keys(campos)) {
    if (typeof campos[nombre] !== "string") throw new TypeError("Los campos del complemento deben ser cadenas.");
  }
}

/** Nombres que difieren (presente en un solo lado cuenta como diferente), en orden alfabético. */
function camposQueDifieren(base: CamposComparables, recibida: CamposComparables): string[] {
  const nombres = new Set([...Object.keys(base), ...Object.keys(recibida)]);
  const difieren: string[] = [];
  for (const n of nombres) {
    const enBase = Object.hasOwn(base, n);
    const enRecibida = Object.hasOwn(recibida, n);
    if (enBase !== enRecibida || (base[n] as string) !== (recibida[n] as string)) difieren.push(n);
  }
  return difieren.sort(comparar);
}

function diferencia(
  clave: string,
  origenExistente: OrigenExistente,
  difieren: readonly string[],
  recibida: CamposComparables,
): DiferenciaComplemento {
  // fromEntries crea propiedades propias: un campo llamado `__proto__` no toca el prototipo.
  const valoresSire = Object.fromEntries(difieren.filter((n) => Object.hasOwn(recibida, n)).map((n) => [n, recibida[n] as string]));
  return { clave, origenExistente, campos: [...difieren], valoresSire };
}

/**
 * Compara lo recibido con lo existente. Un comprobante repetido dentro de lo recibido (D18) conserva su
 * primera aparición: la primera decide si es nueva, igual o distinta frente a lo existente; las siguientes
 * se comparan con ella y cuentan como iguales o distintas (su `origenExistente` es el de la fila que
 * queda guardada: el de la existente o `sire`). Así `recibidas = nuevas + iguales + distintas`.
 */
export function planificarComplemento(
  existentes: readonly ExistenteComplemento[],
  recibidas: readonly RecibidaComplemento[],
): PlanComplemento {
  const porClave = new Map<string, ExistenteComplemento>();
  for (const e of existentes) {
    asegurarCadenas(e.campos);
    if (!porClave.has(e.clave)) porClave.set(e.clave, e);
  }
  for (const r of recibidas) asegurarCadenas(r.campos);

  const primeras = new Map<string, CamposComparables>();
  const nuevas: string[] = [];
  const distintas: DiferenciaComplemento[] = [];
  let iguales = 0;
  for (const r of recibidas) {
    const existente = porClave.get(r.clave);
    const primera = primeras.get(r.clave);
    const base = primera ?? existente?.campos;
    if (primera === undefined) primeras.set(r.clave, r.campos);
    if (base === undefined) {
      nuevas.push(r.clave);
      continue;
    }
    const difieren = camposQueDifieren(base, r.campos);
    if (difieren.length === 0) iguales++;
    else distintas.push(diferencia(r.clave, existente?.origen ?? "sire", difieren, r.campos));
  }
  return { nuevas, iguales, distintas };
}
