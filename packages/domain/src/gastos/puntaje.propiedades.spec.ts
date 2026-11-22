// Spec 027 · T1 (rojo). Propiedades del puntaje (R-2, CA-6; plan, Contratos: domain `puntaje.ts`): permutar ítems, diccionario o historial
// no cambia puntaje, señales ni orden; la entrada no se muta; el puntaje es la suma de sus señales; S1 ≤ 6; señales en orden S1…S7.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { NUM_RUNS, SEMILLA } from "../../tests/ayudas/comprobante";
import { OTRO_PROV, PROV, SEMILLA_GLOBAL, congelar, contextoGastos } from "../../tests/ayudas/gastos";
import type { PalabraPlana } from "../../tests/ayudas/gastos";
import { crearDiccionarioEfectivo, puntuarGastoPersonal } from "../index";
import type { DocProveedor } from "../index";

const opciones = { numRuns: Math.min(NUM_RUNS, 400), seed: SEMILLA };
const VOCABULARIO = [
  "zapatilla", "zapatillas", "polo", "perfume", "peluche", "chocolate", "cable", "cemento", "de", "seguridad", "a", "tierra", "urbana",
  "t42", "punta", "acero", "mochila", "fumigadora", "audifono", "servicio", "und", "zapat.", "POLO", "ZAPATILLAS.38",
];
const PROPIAS: readonly PalabraPlana[] = [
  { palabra: "audifono", categoria: "entretenimiento", excepciones: [], activa: true },
  { palabra: "cemento", categoria: "utiles-escolares", excepciones: ["bolsa"], activa: false },
  { palabra: "cable", categoria: "juguetes", excepciones: ["usb c"], activa: true },
];

const glosaArb = fc.array(fc.constantFrom(...VOCABULARIO), { minLength: 0, maxLength: 6 }).map((p) => p.join(" "));
const glosasArb = fc.array(glosaArb, { minLength: 0, maxLength: 8 });
const fechaArb = fc.constantFrom<string | null>(null, "2026-03-11", "2026-03-14", "2026-03-15", "2026-07-28", "2028-03-11", "2028-12-25");
const ciiuArb = fc.constantFrom<string | null>(null, "4771", "4752", "5610", "4663", "8512", "9602", "0111", "1410");
const proveedoresArb = fc.constantFrom<DocProveedor>(PROV, OTRO_PROV, { tipo: "6", numero: "20100000001" });
const filaHistorialArb = fc
  .record({ proveedor: proveedoresArb, aceptadas6: fc.nat(6), excluidas6: fc.nat(3), extra: fc.nat(3) })
  .map(({ proveedor, aceptadas6, excluidas6, extra }) => ({ proveedor, aceptadas6, excluidas6, excluidas12: excluidas6 + extra }));
const historialArb = fc.uniqueArray(filaHistorialArb, { maxLength: 3, selector: (f) => f.proveedor.numero });
const ciiuProveedoresArb = fc.uniqueArray(fc.record({ proveedor: proveedoresArb, ciiu: ciiuArb }), { maxLength: 3, selector: (f) => f.proveedor.numero });
const ajusteArb = fc.record({
  permitidas: fc.subarray(["calzado-ropa", "juguetes", "cuidado-personal"]),
  quitadas: fc.subarray(["entretenimiento", "alimentos-personales", "utiles-escolares"]),
});
const escenarioArb = fc.record({
  glosas: glosasArb,
  fechaEmision: fechaArb,
  esNuevo: fc.boolean(),
  proveedor: proveedoresArb,
  ciiuCliente: ciiuArb,
  ciiuProveedores: ciiuProveedoresArb,
  historial: historialArb,
  categoriasCliente: ajusteArb,
  claves: fc.array(fc.nat(1_000_000), { minLength: 64, maxLength: 64 }),
});
type Escenario = typeof escenarioArb extends fc.Arbitrary<infer T> ? T : never;

const dic = (globales: readonly PalabraPlana[] = SEMILLA_GLOBAL) => crearDiccionarioEfectivo({ globales, desactivadas: [], propias: PROPIAS });
/** Reordena según claves fijas (una permutación derivada del escenario). */
function permutar<T>(a: readonly T[], claves: readonly number[]): T[] {
  return a
    .map((v, i) => ({ v, k: claves[i % claves.length]! * 1000 + i }))
    .sort((x, y) => x.k - y.k)
    .map((x) => x.v);
}
const ctxDe = (e: Escenario, diccionario = dic()) =>
  contextoGastos({
    diccionario,
    ciiuCliente: e.ciiuCliente,
    ciiuProveedores: e.ciiuProveedores,
    historial: e.historial,
    categoriasCliente: { permitidas: [...e.categoriasCliente.permitidas], quitadas: [...e.categoriasCliente.quitadas] },
  });
