// Layout de importación de la propuesta de ventas y validación de una fila (spec 013, D3, D6, D14b).
// El layout es PROVISIONAL (`oficial: false`) mientras no haya anexo ni muestra de SUNAT: este módulo no
// decide si se usa; el servicio no importa con él en producción. `validarFilaVenta` nunca lanza, informa
// todos los campos con problema y jamás devuelve el valor de una celda (solo el campo y un código).
import { Money, TOLERANCIA_CUADRE, TipoCambio, verificarCuadre } from "../dinero/index";
import type { Moneda } from "../dinero/index";
import { enteroDeDigitos } from "../texto/entero";
import type { Entero } from "../texto/entero";
import { COLUMNAS_VENTA, COMPONENTES_VENTA } from "./columnas";
import type { ColumnaVenta, MontosVenta } from "./columnas";

export interface ColumnaLayout {
  readonly nombre: string;
  readonly obligatoria: boolean;
}

export interface LayoutVentas {
  readonly id: string;
  readonly version: "0-provisional";
  readonly oficial: false;
  readonly columnas: readonly ColumnaLayout[];
}

const col = (nombre: string, obligatoria: boolean): ColumnaLayout => Object.freeze({ nombre, obligatoria });

/** Los nombres son los campos de `FilaVentaSire`; el documento de la contraparte acompaña a la fila. */
export const LAYOUT_VENTAS_PROVISIONAL: LayoutVentas = Object.freeze({
  id: "RVIE-IMPORTACION-PROVISIONAL",
  version: "0-provisional",
  oficial: false,
  columnas: Object.freeze([
    col("tipo", true),
    col("serie", true),
    col("numero", true),
    col("tipoDocContraparte", false),
    col("docContraparte", true),
    col("fechaEmision", true),
    col("moneda", true),
    col("tipoCambio", false),
    ...COLUMNAS_VENTA.map((c) => col(c, true)),
  ]),
});

export interface FilaVentaValida extends MontosVenta {
  readonly tipo: string;
  readonly serie: string;
  /** Tal como llegó (con sus ceros); la clave los quita. */
  readonly numero: string;
  readonly tipoDocContraparte?: string;
  readonly docContraparte: string;
  /** AAAA-MM-DD, fecha real. */
  readonly fechaEmision: string;
  readonly moneda: Moneda;
  readonly tipoCambio?: string;
}

export interface ErrorFilaVenta {
  readonly campo: string;
  readonly codigo: string;
}

export type ResultadoFilaVenta =
  | { readonly ok: true; readonly fila: FilaVentaValida; readonly cuadra: boolean }
  | { readonly ok: false; readonly errores: readonly ErrorFilaVenta[] };

