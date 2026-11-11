// Duplicados entre las filas generables (D11, CA-6; plan, Ratificación 10; D20). Clave: tipo de
// comprobante, serie en mayúsculas ASCII, número sin ceros a la izquierda y documento del proveedor
// (tipo y número en mayúsculas ASCII). El error va en todas las copias, también en las que tienen error de estructura.
import { compararTexto, esVentaCopia } from "./entrada";
import type { FilaTxt } from "./entrada";
import { crearError } from "./errores";
import { MAX_IDS_DUPLICADO, duplicado } from "./explicaciones";
import type { ErrorPrevalidacion } from "./tipos";

const MINUSCULA_ASCII = /[a-z]/g;
/** Ceros a la izquierda sin dejar el número vacío: «000» → «0», que no es «» (H-012-41). */
const CEROS_IZQUIERDA = /^0+(?=[\s\S])/;

/** Solo a-z: ningún otro carácter cambia (sin locale ni plegado Unicode). */
function mayusculasAscii(s: string): string {
  return s.replace(MINUSCULA_ASCII, (c) => c.toUpperCase());
}

/**
 * Clave de duplicado: tipo de comprobante, serie y número normalizados, y documento del proveedor. La
 * usan 012 (DUPLICADO) y 014 (`claveComprobante`), así que ambas deciden lo mismo. El número del
 * documento va en mayúsculas ASCII, como lo normaliza 011 (D20, H-012-26).
 */
export function claveDuplicado(
  comprobante: { readonly tipo: string; readonly serie: string; readonly numero: string },
  proveedor: { readonly tipo: string; readonly numero: string },
): string {
  return JSON.stringify([
    comprobante.tipo,
    mayusculasAscii(comprobante.serie),
    comprobante.numero.replace(CEROS_IZQUIERDA, ""),
    proveedor.tipo,
    mayusculasAscii(proveedor.numero),
  ]);
}

/** En ventas el comprobante lo emite el declarante: la contraparte no lo distingue (012b). */
const SIN_DOCUMENTO = Object.freeze({ tipo: "", numero: "" });

function clave(f: FilaTxt): string {
  return claveDuplicado(f.comprobante, esVentaCopia(f) ? SIN_DOCUMENTO : f.proveedor);
}

/** Un error DUPLICADO por copia; su explicación da los ids de las otras copias. */
export function buscarDuplicados(filas: readonly FilaTxt[]): ErrorPrevalidacion[] {
  const grupos = new Map<string, string[]>();
  for (const f of filas) {
    const k = clave(f);
    const ids = grupos.get(k);
    if (ids === undefined) grupos.set(k, [f.id]);
    else ids.push(f.id);
  }
  const errores: ErrorPrevalidacion[] = [];
  for (const ids of grupos.values()) {
    if (ids.length < 2) continue;
    const ordenados = [...ids].sort(compararTexto);
    // Los primeros MAX + 1 bastan: sin la propia, quedan al menos MAX (ids únicos).
    const primeros = ordenados.slice(0, MAX_IDS_DUPLICADO + 1);
    for (const id of ordenados) {
      const otros = primeros.filter((x) => x !== id).slice(0, MAX_IDS_DUPLICADO);
      errores.push(
        crearError({
          filaId: id,
          codigo: "DUPLICADO",
          campo: null,
          explicacion: duplicado(otros, ordenados.length - 1 - otros.length),
        }),
      );
    }
  }
  return errores;
}
