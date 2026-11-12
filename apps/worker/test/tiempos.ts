// Spec 020 · DT-1 (D-1, P-4): pruebas de tiempo estables. La aserción de tiempo se evalúa solo sin instrumentar
// (`!BAJO_COBERTURA`) y sobre la mediana de varias muestras; la parte funcional de cada prueba corre siempre.
// Duplica `apps/backend/test/tiempos.ts` para no crear dependencia entre las dos apps.

/** `CONTAPP_COBERTURA=1` lo fijan solo los `vitest.cobertura*.config.mts`: la instrumentación v8 encarece el tiempo. */
export const BAJO_COBERTURA = process.env.CONTAPP_COBERTURA === "1";

/** Mediana de `n` muestras tomadas en serie; `muestra` devuelve los ms de su ejecución. */
export async function medirMediana(muestra: () => Promise<number>, n: number): Promise<number> {
  const ms: number[] = [];
  for (let i = 0; i < n; i++) ms.push(await muestra());
  ms.sort((a, b) => a - b);
  return ms[Math.floor(ms.length / 2)] ?? 0;
}
