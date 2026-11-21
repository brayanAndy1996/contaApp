// Spec 025 · T1 (rojo). Propiedades de aprenderDeHistorial contra un oráculo simple (CA-2, D-3, U-2). El oráculo se escribe
// aparte, con decimal.js y enteros, sin reutilizar nada del dominio. Rojo: `aprenderDeHistorial` aún no se exporta.
import Decimal from "decimal.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { NUM_RUNS, SEMILLA } from "../../tests/ayudas/comprobante";
import { aprenderDeHistorial } from "./index";
import type { FilaHistorial } from "./index";

const PERIODOS = ["202601", "202602", "202603", "202604", "202605", "202606"];
const DOCS: readonly { tipo: string | undefined; numero: string; clave: string }[] = [
  { tipo: undefined, numero: "20100070970", clave: "6:20100070970" },
  { tipo: "6", numero: " 2010 0070970 ", clave: "6:20100070970" },
  { tipo: undefined, numero: "20555555555", clave: "6:20555555555" },
  { tipo: "6", numero: "20999999999", clave: "6:20999999999" },
  { tipo: "1", numero: "20100070", clave: "1:20100070" },
  { tipo: "1", numero: "ab- 12", clave: "1:AB-12" },
  { tipo: "1", numero: "AB-12", clave: "1:AB-12" },
  { tipo: "1", numero: "-", clave: "" },
  { tipo: undefined, numero: "  ", clave: "" },
];
const BASES = ["0.00", "-0.00", "0", "10.00", "-25.50", "100.00", "0.01"];

/** La razón social depende solo del proveedor (así el resultado no depende de qué fila del periodo se lea primero). */
const razonDe = (clave: string): string | undefined => (clave === "" ? undefined : `PROVEEDOR ${clave}`);

const filaArb = fc.record({
  doc: fc.constantFrom(...DOCS),
  periodo: fc.constantFrom(...PERIODOS),
  tipoComprobante: fc.constantFrom("01", "03", "07", "08", "14"),
  bases: fc.tuple(fc.constantFrom(...BASES), fc.constantFrom(...BASES), fc.constantFrom(...BASES)),
});

interface Generada {
  doc: (typeof DOCS)[number];
  periodo: string;
  tipoComprobante: string;
  bases: [string, string, string];
}
function aFila(g: Generada): FilaHistorial {
  const [biDg, biDgng, biDng] = g.bases;
  const razon = razonDe(g.doc.clave);
  return {
    periodo: g.periodo,
    ...(g.doc.tipo === undefined ? {} : { tipoDocProveedor: g.doc.tipo }),
    numeroDocProveedor: g.doc.numero,
    ...(razon === undefined ? {} : { razonSocial: razon }),
    tipoComprobante: g.tipoComprobante,
    biDg,
    biDgng,
    biDng,
  };
}

// Una fila sin proveedor y sin base a la vez no se asigna a «sinProveedor» ni a «sinBase» de forma única en el contrato:
// el oráculo exacto la excluye (la suma de ambos descartes sí se comprueba con ella).
const sinAmbiguedad = (g: Generada): boolean => g.doc.clave !== "" || g.bases.some((b) => !new Decimal(b).isZero());
const filasArb = fc.array(filaArb, { maxLength: 60 });
const opciones = { numRuns: NUM_RUNS, seed: SEMILLA };

type Destino = "DG" | "DGNG" | "DNG";
const DESTINOS: readonly Destino[] = ["DG", "DGNG", "DNG"];
interface Esperada {
  conteos: Record<Destino | "mixto" | "total", number>;
  destino: Destino | null;
}

