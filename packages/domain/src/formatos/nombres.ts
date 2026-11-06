// Nombres de archivo (D7; plan, Ratificación 6). Los componentes se validan con una gramática
// estricta ASCII antes de armar el nombre: sin `/`, `\`, `..`, espacios ni controles.
import { NombreArchivoInvalidoError } from "./errores";
import type { ComponentesNombre, NombresArchivo } from "./tipos";

const RUC_11 = /^[0-9]{11}$/;
const PERIODO = /^[0-9]{4}(0[1-9]|1[0-2])$/;

/** Gramáticas de los nombres que producen los formatos de REGISTRO_FORMATOS (hoy, el provisional). */
const GRAMATICAS: readonly RegExp[] = Object.freeze([
  /^CONTAPP-PROVISIONAL-[0-9]{11}-[0-9]{4}(0[1-9]|1[0-2])-RCE\.(txt|zip)$/,
]);

/**
 * `true` solo si `nombre` cumple la gramática de un formato de REGISTRO_FORMATOS. No mira el dígito
 * verificador del RUC (eso es de `prevalidar`). Nunca lanza; un registro de prueba no la amplía.
 */
export function validarNombreArchivo(nombre: string): boolean {
  return typeof nombre === "string" && GRAMATICAS.some((g) => g.test(nombre));
}

/** `nombre()` del formato provisional RCE: lanza NombreArchivoInvalidoError con componentes malos. */
export function nombreProvisional(c: ComponentesNombre): NombresArchivo {
  if (typeof c !== "object" || c === null) throw new NombreArchivoInvalidoError();
  const ruc: unknown = c.ruc;
  const periodo: unknown = c.periodo;
  if (typeof ruc !== "string" || !RUC_11.test(ruc) || typeof periodo !== "string" || !PERIODO.test(periodo)) {
    throw new NombreArchivoInvalidoError();
  }
  const base = `CONTAPP-PROVISIONAL-${ruc}-${periodo}-RCE`;
  return Object.freeze({ nombreTxt: `${base}.txt`, nombreZip: `${base}.zip` });
}
