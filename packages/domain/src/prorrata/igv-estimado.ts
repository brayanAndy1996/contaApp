// IGV estimado del periodo M (spec 026, R-7, U-8; CA-5): débito de ventas menos el crédito DG completo
// y el crédito DGNG con la prorrata; el IGV DNG es informativo y no resta. Todo en soles con Money.
import { Money, redondearSunat } from "../dinero/index";
import { ProrrataError } from "./errores";
import { type Porcentaje, esPorcentaje } from "./porcentaje";

export interface EntradaIgvEstimado {
  readonly igvVentas: Money;
  readonly igvDg: Money;
  readonly igvDgng: Money;
  readonly igvDng: Money;
  /** El Porcentaje de un coeficiente calculado. */
  readonly prorrata: Porcentaje;
}

export type SituacionIgv = "a_pagar" | "saldo_a_favor" | "cero";

export interface IgvEstimado {
  readonly igvVentas: Money;
  readonly creditoDg: Money;
  readonly igvDgng: Money;
  readonly creditoDgng: Money;
  readonly igvDng: Money;
  /** igvVentas − creditoDg − creditoDgng. */
  readonly resultado: Money;
  readonly situacion: SituacionIgv;
}

/** Un Money real en soles (Money.suma rechaza falsos y otras monedas). */
function soles(x: unknown): Money {
  return Money.suma([x as Money], "PEN");
}

export function estimarIgv(entrada: EntradaIgvEstimado): IgvEstimado {
  if (typeof entrada !== "object" || entrada === null) throw new ProrrataError("ENTRADA_INVALIDA");
  const igvVentas = soles(entrada.igvVentas);
  const igvDg = soles(entrada.igvDg);
  const igvDgng = soles(entrada.igvDgng);
  const igvDng = soles(entrada.igvDng);
  if (!esPorcentaje(entrada.prorrata)) throw new ProrrataError("ENTRADA_INVALIDA");
  const creditoDgng = redondearSunat(igvDgng.por(entrada.prorrata.comoFactor()));
  const resultado = igvVentas.restar(igvDg).restar(creditoDgng);
  const situacion: SituacionIgv = resultado.esCero() ? "cero" : resultado.esNegativo() ? "saldo_a_favor" : "a_pagar";
  return Object.freeze({ igvVentas, creditoDg: igvDg, igvDgng, creditoDgng, igvDng, resultado, situacion });
}
