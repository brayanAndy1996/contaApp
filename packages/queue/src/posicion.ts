// Posición en la cola (RF-042, plan 008 "Posición"). Función pura.

export interface TrabajoEnCola {
  id: string;
  tenantId: string;
  cola: string;
  estado: string;
  prioridad: "interactivo" | "programado";
  creadoEn: Date;
}

const rango = (p: TrabajoEnCola["prioridad"]): number =>
  p === "interactivo" ? 0 : 1;

/** 1 + en_cola del mismo estudio y cola que salen antes; null si el objetivo no está en_cola. */
export function calcularPosicion(
  objetivo: TrabajoEnCola,
  trabajos: readonly TrabajoEnCola[],
): number | null {
  if (objetivo.estado !== "en_cola") return null;
  const r = rango(objetivo.prioridad);
  const t = objetivo.creadoEn.getTime();
  let antes = 0;
  for (const o of trabajos) {
    if (
      o.id === objetivo.id ||
      o.tenantId !== objetivo.tenantId ||
      o.cola !== objetivo.cola ||
      o.estado !== "en_cola"
    ) {
      continue;
    }
    const ro = rango(o.prioridad);
    if (ro < r || (ro === r && o.creadoEn.getTime() < t)) antes++;
  }
  return antes + 1;
}
