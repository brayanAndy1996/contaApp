// Diferencia entre la prorrata calculada y la usada en el PDT o ingresada (spec 026, R-8, U-9, U-10;
// CA-6): alerta si |calculada − usada| ≥ 0.01 puntos. Aritmética exacta en centésimas (bigint).
import { ProrrataError } from "./errores";
import { type Porcentaje, centesimasDe } from "./porcentaje";

// U-9: 0 a 100 con hasta 2 decimales (por eso una diferencia de 0.009 es imposible).
const GRAMATICA_USADA = /^(100(\.0{1,2})?|[0-9]{1,2}(\.[0-9]{1,2})?)$/;

export interface DiferenciaProrrata {
  /** calculada − usada en puntos, con signo y 2 decimales («-0.01», «37.34»). */
  readonly diferencia: string;
  readonly alerta: boolean;
}

function centesimasDeUsada(usada: unknown): bigint {
  if (typeof usada !== "string" || !GRAMATICA_USADA.test(usada)) {
    throw new ProrrataError("PRORRATA_USADA_INVALIDA");
  }
  const [entero, decimales = ""] = usada.split(".");
  return BigInt(entero) * 100n + BigInt(decimales.padEnd(2, "0"));
}

function texto(c: bigint): string {
  const abs = c < 0n ? -c : c;
  return `${c < 0n ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

export function compararProrrata(calculada: Porcentaje, usada: string): DiferenciaProrrata {
  const c = centesimasDe(calculada);
  const diferencia = c - centesimasDeUsada(usada);
  const absoluta = diferencia < 0n ? -diferencia : diferencia;
  return Object.freeze({ diferencia: texto(diferencia), alerta: absoluta >= 1n });
}
