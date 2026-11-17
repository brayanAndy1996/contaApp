// Spec 023, T1 (CA-5, D-7, P-3): clasificación de mensajes del buzón SOL. Rojo: sin implementación.
import { describe, expect, it } from "vitest";
import {
  CATALOGO_BUZON,
  clasificarMensaje,
  normalizarAsunto,
  type CategoriaCritica,
} from "./index";

const CRITICAS: readonly CategoriaCritica[] = [
  "coactiva",
  "resolucion_determinacion",
  "resolucion_multa",
  "requerimiento_fiscalizacion",
];

function codigoDe(categoria: CategoriaCritica): string {
  const c = CATALOGO_BUZON.categorias.find((x) => x.categoria === categoria);
  const codigo = c?.codigosTipo[0];
  if (codigo === undefined)
    throw new Error(`el catálogo no tiene código para ${categoria}`);
  return codigo;
}

describe("CATALOGO_BUZON", () => {
  it("tiene versión entera >= 1", () => {
    expect(Number.isInteger(CATALOGO_BUZON.version)).toBe(true);
    expect(CATALOGO_BUZON.version).toBeGreaterThanOrEqual(1);
  });

  it("solo las cuatro categorías críticas, sin duplicar y sin «otro»", () => {
    const nombres = CATALOGO_BUZON.categorias.map((c) => c.categoria);
    expect([...nombres].sort()).toEqual([...CRITICAS].sort());
  });

  it("cada categoría crítica tiene al menos un código de tipo y no se repiten entre categorías", () => {
    const todos: string[] = [];
    for (const c of CATALOGO_BUZON.categorias) {
      expect(c.codigosTipo.length, c.categoria).toBeGreaterThan(0);
      todos.push(...c.codigosTipo);
    }
    expect(new Set(todos).size).toBe(todos.length);
  });
});

describe("normalizarAsunto", () => {
  it("minúsculas, sin tildes, espacios colapsados y recortados", () => {
    expect(normalizarAsunto("  RESOLUCIÓN   de\tMULTA \n")).toBe(
      "resolucion de multa",
    );
  });

  it("quita la puntuación de las abreviaturas", () => {
    expect(normalizarAsunto("R.D.")).toBe("rd");
    expect(normalizarAsunto("Res. de Multa")).toBe("res de multa");
  });

  it("pasa los homoglifos cirílicos a latín", () => {
    // с, о, а cirílicas
    expect(normalizarAsunto("соаctiva")).toBe("coactiva");
  });

  it("quita controles y marcas bidireccionales", () => {
    expect(normalizarAsunto("Mul\u0000t\u0007a‮")).toBe("multa");
  });
});

describe("clasificarMensaje: crítico por asunto (código ausente)", () => {
  const casos: readonly [string, string, CategoriaCritica][] = [
    [
      "coactiva simple",
      "Resolución de Ejecución Coactiva N° 0230070012345",
      "coactiva",
    ],
    [
      "coactiva en mayúsculas",
      "NOTIFICACIÓN DE RESOLUCIÓN COACTIVA",
      "coactiva",
    ],
    [
      "coactiva sin tildes y espacios dobles",
      "Ejecucion   Coactiva",
      "coactiva",
    ],
    [
      "determinación completa",
      "Resolución de Determinación N° 012-003-0001234",
      "resolucion_determinacion",
    ],
    [
      "determinación sin tildes",
      "RESOLUCION DE DETERMINACION",
      "resolucion_determinacion",
    ],
    [
      "determinación «R.D.»",
      "R.D. N° 012-003-0004567",
      "resolucion_determinacion",
    ],
    [
      "multa completa",
      "Resolución de Multa N° 022-002-0003456",
      "resolucion_multa",
    ],
    [
      "multa «Res. de Multa»",
      "Res. de Multa N° 022-002-0003456",
      "resolucion_multa",
    ],
    ["multa en mayúsculas", "RESOLUCIÓN DE MULTA", "resolucion_multa"],
    [
      "fiscalización completa",
      "Requerimiento de Fiscalización N° 0222240000123",
      "requerimiento_fiscalizacion",
    ],
    [
      "fiscalización «REQ. FISCALIZACIÓN»",
      "REQ. FISCALIZACIÓN N° 0222240000123",
      "requerimiento_fiscalizacion",
    ],
    [
      "fiscalización con espacios dobles",
      "Requerimiento   de   fiscalizacion",
      "requerimiento_fiscalizacion",
    ],
    // Homoglifos cirílicos: с (U+0441), о (U+043E), а (U+0430).
    ["coactiva con homoglifos", "Ejecuciоn соасtiva", "coactiva"],
    ["multa con homoglifos", "Resoluciоn de Multа", "resolucion_multa"],
    [
      "determinación con homoglifos",
      "Resoluciоn de Determinaciоn",
      "resolucion_determinacion",
    ],
    [
      "fiscalización con homoglifos",
      "Requerimiento de fiscаlizaciоn",
      "requerimiento_fiscalizacion",
    ],
    // Caracteres de control y bidi dentro de las palabras.
    [
      "multa con controles",
      "Res\u0000oluci\u0007ón de Mul\u0000ta",
      "resolucion_multa",
    ],
    ["coactiva con bidi", "Ejecución Coa\u202Ectiva\u202C", "coactiva"],
  ];

  it.each(casos)("%s", (_nombre, asunto, categoria) => {
    const r = clasificarMensaje({ codigoTipo: null, asunto });
    expect(r.categoria).toBe(categoria);
    expect(r.critico).toBe(true);
    expect(r.motivo).toBe("asunto");
    expect(r.versionCatalogo).toBe(CATALOGO_BUZON.version);
  });
});

