// Punto de entrada de cifrado (lo usa el backend). Nunca alcanza el código de descifrado.
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
export { crearKeyWrapper } from "./cifrado/fabrica";
export type { KeyWrapper, OpcionesProveedor } from "./cifrado/fabrica";
export { cifrarCredencial } from "./cifrado/cifrar";
export { MockKeyProvider } from "./cifrado/mock";
export type { OpcionesMock } from "./cifrado/mock";
