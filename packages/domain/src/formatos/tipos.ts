// Tipos de formatos/ (plan 012, Contratos). Conteos y longitudes con `Entero`, nunca dinero.
import type { Entero } from "../texto/entero";

/** Libro del registro. 013 agrega "ventas" (D15). */
export type Libro = "compras";

export type Codificacion = "ascii" | "latin1" | "utf8";

export type FinDeLinea = "\r\n" | "\n";

export type TipoCampo = "texto" | "ruc" | "fecha" | "monto" | "tc" | "codigo";

export interface CampoTxt {
  readonly nombre: string;
  readonly obligatorio: boolean;
  /** En caracteres (en latin1 coincide con los bytes). */
  readonly longitudMax: Entero;
  /** Sin banderas `g` ni `y`; nunca acepta el separador del formato. */
  readonly patron?: RegExp;
  readonly tipo: TipoCampo;
}

export interface ComponentesNombre {
  readonly ruc: string;
  readonly periodo: string;
}

export interface NombresArchivo {
  readonly nombreTxt: string;
  readonly nombreZip: string;
}

export type FuncionNombre = (c: ComponentesNombre) => NombresArchivo;

export interface FormatoTxt {
  readonly id: string;
  readonly libro: Libro;
  readonly version: string;
  /** AAAAMM desde el que rige (D5). */
  readonly vigenteDesde: string;
  readonly oficial: boolean;
  readonly codificacion: Codificacion;
  readonly separador: string;
  readonly finDeLinea: FinDeLinea;
  readonly campos: readonly CampoTxt[];
  /** El provisional no incluye las excluidas (D14). */
  readonly incluyeExcluidas: boolean;
  readonly nombre: FuncionNombre;
}

export interface CabeceraTxt {
  readonly rucDeclarante: string;
  readonly periodo: string;
  readonly libro: Libro;
}

export type CodigoCampo = "CAMPO_OBLIGATORIO" | "LONGITUD" | "PATRON" | "CARACTER_NO_PERMITIDO" | "RUC_INVALIDO";

/** Resultado de `validarCampo` cuando el valor no es válido. */
export interface ErrorCampo {
  readonly codigo: CodigoCampo;
  /** Índice UTF-16 desde 0 del primer carácter ofensor; `null` si el error no es de un carácter. */
  readonly posicion: Entero | null;
}
