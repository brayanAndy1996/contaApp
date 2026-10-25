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

/**
 * Huellas recordadas por tipo (DEK y nonce). CA-2 exige 10 000 cifrados con nonces y DEKs distintos, así
 * que la ventana debe cubrir al menos ese volumen: un RNG en ciclo de período ≤ 10 000 se detecta antes de
 * repetir un par (hallazgo R2a-1). 16 384 (2^14) deja margen sobre CA-2 con memoria acotada: ~1-2 MB por
 * generador (2 ventanas × 16 384 huellas SHA-256 en base64 de 44 caracteres, más el índice del Set).
 */
export const VENTANA_HUELLAS = 16_384;

export class RngNoConfiableError extends CryptoError {
  constructor() {
    super("rng", false, "Generador aleatorio no confiable");
  }
}

/**
 * Conjunto FIFO de huellas con capacidad fija: al llenarse olvida la más antigua. Búfer circular + Set:
 * `contiene` y `agregar` en O(1) (sin `Array.shift`, que es O(n) con ventanas grandes).
 */
class VentanaHuellas {
  readonly #anillo: (string | undefined)[];
  readonly #presentes = new Set<string>();
  #siguiente = 0;

  constructor(capacidad: number) {
    this.#anillo = new Array<string | undefined>(capacidad);
  }

  contiene(huella: string): boolean {
    return this.#presentes.has(huella);
  }

  agregar(huella: string): void {
    const antigua = this.#anillo[this.#siguiente];
    if (antigua !== undefined) this.#presentes.delete(antigua);
    this.#anillo[this.#siguiente] = huella;
    this.#presentes.add(huella);
    this.#siguiente = (this.#siguiente + 1) % this.#anillo.length;
  }
}

const huella = (b: Buffer): string => createHash("sha256").update(b).digest("base64");

/**
 * Devuelve un generador que lanza si la DEK es todo ceros o si la DEK o el nonce repiten alguno de los
 * últimos `capacidad` generados (detecta un RNG atascado o en ciclo corto: A, B, A). Solo se recuerdan
 * huellas SHA-256, nunca la DEK. `capacidad` es un entero ≥ 1 (solo las pruebas internas la cambian).
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
