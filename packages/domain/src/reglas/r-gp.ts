// R-GP (011 D-5, CA-12; 027 R-1 a R-3, R-5, R-11, D-1). Solo con XML válido: puntúa la compra con el contexto de gastos (sin
// `ctx.gastos`, el de 011: diccionario del contexto y umbral 3) y hay hallazgo si hay palabra clave (S1) y el puntaje ≥ umbral
// (decisión del usuario 2026-11-22, T21a: S2…S7 solo suben o bajan el puntaje de una compra que ya tiene S1). La explicación es
// fija; la sugerencia lleva la palabra del diccionario, la categoría, el puntaje y las señales, nunca texto del XML.
import { puntuarValidado } from "../gastos/puntaje";
import { crearHallazgo } from "./entrada";
import type { ContextoInterno, FilaInterna } from "./entrada";
import { GASTO_NO_DEDUCIBLE } from "./explicaciones";
import type { Hallazgo } from "./tipos";

/** S1 y puntaje ≥ umbral → sugerir excluir (sin montos); siempre pide confirmación (R-1). */
export function evaluarGastoPersonal(fila: FilaInterna, ctx: ContextoInterno): Hallazgo | null {
  if (fila.xml === null) return null;
  const clave = fila.proveedor.clave;
  // S5 con el criterio de R-NEW, aunque R-NEW esté apagada.
  const r = puntuarValidado(fila.xml.glosas, fila.xml.fechaEmision, clave, !ctx.conocidos.has(clave), ctx.gastos);
  // Sin palabra clave no hay hallazgo aunque las demás señales alcancen el umbral (T21a): la sugerencia ya no lleva palabra null.
  if (r.palabra === null || r.puntaje < ctx.gastos.umbral) return null;
  return crearHallazgo({
    filaId: fila.id,
    regla: "R-GP",
    destino: null,
    explicacion: GASTO_NO_DEDUCIBLE,
    sugerencia: { tipo: "excluir", palabra: r.palabra, categoria: r.categoria, puntaje: r.puntaje, senales: r.senales },
    // El puntaje es un indicio, no una prueba de consumo personal: decide el contador.
    requiereConfirmacion: true,
    dato: null,
    lecturas: {},
  });
}
