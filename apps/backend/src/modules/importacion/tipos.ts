// Contrato público del lector de archivos de importación (spec 007b, D7; plan: Decisiones "Lector propio mínimo").
// Stub de T3: solo tipos y constantes; la lógica la escribe T11 (lectores y validación) y T12b (plantilla).

export const LIMITES = {
  maxFilas: 1000,
  /** Columnas que se leen: la plantilla tiene 7; lo que pase de aquí se ignora (no cuesta trabajo). */
  maxColumnas: 32,
  maxBytes: 2 * 1024 * 1024,
  maxDescomprimido: 20 * 1024 * 1024,
} as const;

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
