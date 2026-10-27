// Ayudas de prueba (no es producción: usa enteros solo como oráculo independiente).
import fc from "fast-check";
import type { ColumnaCompra } from "../../src/comprobante/columnas";
import type { Moneda } from "../../src/dinero/index";

export const SEMILLA = 20261025;
export const NUM_RUNS = 1000;

/** Centavos enteros → string canónico `-?\d+\.\d{2}`. */
export function centavosAString(c: number): string {
  const neg = c < 0;
  const a = Math.abs(c);
  const ent = Math.trunc(a / 100);
  const dec = String(a % 100).padStart(2, "0");
  return `${neg && a !== 0 ? "-" : ""}${ent}.${dec}`;
}

export const COLS: readonly ColumnaCompra[] = [
  "biDg", "igvDg", "biDgng", "igvDgng", "biDng", "igvDng",
  "noGravado", "isc", "icbper", "otrosTributos",
];

export type FilaCentavos = Record<ColumnaCompra, number>;

/** Fila con columnas en centavos (mismo signo: todas ≥ 0 o todas ≤ 0, D6). */
export function arbFila(): fc.Arbitrary<FilaCentavos> {
  return fc
    .tuple(
      fc.boolean(),
      fc.array(fc.integer({ min: 0, max: 100_000_000 }), { minLength: 10, maxLength: 10 }),
    )
    .map(([nota, v]) => {
      const fila = {} as FilaCentavos;
      COLS.forEach((c, i) => {
        fila[c] = nota ? -v[i]! : v[i]!;
      });
      return fila;
    });
}

export function totalCentavos(f: FilaCentavos): number {
  return COLS.reduce((s, c) => s + f[c], 0);
}

/** Valores para `MontosComprobante.desde` con total = Σ columnas. */
export function valores(f: FilaCentavos): Record<string, string> {
  const v: Record<string, string> = {};
  for (const c of COLS) v[c] = centavosAString(f[c]);
  v.total = centavosAString(totalCentavos(f));
  return v;
}

export const MONEDAS: readonly Moneda[] = ["PEN", "USD"];
