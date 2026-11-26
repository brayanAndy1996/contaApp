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
//   · si la razón supera el tope tras las rondas base, se siguen midiendo rondas intercaladas (hasta `rondasMax`) y se vuelve a tomar el
//     mínimo (`adaptativa`). Más muestras solo pueden bajar cada mínimo hacia su piso real: una regresión de verdad sigue por encima del
//     tope en todas las rondas, mientras que una ráfaga de carga del runner (turbo corre otras suites a la vez) deja de inflar un lado.
//     No baja la exigencia: el tope no cambia y la prueba nunca se salta.
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

/**
 * Rondas extra opcionales: mientras la razón supere `tope`, se miden más rondas (hasta `rondasMax` en total). Antes de cada ronda extra
 * se espera `pausaMs` sin gastar CPU (no entra en lo medido), para que las rondas extra caigan en otro momento y no en la misma ráfaga de
 * carga (las demás suites del runner arrancan a la vez y compiten por caché y memoria más con el lado que más aloja).
 */
export interface Adaptativa {
  readonly tope: number;
  readonly rondasMax: number;
  readonly pausaMs?: number;
}

const pausar = (ms: number): void => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Mide `chico` y `grande` (misma carga de trabajo, tamaños distintos) de forma intercalada y devuelve los mínimos y su razón.
 * Con `adaptativa`, si tras `rondas` la razón supera el tope sigue midiendo rondas hasta `rondasMax`; sin ella, el comportamiento es fijo.
 */
export function medirEscala(chico: () => unknown, grande: () => unknown, rondas: number = RONDAS, adaptativa?: Adaptativa): Escala {
  chico();
  grande(); // calentamiento de ambos lados (JIT, cachés)
  let minChico = Infinity;
  let minGrande = Infinity;
  const razon = (): number => minGrande / Math.max(minChico, PISO_MS);
  const total = adaptativa === undefined ? rondas : Math.max(rondas, adaptativa.rondasMax);
  for (let r = 0; r < total; r++) {
    if (r >= rondas) {
      if (razon() <= adaptativa!.tope) break;
      pausar(adaptativa!.pausaMs ?? 0);
    }
    if (r % 2 === 0) {
      minChico = Math.min(minChico, cronometrar(chico));
      minGrande = Math.min(minGrande, cronometrar(grande));
    } else {
      minGrande = Math.min(minGrande, cronometrar(grande));
      minChico = Math.min(minChico, cronometrar(chico));
    }
  }
  return { chicoMs: minChico, grandeMs: minGrande, razon: razon() };
}

/** Tope de la razón para una entrada `factor` veces mayor: media geométrica entre lineal (`factor`) y cuadrático (`factor`²) = factor^1,5. */
export const topeRazon = (factor: number): number => factor ** 1.5;
