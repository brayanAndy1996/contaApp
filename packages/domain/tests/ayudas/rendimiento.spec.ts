// Ayuda de rendimiento (spec 027 · CA-15): las rondas adaptativas de `medirEscala` absorben una ráfaga de carga inicial, pero no ocultan
// una regresión sostenida. Las «cargas» son esperas activas de duración fija (sin datos aleatorios): el lado grande es 8× el chico o 1×.
import { describe, expect, it } from "vitest";
import { medirEscala } from "./rendimiento";

const reloj = (globalThis as unknown as { performance: { now(): number } }).performance;
const girar = (ms: number): void => {
  const fin = reloj.now() + ms;
  while (reloj.now() < fin) {
    /* espera activa: consume CPU, que es lo que mide `medirEscala` */
  }
};

const CHICO_MS = 6;
const ALTO_MS = 48;
const TOPE = 2;

describe("medirEscala · rondas adaptativas", () => {
  it("sin `adaptativa` mide solo las rondas pedidas (comportamiento fijo)", () => {
    let llamadas = 0;
    medirEscala(() => girar(1), () => { llamadas++; }, 5);
    expect(llamadas).toBe(1 + 5); // calentamiento + 5 rondas
  });

  it("una ráfaga que dura más que las rondas base no falla la razón: las rondas extra la superan", () => {
    let llamadas = 0;
    const e = medirEscala(
      () => girar(CHICO_MS),
      () => {
        llamadas++;
        girar(llamadas <= 1 + 7 ? ALTO_MS : CHICO_MS); // calentamiento + 7 rondas base inflados; luego normal
      },
      7,
      { tope: TOPE, rondasMax: 20 },
    );
    expect(e.razon).toBeLessThanOrEqual(TOPE);
    expect(llamadas).toBeLessThan(1 + 20); // se detiene al cumplir, no agota las rondas
  });

  it("una regresión sostenida sigue por encima del tope aunque se midan todas las rondas extra", () => {
    let llamadas = 0;
    const e = medirEscala(
      () => girar(CHICO_MS),
      () => {
        llamadas++;
        girar(ALTO_MS);
      },
      7,
      { tope: TOPE, rondasMax: 12 },
    );
    expect(e.razon).toBeGreaterThan(TOPE);
    expect(llamadas).toBe(1 + 12);
  });
});
