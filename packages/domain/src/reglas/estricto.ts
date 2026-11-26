// Lectura estricta de objetos y arreglos recibidos (plan 011, Decisiones: "Entrada estricta"). Separada de entrada.ts (027) para
// que `gastos/contexto.ts` la use sin ciclo de módulos: entrada.ts valida `ctx.gastos` con `gastos/contexto.ts`.
import { EntradaReglasInvalidaError } from "./errores";

export function invalida(): never {
  throw new EntradaReglasInvalidaError();
}

/**
 * Objeto con claves propias ⊆ `permitidas` (sin símbolos ni `__proto__` propio) y con todas las
 * `requeridas`. Devuelve un Map con cada valor leído una sola vez.
 */
export function leerObjeto(
  o: unknown,
  permitidas: readonly string[],
  requeridas: readonly string[] = permitidas,
): Map<string, unknown> {
  if (typeof o !== "object" || o === null || Array.isArray(o)) invalida();
  const obj = o as Record<string, unknown>;
  if (Object.getOwnPropertySymbols(obj).length > 0) invalida();
  const valores = new Map<string, unknown>();
  for (const k of Object.getOwnPropertyNames(obj)) {
    if (!permitidas.includes(k)) invalida();
    valores.set(k, obj[k]);
  }
  for (const k of requeridas) if (!valores.has(k)) invalida();
  return valores;
}

/** Copia de un arreglo real, por índice (sin el iterador del llamador); `undefined` en huecos. */
export function leerArreglo(a: unknown): unknown[] {
  if (!Array.isArray(a)) invalida();
  const arr = a as unknown[];
  const largo = arr.length;
  const copia: unknown[] = [];
  for (let i = 0; i < largo; i++) copia.push(arr[i]);
  return copia;
}
