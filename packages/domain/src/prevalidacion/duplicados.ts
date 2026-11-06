// Duplicados entre las filas generables (D11, CA-6; plan, Ratificación 10). Clave: tipo de
// comprobante, serie en mayúsculas ASCII, número sin ceros a la izquierda y documento del proveedor
// (tipo y número). El error va en todas las copias, también en las que tienen error de estructura.
import { compararTexto } from "./entrada";
import type { FilaCopia } from "./entrada";
import { crearError } from "./errores";
import { duplicado } from "./explicaciones";
import type { ErrorPrevalidacion } from "./tipos";

const MINUSCULA_ASCII = /[a-z]/g;
const CEROS_IZQUIERDA = /^0+/;

/** Solo a-z: ningún otro carácter cambia (sin locale ni plegado Unicode). */
function mayusculasAscii(s: string): string {
  return s.replace(MINUSCULA_ASCII, (c) => c.toUpperCase());
}

function clave(f: FilaCopia): string {
  const { tipo, serie, numero } = f.comprobante;
  return JSON.stringify([
    tipo,
    mayusculasAscii(serie),
    numero.replace(CEROS_IZQUIERDA, ""),
    f.proveedor.tipo,
    f.proveedor.numero,
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
    for (const id of ordenados) {
      errores.push(
        crearError({
          filaId: id,
          codigo: "DUPLICADO",
          campo: null,
          explicacion: duplicado(ordenados.filter((x) => x !== id)),
        }),
      );
    }
  }
  return errores;
}
