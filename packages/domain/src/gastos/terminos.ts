// Spec 027 (R-7, CA-9; plan, Contratos: domain `terminos.ts`): términos para «Aprender» de una compra excluida. Tokens
// normalizados de las glosas sin punto final, de 3 a 40 caracteres [a-z0-9], sin números, unidades, palabras vacías ni términos
// que el diccionario efectivo ya coincide, en orden de primera aparición y sin repetir (tampoco en su otra forma, +s / +es: gana la
// primera, H-027-1-1); a lo sumo 10. Puro: sin IO.
import { mismaPalabra } from "../texto/diccionario";
import type { DiccionarioGlosas } from "../texto/diccionario";
import { tokensDeGlosa } from "../texto/normalizar";

export const MAX_TERMINOS = 10;

const TERMINO = /^[a-z0-9]{3,40}$/;
const CON_DIGITO = /[0-9]/;

/** Palabras vacías (las de menos de 3 letras ya quedan fuera por largo). */
export const PALABRAS_VACIAS: ReadonlySet<string> = new Set([
  "para", "con", "sin", "por", "del", "los", "las", "una", "uno", "unos", "unas", "que", "sus", "como", "mas", "segun",
  "entre", "desde", "hasta", "sobre", "hacia", "contra", "tras", "durante", "mediante", "este", "esta", "estos", "estas",
  "ese", "esa", "esos", "esas", "otro", "otra", "otros", "otras", "muy", "tipo", "marca", "modelo",
]);

/** Unidades de medida y de venta. */
export const UNIDADES: ReadonlySet<string> = new Set([
  "und", "unds", "unid", "unids", "unidad", "unidades", "uni", "niu", "pza", "pzas", "pieza", "piezas", "kgs", "kilo", "kilos",
  "kilogramo", "kilogramos", "grs", "gramo", "gramos", "lts", "litro", "litros", "mts", "metro", "metros", "cms", "mililitros",
  "gal", "galon", "galones", "doc", "docena", "docenas", "par", "pares", "paq", "paquete", "paquetes", "caja", "cajas",
  "rollo", "rollos", "cto", "ciento", "millar",
]);

const sinPuntoFinal = (t: string): string => (t.endsWith(".") ? t.slice(0, -1) : t);

/** Un token que el diccionario coincide (palabra, plural o abreviatura con punto) ya está activo: no se propone. */
const yaActivo = (token: string, diccionario: DiccionarioGlosas): boolean =>
  diccionario.coincidenciasPorItem([token]).length > 0;

export function proponerTerminos(glosas: readonly string[], diccionario: DiccionarioGlosas): string[] {
  const vistos = new Set<string>();
  const salida: string[] = [];
  for (const glosa of glosas) {
    for (const token of tokensDeGlosa(glosa)) {
      const termino = sinPuntoFinal(token);
      if (vistos.has(termino)) continue;
      vistos.add(termino);
      if (!TERMINO.test(termino) || CON_DIGITO.test(termino)) continue;
      if (PALABRAS_VACIAS.has(termino) || UNIDADES.has(termino) || yaActivo(token, diccionario)) continue;
      if (salida.some((t) => mismaPalabra(t, termino))) continue;
      salida.push(termino);
      if (salida.length === MAX_TERMINOS) return salida;
    }
  }
  return salida;
}
