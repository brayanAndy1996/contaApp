// STUB (T5, rojo): punto de entrada de descifrado (solo worker).
export * from "./comun/errores";
export type {
  TipoCredencial,
  CredencialSol,
  CredencialSireApi,
  ValorDe,
  ContextoAad,
  Sobre,
} from "./comun/sobre";
export type { KeyWrapper, OpcionesProveedor } from "./cifrado/fabrica";
export type { KeyUnwrapper } from "./descifrado/fabrica";
export {
  crearKeyUnwrapper,
  crearKeyUnwrapperAnterior,
} from "./descifrado/fabrica";
export { descifrarSobre } from "./descifrado/descifrar";
export { reenvolverDek } from "./descifrado/reenvolver";
export { Secreto } from "./descifrado/secreto";
export { MockKeyProvider } from "./descifrado/mock";
export type { OpcionesMock } from "./cifrado/mock";
