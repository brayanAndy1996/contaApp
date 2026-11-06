// Formato provisional RCE de compras (D10, D14; plan, «Formato provisional RCE» y Ratificación 3).
// Herramienta de prueba del motor, no la estructura de SUNAT: `oficial: false` y nombres
// inconfundibles con uno oficial. Los patrones siguen la gramática de 011 para que una fila sin
// error de estructura nunca haga lanzar a `evaluarReglas`.
import { COLUMNAS_COMPRA } from "../comprobante/columnas";
import type { Entero } from "../texto/entero";
import { nombreProvisional } from "./nombres";
import type { CampoTxt, FormatoTxt, TipoCampo } from "./tipos";

function campo(nombre: string, obligatorio: boolean, longitudMax: Entero, tipo: TipoCampo, patron?: RegExp): CampoTxt {
  return patron === undefined ? { nombre, obligatorio, longitudMax, tipo } : { nombre, obligatorio, longitudMax, tipo, patron };
}

/** Montos: NUMERIC(14,2) con signo = 16 caracteres. */
const LARGO_MONTO = 16;

/** Definición de entrada; RegistroFormatos.desde la copia y la congela en REGISTRO_FORMATOS. */
export const FORMATO_PROVISIONAL_RCE: FormatoTxt = {
  id: "RCE-REEMPLAZO",
  libro: "compras",
  version: "0-provisional",
  vigenteDesde: "202601",
  oficial: false,
  codificacion: "latin1",
  separador: "|",
  finDeLinea: "\r\n",
  incluyeExcluidas: false,
  campos: [
    campo("periodo", true, 6, "codigo"),
    campo("tipoComprobante", true, 2, "codigo", /^[0-9]{2}$/),
    campo("serie", true, 4, "codigo", /^[0-9A-Za-z]{1,4}$/),
    campo("numero", true, 8, "codigo", /^[0-9]{1,8}$/),
    campo("fechaEmision", true, 10, "fecha"),
    campo("tipoDocProveedor", true, 1, "codigo", /^[0-9A-Z]$/),
    campo("numeroDocProveedor", true, 15, "codigo", /^[0-9A-Za-z-]{1,15}$/),
    campo("razonSocial", false, 100, "texto"),
    campo("moneda", true, 3, "codigo"),
    campo("tipoCambio", false, 8, "tc"),
    ...COLUMNAS_COMPRA.map((columna) => campo(columna, true, LARGO_MONTO, "monto")),
    campo("total", true, LARGO_MONTO, "monto"),
  ],
  nombre: nombreProvisional,
};
