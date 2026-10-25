// DEK (32 B) y nonce (12 B) del CSPRNG de node:crypto, con guarda contra un RNG atascado o en ciclo.
// El RNG solo es inyectable aquí (pruebas internas); la API pública no lo expone.
import { createHash, randomBytes } from "node:crypto";
import { CryptoError } from "./errores";
import { LARGO_DEK, LARGO_NONCE } from "./sobre";

export type Rng = (n: number) => Buffer;

export interface Material {
  dek: Buffer;
  nonce: Buffer;
}

/** Huellas recordadas por tipo (DEK y nonce): memoria acotada (~64 B por huella). */
export const VENTANA_HUELLAS = 4096;

export class RngNoConfiableError extends CryptoError {
  constructor() {
    super("rng", false, "Generador aleatorio no confiable");
  }
}

/** Conjunto FIFO de huellas con capacidad fija: al llenarse olvida la más antigua. */
class VentanaHuellas {
  readonly #orden: string[] = [];
  readonly #presentes = new Set<string>();
  readonly #capacidad: number;

  constructor(capacidad: number) {
    this.#capacidad = capacidad;
  }

  contiene(huella: string): boolean {
    return this.#presentes.has(huella);
  }

  agregar(huella: string): void {
    this.#orden.push(huella);
    this.#presentes.add(huella);
    if (this.#orden.length > this.#capacidad) {
      this.#presentes.delete(this.#orden.shift() as string);
    }
  }
}

const huella = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/**
 * Devuelve un generador que lanza si la DEK es todo ceros o si la DEK o el nonce repiten alguno de los
 * últimos `capacidad` generados (detecta un RNG atascado o en ciclo corto: A, B, A). Solo se recuerdan
 * huellas SHA-256, nunca la DEK.
 */
export function crearGeneradorMaterial(
  rng: Rng = randomBytes,
  capacidad: number = VENTANA_HUELLAS,
): () => Material {
  const deks = new VentanaHuellas(capacidad);
  const nonces = new VentanaHuellas(capacidad);
  return () => {
    const dek = rng(LARGO_DEK);
    const nonce = rng(LARGO_NONCE);
    const huellaDek = huella(dek);
    const huellaNonce = huella(nonce);
    const atascado =
      dek.every((b) => b === 0) ||
      deks.contiene(huellaDek) ||
      nonces.contiene(huellaNonce);
    if (atascado) {
      dek.fill(0);
      throw new RngNoConfiableError();
    }
    deks.agregar(huellaDek);
    nonces.agregar(huellaNonce);
    return { dek, nonce };
  };
}
