// Ventana de la prorrata (spec 026, R-1, U-1): los 12 periodos de M−11 a M, en orden.
import { type Entero, enteroDeDigitos } from "../texto/entero";
import { ProrrataError } from "./errores";

const GRAMATICA_PERIODO = /^[0-9]{4}(0[1-9]|1[0-2])$/;
const MESES_VENTANA = 12;

/** Lanza ProrrataError si `periodo` no es AAAAMM (mes 01–12, año ≥ 0001); devuelve el mismo texto. */
export function asegurarPeriodo(periodo: unknown): string {
  if (typeof periodo !== "string" || !GRAMATICA_PERIODO.test(periodo) || periodo.startsWith("0000")) {
    throw new ProrrataError("PERIODO_INVALIDO");
  }
  return periodo;
}

/** Los 12 periodos AAAAMM que terminan en `periodo` (incluido), del más antiguo al más reciente. */
export function ventanaProrrata(periodo: string): string[] {
  const p = asegurarPeriodo(periodo);
  // Índice absoluto de meses (año × 12 + mes − 1); la gramática garantiza los dígitos.
  const anioM = enteroDeDigitos(p.slice(0, 4)) as Entero;
  const mesM = enteroDeDigitos(p.slice(4)) as Entero;
  const fin = anioM * MESES_VENTANA + mesM - 1;
  const ventana: string[] = [];
  for (let i = fin - (MESES_VENTANA - 1); i <= fin; i++) {
    const anio = (i - (i % MESES_VENTANA)) / MESES_VENTANA;
    const mes = (i % MESES_VENTANA) + 1;
    ventana.push(`${String(anio).padStart(4, "0")}${String(mes).padStart(2, "0")}`);
  }
  return ventana;
}
