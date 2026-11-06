// Validación de un valor contra un CampoTxt (D13, CA-5; plan, Ratificación 2). Nunca lanza, no
// recorta, no normaliza ni translitera. Devuelve solo código y posición: la explicación con
// `U+XXXX` la arma prevalidacion/, nunca con el carácter crudo.
import { validarRuc } from "@contapp/shared";
import type { Entero } from "../texto/entero";
import type { CampoTxt, CodigoCampo, ErrorCampo, FormatoTxt } from "./tipos";

const sinPosicion = (codigo: CodigoCampo): ErrorCampo => Object.freeze({ codigo, posicion: null });
const OBLIGATORIO = sinPosicion("CAMPO_OBLIGATORIO");
const RUC_INVALIDO = sinPosicion("RUC_INVALIDO");
const LONGITUD = sinPosicion("LONGITUD");
const PATRON = sinPosicion("PATRON");

/**
 * Precedencia: vacío (`CAMPO_OBLIGATORIO`, o `null` si es opcional); si el tipo es `ruc`, solo
 * `validarRuc`; luego `CARACTER_NO_PERMITIDO`, `LONGITUD` y `PATRON`. Un error por campo;
 * `null` = válido.
 */
export function validarCampo(valor: string, campo: CampoTxt, formato: FormatoTxt): ErrorCampo | null {
  if (typeof valor !== "string") return PATRON;
  if (valor === "") return campo.obligatorio ? OBLIGATORIO : null;
  if (campo.tipo === "ruc") return validarRuc(valor) ? null : RUC_INVALIDO;
  const posicion = primerCaracterNoPermitido(valor, formato);
  if (posicion !== null) return Object.freeze({ codigo: "CARACTER_NO_PERMITIDO", posicion });
  if (valor.length > campo.longitudMax) return LONGITUD;
  // Solo el patrón propio: un `patron` heredado de Object.prototype no se aplica (H-012-25).
  const patron = Object.hasOwn(campo, "patron") ? campo.patron : undefined;
  // Copia nueva en cada llamada: un patrón ajeno con `g` o `y` no arrastra `lastIndex`.
  if (patron !== undefined && !new RegExp(patron.source, patron.flags).test(valor)) return PATRON;
  return null;
}

/**
 * Texto admitido (D13): U+0020-U+007E y, salvo en `ascii`, U+00A1-U+00FF; nunca el separador.
 * Fuera quedan controles C0 y C1, DEL, NBSP, saltos de línea, marcas combinantes, sustitutos
 * (emojis) y cualquier carácter fuera de latin1.
 */
function primerCaracterNoPermitido(valor: string, formato: FormatoTxt): Entero | null {
  const separador = formato.separador.charCodeAt(0);
  const conLatin1 = formato.codificacion !== "ascii";
  for (let i = 0; i < valor.length; i++) {
    const c = valor.charCodeAt(i);
    const ascii = c >= 0x20 && c <= 0x7e && c !== separador;
    if (!ascii && !(conLatin1 && c >= 0xa1 && c <= 0xff)) return i;
  }
  return null;
}

