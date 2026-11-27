import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

// Spec 029 (D1, CA-6). Cifrado del secreto TOTP con AES-256-GCM. Puro: sin IO. Ningún error lleva
// la clave, el secreto ni el cifrado.

const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION_MAX = 32767;

export interface ClaveTotp {
  version: number;
  /** 32 bytes. */
  clave: Buffer;
}

export class ClaveTotpInvalidaError extends Error {
  constructor() {
    super("clave_totp_invalida");
    this.name = "ClaveTotpInvalidaError";
  }
}

export class TotpCifradoError extends Error {
  constructor() {
    super("totp_descifrado_fallido");
    this.name = "TotpCifradoError";
  }
}

/** `<versión>:<base64 de 32 B>` (valor de `TOTP_CLAVE`). El error nunca incluye el valor. */
export function parsearClaveTotp(valor: string): ClaveTotp {
  if (typeof valor !== "string") throw new ClaveTotpInvalidaError();
  const partes = valor.split(":");
  if (partes.length !== 2) throw new ClaveTotpInvalidaError();
  const [textoVersion, b64] = partes as [string, string];
  if (!/^[0-9]{1,5}$/.test(textoVersion)) throw new ClaveTotpInvalidaError();
  const version = Number(textoVersion);
  if (version < 1 || version > VERSION_MAX) throw new ClaveTotpInvalidaError();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new ClaveTotpInvalidaError();
  const clave = Buffer.from(b64, "base64");
  if (clave.length !== 32 || clave.toString("base64") !== b64) {
    throw new ClaveTotpInvalidaError();
  }
  return { version, clave };
}

/** `iv(12) ‖ texto cifrado ‖ tag(16)`; AAD = `usuarioId` en UTF-8 (el secreto no se copia a otra fila). */
export function cifrarSecreto(o: {
  secreto: Buffer;
  usuarioId: string;
  clave: ClaveTotp;
}): { cifrado: Buffer; version: number } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", o.clave.clave, iv);
  cipher.setAAD(Buffer.from(o.usuarioId, "utf8"));
  const texto = Buffer.concat([cipher.update(o.secreto), cipher.final()]);
  return {
    cifrado: Buffer.concat([iv, texto, cipher.getAuthTag()]),
    version: o.clave.version,
  };
}

/** Abre con la clave de esa `version` (actual o anterior). Cualquier fallo es `TotpCifradoError`. */
export function descifrarSecreto(o: {
  cifrado: Buffer;
  version: number;
  usuarioId: string;
  claves: readonly ClaveTotp[];
}): Buffer {
  try {
    const clave = o.claves.find((c) => c.version === o.version);
    if (!clave || o.cifrado.length < IV_BYTES + TAG_BYTES) {
      throw new TotpCifradoError();
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      clave.clave,
      o.cifrado.subarray(0, IV_BYTES),
    );
    decipher.setAAD(Buffer.from(o.usuarioId, "utf8"));
    decipher.setAuthTag(o.cifrado.subarray(o.cifrado.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(
        o.cifrado.subarray(IV_BYTES, o.cifrado.length - TAG_BYTES),
      ),
      decipher.final(),
    ]);
  } catch {
    throw new TotpCifradoError();
  }
}
