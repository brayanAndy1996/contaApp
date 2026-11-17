// Spec 022 · T2: mismo helper de tiempos de 020 (apps/*/test/tiempos.ts), duplicado aquí para no depender de apps.
// La aserción de tiempo se evalúa solo sin instrumentar (`!BAJO_COBERTURA`) y sobre la mediana de varias muestras.
export const BAJO_COBERTURA = process.env.CONTAPP_COBERTURA === "1";

/** Mediana de `n` muestras tomadas en serie; `muestra` devuelve los ms de su ejecución. */
export async function medirMediana(
  muestra: () => Promise<number>,
  n: number,
): Promise<number> {
  const ms: number[] = [];
  for (let i = 0; i < n; i++) ms.push(await muestra());
  ms.sort((a, b) => a - b);
  return ms[Math.floor(ms.length / 2)] ?? 0;
}