/** Oráculo: conteos por proveedor y destino propuesto con enteros (5·c ≥ 4·t, c ≥ 2, sin empate). */
function oraculo(gs: readonly Generada[]) {
  const porProveedor = new Map<string, Esperada>();
  let sinProveedor = 0;
  let sinBase = 0;
  for (const g of gs) {
    if (g.doc.clave === "") {
      sinProveedor += 1;
      continue;
    }
    const noCero = g.bases.map((b) => !new Decimal(b).abs().isZero());
    const n = noCero.filter(Boolean).length;
    if (n === 0) {
      sinBase += 1;
      continue;
    }
    const e = porProveedor.get(g.doc.clave) ?? { conteos: { DG: 0, DGNG: 0, DNG: 0, mixto: 0, total: 0 }, destino: null };
    porProveedor.set(g.doc.clave, e);
    e.conteos.total += 1;
    if (n >= 2) e.conteos.mixto += 1;
    else e.conteos[DESTINOS[noCero.indexOf(true)] as Destino] += 1;
  }
  for (const e of porProveedor.values()) {
    const cumple = DESTINOS.filter((d) => e.conteos[d] >= 2 && 5 * e.conteos[d] >= 4 * e.conteos.total);
    e.destino = cumple.length === 1 ? (cumple[0] as Destino) : null;
  }
  return { porProveedor, sinProveedor, sinBase };
}

const clave = (c: { proveedor: { tipo: string; numero: string } }) => `${c.proveedor.tipo}:${c.proveedor.numero}`;
const comparar = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

