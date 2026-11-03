// R-GP (spec D-5, CA-12; plan 011, Decisiones: "R-GP"). Solo con XML válido; la explicación
// lleva la palabra del diccionario (singular normalizado), nunca texto del XML.
import { crearHallazgo } from "./entrada";
import type { ContextoInterno, FilaInterna } from "./entrada";
import { gastoPersonal } from "./explicaciones";
import type { Hallazgo } from "./tipos";

/** Primera glosa del XML con palabra del diccionario → sugerir excluir (sin montos). */
export function evaluarGastoPersonal(fila: FilaInterna, ctx: ContextoInterno): Hallazgo | null {
  if (fila.xml === null) return null;
  const c = ctx.diccionario.buscar(fila.xml.glosas);
  if (c === null) return null;
  return crearHallazgo({
    filaId: fila.id,
    regla: "R-GP",
    destino: null,
    explicacion: gastoPersonal(c.palabra),
    sugerencia: { tipo: "excluir", palabra: c.palabra, categoria: c.categoria },
    // La palabra es un indicio, no una prueba de consumo personal: decide el contador.
    requiereConfirmacion: true,
    dato: null,
    lecturas: {},
  });
}
