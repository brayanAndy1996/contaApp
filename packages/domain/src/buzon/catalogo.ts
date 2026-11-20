// Spec 023 (D-7, CA-5; plan, Contratos: Dominio): catálogo versionado de mensajes críticos del
// buzón SOL. Los códigos de categoría (`CATEGORIAS_BUZON`) viven en `shared`; aquí solo están los
// códigos de tipo de SUNAT y los patrones sobre el asunto normalizado (`normalizarAsunto`).

export type CategoriaCritica =
  | "coactiva"
  | "resolucion_determinacion"
  | "resolucion_multa"
  | "requerimiento_fiscalizacion";
export type CategoriaBuzon = CategoriaCritica | "otro";
export type MotivoCritico = "codigo" | "asunto" | "duda";

export interface CategoriaCatalogo {
  readonly categoria: CategoriaCritica;
  /** Códigos de tipo de mensaje de SUNAT que la identifican. */
  readonly codigosTipo: readonly string[];
}

export interface CatalogoBuzon {
  readonly version: number;
  readonly categorias: readonly CategoriaCatalogo[];
}

/**
 * Patrones de una categoría sobre el asunto normalizado. Sin expresiones regulares:
 * - `frases`: subcadenas del asunto sin espacios ("resoluciondemulta"), así un espacio de más o
 *   de menos no evita el patrón.
 * - `siglas`: palabras exactas ("rd", "rm"), porque como subcadena aparecerían en cualquier lado.
 * - `debiles`: subcadenas del asunto sin espacios que, sin patrón completo, dan crítico con
 *   motivo `duda` (D-7: ante la duda, crítico).
 * - `abreviables`: palabras que SUNAT abrevia en las esquelas ("Coact.", "Fisc.", "Determ.", "Det.", "Mult."). Una palabra
 *   del asunto de al menos `LARGO_MINIMO_ABREVIATURA` letras que es el comienzo de una de ellas da crítico con motivo `duda`
 *   (H-023-2-11).
 */
export interface PatronesAsunto {
  readonly categoria: CategoriaCritica;
  readonly frases: readonly string[];
  readonly siglas: readonly string[];
  readonly debiles: readonly string[];
  readonly abreviables: readonly string[];
}

/** Letras mínimas de una abreviatura ("det", "req"): con menos, "de" sería el comienzo de "determinacion". */
export const LARGO_MINIMO_ABREVIATURA = 3;

function congelar<T>(valor: T): T {
  if (typeof valor === "object" && valor !== null && !Object.isFrozen(valor)) {
    for (const v of Object.values(valor)) congelar(v);
    Object.freeze(valor);
  }
  return valor;
}

/**
 * Versión 1. Los códigos de tipo son provisionales hasta que el adaptador real (Playwright)
 * confirme los de SUNAT; cambiar códigos o patrones sube la versión (se guarda en cada mensaje).
 * El orden decide el empate entre categorías.
 */
export const CATALOGO_BUZON: CatalogoBuzon = congelar({
  version: 1,
  categorias: [
    { categoria: "coactiva", codigosTipo: ["REC", "COA"] },
    { categoria: "resolucion_determinacion", codigosTipo: ["RD"] },
    { categoria: "resolucion_multa", codigosTipo: ["RM"] },
    { categoria: "requerimiento_fiscalizacion", codigosTipo: ["RQF", "FIS"] },
  ],
});

export const PATRONES_ASUNTO: readonly PatronesAsunto[] = congelar([
  {
    categoria: "coactiva",
    frases: ["coactiv"],
    siglas: ["rec"],
    debiles: ["embargo"],
    abreviables: ["coactiva", "coactivo"],
  },
  {
    categoria: "resolucion_determinacion",
    frases: [
      "resoluciondedeterminacion",
      "resoluciondeterminacion",
      "resdedeterminacion",
      "resdeterminacion",
    ],
    siglas: ["rd"],
    debiles: ["determinacion"],
    abreviables: ["determinacion"],
  },
  {
    categoria: "resolucion_multa",
    frases: [
      "resoluciondemulta",
      "resolucionmulta",
      "resdemulta",
      "resmulta",
    ],
    siglas: ["rm"],
    debiles: ["multa"],
    abreviables: ["multa"],
  },
  {
    categoria: "requerimiento_fiscalizacion",
    frases: [
      "requerimientodefiscalizacion",
      "requerimientofiscalizacion",
      "reqdefiscalizacion",
      "reqfiscalizacion",
    ],
    siglas: [],
    debiles: ["fiscalizacion", "requerimiento"],
    abreviables: ["fiscalizacion", "requerimiento"],
  },
] as const);

/** Palabras corrientes que empiezan como una palabra clave sin abreviarla ("domicilio fiscal"): no son abreviaturas. */
export const EXCEPCIONES_ABREVIATURAS: readonly string[] = congelar(["fiscal"]);

/** Frases que contienen una palabra débil sin ser críticas ("sin embargo"); se quitan antes. */
export const EXCEPCIONES_DEBILES: readonly string[] = congelar(["sinembargo"]);
