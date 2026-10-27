// R-NEW (RF-085; spec CA-7; plan 011, Decisiones: "R-NEW"). La clave normalizada tipo:numero se
// busca en un Set construido en entrada.ts (nunca un objeto literal como diccionario).
import { crearHallazgo } from "./entrada";
import type { ContextoInterno, FilaInterna } from "./entrada";
import { PROVEEDOR_NUEVO } from "./explicaciones";
import type { Hallazgo } from "./tipos";

/** Proveedor fuera de los conocidos → pide el destino; sin montos ni lecturas. */
export function evaluarNuevo(fila: FilaInterna, ctx: ContextoInterno): Hallazgo | null {
  if (ctx.conocidos.has(fila.proveedor.clave)) return null;
  return crearHallazgo({
    filaId: fila.id,
    regla: "R-NEW",
    destino: null,
    explicacion: PROVEEDOR_NUEVO,
    sugerencia: { tipo: "clasificar" },
    requiereConfirmacion: true,
    dato: "destino",
    lecturas: {},
  });
}
