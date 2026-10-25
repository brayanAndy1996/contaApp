// Errores tipados de @contapp/crypto. Mensajes fijos: nunca llevan valores, material de llave
// ni `cause` (CA-9). Ambas entradas del paquete reexportan estas mismas clases.
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

/** El secreto a cifrar no cumple D8 (vacío, largo, mal formado o de otro tipo). */
export class SecretoInvalidoError extends CryptoError {
  constructor() {
    super("secreto_invalido", false, "Secreto inválido");
  }
}

/** Contexto AAD no canónico (UUID, tipo fuera del enum, separadores). */
export class ContextoAadInvalidoError extends CryptoError {
  constructor() {
    super("contexto_invalido", false, "Contexto AAD inválido");
  }
}

/** Sobre con forma inválida (nonce, tag, versión o kek_id); se detecta antes de tocar la llave. */
export class SobreInvalidoError extends CryptoError {
  constructor() {
    super("sobre_invalido", false, "Sobre inválido");
  }
}

/** Fallo de autenticación: tag, AAD, DEK alterada o llave equivocada. No distingue la causa. */
export class IntegridadError extends CryptoError {
  constructor() {
    super("integridad", false, "Fallo de integridad");
  }
}

/** Proveedor de llaves caído: llave faltante, ilegible, corrupta, error o timeout. */
export class KeyProviderError extends CryptoError {
  constructor() {
    super("key_provider", true, "KeyProvider no disponible");
  }
}

/** El sobre usa un kek_id que este proveedor no conoce (otro modo o KEK retirada). */
export class KekDesconocidaError extends CryptoError {
  constructor() {
    super("kek_desconocida", true, "KEK desconocida o retirada");
  }
}

/** Configuración inválida del proveedor: impide arrancar. */
export class ConfiguracionKeyProviderError extends CryptoError {
  constructor() {
    super("configuracion", false, "Configuración del KeyProvider inválida");
  }
}

/**
 * La rotación de KEK no admite la llave `mock` (su privada está en el repo): re-envolver DEKs reales
 * con ella sería un downgrade. Se lanza antes de tocar la BD o la llave.
 */
export class RotacionConMockError extends CryptoError {
  constructor() {
    super("rotacion_mock", false, "La rotación de KEK no admite la llave mock");
  }
}

/** Normaliza cualquier fallo de un proveedor: los errores propios pasan, el resto es KeyProviderError. */
export function aErrorProveedor(e: unknown): CryptoError {
  return e instanceof CryptoError ? e : new KeyProviderError();
}
