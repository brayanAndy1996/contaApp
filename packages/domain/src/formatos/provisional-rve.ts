// Formato provisional RVIE de ventas (spec 013, D13 y D14b; 012 D5). Solo la DEFINICIÓN del formato:
// `generarTxt` no genera ventas hasta 012b. Herramienta de prueba, no la estructura de SUNAT:
// `oficial: false` y nombres inconfundibles con uno oficial. Mismo criterio de patrones que el RCE.
import type { Entero } from "../texto/entero";
import { nombreProvisionalRvie } from "./nombres";
import type { CampoTxt, FormatoTxt, TipoCampo } from "./tipos";

function campo(nombre: string, obligatorio: boolean, longitudMax: Entero, tipo: TipoCampo, patron?: RegExp): CampoTxt {
  return patron === undefined ? { nombre, obligatorio, longitudMax, tipo } : { nombre, obligatorio, longitudMax, tipo, patron };
}

/** Montos: NUMERIC(14,2) con signo = 16 caracteres. */
const LARGO_MONTO = 16;

/** Definición de entrada; RegistroFormatos.desde la copia y la congela en REGISTRO_FORMATOS. */
export const FORMATO_PROVISIONAL_RVIE: FormatoTxt = {
  id: "RVIE-REEMPLAZO",
  libro: "ventas",
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
    campo("tipoDocContraparte", false, 1, "codigo", /^[0-9A-Za-z]$/),
    // «-» es el consumidor final, así que el documento va como código y no como `ruc`.
    campo("docContraparte", true, 20, "codigo", /^(?:-|[0-9A-Za-z][0-9A-Za-z-]{0,19})$/),
    campo("moneda", true, 3, "codigo"),
    campo("tipoCambio", false, 8, "tc"),
    campo("baseGravada", true, LARGO_MONTO, "monto"),
    campo("igv", true, LARGO_MONTO, "monto"),
    campo("exonerada", true, LARGO_MONTO, "monto"),
    campo("inafecta", true, LARGO_MONTO, "monto"),
    campo("isc", true, LARGO_MONTO, "monto"),
    campo("icbper", true, LARGO_MONTO, "monto"),
    campo("otros", true, LARGO_MONTO, "monto"),
    campo("total", true, LARGO_MONTO, "monto"),
  ],
  nombre: nombreProvisionalRvie,
};