const entradaDe = (e: Escenario) => ({ glosas: e.glosas, fechaEmision: e.fechaEmision, proveedor: e.proveedor, esNuevo: e.esNuevo });

describe("puntuarGastoPersonal · propiedades", () => {
  it("puntaje = suma de los puntos de sus señales; es entero y las señales salen en orden S1…S7 sin repetirse", () => {
    fc.assert(
      fc.property(escenarioArb, (e) => {
        const r = puntuarGastoPersonal(entradaDe(e), ctxDe(e));
        expect(Number.isInteger(r.puntaje)).toBe(true);
        expect(r.puntaje).toBe(r.senales.reduce((a, s) => a + s.puntos, 0));
        const orden = r.senales.map((s) => s.codigo);
        expect(orden).toEqual([...new Set(orden)].sort());
        for (const c of orden) expect(["S1", "S2", "S3", "S4", "S5", "S6", "S7"]).toContain(c);
      }),
      opciones,
    );
  });

  it("S1 nunca pasa de 6 puntos, S3 es 0 o 2, y S6 y S7 no aparecen juntas", () => {
    fc.assert(
      fc.property(escenarioArb, (e) => {
        const r = puntuarGastoPersonal(entradaDe(e), ctxDe(e));
        const s1 = r.senales.find((s) => s.codigo === "S1");
        if (s1 !== undefined) expect(s1.puntos).toBeLessThanOrEqual(6);
        const s3 = r.senales.find((s) => s.codigo === "S3");
        if (s3 !== undefined) expect(s3.puntos).toBe(2);
        const orden = r.senales.map((s) => s.codigo);
        expect(orden.includes("S6") && orden.includes("S7")).toBe(false);
      }),
      opciones,
    );
  });

  it("permutar los ítems no cambia el resultado (R-2, CA-6)", () => {
    fc.assert(
      fc.property(escenarioArb, (e) => {
        const a = puntuarGastoPersonal(entradaDe(e), ctxDe(e));
        const b = puntuarGastoPersonal({ ...entradaDe(e), glosas: permutar(e.glosas, e.claves) }, ctxDe(e));
        expect(b).toEqual(a);
      }),
      opciones,
    );
  });

  it("permutar las palabras del diccionario (globales) no cambia el resultado", () => {
    fc.assert(
      fc.property(escenarioArb, (e) => {
        const a = puntuarGastoPersonal(entradaDe(e), ctxDe(e));
        const b = puntuarGastoPersonal(entradaDe(e), ctxDe(e, dic(permutar(SEMILLA_GLOBAL, e.claves))));
        expect(b).toEqual(a);
      }),
      opciones,
    );
  });

  it("permutar el historial y los CIIU de proveedores no cambia el resultado", () => {
    fc.assert(
      fc.property(escenarioArb, (e) => {
        const a = puntuarGastoPersonal(entradaDe(e), ctxDe(e));
        const permutado = { ...e, historial: permutar(e.historial, e.claves), ciiuProveedores: permutar(e.ciiuProveedores, e.claves) };
        expect(puntuarGastoPersonal(entradaDe(e), ctxDe(permutado))).toEqual(a);
      }),
      opciones,
    );
  });

  it("no muta la entrada ni el contexto (congelados no lanzan) y es determinista", () => {
    fc.assert(
      fc.property(escenarioArb, (e) => {
        const entrada = congelar({ ...entradaDe(e), glosas: [...e.glosas] });
        const ctx = congelar(ctxDe(e));
        const a = puntuarGastoPersonal(entrada, ctx);
        expect(puntuarGastoPersonal(entrada, ctx)).toEqual(a);
        expect(entrada.glosas).toEqual(e.glosas);
      }),
      opciones,
    );
  });

  it("sin glosas coincidentes no hay palabra ni categoría; con ellas, la palabra es la menor de las coincidentes", () => {
    fc.assert(
      fc.property(escenarioArb, (e) => {
        const r = puntuarGastoPersonal(entradaDe(e), ctxDe(e));
        const s1 = r.senales.find((s) => s.codigo === "S1");
        if (s1 === undefined) {
          expect(r.palabra).toBeNull();
          expect(r.categoria).toBeNull();
        } else {
          expect(r.palabra).toBe(s1.palabra);
          const todas = ctxDe(e).diccionario.coincidenciasPorItem(e.glosas).map((c) => c.palabra);
          expect(r.palabra).toBe([...todas].sort()[0]);
          expect(s1.items?.total).toBe(e.glosas.length);
        }
      }),
      opciones,
    );
  });
});
