// Registro de persistidores por libro del SIRE (spec 013, D2). 014 agrega aquí el de compras (una línea) y no toca
// el procesador común.
import { persistidorVentas } from "./ventas.js";
import type { PersistidoresLibro } from "./tipos.js";

export const PERSISTIDORES: PersistidoresLibro = {
  ventas: persistidorVentas,
};

export { ErrorPropuesta } from "./errores.js";
export type { DetalleErrorPropuesta } from "./errores.js";
export type {
  ContextoPersistidor,
  FilaPreparada,
  LibroSire,
  PersistidorLibro,
  PersistidoresLibro,
} from "./tipos.js";
