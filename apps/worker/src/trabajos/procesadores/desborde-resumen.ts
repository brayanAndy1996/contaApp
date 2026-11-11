// Desborde del resumen al generar (spec 012b, ronda 1, H-012b-2). `prepararArchivo` (domain) convierte un impacto en IGV que no cabe
// en NUMERIC(14,2) en `EntradaPrevalidacionInvalidaError` (D22 y H-012-28 de 012), el mismo error que una forma imposible de la
// entrada (un error de programación, que no se traduce). Para traducir SOLO el desborde, ante ese error se repite el
// armado con las mismas filas y todos sus montos en 0.00 (mismas monedas, ids, estados, comprobantes y tipos de cambio): si así pasa,
// el fallo dependía de los montos, y lo único que depende de los montos y lanza es la suma del resumen (las conversiones y la
// prevalidación de una fila no lanzan: son errores corregibles). Si también falla, era la forma y se propaga tal cual.
// El gemelo del backend está en `apps/backend/src/modules/archivos/desborde.ts` (mismo criterio; el worker no depende del backend).
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

/** La misma entrada con todos los montos de las filas en 0.00. Lanza si la forma no lo permite (entonces no es un desborde). */
function enCero(e: EntradaPreparar): EntradaPreparar {
  if (e.libro === "ventas") return { ...e, original: e.original.map(ventaEnCero), vigente: e.vigente.map(ventaEnCero) };
  return { ...e, original: e.original.map(compraEnCero), vigente: e.vigente.map(compraEnCero) };
}

function esDesbordeDelResumen(e: EntradaPreparar): boolean {
  try {
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
