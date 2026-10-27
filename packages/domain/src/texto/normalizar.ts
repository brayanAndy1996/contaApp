// Spec 011, D-5: normalización simple de glosas. Lógica pura, lineal, sin regex con retroceso.

const MARCAS = /\p{M}+/gu;

function esCaracterDeToken(c: number): boolean {
  return (
    (c >= 97 && c <= 122) || // a-z
    (c >= 48 && c <= 57) || // 0-9
    c === 46 // .
  );
}

/**
 * NFKD → quita marcas (\p{M}) → minúsculas → todo lo que no sea [a-z0-9.] separa.
 * Un punto final se conserva en el token: marca una abreviatura ("zapat.").
 */
export function tokensDeGlosa(glosa: string): readonly string[] {
  const limpia = glosa
    .normalize("NFKD")
    .toLowerCase()
    .replace(MARCAS, "");
  const tokens: string[] = [];
  let inicio = -1;
  for (let i = 0; i < limpia.length; i++) {
    if (esCaracterDeToken(limpia.charCodeAt(i))) {
      if (inicio < 0) inicio = i;
    } else if (inicio >= 0) {
      tokens.push(limpia.slice(inicio, i));
      inicio = -1;
    }
  }
  if (inicio >= 0) tokens.push(limpia.slice(inicio));
  return Object.freeze(tokens);
}
