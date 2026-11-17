// Spec 023 · T20 · pruebas de las correcciones de la ronda adversarial 2 (dominio; rojo, las corrige T21). Fijan el comportamiento
// esperado de `clasificarMensaje` como invariante (D-7, CA-5, P-3: «ante la duda, crítico»), sin mirar cómo se normaliza.
// Los caracteres raros se arman con su punto de código para que ningún formateador los deje invisibles en el fuente.
import { describe, expect, it } from "vitest";
import { clasificarMensaje } from "./index";

const u = (cp: number): string => String.fromCodePoint(cp);

const sinCodigo = (asunto: string) =>
  clasificarMensaje({ codigoTipo: null, asunto });

describe("H-023-2-10 · homoglifos y rellenos invisibles no esconden un crítico (D-7, CA-5)", () => {
  // Letras latinas extendidas (ı, ɑ), armenia (օ), versalita (ᴏ), cheroqui (Ꮯ) y los rellenos Hangul (U+3164, U+115F, U+FFA0):
  // escribir «Coactiva», «Multa» o «Determinación» con ellas debe dar la MISMA categoría que escribirlas con letras normales.
  const casos: readonly (readonly [string, string])[] = [
    [`Resolución de Ejecución Coact${u(0x0131)}va N° 0230`, "coactiva"], // ı sin punto
    [
      `Resoluci${u(0x0585)}n de Ejecuci${u(0x0585)}n C${u(0x0585)}activa`,
      "coactiva",
    ], // օ armenia
    [`Notificación: Co${u(0x0251)}ctiva`, "coactiva"], // ɑ latina
    [`Ejecución C${u(0x1d0f)}activa`, "coactiva"], // ᴏ versalita
    [`Ejecución ${u(0x13df)}oactiva - Exp. 0230`, "coactiva"], // Ꮯ cheroqui
    [`Resolución de Mu${u(0x3164)}lta N° 012-002`, "resolucion_multa"], // relleno Hangul U+3164
    [`Resolución de Mult${u(0x0251)} N° 012-002`, "resolucion_multa"], // ɑ latina
    [`Resolución de Determ${u(0x115f)}inación`, "resolucion_determinacion"], // relleno de inicial Hangul U+115F
    [
      `Resolución de Determ${u(0x0131)}nación N° 012-003`,
      "resolucion_determinacion",
    ], // ı sin punto
    [
      `Requerimiento de Fiscaliza${u(0xffa0)}ción`,
      "requerimiento_fiscalizacion",
    ], // relleno Hangul de ancho medio
  ];

  it("cada escritura disfrazada sale crítica con la categoría que tendría escrita normalmente", () => {
    const mal = casos
      .map(([asunto, esperada]) => ({ asunto, esperada, c: sinCodigo(asunto) }))
      .filter((x) => !x.c.critico || x.c.categoria !== x.esperada)
      .map(
        (x) =>
          `${JSON.stringify(x.asunto)} -> ${x.c.categoria} (esperada ${x.esperada})`,
      );
    expect(mal).toEqual([]);
  });
});

describe("H-023-2-11 · abreviaturas usuales de SUNAT salen críticas, al menos con motivo «duda» (D-7, CA-5, P-3)", () => {
  const abreviados = [
    "Esquela - Proced. de Cob. Coact. N° 0230",
    "Ejec. Coact. - Exp. 0230-2026",
    "Req. Fisc. N° 0122260001234",
    "Requer. de Fiscaliz. - Carta 26",
    "Resol. Determ. N° 012-003-0001234",
    "Res. Det. N° 012-003-0001234",
    "Res. Mult. N° 012-002-0000456",
  ];

  it("Cob. Coact., Ejec. Coact., Req. Fisc., Requer. de Fiscaliz., Resol. Determ., Res. Det. y Res. Mult. son críticos", () => {
    const mal = abreviados
      .map((asunto) => ({ asunto, c: sinCodigo(asunto) }))
      .filter((x) => !x.c.critico || x.c.motivo === null)
      .map((x) => `${JSON.stringify(x.asunto)} -> ${x.c.categoria} no crítico`);
    expect(mal).toEqual([]);
  });

  it("sin pasarse: comunicados corrientes de SUNAT siguen siendo «otro»", () => {
    const comunes = [
      "Boletín informativo 12",
      "Comunicado: calendario de vencimientos 2026",
      "Resumen mensual de comprobantes electrónicos",
    ];
    expect(comunes.filter((a) => sinCodigo(a).critico)).toEqual([]);
  });
});
