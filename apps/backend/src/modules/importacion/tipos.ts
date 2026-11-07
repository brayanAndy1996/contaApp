// Contrato público del lector de archivos de importación (spec 007b, D7; plan: Decisiones "Lector propio mínimo").
// Stub de T3: solo tipos y constantes; la lógica la escribe T11 (lectores y validación) y T12b (plantilla).

/**
 * Topes de un lector. Cada uso trae los suyos (clientes: `LIMITES`; ventas: `LIMITES_VENTAS`); el lector no sabe de
 * quién son y aplica todos igual: bytes antes de leer, entradas, descompresión real y filas contando las vacías.
 */
export interface Limites {
  readonly maxFilas: number;
  /** Columnas que se leen: lo que pase de aquí se ignora (no cuesta trabajo). */
  readonly maxColumnas: number;
  readonly maxBytes: number;
  readonly maxDescomprimido: number;
}

/** Importación de clientes (007b): la plantilla tiene 7 columnas. */
export const LIMITES: Limites = {
  maxFilas: 1000,
  maxColumnas: 32,
  maxBytes: 2 * 1024 * 1024,
  maxDescomprimido: 20 * 1024 * 1024,
};

/**
 * Importación de la propuesta de ventas (013, D10): 20.000 filas de 16 columnas pesan unos 2,5 MB en `.csv` y hasta
 * ~20 MB de XML descomprimido en `.xlsx`. El tope de bytes deja holgura sobre eso y queda lejos de los 64 MB y de las
 * bombas de 120 MB que debe rechazar; el de descompresión sigue siendo un múltiplo pequeño del archivo permitido.
 */
export const LIMITES_VENTAS: Limites = {
  maxFilas: 20_000,
  maxColumnas: 32,
  maxBytes: 8 * 1024 * 1024,
  maxDescomprimido: 32 * 1024 * 1024,
};

/**
 * Códigos con que un lector rechaza el archivo completo. El controlador los mapea a HTTP:
 * `archivo_demasiado_grande` -> 413; los otros tres -> 400. El mensaje del error es solo el código
 * (nunca el contenido de una celda).
 */
export type CodigoErrorArchivo =
  | "archivo_invalido"
  | "columnas_faltantes"
  | "demasiadas_filas"
  | "archivo_demasiado_grande";

export class ErrorArchivo extends Error {
  constructor(readonly codigo: CodigoErrorArchivo) {
    super(codigo);
    this.name = "ErrorArchivo";
  }
}

export type Columna =
  | "ruc"
  | "razonSocial"
  | "usuarioSol"
  | "claveSol"
  | "clientId"
  | "clientSecret"
  | "responsable";

/**
 * Una fila de datos tal como viene en el archivo. Todos los campos son texto ("" si la celda está vacía).
 * `n` es el número de fila del archivo (la cabecera es la 1; la primera de datos, la 2).
 * `formulas` lista las columnas cuya celda traía una fórmula real (`<f>` en `.xlsx`); el lector no las evalúa.
 */
export interface FilaLeida {
  n: number;
  ruc: string;
  razonSocial: string;
  usuarioSol: string;
  claveSol: string;
  clientId: string;
  clientSecret: string;
  responsable: string;
  formulas: Columna[];
}

export interface ArchivoLeido {
  filas: FilaLeida[];
}
