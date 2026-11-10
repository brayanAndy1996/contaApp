// Spec 016 (D-2): importes del XML → `Money` en la moneda del documento. Todo importe pasa por `MontoExacto` y
// `redondearSunat` (mitad hacia afuera a 2 decimales) y debe caber en NUMERIC(14,2); si no, `xml_invalido`. Ningún monto
// pasa por `number`. Ningún importe del XML puede ser negativo.
import { Money, MontoExacto, redondearSunat } from "../dinero/index";
import type { Moneda } from "../dinero/index";
import { invalido } from "./tipos";

/** Cantidad o precio exacto: decimal sin signo, hasta 12 enteros y 10 decimales. */
const DECIMAL_EXACTO = /^[0-9]{1,12}(\.[0-9]{1,10})?$/;

/** Ejecuta `f` y convierte su error (de dinero: monto inválido o fuera de rango) en `xml_invalido`, sin causa. */
function enDinero<T>(f: () => T): T {
  try {
    return f();
  } catch {
    return invalido();
  }
}

/**
 * Importe del XML (texto ya recortado) → `Money` redondeado. `null` (el elemento no vino) → 0.00. Un importe estrictamente
 * negativo es `xml_invalido` en cualquier raíz (H-016-4): el signo de la nota de crédito lo pone solo el mapeo. `-0` y `-0.00`
 * no son negativos y quedan en 0.00.
 */
export function importe(texto: string | null, moneda: Moneda): Money {
  if (texto === null) return Money.cero(moneda);
  const exacto = enDinero(() => MontoExacto.desde(texto, moneda));
  if (exacto.toString().startsWith("-")) invalido();
  return enDinero(() => redondearSunat(exacto));
}

/** Suma de importes; el resultado también debe caber en NUMERIC(14,2). */
export function sumar(lista: readonly Money[], moneda: Moneda): Money {
  return enDinero(() => Money.suma(lista, moneda));
}

/** Texto final de un total o importe de línea: con signo negativo en las notas de crédito. */
export function texto(m: Money, negativo: boolean): string {
  return (negativo ? m.negar() : m).toString();
}

/** Cantidad o precio unitario, exacto como texto (solo se muestra); sin él, "0". */
export function exacto(valor: string | null): string {
  if (valor === null) return "0";
  return DECIMAL_EXACTO.test(valor) ? valor : invalido();
}
