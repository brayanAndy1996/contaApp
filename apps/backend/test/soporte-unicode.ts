// Letras que Node acepta (`nombreValido`: \p{L}|\p{Nd}) y el CHECK de nombre de `registro_pendiente` rechaza (b5).
// Qué letras recientes conoce el ICU/ctype de PG cambia con la versión menor y el paquete de la imagen, así que no se
// fija un carácter: se le pregunta a la BD del entorno cuál de los candidatos no cumple `[[:alnum:]]` bajo ICU.
const LETRA_O_DIGITO = /[\p{L}\p{Nd}]/u;
const CONTROL_O_FORMATO = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** Puntos de código con letra o dígito decimal para Node, desde los más nuevos (planos 1 y 2, luego el BMP). */
function candidatas(): string[] {
  const lista: string[] = [];
  const rangos: [number, number][] = [
    [0x10000, 0x1ffff],
    [0x20000, 0x2ffff],
    [0x100, 0xffff],
  ];
  for (const [a, b] of rangos)
    for (let cp = a; cp <= b; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      if (LETRA_O_DIGITO.test(c) && !CONTROL_O_FORMATO.test(c)) lista.push(c);
    }
  return lista;
}

/** Una letra válida para Node que el CHECK de PG rechaza, o `null` si este PG conoce todas las que conoce Node. */
export async function letraQueNodeAceptaYPgRechaza(
  sql: (texto: string, valores?: unknown[]) => Promise<{ c: string }[]>,
): Promise<string | null> {
  const filas = await sql(
    `select c from unnest($1::text[]) as c
      where not ((c collate pg_catalog."und-x-icu") ~ '[[:alnum:]]') limit 1`,
    [candidatas()],
  );
  return filas[0]?.c ?? null;
}
