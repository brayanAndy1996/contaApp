// De una tabla cruda (registros de celdas de texto) a `FilaLeida[]`: cabecera, columnas y tope de filas.
// Común a los lectores `.xlsx` y `.csv`. Pura: sin IO ni logs; los errores llevan solo el código.
import {
  ErrorArchivo,
  LIMITES,
  type ArchivoLeido,
  type Columna,
  type FilaLeida,
  type Limites,
} from "./tipos.js";

export interface Registro {
  /** Número de fila del archivo (1 = primera). */
  n: number;
  celdas: string[];
  /** Índices de las celdas que traían una fórmula real. */
  formulas?: ReadonlySet<number>;
}

/**
 * Lo que distingue un uso del lector de otro: sus topes y sus columnas. La cabecera se normaliza (minúsculas, sin
 * tildes, `_` y espacios colapsados) y debe traer todas las `obligatorias`; las columnas ajenas se ignoran.
 */
export interface PerfilTabla<C extends string> {
  readonly limites: Limites;
  /** Cabecera normalizada -> columna. */
  readonly columnas: ReadonlyMap<string, C>;
  readonly obligatorias: readonly C[];
}

/** Una fila de datos de un perfil: todas las columnas son texto ("" si la celda está vacía o no existe). */
export interface FilaTabla<C extends string> {
  /** Número de fila del archivo (la cabecera es la 1; la primera de datos, la 2). */
  n: number;
  valores: Record<C, string>;
  /** Columnas cuya celda traía una fórmula real; el lector no las evalúa. */
  formulas: C[];
}

/** Cabecera normalizada -> columna, para armar un perfil. */
export function columnasDePerfil<C extends string>(nombres: readonly C[]): ReadonlyMap<string, C> {
  return new Map(nombres.map((n) => [normalizar(n), n]));
}

export function normalizar(texto: string): string {
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
export function construirTabla<C extends string>(
  registros: Iterable<Registro>,
  perfil: PerfilTabla<C>,
): FilaTabla<C>[] {
  let indices: Map<C, number> | null = null;
  const filas: FilaTabla<C>[] = [];
  // La cabecera y las filas vacías también cuentan contra el tope (cabecera + maxFilas): así no hay más de maxFilas
  // filas de datos y un archivo de millones de filas vacías no cuesta trabajo proporcional (H-007b-1).
  let vistos = 0;
  for (const r of registros) {
    if (++vistos > perfil.limites.maxFilas + 1)
      throw new ErrorArchivo("demasiadas_filas");
    if (vacio(r)) continue;
    if (indices === null) {
      indices = new Map();
      r.celdas.forEach((c, i) => {
        const col = perfil.columnas.get(normalizar(c));
        if (col === undefined) return;
        if (indices!.has(col)) throw new ErrorArchivo("archivo_invalido");
        indices!.set(col, i);
      });
      if (perfil.obligatorias.some((c) => !indices!.has(c)))
        throw new ErrorArchivo("columnas_faltantes");
      continue;
    }
    const valores = {} as Record<C, string>;
    for (const col of perfil.columnas.values()) valores[col] = "";
    const formulas: C[] = [];
    for (const [col, i] of indices) {
      valores[col] = r.celdas[i] ?? "";
      if (r.formulas?.has(i)) formulas.push(col);
    }
    filas.push({ n: r.n, valores, formulas });
  }
  if (indices === null) throw new ErrorArchivo("archivo_invalido");
  return filas;
}

/** Perfil de la importación de clientes (007b). */
const PERFIL_CLIENTES: PerfilTabla<Columna> = {
  limites: LIMITES,
  columnas: new Map<string, Columna>([
    ["ruc", "ruc"],
    ["razon social", "razonSocial"],
    ["usuario sol", "usuarioSol"],
    ["clave sol", "claveSol"],
    ["client id", "clientId"],
    ["client secret", "clientSecret"],
    ["responsable", "responsable"],
  ]),
  // D7: la razón social es opcional; las demás columnas de la plantilla son obligatorias.
  obligatorias: ["ruc", "usuarioSol", "claveSol", "clientId", "clientSecret", "responsable"],
};

export { PERFIL_CLIENTES };

/** Clientes (007b): igual que `construirTabla` con su perfil, en la forma `FilaLeida`. */
export function construirFilas(registros: Iterable<Registro>): ArchivoLeido {
  const filas: FilaLeida[] = construirTabla(registros, PERFIL_CLIENTES).map((f) => ({
    n: f.n,
    // Solo el RUC se recorta: las claves llegan tal cual y el resto lo juzga la validación.
    ruc: f.valores.ruc.trim(),
    razonSocial: f.valores.razonSocial,
    usuarioSol: f.valores.usuarioSol,
    claveSol: f.valores.claveSol,
    clientId: f.valores.clientId,
    clientSecret: f.valores.clientSecret,
    responsable: f.valores.responsable,
    formulas: f.formulas,
  }));
  return { filas };
}