const TIPO = /^[0-9]{2}$/;
const SERIE = /^[0-9A-Za-z]{4}$/;
const NUMERO = /^[0-9A-Za-z]{1,20}$/;
const TIPO_DOC = /^[0-9A-Za-z]$/;
/** «-» es el consumidor final; un documento no empieza por un símbolo (=, +, @ de una fórmula). */
const DOCUMENTO = /^(?:-|[0-9A-Za-z][0-9A-Za-z-]{0,19})$/;
const FECHA = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const DIAS_POR_MES: readonly Entero[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function esBisiesto(anio: Entero): boolean {
  return anio % 4 === 0 && (anio % 100 !== 0 || anio % 400 === 0);
}

/** AAAA-MM-DD existente en el calendario (sin `Date`: no depende de la zona horaria). */
function esFechaReal(s: string): boolean {
  const m = FECHA.exec(s);
  if (m === null) return false;
  const anio = enteroDeDigitos(m[1]);
  const mes = enteroDeDigitos(m[2]);
  const dia = enteroDeDigitos(m[3]);
  if (anio === null || mes === null || dia === null || anio < 1 || mes < 1 || mes > 12 || dia < 1) return false;
  const dias = (DIAS_POR_MES[mes - 1] as Entero) + (mes === 2 && esBisiesto(anio) ? 1 : 0);
  return dia <= dias;
}

/** Ausente, `null` o vacío: la celda no trae valor. */
const sinValor = (v: unknown): boolean => v === undefined || v === null || v === "";

/** Solo propiedades propias: un valor heredado de Object.prototype no cuenta. */
function leer(o: object, nombre: string): unknown {
  return Object.hasOwn(o, nombre) ? (o as Record<string, unknown>)[nombre] : undefined;
}

function monto(v: unknown): Money | null {
  if (typeof v !== "string") return null;
  try {
    return Money.desde(v, "PEN");
  } catch {
    // Money.desde solo lanza errores de dinero (cadena mal formada o fuera de NUMERIC(14,2)).
    return null;
  }
}

function tipoCambioValido(v: unknown): boolean {
  if (typeof v !== "string") return false;
  try {
    TipoCambio.desde(v);
    return true;
  } catch {
    // TipoCambio.desde solo lanza FactorInvalidoError.
    return false;
  }
}

/** El cuadre es exacto (tolerancia 0.00) en la moneda del comprobante; Σ fuera de rango es «no cuadra». */
function cuadraExacto(montos: Readonly<Record<ColumnaVenta, string>>, moneda: Moneda): boolean {
  const total = Money.desde(montos.total, moneda);
  const componentes = COMPONENTES_VENTA.map((c) => Money.desde(montos[c], moneda));
  try {
    return verificarCuadre({ moneda, total, componentes: () => componentes }, TOLERANCIA_CUADRE).cuadra;
  } catch {
    // El único error posible es MontoFueraDeRangoError: la suma excede NUMERIC(14,2), así que no cuadra.
    return false;
  }
}

/** Valida una fila cruda (de un archivo o de la API). Nunca lanza ni devuelve el valor de una celda. */
export function validarFilaVenta(cruda: unknown): ResultadoFilaVenta {
  if (typeof cruda !== "object" || cruda === null || Array.isArray(cruda)) {
    return { ok: false, errores: [{ campo: "fila", codigo: "FILA_INVALIDA" }] };
  }
  const errores: ErrorFilaVenta[] = [];
  const falla = (campo: string, codigo: string): void => {
    errores.push({ campo, codigo });
  };
  const texto = (campo: string, patron: RegExp, codigo: string): string => {
    const v = leer(cruda, campo);
    if (v === undefined || v === null) {
      falla(campo, "CAMPO_OBLIGATORIO");
      return "";
    }
    if (typeof v !== "string" || !patron.test(v)) {
      falla(campo, codigo);
      return "";
    }
    return v;
  };

  const tipo = texto("tipo", TIPO, "TIPO_INVALIDO");
  const serie = texto("serie", SERIE, "SERIE_INVALIDA");
  const numero = texto("numero", NUMERO, "NUMERO_INVALIDO");
  const docContraparte = texto("docContraparte", DOCUMENTO, "DOCUMENTO_INVALIDO");

  const tipoDocCruda = leer(cruda, "tipoDocContraparte");
  let tipoDocContraparte: string | undefined;
  if (!sinValor(tipoDocCruda)) {
    if (typeof tipoDocCruda === "string" && TIPO_DOC.test(tipoDocCruda)) tipoDocContraparte = tipoDocCruda;
    else falla("tipoDocContraparte", "TIPO_DOCUMENTO_INVALIDO");
  }

  const fecha = leer(cruda, "fechaEmision");
  let fechaEmision = "";
  if (fecha === undefined || fecha === null) falla("fechaEmision", "CAMPO_OBLIGATORIO");
  else if (typeof fecha === "string" && esFechaReal(fecha)) fechaEmision = fecha;
  else falla("fechaEmision", "FECHA_INVALIDA");

  const monedaCruda = leer(cruda, "moneda");
  let moneda: Moneda | null = null;
  if (monedaCruda === undefined || monedaCruda === null) falla("moneda", "CAMPO_OBLIGATORIO");
  else if (monedaCruda === "PEN" || monedaCruda === "USD") moneda = monedaCruda;
  else falla("moneda", "MONEDA_INVALIDA");

  // El tipo de cambio solo vale en USD; con la moneda ilegible no se evalúa para no repetir el error.
  const tcCruda = leer(cruda, "tipoCambio");
  let tipoCambio: string | undefined;
  if (moneda !== null && !sinValor(tcCruda)) {
    if (moneda === "USD" && tipoCambioValido(tcCruda)) tipoCambio = tcCruda as string;
    else falla("tipoCambio", moneda === "USD" ? "TIPO_CAMBIO_INVALIDO" : "TIPO_CAMBIO_SOLO_EN_USD");
  }

  const montos = {} as Record<ColumnaVenta, string>;
  for (const c of COLUMNAS_VENTA) {
    const v = leer(cruda, c);
    if (v === undefined || v === null) {
      falla(c, "CAMPO_OBLIGATORIO");
      continue;
    }
    const m = monto(v);
    if (m === null) falla(c, "MONTO_INVALIDO");
    else montos[c] = m.toString();
  }

  if (errores.length > 0 || moneda === null) return { ok: false, errores };
  const fila: FilaVentaValida = {
    tipo,
    serie,
    numero,
    ...(tipoDocContraparte === undefined ? {} : { tipoDocContraparte }),
    docContraparte,
    fechaEmision,
    moneda,
    ...(tipoCambio === undefined ? {} : { tipoCambio }),
    ...montos,
  };
  return { ok: true, fila, cuadra: cuadraExacto(montos, moneda) };
}