describe("clasificarMensaje: crítico por código de tipo", () => {
  it.each(CRITICAS)(
    "el código de %s lo hace crítico aunque el asunto sea común",
    (categoria) => {
      const r = clasificarMensaje({
        codigoTipo: codigoDe(categoria),
        asunto: "Notificación",
      });
      expect(r).toEqual({
        categoria,
        critico: true,
        motivo: "codigo",
        versionCatalogo: CATALOGO_BUZON.version,
      });
    },
  );

  it("el código gana cuando contradice el asunto", () => {
    const r = clasificarMensaje({
      codigoTipo: codigoDe("coactiva"),
      asunto: "Resolución de Multa N° 022-002-0003456",
    });
    expect(r.categoria).toBe("coactiva");
    expect(r.motivo).toBe("codigo");
  });

  it("el código gana aunque el asunto sea de otra categoría crítica (todas las parejas)", () => {
    const asuntos: Record<CategoriaCritica, string> = {
      coactiva: "Ejecución Coactiva",
      resolucion_determinacion: "Resolución de Determinación",
      resolucion_multa: "Resolución de Multa",
      requerimiento_fiscalizacion: "Requerimiento de Fiscalización",
    };
    for (const porCodigo of CRITICAS) {
      for (const porAsunto of CRITICAS) {
        if (porCodigo === porAsunto) continue;
        const r = clasificarMensaje({
          codigoTipo: codigoDe(porCodigo),
          asunto: asuntos[porAsunto],
        });
        expect(r.categoria, `${porCodigo} vs ${porAsunto}`).toBe(porCodigo);
        expect(r.motivo).toBe("codigo");
      }
    }
  });

  it("un código desconocido no cuenta: decide el asunto", () => {
    const r = clasificarMensaje({
      codigoTipo: "ZZ-999-NO-EXISTE",
      asunto: "Resolución de Multa N° 1",
    });
    expect(r.categoria).toBe("resolucion_multa");
    expect(r.motivo).toBe("asunto");
  });

  it("un código desconocido con asunto común es «otro»", () => {
    const r = clasificarMensaje({
      codigoTipo: "ZZ-999-NO-EXISTE",
      asunto: "Bienvenido al buzón SOL",
    });
    expect(r.critico).toBe(false);
    expect(r.categoria).toBe("otro");
  });
});

describe("clasificarMensaje: ante la duda, crítico", () => {
  it("«embargo» suelto es crítico con motivo duda (coactiva)", () => {
    const r = clasificarMensaje({
      codigoTipo: null,
      asunto: "Aviso de embargo",
    });
    expect(r).toEqual({
      categoria: "coactiva",
      critico: true,
      motivo: "duda",
      versionCatalogo: CATALOGO_BUZON.version,
    });
  });

  it("«multa» suelta es crítico con motivo duda (resolución de multa)", () => {
    const r = clasificarMensaje({
      codigoTipo: null,
      asunto: "Información sobre MULTA tributaria",
    });
    expect(r.critico).toBe(true);
    expect(r.motivo).toBe("duda");
    expect(r.categoria).toBe("resolucion_multa");
  });

  it("la palabra débil disfrazada (tildes, homoglifos, mayúsculas) también es duda", () => {
    const r = clasificarMensaje({
      codigoTipo: null,
      asunto: "AVISO DE EMBаRGO",
    });
    expect(r.critico).toBe(true);
    expect(r.motivo).toBe("duda");
  });

  it("si hay patrón completo, el motivo es asunto y no duda", () => {
    const r = clasificarMensaje({
      codigoTipo: null,
      asunto: "Resolución de Multa por embargo",
    });
    expect(r.critico).toBe(true);
    expect(r.motivo).toBe("asunto");
  });

  it("ningún caso crítico de la tabla sale «otro»", () => {
    const asuntos = [
      "Aviso de embargo",
      "multa",
      "Res. de Multa",
      "R.D.",
      "REQ. FISCALIZACIÓN",
      "Coactiva",
    ];
    for (const asunto of asuntos) {
      const r = clasificarMensaje({ codigoTipo: null, asunto });
      expect(r.critico, asunto).toBe(true);
      expect(r.categoria, asunto).not.toBe("otro");
    }
  });
});

describe("clasificarMensaje: comunes del fixture son «otro»", () => {
  const comunes = [
    "Bienvenido al buzón electrónico SOL",
    "Constancia de presentación de declaración jurada mensual",
    "Comunicado: nuevo cronograma de vencimientos 2026",
    "Recordatorio: pago de tributos del periodo 10",
    "Resultado de solicitud de inscripción de domicilio fiscal",
    "",
  ];
  it.each(comunes)("«%s»", (asunto) => {
    expect(clasificarMensaje({ codigoTipo: null, asunto })).toEqual({
      categoria: "otro",
      critico: false,
      motivo: null,
      versionCatalogo: CATALOGO_BUZON.version,
    });
  });
});
