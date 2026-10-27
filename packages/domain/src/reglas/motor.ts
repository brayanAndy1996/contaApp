// evaluarReglas (plan 011, Contratos y Decisiones). T9: entrada estricta, avisos de XML, R-ISC y
// R-MIX por destino y orden de salida. T10 agrega R-RED, R-NEW y R-GP (por fila).
import { TASA_IGV_10, TASA_IGV_18, igvCuadra } from "../dinero/index";
import { PARES_DESTINO, validarContexto, validarFilas } from "./entrada";
import type { ContextoInterno, FilaInterna } from "./entrada";
import { evaluarIscIgvCero, evaluarIscMarcado } from "./r-isc";
import type { DestinoEvaluado } from "./r-isc";
import { evaluarMix } from "./r-mix";
import { ORDEN_REGLAS } from "./tipos";
import type { Aviso, ContextoReglas, FilaEvaluable, Hallazgo, ResultadoEvaluacion } from "./tipos";

/** Destinos de la fila con BI ≠ 0 o IGV ≠ 0 (un destino en 0.00/0.00 se ignora). */
function destinosActivos(fila: FilaInterna): DestinoEvaluado[] {
  const leidos = PARES_DESTINO.map((par) => ({
    par,
    bi: fila.montos.obtener(par.bi),
    igv: fila.montos.obtener(par.igv),
  }));
  const conBi = leidos.filter((d) => !d.bi.esCero()).length;
  return leidos
    .filter((d) => !d.bi.esCero() || !d.igv.esCero())
    .map((d) => ({ ...d, unicoConBi: conBi === 1 && !d.bi.esCero() }));
}

/** R-ISC y R-MIX por destino (CA-5): IGV = 0 → R-ISC; IGV que no cuadra → R-MIX. */
function porDestino(fila: FilaInterna, ctx: ContextoInterno): Hallazgo[] {
  const marcado = ctx.isc.has(fila.proveedor.clave);
  const hallazgos: Hallazgo[] = [];
  for (const d of destinosActivos(fila)) {
    if (d.igv.esCero()) {
      hallazgos.push(evaluarIscIgvCero(fila, d));
    } else if (!igvCuadra(d.bi, d.igv, TASA_IGV_18) && !igvCuadra(d.bi, d.igv, TASA_IGV_10)) {
      hallazgos.push(evaluarMix(fila, d));
    } else if (marcado) {
      hallazgos.push(evaluarIscMarcado(fila, d));
    }
  }
  return hallazgos;
}

const ORDEN_DESTINO = ["DG", "DGNG", "DNG"];

/** Comparación por unidades de código, sin locale. */
function compararTexto(a: string, b: string): -1 | 0 | 1 {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function compararHallazgos(a: Hallazgo, b: Hallazgo) {
  return (
    compararTexto(a.filaId, b.filaId) ||
    ORDEN_REGLAS.indexOf(a.regla) - ORDEN_REGLAS.indexOf(b.regla) ||
    ORDEN_DESTINO.indexOf(a.destino ?? "") - ORDEN_DESTINO.indexOf(b.destino ?? "")
  );
}

/**
 * Evalúa las filas sin mutarlas. Valida todo antes de evaluar (sin resultados parciales):
 * entrada inválida → EntradaReglasInvalidaError. Orden: id → ORDEN_REGLAS → DG, DGNG, DNG.
 */
export function evaluarReglas(filas: readonly FilaEvaluable[], ctx: ContextoReglas): ResultadoEvaluacion {
  const contexto = validarContexto(ctx);
  const internas = validarFilas(filas);
  const hallazgos: Hallazgo[] = [];
  const avisos: Aviso[] = [];
  for (const fila of internas) {
    if (fila.aviso !== null) avisos.push(fila.aviso);
    hallazgos.push(...porDestino(fila, contexto));
  }
  hallazgos.sort(compararHallazgos);
  avisos.sort((a, b) => compararTexto(a.filaId, b.filaId));
  return Object.freeze({ hallazgos: Object.freeze(hallazgos), avisos: Object.freeze(avisos) });
}
