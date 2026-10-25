// STUB (T5, rojo): solo las clases tipadas del contrato; la implementación real es T9.
export class CryptoError extends Error {
  readonly codigo: string;
  readonly reintentable: boolean;
  constructor(codigo: string, reintentable: boolean, mensaje: string) {
    super(mensaje);
    this.name = new.target.name;
    this.codigo = codigo;
    this.reintentable = reintentable;
  }
}
export class SecretoInvalidoError extends CryptoError {
  constructor() {
    super("secreto_invalido", false, "Secreto inválido");
  }
}
export class ContextoAadInvalidoError extends CryptoError {
  constructor() {
    super("contexto_invalido", false, "Contexto AAD inválido");
  }
}
export class SobreInvalidoError extends CryptoError {
  constructor() {
    super("sobre_invalido", false, "Sobre inválido");
  }
}
export class IntegridadError extends CryptoError {
  constructor() {
    super("integridad", false, "Fallo de integridad");
  }
}
export class KeyProviderError extends CryptoError {
  constructor() {
    super("key_provider", true, "KeyProvider no disponible");
  }
}
export class KekDesconocidaError extends CryptoError {
  constructor() {
    super("kek_desconocida", true, "KEK desconocida o retirada");
  }
}
export class ConfiguracionKeyProviderError extends CryptoError {
  constructor() {
    super("configuracion", false, "Configuración del KeyProvider inválida");
  }
}
