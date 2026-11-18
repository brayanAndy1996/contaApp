// Spec 023 · T19 · ronda adversarial 2 (dominio): asunto crítico disfrazado para que salga «otro» (D-7, CA-5, P-3: «ante la duda,
// crítico»). Caja negra: `clasificarMensaje` con asuntos reales de SUNAT escritos con invisibles, homoglifos y abreviaturas.
// Caja blanca: `normalizar.ts` (mapa cerrado de homoglifos, invisibles = Cc/Cf/Cs) y `catalogo.ts` (frases, siglas y débiles
// como subcadenas exactas).
// Los caracteres raros se arman con su punto de código (`u(0x200b)`) para que ningún formateador los deje invisibles en el fuente.
// Hallazgos H-023-2-n: marcados con `it.fails` en T19; T21 los corrige y vuelven a `it`.
import { describe, expect, it } from "vitest";
import { clasificarMensaje } from "./index";

const u = (cp: number): string => String.fromCodePoint(cp);

const sinCodigo = (asunto: string) =>
  clasificarMensaje({ codigoTipo: null, asunto });

/** Los asuntos de la lista que NO salen críticos. */
function noSalenCriticos(casos: readonly string[]): string[] {
  return casos.filter((a) => !sinCodigo(a).critico);
}

describe("D-7 · espacios de ancho cero y caracteres de formato dentro de la palabra clave", () => {
  it("ZWSP, ZWNJ, ZWJ, WORD JOINER, BOM, guion blando, separador mongol, LRM, RLO e INVISIBLE TIMES dentro de la palabra siguen siendo críticos", () => {
    const invisibles = [
      0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x180e, 0x200e, 0x202e,
      0x2062,
    ].map(u);
    const asuntos = invisibles.flatMap((z) => [
      `Resolución de Ejecución Co${z}activa N° 0230`,
      `Resolución de Mu${z}lta N° 012-002`,
      `Requerimiento de Fiscali${z}zación - Carta 26`,
      `Resolución de Determi${z}nación 012-003`,
    ]);
    expect(noSalenCriticos(asuntos)).toEqual([]);
  });
});

describe("H-023-2-10 · homoglifos fuera del mapa y letras invisibles (D-7, CA-5)", () => {
  // Media: el mapa cerrado de `normalizar.ts` solo cubre cirílico y griego. Letras latinas extendidas, armenias, cheroquis y
  // los «rellenos» Hangul (U+3164, U+FFA0, U+115F) son \p{L}: no se quitan como invisibles ni se mapean, y parten la frase.
  // Un crítico así sale «otro», sin aviso.
  it(
    "ı latina sin punto, ɑ latina, օ armenia, ᴏ versalita, Ꮯ cheroqui y rellenos Hangul invisibles no esconden el crítico",
    () => {
      const asuntos = [
        `Resolución de Ejecución Coact${u(0x0131)}va N° 0230`, // ı latina sin punto
        `Resoluci${u(0x0585)}n de Ejecuci${u(0x0585)}n C${u(0x0585)}activa`, // օ armenia
        `Notificación: Co${u(0x0251)}ctiva`, // ɑ latina
        `Ejecución C${u(0x1d0f)}activa`, // ᴏ versalita
        `Ejecución ${u(0x13df)}oactiva - Exp. 0230`, // Ꮯ cheroqui
        `Resolución de Mu${u(0x3164)}lta N° 012-002`, // relleno Hangul (NFKD -> U+1160, letra)
        `Requerimiento de Fiscaliza${u(0xffa0)}ción`, // relleno Hangul de ancho medio
        `Resolución de Determ${u(0x115f)}inación`, // relleno de inicial Hangul
      ];
      expect(noSalenCriticos(asuntos)).toEqual([]);
    },
  );
});

describe("H-023-2-11 · abreviaturas nuevas de SUNAT (D-7, CA-5)", () => {
  // Media: frases y débiles son subcadenas completas ("coactiv", "fiscalizacion", "determinacion", "multa"). Las abreviaturas
  // usuales en las esquelas ("Cob. Coact.", "Req. Fisc.", "Resol. Determ.", "Res. Mult.") no contienen ninguna y salen
  // «otro»; ni siquiera llegan a `duda`, contra «ante la duda, gana crítico».
  it(
    "Cob. Coact., Ejec. Coact., Req. Fisc., Requer. de Fiscaliz., Resol. Determ., Res. Det. y Res. Mult. son críticos",
    () => {
      const asuntos = [
        "Esquela - Proced. de Cob. Coact. N° 0230",
        "Ejec. Coact. - Exp. 0230-2026",
        "Req. Fisc. N° 0122260001234",
        "Requer. de Fiscaliz. - Carta 26",
        "Resol. Determ. N° 012-003-0001234",
        "Res. Det. N° 012-003-0001234",
        "Res. Mult. N° 012-002-0000456",
      ];
      expect(noSalenCriticos(asuntos)).toEqual([]);
    },
  );
});