describe("aprenderDeHistorial: propiedades contra un oráculo", () => {
  it("coincide con el oráculo: conteos y destino de cada proveedor, y los descartados", () => {
    fc.assert(
      fc.property(fc.array(filaArb.filter(sinAmbiguedad), { maxLength: 60 }), (gs) => {
        const r = aprenderDeHistorial(gs.map(aFila));
        const o = oraculo(gs);
        expect(r.candidatas.map(clave)).toEqual([...o.porProveedor.keys()].sort(comparar));
        for (const c of r.candidatas) {
          const e = o.porProveedor.get(clave(c)) as Esperada;
          expect(c.conteos).toEqual(e.conteos);
          expect(c.destino).toBe(e.destino);
        }
        expect(r.descartadas).toEqual({ sinProveedor: o.sinProveedor, sinBase: o.sinBase });
      }),
      opciones,
    );
  });

  it("los conteos suman el total: DG + DGNG + DNG + mixto = total, y total ≥ 1", () => {
    fc.assert(
      fc.property(filasArb, (gs) => {
        for (const c of aprenderDeHistorial(gs.map(aFila)).candidatas) {
          expect(c.conteos.DG + c.conteos.DGNG + c.conteos.DNG + c.conteos.mixto).toBe(c.conteos.total);
          expect(c.conteos.total).toBeGreaterThanOrEqual(1);
        }
      }),
      opciones,
    );
  });

  it("solo propone si cumple U-2 (al menos 2 y al menos 80 %) y nunca con empate; si no, destino null", () => {
    fc.assert(
      fc.property(filasArb, (gs) => {
        for (const c of aprenderDeHistorial(gs.map(aFila)).candidatas) {
          const cumplen = DESTINOS.filter((d) => c.conteos[d] >= 2 && 5 * c.conteos[d] >= 4 * c.conteos.total);
          if (c.destino !== null) {
            expect(cumplen).toEqual([c.destino]);
          } else {
            expect(cumplen.length === 1).toBe(false);
          }
        }
      }),
      opciones,
    );
  });

  it("todas las filas quedan contadas o descartadas: Σ totales + sinProveedor + sinBase = nº de filas", () => {
    fc.assert(
      fc.property(filasArb, (gs) => {
        const r = aprenderDeHistorial(gs.map(aFila));
        const contadas = r.candidatas.reduce((s, c) => s + c.conteos.total, 0);
        expect(contadas + r.descartadas.sinProveedor + r.descartadas.sinBase).toBe(gs.length);
      }),
      opciones,
    );
  });

  it("orden estable: por tipo y número, sin claves repetidas", () => {
    fc.assert(
      fc.property(filasArb, (gs) => {
        const claves = aprenderDeHistorial(gs.map(aFila)).candidatas.map((c) => [c.proveedor.tipo, c.proveedor.numero] as const);
        for (let i = 1; i < claves.length; i++) {
          const a = claves[i - 1] as readonly [string, string];
          const b = claves[i] as readonly [string, string];
          expect(comparar(a[0], b[0]) || comparar(a[1], b[1])).toBe(-1);
        }
      }),
      opciones,
    );
  });

  it("invariante a permutar las filas (mismo resultado en cualquier orden de entrada)", () => {
    fc.assert(
      fc.property(filasArb, fc.integer({ min: 1, max: 1_000_000 }), (gs, semilla) => {
        const filas = gs.map(aFila);
        const barajadas = [...filas].sort((a, b) => hash(JSON.stringify(a), semilla) - hash(JSON.stringify(b), semilla));
        expect(aprenderDeHistorial(barajadas)).toEqual(aprenderDeHistorial(filas));
      }),
      opciones,
    );
  });

  it("el signo de las bases no importa: negar todas las bases no cambia el resultado", () => {
    fc.assert(
      fc.property(filasArb, (gs) => {
        const filas = gs.map(aFila);
        const negadas = filas.map((f) => ({ ...f, biDg: negar(f.biDg), biDgng: negar(f.biDgng), biDng: negar(f.biDng) }));
        expect(aprenderDeHistorial(negadas)).toEqual(aprenderDeHistorial(filas));
      }),
      opciones,
    );
  });

  it("los demás proveedores no influyen: agregar filas de otro proveedor no cambia las candidatas existentes", () => {
    fc.assert(
      fc.property(filasArb, filasArb, (a, b) => {
        const soloA = a.filter((g) => g.doc.clave === "6:20100070970").map(aFila);
        const otros = b.filter((g) => g.doc.clave !== "6:20100070970" && g.doc.clave !== "").map(aFila);
        const solo = aprenderDeHistorial(soloA).candidatas.filter((c) => clave(c) === "6:20100070970");
        const junto = aprenderDeHistorial([...soloA, ...otros]).candidatas.filter((c) => clave(c) === "6:20100070970");
        expect(junto).toEqual(solo);
      }),
      opciones,
    );
  });

  it("periodosConProveedor es al menos 1 y no pasa de los periodos distintos de la entrada", () => {
    fc.assert(
      fc.property(filasArb, (gs) => {
        const filas = gs.map(aFila);
        const distintos = new Set(filas.map((f) => f.periodo)).size;
        for (const c of aprenderDeHistorial(filas).candidatas) {
          expect(c.periodosConProveedor).toBeGreaterThanOrEqual(1);
          expect(c.periodosConProveedor).toBeLessThanOrEqual(distintos);
        }
      }),
      opciones,
    );
  });

  it("es determinista y no muta la entrada", () => {
    fc.assert(
      fc.property(filasArb, (gs) => {
        const filas = gs.map(aFila);
        const antes = JSON.stringify(filas);
        const a = aprenderDeHistorial(filas);
        const b = aprenderDeHistorial(filas);
        expect(b).toEqual(a);
        expect(JSON.stringify(filas)).toBe(antes);
      }),
      opciones,
    );
  });

  it("la razón social de cada candidata es la de su proveedor", () => {
    fc.assert(
      fc.property(filasArb, (gs) => {
        for (const c of aprenderDeHistorial(gs.map(aFila)).candidatas) {
          expect(c.razonSocial).toBe(`PROVEEDOR ${clave(c)}`);
        }
      }),
      opciones,
    );
  });
});

function negar(s: string): string {
  return new Decimal(s).isZero() ? s : new Decimal(s).neg().toFixed(2);
}

/** Hash determinista simple para barajar sin depender del orden de entrada. */
function hash(texto: string, semilla: number): number {
  let h = semilla;
  for (let i = 0; i < texto.length; i++) h = (Math.imul(h, 31) + texto.charCodeAt(i)) | 0;
  return h;
}
