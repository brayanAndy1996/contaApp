// Spec 011, D-5: normalización simple de glosas. Lógica pura, lineal, sin regex con retroceso.

const MARCAS = /\p{M}+/gu;

const PUNTO = 46;

/** a-z (NaN fuera de la cadena: no es letra). */
function esLetra(c: number): boolean {
  return c >= 97 && c <= 122;
}

/** 0-9 (NaN fuera de la cadena: no es dígito). */
function esDigito(c: number): boolean {
  return c >= 48 && c <= 57;
}

/**
 * NFKD → quita marcas (\p{M}) → minúsculas → todo lo que no sea [a-z0-9.] separa.
 * Un punto después de una letra cierra el token y se conserva en él: marca una abreviatura
 * ("zapat.") o cierra una palabra completa ("zapatillas.", también ante dígitos: "zapatillas.38")
 * (T13 y T15, decisión del usuario sobre R1b-7). El punto entre dos dígitos se conserva ("1.50").
 * Cualquier otro punto separa: los repetidos ("zapat...", "…" → "...") y el que sigue a un dígito.
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
    if (esLetra(c) || esDigito(c)) {
      if (inicio < 0) inicio = i;
    } else if (c === PUNTO && inicio >= 0 && esLetra(limpia.charCodeAt(i - 1))) {
      tokens.push(limpia.slice(inicio, i + 1));
      inicio = -1;
    } else if (c !== PUNTO || inicio < 0 || !esDigito(limpia.charCodeAt(i + 1))) {
      // Separador; un punto con un dígito antes (inicio ≥ 0 y sin letra antes) y uno después
      // es decimal y sigue en el token.
      if (inicio >= 0) tokens.push(limpia.slice(inicio, i));
      inicio = -1;
    }
  }
  if (inicio >= 0) tokens.push(limpia.slice(inicio));
  return Object.freeze(tokens);
}
