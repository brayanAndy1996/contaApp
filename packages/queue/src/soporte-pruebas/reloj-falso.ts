// Soporte de pruebas unitarias de `queue` (no se publica: excluido de tsconfig.build.json).
// Reloj falso: `Reloj { ahora(): Date }` es el contrato que inyectan Despachador, Reconciliador,
// ejecutor y caché de token (plan 008, "Pruebas de tiempo"). Nunca hay `sleep` reales.
export const INICIO = Date.parse("2026-10-27T15:00:00.000Z");

export class RelojFalso {
  private t: number;

  constructor(inicio: number = INICIO) {
    this.t = inicio;
  }

  ahora(): Date {
    return new Date(this.t);
  }

  /** Milisegundos desde epoch (para comparar con puntajes de ZSET y vencimientos). */
  ms(): number {
    return this.t;
  }

  avanzar(ms: number): void {
    this.t += ms;
  }
}
