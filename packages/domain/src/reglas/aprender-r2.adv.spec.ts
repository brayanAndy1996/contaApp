// Spec 025 · T18 (ronda adversarial 2), deducción pura: montos extremos y fuera de NUMERIC(14,2), el 80 % exacto con muchos
// comprobantes, razones sociales hostiles (`|`, saltos de línea, bidi, 10.000 caracteres) frente a la gramática que exige
// `reglas_importacion_completar` (0064) y R-STD sobre notas de crédito e IGV sin base. Las que revelan un hallazgo quedan en rojo
// (H-025-2-n en tasks.md); las verdes quedan como regresión.
import { describe, expect, it } from "vitest";
import { MontosComprobante, cambiarDestino } from "../comprobante/index";
import { aceptarSugerenciaGuardada } from "../compras/aceptar";
import { crearEvaluarCompras } from "../compras/evaluar";
import type { CompraEvaluable } from "../compras/evaluar";
import { MontoInvalidoError } from "../dinero/index";
import { aprenderDeHistorial } from "./index";
import type { FilaHistorial } from "./index";

const RUC = "20100070970";
type Dest = "DG" | "DGNG" | "DNG";

const fila = (destino: Dest | "MIXTA", over: Partial<FilaHistorial> = {}): FilaHistorial => ({
  periodo: "202609",
  numeroDocProveedor: RUC,
  tipoComprobante: "01",
  biDg: destino === "DG" || destino === "MIXTA" ? "100.00" : "0.00",
  biDgng: destino === "DGNG" || destino === "MIXTA" ? "100.00" : "0.00",
  biDng: destino === "DNG" ? "100.00" : "0.00",
  ...over,
});
const n = (k: number, destino: Dest | "MIXTA", over: Partial<FilaHistorial> = {}): FilaHistorial[] =>
  Array.from({ length: k }, () => fila(destino, over));

