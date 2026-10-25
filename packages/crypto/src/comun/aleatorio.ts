// DEK (32 B) y nonce (12 B) del CSPRNG de node:crypto, con guarda contra un RNG atascado.
// El RNG solo es inyectable aquí (pruebas internas); la API pública no lo expone.
import { createHash, randomBytes } from "node:crypto";
import { CryptoError } from "./errores";
import { LARGO_DEK, LARGO_NONCE } from "./sobre";

export type Rng = (n: number) => Buffer;

export interface Material {
  dek: Buffer;
  nonce: Buffer;
}

export class RngNoConfiableError extends CryptoError {
  constructor() {
    super("rng", false, "Generador aleatorio no confiable");
  }
}

/** Devuelve un generador que lanza si la DEK es todo ceros o se repite la DEK o el nonce previos. */
export function crearGeneradorMaterial(rng: Rng = randomBytes): () => Material {
  let huellaDekPrevia: Buffer | undefined;
  let noncePrevio: Buffer | undefined;
  return () => {
    const dek = rng(LARGO_DEK);
    const nonce = rng(LARGO_NONCE);
    // Solo se recuerda la huella de la DEK previa, nunca la DEK.
    const huellaDek = createHash("sha256").update(dek).digest();
    const atascado =
      dek.every((b) => b === 0) ||
      huellaDekPrevia?.equals(huellaDek) === true ||
      noncePrevio?.equals(nonce) === true;
    if (atascado) {
      dek.fill(0);
      throw new RngNoConfiableError();
    }
    huellaDekPrevia = huellaDek;
    noncePrevio = Buffer.from(nonce);
    return { dek, nonce };
  };
}
