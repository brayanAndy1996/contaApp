// RSA-OAEP, lado privado (desenvolver). Solo lo alcanza la entrada de descifrado.
import {
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  type KeyObject,
} from "node:crypto";
import { IntegridadError, KeyProviderError } from "../comun/errores";
import {
  exigirRsaFuerte,
  parametrosOaep,
  rechazarFixtureMock,
} from "../comun/rsa";
import { LARGO_DEK } from "../comun/sobre";

export interface ParRsa {
  privada: KeyObject;
  publica: KeyObject;
}

/** Interpreta el PEM de una privada y deriva su pública. PEM inválido → KeyProviderError. */
export function cargarPrivada(pem: Buffer, rechazarMock: boolean): ParRsa {
  let privada: KeyObject;
  try {
    privada = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    throw new KeyProviderError();
  }
  exigirRsaFuerte(privada);
  const publica = createPublicKey(privada);
  if (rechazarMock) rechazarFixtureMock(publica);
  return { privada, publica };
}

/** Todo fallo (llave equivocada, etiqueta, DEK alterada o de otro largo) es IntegridadError. */
export function desenvolverDek(
  privada: KeyObject,
  kekId: string,
  envuelta: Buffer,
): Buffer {
  let dek: Buffer;
  try {
    dek = privateDecrypt(parametrosOaep(privada, kekId), envuelta);
  } catch {
    throw new IntegridadError();
  }
  if (dek.length !== LARGO_DEK) {
    dek.fill(0);
    throw new IntegridadError();
  }
  return dek;
}
