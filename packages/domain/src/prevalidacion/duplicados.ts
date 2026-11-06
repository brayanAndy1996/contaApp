// Duplicados entre las filas generables (D11, CA-6; plan, Ratificación 10; D20). Clave: tipo de
// comprobante, serie en mayúsculas ASCII, número sin ceros a la izquierda y documento del proveedor
// (tipo y número en mayúsculas ASCII). El error va en todas las copias, también en las que tienen error de estructura.
import { compararTexto } from "./entrada";
import type { FilaCopia } from "./entrada";
import { crearError } from "./errores";
import { MAX_IDS_DUPLICADO, duplicado } from "./explicaciones";
import type { ErrorPrevalidacion } from "./tipos";

const MINUSCULA_ASCII = /[a-z]/g;
const CEROS_IZQUIERDA = /^0+/;

/** Solo a-z: ningún otro carácter cambia (sin locale ni plegado Unicode). */
function mayusculasAscii(s: string): string {
  return s.replace(MINUSCULA_ASCII, (c) => c.toUpperCase());
}

/** El número del documento va en mayúsculas ASCII, como lo normaliza 011 (D20, H-012-26). */
function clave(f: FilaCopia): string {
  const { tipo, serie, numero } = f.comprobante;
  return JSON.stringify([
    tipo,
    mayusculasAscii(serie),
    numero.replace(CEROS_IZQUIERDA, ""),
    f.proveedor.tipo,
    mayusculasAscii(f.proveedor.numero),
  ]);
}

/** Un error DUPLICADO por copia; su explicación da los ids de las otras copias. */
export function buscarDuplicados(filas: readonly FilaCopia[]): ErrorPrevalidacion[] {
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
