// STUB (spec 023, T1): solo tipos y constantes para compilar. La lógica la implementa T8.

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

function noImplementado(nombre: string): never {
  throw new Error(`no implementado: ${nombre}`);
}

export const CATALOGO_BUZON: CatalogoBuzon = {
  get version(): number {
    return noImplementado("CATALOGO_BUZON.version");
  },
  get categorias(): readonly CategoriaCatalogo[] {
    return noImplementado("CATALOGO_BUZON.categorias");
  },
};
