/**
 * Límite efectivo de RUCs (D6, D10): `maxRucs + min(contratados, maxRucsExtra)`.
 * Función pura con enteros; si el super-admin baja el tope del plan, los contratados
 * por encima del tope no suman cupo.
 */
export function limiteEfectivoRucs(
  maxRucs: number,
  maxRucsExtra: number,
  contratados: number,
): number {
  return maxRucs + Math.min(contratados, maxRucsExtra);
}