/** Gramática de `reglas_importacion_completar` (0064) y del CHECK `regla_candidata_razon_social_valida` (0061). */
const CONTROLES_BD = /[\u0001-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/u;
const razonAdmitidaPorBd = (r: string | null): boolean =>
  r === null || (Array.from(r).length >= 1 && Array.from(r).length <= 200 && !CONTROLES_BD.test(r));

/** Baraja determinista (LCG) para comprobar que el resultado no depende del orden. */
function barajar<T>(xs: readonly T[], semilla: number): T[] {
  const a = [...xs];
  let s = semilla >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

describe("T18 · aprenderDeHistorial: dinero", () => {
  it("ADV2-1 montos en el borde de NUMERIC(14,2) y notas de crédito por el máximo cuentan; uno fuera de rango no se cuenta en silencio", () => {
    const r = aprenderDeHistorial([
      fila("DG", { biDg: "999999999999.99" }),
      fila("DG", { tipoComprobante: "07", biDg: "-999999999999.99" }),
      fila("DG", { biDg: "0.01" }),
      fila("DG", { tipoComprobante: "07", biDg: "-0.01" }),
      fila("DG", { biDg: "-0.00" }),
    ]);
    expect(r.candidatas).toHaveLength(1);
    expect(r.candidatas[0]?.conteos).toEqual({ DG: 4, DGNG: 0, DNG: 0, mixto: 0, total: 4 });
    expect(r.descartadas.sinBase, "«-0.00» es base cero").toBe(1);
    // Un monto que NUMERIC(14,2) no admite no puede pasar por «≠ 0» ni por «sin base»: el worker lo convierte en fila ilegible.
    for (const malo of ["1000000000000.00", "0.005", "100.005", " 100.00", "1e2", "100,00", "+100.00", ".50", "NaN", "Infinity"]) {
      expect(() => aprenderDeHistorial([fila("DG", { biDg: malo })]), malo).toThrow(MontoInvalidoError);
    }
  });

  it("ADV2-2 el 80 % exacto con muchos comprobantes (enteros, sin flotantes) y sin depender del orden", () => {
    const casos: Array<[string, FilaHistorial[], Dest | null]> = [
      ["800 DG + 200 mixtos de 1.000", [...n(800, "DG"), ...n(200, "MIXTA")], "DG"],
      ["799 DG + 201 DNG de 1.000", [...n(799, "DG"), ...n(201, "DNG")], null],
      ["4.000 DGNG + 1.000 DG", [...n(4000, "DGNG"), ...n(1000, "DG")], "DGNG"],
      ["3.999 DGNG + 1.000 DG + 1 mixto", [...n(3999, "DGNG"), ...n(1000, "DG"), ...n(1, "MIXTA")], null],
      ["4 DNG + 1 DG (el mínimo con 80 %)", [...n(4, "DNG"), ...n(1, "DG")], "DNG"],
      ["1 DG (100 % pero menos de 2)", n(1, "DG"), null],
      ["2 DG + 50 sin base (no cuentan)", [...n(2, "DG"), ...n(50, "DG", { biDg: "0.00" })], "DG"],
    ];
    for (const [nombre, filas, esperado] of casos) {
      const base = aprenderDeHistorial(filas);
      expect(base.candidatas[0]?.destino ?? null, nombre).toBe(esperado);
      for (const semilla of [1, 7, 2026]) {
        expect(aprenderDeHistorial(barajar(filas, semilla)), `${nombre} (barajado ${semilla})`).toEqual(base);
      }
    }
  });
});

describe("T18 · aprenderDeHistorial: razón social y documento frente a la gramática de la BD", () => {
  it("ADV2-3 `|`, saltos de línea, bidi, NUL, sustitutos sueltos y 10.000 caracteres: lo que sale lo admite completar (0064)", () => {
    const hostiles = [
      "ACME | SAC|||",
      "LINEA 1\nLINEA 2\r\nLINEA 3 LINEA 4 FIN",
      "‮ODAINOR‬ ⁦AISLADO⁩ ؜ARABE ‎‏",
      "\u0000NUL\u0001\u001F\u007F\u0085\u009F",
      "SUSTITUTO \uD800 SUELTO \uDFFF Y PAR 😀",
      "﻿​‍ CERO ANCHO ⁠",
      "Ñ".repeat(10_000),
      "😀".repeat(10_000),
      `${" ".repeat(150)}${"‮".repeat(100)}X${"A".repeat(300)}`,
      " 　\t\n",
      "‮‬⁦⁩",
    ];
    for (const [i, razon] of hostiles.entries()) {
      const r = aprenderDeHistorial([fila("DG", { razonSocial: razon, numeroDocProveedor: `2010007${String(i).padStart(4, "0")}` })]);
      const c = r.candidatas[0];
      expect(c, `caso ${i}`).toBeDefined();
      expect(razonAdmitidaPorBd(c?.razonSocial ?? null), `caso ${i}: ${JSON.stringify(c?.razonSocial)?.slice(0, 80)}`).toBe(true);
    }
    // El separador del TXT no es un control: se conserva (la candidata no se exporta).
    expect(aprenderDeHistorial([fila("DG", { razonSocial: "A|B" })]).candidatas[0]?.razonSocial).toBe("A|B");
  });
});

describe("T18 · R-STD: nota de crédito e IGV sin base (CA-9)", () => {
  const CERO = { biDg: "0.00", igvDg: "0.00", biDgng: "0.00", igvDgng: "0.00", biDng: "0.00", igvDng: "0.00", noGravado: "0.00", isc: "0.00", icbper: "0.00", otrosTributos: "0.00", total: "0.00" };
  const SELVA = { zona: "amazonia", ventasExoneradas: true, ventasMixtas: false } as const;
  const compra = (m: Partial<typeof CERO>, o: Partial<CompraEvaluable> = {}): CompraEvaluable => ({
    docTipo: "6",
    docNumero: RUC,
    tipoDoc: "01",
    serie: "F001",
    numero: "77",
    moneda: "PEN",
    clasificada: false,
    montos: { ...CERO, ...m },
    ...o,
  });

  it("ADV2-4 en masa da lo mismo que clasificar a mano en DNG, conserva el total y no lo sugiere con solo IGV fuera de DNG", () => {
    const evaluar = crearEvaluarCompras([{ tipo: "6", numero: RUC }], { xmlSimuladoEnReglas: false, perfil: SELVA });
    const casos: CompraEvaluable[] = [
      compra({ biDg: "-100.00", igvDg: "-18.00", total: "-118.00" }, { tipoDoc: "07" }),
      compra({ igvDg: "18.00", biDgng: "100.00", total: "118.00" }),
      compra({ biDg: "-50.00", igvDg: "-9.00", biDgng: "150.00", igvDgng: "27.00", total: "118.00" }),
      compra({ biDg: "999999999999.99", total: "999999999999.99" }, { moneda: "USD" }),
    ];
    for (const [i, c] of casos.entries()) {
      const h = evaluar(c).find((x) => x.regla === "R-STD");
      expect(h, `caso ${i}: R-STD`).toBeDefined();
      const r = aceptarSugerenciaGuardada({
        compra: c,
        hallazgo: h,
        proveedoresConocidos: [{ tipo: "6", numero: RUC }],
        confirmar: false,
        dato: undefined,
        enMasa: true,
      });
      const aMano = cambiarDestino(MontosComprobante.desde(c.moneda, c.montos), "DNG").montos.toJSON();
      expect(r, `caso ${i}`).toEqual({ ok: true, montos: { ...aMano.columnas, total: aMano.total }, excluir: false, clasifica: true });
      expect(r.ok && r.montos.total, `caso ${i}: total`).toBe(c.montos.total);
    }
    // IGV en DG sin base gravada fuera de DNG: no hay base que mover (D-8 exige base gravada fuera de DNG).
    expect(evaluar(compra({ igvDg: "18.00", biDng: "100.00", total: "118.00" })).map((x) => x.regla)).not.toContain("R-STD");
  });
});
