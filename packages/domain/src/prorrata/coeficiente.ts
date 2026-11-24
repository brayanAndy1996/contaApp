// Coeficiente de prorrata de la ventana (spec 026, R-3, R-4, R-6, R-2b; U-5, U-6, U-7; CA-2).
// numerador = Σ(gravadas + exportaciones); total = numerador + Σ noGravadas; porcentaje con
// porcentajeProrrata. Se calcula al leer: no hay estado que invalidar (plan, Decisiones técnicas).
import { Acumulado } from "../dinero/acumulado";
import type { Money } from "../dinero/index";
import { ProrrataError } from "./errores";
import { type MesProrrata, esMesResuelto } from "./meses";
import { type Porcentaje, porcentajeProrrata } from "./porcentaje";
import { ventanaProrrata } from "./ventana";

export type AvisoCoeficiente = "exportaciones_en_sire" | "numerador_cero";

export interface ProrrataCalculada {
  readonly estado: "calculado";
  readonly porcentaje: Porcentaje;
  readonly numerador: Money;
  readonly total: Money;
  /** Algún mes es SIRE o manual. */
  readonly provisional: boolean;
  readonly avisos: readonly AvisoCoeficiente[];
}

export interface ProrrataFaltanMeses {
  readonly estado: "faltan_meses";
  /** Periodos sin origen, en el orden de la ventana. */
  readonly faltantes: readonly string[];
}

export interface ProrrataNoDeterminable {
  readonly estado: "no_determinable";
  /** `montos_fuera_de_rango` (H-026-2-4): un mes o el acumulado de la ventana no cabe en NUMERIC(14,2). */
  readonly motivo: "total_cero" | "acumulado_invalido" | "montos_fuera_de_rango";
}

export type ResultadoProrrata = ProrrataCalculada | ProrrataFaltanMeses | ProrrataNoDeterminable;

/** Los 12 meses deben salir de resolverMes y ser la ventana de su último periodo, en orden. */
function asegurarVentana(meses: readonly MesProrrata[]): void {
  if (!Array.isArray(meses) || meses.length !== 12 || !meses.every(esMesResuelto)) {
    throw new ProrrataError("ENTRADA_INVALIDA");
  }
  const ventana = ventanaProrrata(meses[11].periodo);
  if (meses.some((m, i) => m.periodo !== ventana[i])) throw new ProrrataError("ENTRADA_INVALIDA");
}

/** Coeficiente de los 12 meses de la ventana (de M−11 a M). */
export function calcularProrrata(meses: readonly MesProrrata[]): ResultadoProrrata {
  asegurarVentana(meses);
  // R-6: faltar un mes tiene precedencia sobre cualquier otro estado.
  const faltantes = meses.filter((m) => m.origen === "falta").map((m) => m.periodo);
  if (faltantes.length > 0) return Object.freeze({ estado: "faltan_meses", faltantes: Object.freeze(faltantes) });

  // H-026-2-4: un mes fuera de rango (sus montos están en el tope) o un acumulado que no cabe en NUMERIC(14,2) no se calcula,
  // pero tampoco es un error: la tabla se muestra igual. Las sumas son exactas; el rango se mira solo en el resultado.
  const sumaExacta = (montos: readonly Money[]): Acumulado =>
    montos.reduce((a, m) => a.mas(Acumulado.de(m)), Acumulado.cero());
  const numeradorExacto = sumaExacta(meses.flatMap((m) => [m.gravadas, m.exportaciones]));
  const totalExacto = numeradorExacto.mas(sumaExacta(meses.map((m) => m.noGravadas)));
  if (meses.some((m) => m.fueraDeRango) || !numeradorExacto.cabe() || !totalExacto.cabe()) {
    return Object.freeze({ estado: "no_determinable", motivo: "montos_fuera_de_rango" });
  }
  const numerador = numeradorExacto.acotado("PEN");
  const total = totalExacto.acotado("PEN");
  // R-4: total 0 → no determinable; numerador < 0, total < 0 o numerador > total → acumulado inválido.
  if (total.esCero()) return Object.freeze({ estado: "no_determinable", motivo: "total_cero" });
  if (numerador.esNegativo() || total.esNegativo() || numerador.comparar(total) > 0) {
    return Object.freeze({ estado: "no_determinable", motivo: "acumulado_invalido" });
  }

  const hayExportacionesFueraDeSire = meses.some(
    (m) => (m.origen === "declarado" || m.origen === "manual") && !m.exportaciones.esCero(),
  );
  const haySire = meses.some((m) => m.origen === "sire");
  const avisos: AvisoCoeficiente[] = [];
  if (haySire && hayExportacionesFueraDeSire) avisos.push("exportaciones_en_sire");
  if (numerador.esCero()) avisos.push("numerador_cero");

  return Object.freeze({
    estado: "calculado",
    porcentaje: porcentajeProrrata(numerador, total),
    numerador,
    total,
    provisional: meses.some((m) => m.origen === "sire" || m.origen === "manual"),
    avisos: Object.freeze(avisos),
  });
}
