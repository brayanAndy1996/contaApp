import Decimal from "decimal.js";
import { montoDecimalSchema, type MontosCompra } from "@contapp/shared";

// Montos de la pantalla de compras (spec 015, D-3, P-2). ÚNICO archivo del frontend que importa `decimal.js`
// (lo comprueba `compras.estatico.spec.ts`). Todo monto es una cadena decimal de NUMERIC(14,2): ninguna
// función recibe ni devuelve un `number`, y aquí tampoco se convierte a uno. El servidor sigue siendo la
// fuente de cada cifra; esto solo suma lo que el usuario teclea (total en vivo), compara y da formato.

/** Copia aislada de `Decimal`: la precisión alta evita redondeos al sumar hasta 5.000 filas de 14 dígitos. */
const D = Decimal.clone({ precision: 40 });

const ENTERO_MAX = 12;
const DECIMALES_MAX = 2;

export const MOTIVOS_MONTO = {
  vacio: "Escribe un monto.",
  decimales: "El monto admite como máximo 2 decimales.",
  signo:
    "El signo solo puede ir al inicio y ser «-» (para un monto negativo).",
  formato:
    "El monto debe tener solo dígitos y un punto decimal, por ejemplo 1234.50.",
  enteros: "El monto admite como máximo 12 dígitos enteros.",
} as const;

export type ResultadoMonto =
  { ok: true; valor: string } | { ok: false; motivo: string };

/** Decimal en texto plano: signo opcional, enteros y decimales opcionales. Acota el largo (nada de exponentes). */
const DECIMAL_EXACTO = /^-?\d{1,30}(?:\.\d{1,12})?$/;

/**
 * Cadena exacta (sin redondear) con al menos 2 decimales: 0.1 + 0.2 + 0.005 → «0.305», 0.1 + 0.2 → «0.30».
 * El cero es siempre «0.00» (nunca «-0.00»).
 */
function textoExacto(d: Decimal): string {
  if (d.isZero()) return "0.00";
  const [entero = "0", decimales = ""] = d.toFixed().split(".");
  return `${entero}.${decimales.padEnd(DECIMALES_MAX, "0")}`;
}

/** `Decimal` de un monto del servidor o ya validado; lanza `RangeError` si la cadena no es un decimal plano. */
function leer(monto: string): Decimal {
  if (!DECIMAL_EXACTO.test(monto)) throw new RangeError("monto inválido");
  return new D(monto);
}

/**
 * Suma exacta de decimales en texto, sin redondear: los montos del servidor (2 decimales) dan 2 decimales y
 * una entrada con más precisión la conserva. Cada elemento debe ser un decimal plano (el servidor los envía
 * así; lo tecleado pasa antes por `validarMonto`): uno inválido lanza `RangeError` en vez de dar un total a medias.
 */
export function sumar(cadenas: readonly string[]): string {
  let total = new D(0);
  for (const c of cadenas) total = total.plus(leer(c));
  return textoExacto(total);
}

/** ¿Valen lo mismo? «1.5» y «1.50» sí. Una cadena que no es decimal nunca es igual a nada. */
export function iguales(a: string, b: string): boolean {
  if (!DECIMAL_EXACTO.test(a) || !DECIMAL_EXACTO.test(b)) return false;
  return new D(a).eq(new D(b));
}

/**
 * Formato de miles por manipulación de texto: «1234.5» → «1,234.50», «-1234567.89» → «-1,234,567.89».
 * El cero negativo se muestra «0.00». Un texto que no es monto se devuelve tal cual (React lo escapa).
 */
export function conMiles(monto: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(monto);
  if (!m || !montoDecimalSchema.safeParse(monto).success) return monto;
  const entero = (m[2] ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const decimales = (m[3] ?? "").padEnd(DECIMALES_MAX, "0");
  const esCero = !/[1-9]/.test(`${m[2] ?? ""}${m[3] ?? ""}`);
  return `${esCero ? "" : (m[1] ?? "")}${entero}.${decimales}`;
}

/**
 * Valida lo que el usuario teclea o pega en una celda de monto. Acepta negativos (notas de crédito) y
 * devuelve la forma canónica con 2 decimales. Más de 2 decimales se rechaza con su motivo: nunca se
 * redondea en silencio. La última palabra la tiene `montoDecimalSchema`, el mismo que usa el servidor.
 */
export function validarMonto(texto: string): ResultadoMonto {
  const t = texto.trim();
  if (t === "") return { ok: false, motivo: MOTIVOS_MONTO.vacio };
  if (/[^0-9.+-]/.test(t)) return { ok: false, motivo: MOTIVOS_MONTO.formato };
  // El único signo válido es un «-» al inicio: «+5», «5-» y «--5» se explican como error de signo.
  if (/\+|.-/.test(t)) return { ok: false, motivo: MOTIVOS_MONTO.signo };
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(t);
  if (!m) return { ok: false, motivo: MOTIVOS_MONTO.formato };
  const decimales = m[3] ?? "";
  if (decimales.length > DECIMALES_MAX) {
    return { ok: false, motivo: MOTIVOS_MONTO.decimales };
  }
  const entero = (m[2] ?? "").replace(/^0+(?=\d)/, "");
  if (entero.length > ENTERO_MAX) {
    return { ok: false, motivo: MOTIVOS_MONTO.enteros };
  }
  const valor = textoExacto(new D(`${m[1] ?? ""}${entero}.${decimales || "0"}`));
  if (!montoDecimalSchema.safeParse(valor).success) {
    return { ok: false, motivo: MOTIVOS_MONTO.formato };
  }
  return { ok: true, valor };
}

export type DestinoFila = "DG" | "DGNG" | "DNG" | "Mixta" | "Sin base";

/**
 * Destino informativo de la fila (P-5): compara con cero las tres bases. Una sola base distinta de cero da
 * su destino; más de una, «Mixta»; ninguna, «Sin base». No escribe nada: la clasificación real es del servidor.
 */
export function destinoDe(
  montos: Pick<MontosCompra, "biDg" | "biDgng" | "biDng">,
): DestinoFila {
  const con: DestinoFila[] = [];
  if (!leer(montos.biDg).isZero()) con.push("DG");
  if (!leer(montos.biDgng).isZero()) con.push("DGNG");
  if (!leer(montos.biDng).isZero()) con.push("DNG");
  if (con.length === 0) return "Sin base";
  if (con.length > 1) return "Mixta";
  return con[0] ?? "Sin base";
}
