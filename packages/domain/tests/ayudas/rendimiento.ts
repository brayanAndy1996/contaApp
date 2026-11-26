// Ayuda de pruebas de rendimiento (spec 027 · T25a). Sin azar ni reloj de pared: solo `performance.now()`.
//
// Por qué no hay topes absolutos en milisegundos: bajo la instrumentación de cobertura (v8) y en un runner de CI cargado el mismo
// código tarda 3-10× más que en local, y un tope fijo (800 ms, 1 s) falla sin que haya ninguna regresión (run 45306073754 de CI).
// Lo que estas pruebas protegen es la COMPLEJIDAD (lineal, sin explosión), y eso se mide con una razón entre dos tamaños de la
// misma entrada ejecutados en la misma corrida: la instrumentación y la carga multiplican ambos lados por igual y la razón no cambia.
//   · lineal → razón ≈ factor de tamaño;  cuadrático → razón ≈ factor².  El tope se fija entre ambos (≈ la media geométrica).
//   · se mide tiempo de CPU del proceso (`process.cpuUsage`, usuario + sistema) y no de pared: con la máquina saturada (backend a la vez,
//     runner de CI) el reloj de pared incluye las esperas por turno de CPU, que caen al azar sobre un lado u otro y desvirtúan la razón.
//     Si `process.cpuUsage` no existe, se usa `performance.now()`.
//   · cada lado se mide como el MÍNIMO de varias rondas (descarta picos de máquina cargada y pausas del GC), con ambos lados
//     intercalados (y el orden invertido en las rondas impares) para que vean la misma carga.
//   · el lado chico se acota por debajo (`PISO_MS`): con tiempos de 1-2 ms el ruido del reloj dominaría la razón.
const entorno = globalThis as unknown as {
  performance: { now(): number };
  process?: { cpuUsage?: (previo?: { user: number; system: number }) => { user: number; system: number } };
};
const reloj = entorno.performance;
const cpu = entorno.process?.cpuUsage?.bind(entorno.process);

export const RONDAS = 7;
export const PISO_MS = 2;

export interface Escala {
  readonly chicoMs: number;
  readonly grandeMs: number;
  /** grande / max(chico, PISO_MS) */
  readonly razon: number;
}

const cronometrar = (f: () => unknown): number => {
  if (cpu !== undefined) {
    const t0 = cpu();
    f();
    const d = cpu(t0);
    return (d.user + d.system) / 1000; // µs → ms
  }
  const t0 = reloj.now();
  f();
  return reloj.now() - t0;
};

/** Mide `chico` y `grande` (misma carga de trabajo, tamaños distintos) de forma intercalada y devuelve los mínimos y su razón. */
export function medirEscala(chico: () => unknown, grande: () => unknown, rondas: number = RONDAS): Escala {
  chico();
  grande(); // calentamiento de ambos lados (JIT, cachés)
  let minChico = Infinity;
  let minGrande = Infinity;
  for (let r = 0; r < rondas; r++) {
    if (r % 2 === 0) {
      minChico = Math.min(minChico, cronometrar(chico));
      minGrande = Math.min(minGrande, cronometrar(grande));
    } else {
      minGrande = Math.min(minGrande, cronometrar(grande));
      minChico = Math.min(minChico, cronometrar(chico));
    }
  }
  return { chicoMs: minChico, grandeMs: minGrande, razon: minGrande / Math.max(minChico, PISO_MS) };
}

/** Tope de la razón para una entrada `factor` veces mayor: media geométrica entre lineal (`factor`) y cuadrático (`factor`²) = factor^1,5. */
export const topeRazon = (factor: number): number => factor ** 1.5;
