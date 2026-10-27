// RSA-OAEP 4096 con SHA-256, lado público (envolver). Este módulo nunca abre una llave privada.
import {
  constants,
  createHash,
  createPublicKey,
  publicEncrypt,
  type KeyObject,
} from "node:crypto";
import {
  ConfiguracionKeyProviderError,
  KeyProviderError,
} from "./errores";

export const MODULO_MINIMO = 4096;
export const KEK_ID_MOCK = "mock";

/** Huella SHA-256 del SPKI de la pública del fixture `mock` (`local` la rechaza). */
export const HUELLA_SPKI_MOCK =
  "b93658d83541b6501ec40f6a9a5c11b7b18ce012f25bb8ac83b7995735c86233";

/** Etiqueta OAEP: ata la DEK envuelta a su kek_id. */
export function etiquetaOaep(kekId: string): Buffer {
  return Buffer.from(`contapp-kek|v1|${kekId}`, "utf8");
}

export function parametrosOaep(llave: KeyObject, kekId: string) {
  return {
    key: llave,
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha256",
    oaepLabel: etiquetaOaep(kekId),
  };
}

export function huellaSpki(publica: KeyObject): string {
  const der = publica.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

/** Exige RSA de al menos 4096 bits. */
export function exigirRsaFuerte(llave: KeyObject): void {
  const bits = llave.asymmetricKeyDetails?.modulusLength ?? 0;
  if (llave.asymmetricKeyType !== "rsa" || bits < MODULO_MINIMO) {
    throw new ConfiguracionKeyProviderError();
  }
}

/** Rechaza la llave del fixture `mock` fuera del modo mock. */
export function rechazarFixtureMock(publica: KeyObject): void {
  if (huellaSpki(publica) === HUELLA_SPKI_MOCK) {
    throw new ConfiguracionKeyProviderError();
  }
}

/**
 * Interpreta el PEM de una llave pública. Si el archivo trae una privada, es un error de
 * configuración (el backend nunca debe tenerla); si no es una llave válida, el proveedor está caído.
 */
export function cargarPublica(pem: Buffer, rechazarMock: boolean): KeyObject {
  if (pem.toString("latin1").includes("PRIVATE KEY")) {
    throw new ConfiguracionKeyProviderError();
  }
  let publica: KeyObject;
  try {
    publica = createPublicKey({ key: pem, format: "pem" });
  } catch {
    throw new KeyProviderError();
  }
  exigirRsaFuerte(publica);
  if (rechazarMock) rechazarFixtureMock(publica);
  return publica;
}

export function envolverDek(
  publica: KeyObject,
  kekId: string,
  dek: Buffer,
): Buffer {
  return publicEncrypt(parametrosOaep(publica, kekId), dek);
}
