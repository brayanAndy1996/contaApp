// Spec 027 · T1 (rojo). Rendimiento (CA-15, R-10): 5.000 compras × 20 ítems con 2.000 palabras propias no tardan más del doble que la
// misma evaluación con la R-GP de 011 (mínimo de 7 rondas intercaladas). Fuera de cobertura (T14). Sin datos aleatorios: generador determinista.
import { describe, expect, it } from "vitest";
import { MontosComprobante } from "../comprobante/index";
import { Money } from "../dinero/index";
import { evaluarReglas } from "../reglas/index";
import type { ContextoReglas, FilaEvaluable, ResumenXml } from "../reglas/index";
import { DICCIONARIO_GLOSAS_BASE, tokensDeGlosa } from "../texto/index";
import { PROV, SEMILLA_GLOBAL, contextoGastos, contextoNeutro } from "../../tests/ayudas/gastos";
import type { PalabraPlana } from "../../tests/ayudas/gastos";
import { crearDiccionarioEfectivo, puntuarGastoPersonal } from "../index";

const COMPRAS = 5_000;
const ITEMS = 20;
const PROPIAS = 2_000;
const TOPE = 2;

/** LCG determinista (sin reloj ni azar). */
function generador(semilla: number): () => number {
  let s = semilla >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

const MUNDO = ["cable", "usb", "tornillo", "cemento", "fierro", "servicio", "mantenimiento", "equipo", "pintura", "brocha", "llave", "taladro", "disco", "guante", "casco", "cinta"];
const letras = (n: number): string => {
  let r = "";
  let x = n;
  do {
    r = String.fromCharCode(97 + (x % 26)) + r;
    x = Math.floor(x / 26);
  } while (x > 0);
  return r;
};
const propias: PalabraPlana[] = Array.from({ length: PROPIAS }, (_, i) => ({
  palabra: `prop${letras(i).padStart(4, "a")}`,
  categoria: "entretenimiento",
  excepciones: [],
  activa: true,
}));

function glosasDeCompra(i: number, rnd: () => number): string[] {
  return Array.from({ length: ITEMS }, (_, j) => {
    const base = `${MUNDO[rnd() % MUNDO.length]} ${MUNDO[rnd() % MUNDO.length]} ${MUNDO[rnd() % MUNDO.length]} x${(i + j) % 50} 2.00`;
    // Algunas glosas con palabras de la semilla y con palabras propias, para que haya coincidencias de verdad.
    if ((i + j) % 17 === 0) return `${base} zapatillas`;
    if ((i + j) % 23 === 0) return `${base} ${propias[(i * 7 + j) % PROPIAS]!.palabra}`;
    return base;
  });
}

const rnd = generador(20261122);
const COMPRAS_GLOSAS: string[][] = Array.from({ length: COMPRAS }, (_, i) => glosasDeCompra(i, rnd));

const RONDAS = 7;
const reloj = (globalThis as unknown as { performance: { now(): number } }).performance;

/**
 * Mide dos funciones de forma intercalada: calentamiento de ambas y luego RONDAS rondas en las que se alternan
 * (y se invierte el orden en las rondas impares). Devuelve el mínimo de cada lado: el mínimo descarta los picos
 * de la máquina cargada y, al intercalar, ambos lados ven la misma carga.
 */
function minimosIntercalados(a: () => unknown, b: () => unknown): { a: number; b: number } {
  a();
  b();
  let minA = Infinity;
  let minB = Infinity;
  const cronometrar = (f: () => unknown): number => {
    const t0 = reloj.now();
    f();
    return reloj.now() - t0;
  };
  for (let r = 0; r < RONDAS; r++) {
    if (r % 2 === 0) {
      minA = Math.min(minA, cronometrar(a));
      minB = Math.min(minB, cronometrar(b));
    } else {
      minB = Math.min(minB, cronometrar(b));
      minA = Math.min(minA, cronometrar(a));
    }
  }
  return { a: minA, b: minB };
}

/** Referencia: el algoritmo de la R-GP de 011 (palabra × token, sin índice) con su diccionario base. */
const BASE_011 = ["zapatilla", "zapato", "polo", "casaca", "blusa", "vestido", "juguete", "peluche", "muneca", "perfume", "colonia", "maquillaje", "labial", "videojuego", "cine"];
function coincide011(token: string, palabra: string): boolean {
  if (!token.startsWith(palabra)) return false;
  const resto = token.length - palabra.length;
  return resto === 0 || (resto === 1 && token.endsWith("s")) || (resto === 2 && token.endsWith("es"));
}
function buscar011(glosas: readonly string[]): string | null {
  for (const g of glosas) {
    const tokens = tokensDeGlosa(g);
    for (const p of BASE_011) for (const t of tokens) if (coincide011(t, p) || (t.endsWith(".") && t.length > 4 && p.startsWith(t.slice(0, -1)))) return p;
  }
  return null;
}

describe("CA-15 · puntuar 5.000 compras × 20 ítems con 2.000 palabras propias", () => {
  it(`el puntaje completo tarda a lo sumo ${TOPE}× lo que tarda la búsqueda de 011 sobre las mismas glosas`, { timeout: 180_000 }, () => {
    const diccionario = crearDiccionarioEfectivo({ globales: SEMILLA_GLOBAL, desactivadas: [], propias });
    const ctx = contextoNeutro({ diccionario, ciiuCliente: "4752", ciiuProveedores: [{ proveedor: { ...PROV }, ciiu: "4771" }] });
    let marcadas = 0;
    const { a: nueva, b: referencia } = minimosIntercalados(
      () => {
        marcadas = 0;
        for (const glosas of COMPRAS_GLOSAS) {
          const r = puntuarGastoPersonal({ glosas, fechaEmision: "2026-03-14", proveedor: PROV, esNuevo: false }, ctx);
          if (r.palabra !== null) marcadas++;
        }
      },
      () => {
        for (const glosas of COMPRAS_GLOSAS) buscar011(glosas);
      },
    );
    expect(marcadas, "la prueba debe encontrar coincidencias reales").toBeGreaterThan(0);
    expect(nueva).toBeLessThanOrEqual(TOPE * referencia);
  });
});

describe("CA-15 · evaluarReglas con la R-GP completa frente a la de 011", () => {
  const pen = (s: string): Money => Money.desde(s, "PEN");
  const PROVEEDOR = { tipo: "6", numero: "20100000001" } as const;
  const COMPROBANTE = { tipo: "01", serie: "F001", numero: "123" } as const;
  const filas: FilaEvaluable[] = COMPRAS_GLOSAS.map((glosas, i) => {
    const xml: ResumenXml = {
      proveedor: { ...PROVEEDOR },
      comprobante: { ...COMPROBANTE },
      moneda: "PEN",
      gravado: pen("100.00"),
      igv: pen("18.00"),
      noGravado: pen("0.00"),
      isc: pen("0.00"),
      icbper: pen("0.00"),
      total: pen("118.00"),
      glosas,
    };
    return {
      id: `f${i}`,
      proveedor: { ...PROVEEDOR },
      comprobante: { ...COMPROBANTE },
      montos: MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" }),
      xml,
    };
  });
  const base: ContextoReglas = { proveedoresConocidos: [{ ...PROVEEDOR }], proveedoresIsc: [], diccionario: DICCIONARIO_GLOSAS_BASE };

  it(`con 2.000 palabras propias tarda a lo sumo ${TOPE}× lo que tarda con el diccionario base sin contexto de gastos`, { timeout: 180_000 }, () => {
    const diccionario = crearDiccionarioEfectivo({ globales: SEMILLA_GLOBAL, desactivadas: [], propias });
    const gastos = contextoGastos({ diccionario, ciiuCliente: null, ciiuProveedores: [] });
    let hallazgos = 0;
    const { a: completa, b: minima } = minimosIntercalados(
      () => {
        hallazgos = evaluarReglas(filas, { ...base, gastos } as ContextoReglas).hallazgos.filter((h) => h.regla === "R-GP").length;
      },
      () => evaluarReglas(filas, base),
    );
    expect(hallazgos, "la prueba debe marcar compras de verdad").toBeGreaterThan(0);
    expect(completa).toBeLessThanOrEqual(TOPE * minima);
  });
});
