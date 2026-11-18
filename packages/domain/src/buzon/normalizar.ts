// Spec 023 (D-7, CA-5): normalización del asunto para clasificar. Lineal, sin retroceso.

/** Homoglifos cirílicos y griegos (ya en minúsculas) → latín. Mapa cerrado. */
const HOMOGLIFOS_BASE: readonly (readonly [string, string])[] = [
  // Cirílico
  ["а", "a"],
  ["в", "b"],
  ["е", "e"],
  ["һ", "h"],
  ["і", "i"],
  ["ј", "j"],
  ["к", "k"],
  ["м", "m"],
  ["н", "h"],
  ["о", "o"],
  ["р", "p"],
  ["с", "c"],
  ["ѕ", "s"],
  ["т", "t"],
  ["у", "y"],
  ["х", "x"],
  ["ԁ", "d"],
  ["ӏ", "l"],
  ["ԛ", "q"],
  ["ԝ", "w"],
  ["ѵ", "v"],
  // Griego
  ["α", "a"],
  ["β", "b"],
  ["ε", "e"],
  ["η", "n"],
  ["ι", "i"],
  ["κ", "k"],
  ["ν", "v"],
  ["ο", "o"],
  ["ρ", "p"],
  ["τ", "t"],
  ["υ", "u"],
  ["χ", "x"],
  ["ω", "w"],
  ["ϲ", "c"],
  ["ϳ", "j"],
];

/**
 * H-023-2-10: letras de otros bloques que se leen como latinas y que NFKD no descompone. Se dan por punto de código
 * (algunas son casi invisibles en el fuente) y se mapean en mayúscula y en minúscula (`toLowerCase` va antes).
 */
const HOMOGLIFOS_EXTRA: readonly (readonly [number, string])[] = [
  // Latín extendido, IPA y versalitas
  [0x0131, "i"], // ı sin punto
  [0x0269, "i"], // ɩ
  [0x026a, "i"], // ɪ
  [0x0237, "j"], // ȷ
  [0x0251, "a"], // ɑ
  [0x025b, "e"], // ɛ
  [0x0261, "g"], // ɡ
  [0x0262, "g"], // ɢ
  [0x029c, "h"], // ʜ
  [0x029f, "l"], // ʟ
  [0x0274, "n"], // ɴ
  [0x0280, "r"], // ʀ
  [0x028f, "y"], // ʏ
  [0x0299, "b"], // ʙ
  [0x1d00, "a"], // ᴀ
  [0x1d04, "c"], // ᴄ
  [0x1d05, "d"], // ᴅ
  [0x1d07, "e"], // ᴇ
  [0x1d0a, "j"], // ᴊ
  [0x1d0b, "k"], // ᴋ
  [0x1d0d, "m"], // ᴍ
  [0x1d0f, "o"], // ᴏ
  [0x1d18, "p"], // ᴘ
  [0x1d1b, "t"], // ᴛ
  [0x1d1c, "u"], // ᴜ
  [0x1d20, "v"], // ᴠ
  [0x1d21, "w"], // ᴡ
  [0x1d22, "z"], // ᴢ
  [0xa731, "s"], // ꜱ
  // Armenio
  [0x0555, "o"], // Օ
  [0x0585, "o"], // օ
  [0x0578, "n"], // ո
  [0x057d, "u"], // ս
  [0x0570, "h"], // հ
  [0x0581, "g"], // ց
  [0x0566, "q"], // զ
  [0x0561, "w"], // ա
  // Cheroqui (la minúscula de U+13A0.. está en U+AB70..)
  [0x13aa, "a"], // Ꭺ
  [0x13f4, "b"], // Ᏼ
  [0x13df, "c"], // Ꮯ
  [0x13a0, "d"], // Ꭰ
  [0x13ac, "e"], // Ꭼ
  [0x13c0, "g"], // Ꮐ
  [0x13bb, "h"], // Ꮋ
  [0x13a5, "i"], // Ꭵ
  [0x13ab, "j"], // Ꭻ
  [0x13e6, "k"], // Ꮶ
  [0x13de, "l"], // Ꮮ
  [0x13b7, "m"], // Ꮇ
  [0x13e2, "p"], // Ꮲ
  [0x13d2, "r"], // Ꮢ
  [0x13da, "s"], // Ꮪ
  [0x13a2, "t"], // Ꭲ
  [0x13d9, "v"], // Ꮩ
  [0x13b3, "w"], // Ꮃ
  [0x13a9, "y"], // Ꭹ
  [0x13c3, "z"], // Ꮓ
];

const HOMOGLIFOS: ReadonlyMap<string, string> = new Map([
  ...HOMOGLIFOS_BASE,
  ...HOMOGLIFOS_EXTRA.flatMap(([cp, latina]): [string, string][] => {
    const c = String.fromCodePoint(cp);
    return [
      [c, latina],
      [c.toLowerCase(), latina],
    ];
  }),
]);

const MARCAS = /\p{M}/gu;
const ESPACIOS = /\s/gu;
/**
 * Controles, formato (bidi, ancho cero) y sustitutos sueltos: fuera sin dejar hueco. También las «letras» que no se ven
 * (H-023-2-10): los rellenos Hangul (U+115F, U+1160, U+3164, U+FFA0; NFKD lleva los dos últimos a U+1160), las vocales
 * inherentes jemer (U+17B4, U+17B5) y el blanco braille (U+2800).
 */
const INVISIBLES =
  /[\p{Cc}\p{Cf}\p{Cs}\u115F\u1160\u17B4\u17B5\u2800\u3164\uFFA0]/gu;
const LETRA_O_DIGITO = /[\p{L}\p{N}]/u;

/**
 * NFKD sin marcas, minúsculas, controles, bidi y rellenos invisibles fuera, homoglifos (cirílicos, griegos, latín
 * extendido, armenios y cheroquis) a latín,
 * puntuación de abreviaturas fuera ("R.D." → "rd"), espacios colapsados y recortados.
 */
export function normalizarAsunto(asunto: string): string {
  const base = asunto
    .normalize("NFKD")
    .toLowerCase()
    .replace(MARCAS, "")
    .replace(ESPACIOS, " ")
    .replace(INVISIBLES, "");
  let salida = "";
  let espacio = false;
  for (const caracter of base) {
    if (caracter === ".") continue;
    const c = HOMOGLIFOS.get(caracter) ?? caracter;
    if (LETRA_O_DIGITO.test(c)) {
      if (espacio && salida.length > 0) salida += " ";
      espacio = false;
      salida += c;
    } else {
      espacio = true;
    }
  }
  return salida;
}
