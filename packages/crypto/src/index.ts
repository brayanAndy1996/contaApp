// STUB (T5, rojo): punto de entrada de cifrado (backend).
export * from "./comun/errores";
export type {
  TipoCredencial,
  CredencialSol,
  CredencialSireApi,
  ValorDe,
  ContextoAad,
  Sobre,
} from "./comun/sobre";
export { crearKeyWrapper } from "./cifrado/fabrica";
export type { KeyWrapper, OpcionesProveedor } from "./cifrado/fabrica";
export { cifrarCredencial } from "./cifrado/cifrar";
export { MockKeyProvider } from "./cifrado/mock";
export type { OpcionesMock } from "./cifrado/mock";
