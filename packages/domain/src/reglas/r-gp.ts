// R-GP (011 D-5, CA-12; 027 R-1 a R-3, R-5, R-11, D-1). Solo con XML válido: puntúa la compra con el contexto de gastos (sin
// `ctx.gastos`, el de 011: diccionario del contexto y umbral 3) y hay hallazgo si el puntaje ≥ umbral. La explicación es fija;
// la sugerencia lleva la palabra del diccionario, la categoría, el puntaje y las señales, nunca texto del XML.
import { puntuarValidado } from "../gastos/puntaje";
import { crearHallazgo } from "./entrada";
import type { ContextoInterno, FilaInterna } from "./entrada";
import { GASTO_NO_DEDUCIBLE } from "./explicaciones";
import type { Hallazgo } from "./tipos";

/** Puntaje ≥ umbral → sugerir excluir (sin montos); siempre pide confirmación (R-1). */
export function evaluarGastoPersonal(fila: FilaInterna, ctx: ContextoInterno): Hallazgo | null {
  if (fila.xml === null) return null;
  const clave = fila.proveedor.clave;
  // S5 con el criterio de R-NEW, aunque R-NEW esté apagada.
  const r = puntuarValidado(fila.xml.glosas, fila.xml.fechaEmision, clave, !ctx.conocidos.has(clave), ctx.gastos);
  if (r.puntaje < ctx.gastos.umbral) return null;
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
