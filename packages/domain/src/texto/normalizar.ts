// Spec 011, D-5: normalización simple de glosas. Lógica pura, lineal, sin regex con retroceso.

const MARCAS = /\p{M}+/gu;

const PUNTO = 46;

/** a-z (NaN fuera de la cadena: no es letra). */
function esLetra(c: number): boolean {
  return c >= 97 && c <= 122;
}

function esCaracterDeToken(c: number): boolean {
  return (
    esLetra(c) ||
    (c >= 48 && c <= 57) || // 0-9
    c === PUNTO
  );
}

/**
 * NFKD → quita marcas (\p{M}) → minúsculas → todo lo que no sea [a-z0-9.] separa.
 * Un punto final se conserva en el token: marca una abreviatura ("zapat.") o cierra una palabra
 * completa ("zapatillas."). Un punto seguido de una letra también cierra el token (T13, R1b-7):
 * "zapat.dep." → "zapat.", "dep."; el punto interior de un número se conserva ("1.50").
 */
export function tokensDeGlosa(glosa: string): readonly string[] {
  const limpia = glosa
    .normalize("NFKD")
    .toLowerCase()
    .replace(MARCAS, "");
  const tokens: string[] = [];
  let inicio = -1;
  for (let i = 0; i < limpia.length; i++) {
    const c = limpia.charCodeAt(i);
    if (esCaracterDeToken(c)) {
      if (inicio < 0) inicio = i;
      if (c === PUNTO && esLetra(limpia.charCodeAt(i + 1))) {
        tokens.push(limpia.slice(inicio, i + 1));
        inicio = -1;
      }
    } else if (inicio >= 0) {
      tokens.push(limpia.slice(inicio, i));
      inicio = -1;
    }
  }
  if (inicio >= 0) tokens.push(limpia.slice(inicio));
  return Object.freeze(tokens);
}
