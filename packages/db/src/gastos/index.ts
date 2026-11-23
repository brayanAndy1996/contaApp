// Repositorio de gastos no deducibles (spec 027). Escribe solo por las funciones acotadas de 0070; lee con la RLS del estudio.
export { esUuidGastos, GastosRepoError } from "./errores";
export { leerContextoGastos, leerGlosasCompra } from "./contexto";
export type {
  ContextoGastosLeido,
  PalabraContexto,
  ProveedorDoc,
} from "./contexto";
export {
  agregarPalabra,
  cambiarEstadoGlobal,
  cambiarEstadoPalabra,
  fijarUmbral,
  leerGastosEstudio,
} from "./diccionario";
export type { GastosEstudioLeido } from "./diccionario";
export { fijarCategoriasCliente, leerCategoriasCliente } from "./categorias";
export type { CategoriasClienteLeidas } from "./categorias";
export { aprender, excepcionesSugeridas } from "./aprender";
export { ciiuPendientes, guardarCiiu } from "./ciiu";
