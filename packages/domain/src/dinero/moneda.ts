import { MonedaDistintaError, MontoInvalidoError } from "./errores";

export type Moneda = "PEN" | "USD";

/** Lanza MontoInvalidoError si `m` no es una moneda soportada (D7). */
export function asegurarMoneda(m: unknown): Moneda {
  if (m !== "PEN" && m !== "USD") throw new MontoInvalidoError();
  return m;
}

/** Lanza MonedaDistintaError si las monedas difieren. */
export function asegurarMismaMoneda(a: Moneda, b: Moneda): void {
  if (a !== b) throw new MonedaDistintaError();
}
