// Ayudas de prueba de formatos/ (spec 012, T3). Solo construyen definiciones sintéticas; no es
// producción. Los conteos y longitudes son enteros (`Entero`), nunca dinero.
import type { CampoTxt, FormatoTxt } from "../../src/index";

export function campoDePrueba(over: Partial<CampoTxt> = {}): CampoTxt {
  return {
    nombre: "campo",
    obligatorio: true,
    longitudMax: 10,
    tipo: "texto",
    ...over,
  };
}

/** Formato válido y mínimo: dos campos, latin1, separador `|`, fin de línea CRLF. */
export function formatoDePrueba(over: Partial<FormatoTxt> = {}): FormatoTxt {
  return {
    id: "PRUEBA",
    libro: "compras",
    version: "1",
    vigenteDesde: "202601",
    oficial: false,
    codificacion: "latin1",
    separador: "|",
    finDeLinea: "\r\n",
    incluyeExcluidas: false,
    campos: [campoDePrueba({ nombre: "a" }), campoDePrueba({ nombre: "b", obligatorio: false })],
    nombre: ({ ruc, periodo }) => ({
      nombreTxt: `PRUEBA-${ruc}-${periodo}.txt`,
      nombreZip: `PRUEBA-${ruc}-${periodo}.zip`,
    }),
    ...over,
  };
}
