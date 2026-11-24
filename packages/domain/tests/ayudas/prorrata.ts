// Spec 026 · T1. Ayudas de las pruebas de prorrata: construyen meses con `resolverMes` (así las pruebas del coeficiente
// no dependen de la representación interna de `MesProrrata`) y un oráculo con `BigInt` en céntimos, sin reutilizar el dominio.
import { Money } from "../../src/dinero/index";
import { resolverMes } from "../../src/prorrata/meses";

export const pen = (s: string): Money => Money.desde(s, "PEN");

/** Céntimos → cadena canónica de Money («-?\d+\.\d{2}», sin -0.00). */
export function aTexto(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg && a !== 0n ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
}

/** Cadena canónica de Money (o la cadena tal cual) → céntimos. */
export function aCentimos(s: string): bigint {
  const neg = s.startsWith("-");
  const [e, d = ""] = (neg ? s.slice(1) : s).split(".");
  const c = BigInt(e) * 100n + BigInt(d.padEnd(2, "0").slice(0, 2));
  return neg ? -c : c;
}

/** Los 12 periodos AAAAMM que terminan en `m` (AAAAMM), con aritmética entera independiente. */
export function ventanaOraculo(m: string): string[] {
  const anio = Number(m.slice(0, 4));
  const mes = Number(m.slice(4, 6));
  const fin = anio * 12 + (mes - 1);
  const r: string[] = [];
  for (let i = fin - 11; i <= fin; i++) {
    const a = Math.floor(i / 12);
    const mm = (i % 12) + 1;
    r.push(`${a}${String(mm).padStart(2, "0")}`);
  }
  return r;
}

/** Ventana de 2026-10: 2025-11 a 2026-10. */
export const VENTANA_202610 = ventanaOraculo("202610");

export interface PresentacionPrueba {
  numeroOrden: string;
  fechaPresentacion: string;
  tipo: "original" | "rectificatoria";
  ventasGravadasBase: string;
  ventasGravadasIgv: string;
  exportaciones: string;
  noGravadas: string;
  igvAdquisicionesDg: string;
  igvAdquisicionesDgng: string;
  prorrataUsada: string | null;
}

/** Presentación del PDT 621 con la forma de `Declaracion621` (sunat) sin el periodo. */
export const presentacion = (p: Partial<PresentacionPrueba> = {}): PresentacionPrueba => ({
  numeroOrden: "1",
  fechaPresentacion: "2026-01-15",
  tipo: "original",
  ventasGravadasBase: "0.00",
  ventasGravadasIgv: "0.00",
  exportaciones: "0.00",
  noGravadas: "0.00",
  igvAdquisicionesDg: "0.00",
  igvAdquisicionesDgng: "0.00",
  prorrataUsada: null,
  ...p,
});

export const PEN_CERO = { baseGravada: "0.00", exonerada: "0.00", inafecta: "0.00" };

/** Mes declarado con una sola presentación (original). */
export const mesDeclarado = (periodo: string, gravadas: string, exportaciones: string, noGravadas: string) =>
  resolverMes({
    periodo,
    declaraciones: [presentacion({ ventasGravadasBase: gravadas, exportaciones, noGravadas })],
    manual: null,
    sire: null,
  });

/** Mes con manual vigente y sin declaración ni SIRE. */
export const mesManual = (periodo: string, gravadas: string, exportaciones: string, noGravadas: string) =>
  resolverMes({ periodo, declaraciones: [], manual: { gravadas, exportaciones, noGravadas }, sire: null });

/** Mes solo SIRE, en soles. */
export const mesSire = (periodo: string, baseGravada: string, noGravadas = "0.00") =>
  resolverMes({
    periodo,
    declaraciones: [],
    manual: null,
    sire: { pen: { baseGravada, exonerada: noGravadas, inafecta: "0.00" }, usd: [] },
  });

/** Mes sin ningún origen. */
export const mesFalta = (periodo: string) =>
  resolverMes({ periodo, declaraciones: [], manual: null, sire: null });

/** 12 meses declarados iguales (cada uno con los mismos montos). */
export const docePorMes = (
  montos: (periodo: string, i: number) => [string, string, string],
  origen: "declarado" | "manual" = "manual",
  periodoM = "202610",
) =>
  ventanaOraculo(periodoM).map((p, i) => {
    const [g, e, n] = montos(p, i);
    return origen === "manual" ? mesManual(p, g, e, n) : mesDeclarado(p, g, e, n);
  });

/** Reemplaza el mes `i` por `mes`. */
export function conMes<T>(meses: readonly T[], i: number, mes: T): T[] {
  return meses.map((m, k) => (k === i ? mes : m));
}
