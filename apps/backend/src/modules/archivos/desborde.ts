// Desborde del resumen del previo (spec 012b, ronda 1, H-012b-2). `prepararArchivo` (domain) convierte un impacto en IGV que no cabe
// en NUMERIC(14,2) en `EntradaPrevalidacionInvalidaError` (D22 y H-012-28 de 012), el mismo error que una forma imposible de la
// entrada (un error de programación, que debe seguir siendo un 500). Para traducir SOLO el desborde, ante ese error se repite el
// armado con las mismas filas y todos sus montos en 0.00 (mismas monedas, ids, estados, comprobantes y tipos de cambio): si así pasa,
// el fallo dependía de los montos, y lo único que depende de los montos y lanza es la suma del resumen (las conversiones y la
// prevalidación de una fila no lanzan: son errores corregibles). Si también falla, era la forma y se propaga tal cual.
// Antes del armado en cero se exige que cada monto sea un `Money` / `MontosComprobante` real (H-012b-5): la reconstrucción en
// cero reemplazaría una forma imposible EN los montos por montos válidos y la haría pasar por desborde. La prueba de «real» usa
// la marca privada de las clases a través de su API pública (`sumar` lee el campo privado del argumento y lanza si no lo tiene),
// así que no la engañan objetos con la misma forma visible ni prototipos copiados.
// El gemelo del worker está en `apps/worker/src/trabajos/procesadores/desborde-resumen.ts` (mismo criterio).
import {
  EntradaPrevalidacionInvalidaError,
  Money,
  MontosComprobante,
  prepararArchivo,
  type ArchivoPreparado,
  type FilaReemplazo,
  type FilaReemplazoVenta,
} from "@contapp/domain";

type EntradaPreparar = Parameters<typeof prepararArchivo>[0];

const montosEnCero = (m: MontosComprobante): MontosComprobante => MontosComprobante.desde(m.moneda, { total: "0.00" });

function compraEnCero(f: FilaReemplazo): FilaReemplazo {
  return {
    ...f,
    montos: montosEnCero(f.montos),
    origenUsd: f.origenUsd === null ? null : { ...f.origenUsd, montos: montosEnCero(f.origenUsd.montos) },
  };
}

function ventaEnCero(f: FilaReemplazoVenta): FilaReemplazoVenta {
  const montos = Object.fromEntries(Object.entries(f.montos).map(([k, m]) => [k, Money.cero(m.moneda)]));
  return { ...f, montos: montos as FilaReemplazoVenta["montos"] };
}

/** Un `Money` creado por su constructor (no una imitación): sumarlo a un cero de su moneda solo pasa con la marca privada. */
function esMoneyReal(x: unknown): boolean {
  if (!(x instanceof Money)) return false;
  try {
    Money.cero(x.moneda).sumar(x);
    return true;
  } catch {
    return false;
  }
}

/** Un `MontosComprobante` creado por su constructor (no una imitación), por la misma vía que `esMoneyReal`. */
function esMontosReales(x: unknown): boolean {
  if (!(x instanceof MontosComprobante)) return false;
  try {
    MontosComprobante.desde(x.moneda, { total: "0.00" }).sumar(x);
    return true;
  } catch {
    return false;
  }
}

function montosDeVentaReales(f: FilaReemplazoVenta): boolean {
  const montos: unknown = f.montos;
  return typeof montos === "object" && montos !== null && Object.values(montos).every(esMoneyReal);
}

function montosDeCompraReales(f: FilaReemplazo): boolean {
  if (!esMontosReales(f.montos)) return false;
  const usd: unknown = f.origenUsd;
  if (usd === null) return true;
  return typeof usd === "object" && esMontosReales((usd as { montos?: unknown }).montos);
}

/** Todos los montos de todas las filas son instancias reales; si no, la forma es imposible y no se evalúa el desborde. */
function montosReales(e: EntradaPreparar): boolean {
  const filas: readonly unknown[] = [...e.original, ...e.vigente];
  return e.libro === "ventas"
    ? (filas as FilaReemplazoVenta[]).every((f) => typeof f === "object" && f !== null && montosDeVentaReales(f))
    : (filas as FilaReemplazo[]).every((f) => typeof f === "object" && f !== null && montosDeCompraReales(f));
}

/** La misma entrada con todos los montos de las filas en 0.00. Lanza si la forma no lo permite (entonces no es un desborde). */
function enCero(e: EntradaPreparar): EntradaPreparar {
  if (e.libro === "ventas") return { ...e, original: e.original.map(ventaEnCero), vigente: e.vigente.map(ventaEnCero) };
  return { ...e, original: e.original.map(compraEnCero), vigente: e.vigente.map(compraEnCero) };
}

function esDesbordeDelResumen(e: EntradaPreparar): boolean {
  try {
    if (!montosReales(e)) return false;
    prepararArchivo(enCero(e));
    return true;
  } catch {
    return false;
  }
}

/**
 * `prepararArchivo`, salvo que un impacto en IGV fuera de NUMERIC(14,2) lanza lo que devuelve `fueraDeRango` (sin datos de las
 * filas). Cualquier otro error, incluida una `EntradaPrevalidacionInvalidaError` de forma, se propaga tal cual.
 */
export function prepararSinDesborde(e: EntradaPreparar, fueraDeRango: () => Error): ArchivoPreparado {
  try {
    return prepararArchivo(e);
  } catch (err) {
    if (err instanceof EntradaPrevalidacionInvalidaError && esDesbordeDelResumen(e)) throw fueraDeRango();
    throw err;
  }
}
