import { tokensDeGlosa } from "@contapp/domain";
import { AccesoError } from "../acceso/errores.js";

// Normalización de lo que escribe el usuario en el diccionario (spec 027, R-4): la misma de las glosas del dominio (`tokensDeGlosa`:
// NFKD, sin marcas, minúsculas, solo [a-z0-9]). Una entrada que no queda en la forma que exige la BD es 400 `solicitud_invalida`, sin eco.

const PALABRA = /^[a-z0-9]{3,40}$/;
const FRASE_MAX_PALABRAS = 3;

/** Una palabra del diccionario: un solo token [a-z0-9] de 3 a 40 caracteres tras normalizar. */
export function normalizarPalabraGnd(texto: string): string {
  const tokens = tokensDeGlosa(texto);
  const token = tokens[0];
  if (tokens.length !== 1 || token === undefined || !PALABRA.test(token)) throw new AccesoError("solicitud_invalida");
  return token;
}

/** Una frase de excepción: de 1 a 3 palabras normalizadas, separadas por un espacio. */
function normalizarFrase(texto: string): string {
  const tokens = tokensDeGlosa(texto).map((t) => (t.endsWith(".") ? t.slice(0, -1) : t));
  if (tokens.length === 0 || tokens.length > FRASE_MAX_PALABRAS || tokens.some((t) => !/^[a-z0-9]+$/.test(t))) {
    throw new AccesoError("solicitud_invalida");
  }
  return tokens.join(" ");
}

/** Las frases de excepción normalizadas y sin repetir, en su orden (≤ 5, ya validado por el esquema). */
export function normalizarExcepciones(frases: readonly string[] | undefined): string[] {
  return [...new Set((frases ?? []).map(normalizarFrase))];
}
