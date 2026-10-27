// Punto de entrada de descifrado (solo el worker; la regla de lint impide que lo importe el backend).
export {
  CryptoError,
  SecretoInvalidoError,
  ContextoAadInvalidoError,
  SobreInvalidoError,
  IntegridadError,
  KeyProviderError,
  KekDesconocidaError,
  ConfiguracionKeyProviderError,
  RotacionConMockError,
} from "./comun/errores";
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
export { esLlaveMock, reenvolverDek } from "./descifrado/reenvolver";
export { Secreto, SecretoDestruidoError } from "./descifrado/secreto";
export { MockKeyProvider } from "./descifrado/mock";
export type { OpcionesMock } from "./cifrado/mock";
