// Periodos de una importación del historial (spec 025, D-4, U-5): del MES ANTERIOR al de `ahora` hacia atrás, en hora de Lima. Puro.

/** Lima no tiene horario de verano: UTC-5 todo el año (mismo criterio que `periodoEnCurso` de ventas y el catálogo de la cola). */
const HUSO_LIMA_MS = 5 * 60 * 60 * 1000;

/**
 * Los `cantidad` periodos AAAAMM que preceden al mes en curso (hora de Lima), del más reciente al más antiguo. Cruza el año:
 * en enero de 2026 con 3 periodos salen `202512`, `202511` y `202510`.
 */
export function periodosAImportar(cantidad: number, ahoraMs: number): string[] {
  const lima = new Date(ahoraMs - HUSO_LIMA_MS);
  // Meses desde el año 0: el mes en curso es `indice`; el primero a importar es el anterior.
  const indice = lima.getUTCFullYear() * 12 + lima.getUTCMonth();
  return Array.from({ length: cantidad }, (_, i) => {
    const m = indice - 1 - i;
    return `${Math.floor(m / 12)}${String((m % 12) + 1).padStart(2, "0")}`;
  });
}
