// De una tabla cruda (registros de celdas de texto) a `FilaLeida[]`: cabecera, columnas y tope de filas.
// Común a los lectores `.xlsx` y `.csv`. Pura: sin IO ni logs; los errores llevan solo el código.
import {
  ErrorArchivo,
  LIMITES,
  type ArchivoLeido,
  type Columna,
  type FilaLeida,
} from "./tipos.js";

export interface Registro {
  /** Número de fila del archivo (1 = primera). */
  n: number;
  celdas: string[];
  /** Índices de las celdas que traían una fórmula real. */
  formulas?: ReadonlySet<number>;
}

/** Cabecera normalizada (minúsculas, sin tildes, `_` y espacios colapsados) -> columna. */
const COLUMNAS: ReadonlyMap<string, Columna> = new Map([
  ["ruc", "ruc"],
  ["razon social", "razonSocial"],
  ["usuario sol", "usuarioSol"],
  ["clave sol", "claveSol"],
  ["client id", "clientId"],
  ["client secret", "clientSecret"],
  ["responsable", "responsable"],
]);

/** D7: la razón social es opcional; las demás columnas de la plantilla son obligatorias. */
const OBLIGATORIAS: readonly Columna[] = [
  "ruc",
  "usuarioSol",
  "claveSol",
  "clientId",
  "clientSecret",
  "responsable",
];

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[\s_]+/g, " ")
    .trim();
}

const vacio = (r: Registro) =>
  (r.formulas?.size ?? 0) === 0 && r.celdas.every((c) => c.trim() === "");

/**
 * La primera fila no vacía es la cabecera. Las filas totalmente vacías se omiten sin renumerar. Lanza
 * `columnas_faltantes` si falta una columna obligatoria y `demasiadas_filas` en cuanto se supera el tope
 * (sin seguir acumulando).
 */
export function construirFilas(registros: Iterable<Registro>): ArchivoLeido {
  let indices: Map<Columna, number> | null = null;
  const filas: FilaLeida[] = [];
  // La cabecera y las filas vacías también cuentan contra el tope (cabecera + maxFilas): así no hay más de maxFilas
  // filas de datos y un archivo de millones de filas vacías no cuesta trabajo proporcional (H-007b-1).
  let vistos = 0;
  for (const r of registros) {
    if (++vistos > LIMITES.maxFilas + 1)
      throw new ErrorArchivo("demasiadas_filas");
    if (vacio(r)) continue;
    if (indices === null) {
      indices = new Map();
      r.celdas.forEach((c, i) => {
        const col = COLUMNAS.get(normalizar(c));
        if (col === undefined) return;
        if (indices!.has(col)) throw new ErrorArchivo("archivo_invalido");
        indices!.set(col, i);
      });
      if (OBLIGATORIAS.some((c) => !indices!.has(c)))
        throw new ErrorArchivo("columnas_faltantes");
      continue;
    }
    const valor = (col: Columna) => {
      const i = indices!.get(col);
      return i === undefined ? "" : (r.celdas[i] ?? "");
    };
    const formulas: Columna[] = [];
    for (const [col, i] of indices) if (r.formulas?.has(i)) formulas.push(col);
    filas.push({
      n: r.n,
      // Solo el RUC se recorta: las claves llegan tal cual y el resto lo juzga la validación.
      ruc: valor("ruc").trim(),
      razonSocial: valor("razonSocial"),
      usuarioSol: valor("usuarioSol"),
      claveSol: valor("claveSol"),
      clientId: valor("clientId"),
      clientSecret: valor("clientSecret"),
      responsable: valor("responsable"),
      formulas,
    });
  }
  if (indices === null) throw new ErrorArchivo("archivo_invalido");
  return { filas };
}
