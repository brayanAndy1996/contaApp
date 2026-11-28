/**
 * TXT de la propuesta de compras (RCE) → `FilaPropuestaSire` (plan 041, «Mapeo»; spec CA-3, CA-5, CA-6, CA-7).
 * Síncrona y pura. Columnas por nombre normalizado; el proveedor es `Apellidos Nombres/ Razón Social` (col. 14), nunca
 * la del contribuyente. Se valida TODO el archivo antes de devolver filas.
 */
import type { FilaPropuestaSire } from "../../puertos.js";
import type { TxtLeido } from "./leer-txt.js";
import {
  celda,
  columnas,
  fecha,
  moneda,
  monto,
  obligatorio,
  sinEquivalente,
  tipoCambio,
  verificarPropias,
  type EsperadoTxt,
} from "./valores.js";

export type { EsperadoTxt } from "./valores.js";

const C = {
  ruc: "RUC",
  periodo: "Periodo",
  tipo: "Tipo CP/Doc.",
  serie: "Serie del CDP",
  numero: "Nro CP o Doc. Nro Inicial (Rango)",
  tipoDoc: "Tipo Doc Identidad",
  nroDoc: "Nro Doc Identidad",
  razonSocial: "Apellidos Nombres/ Razón Social",
  fecha: "Fecha de emisión",
  moneda: "Moneda",
  tipoCambio: "Tipo de Cambio",
  biDg: "BI Gravado DG",
  igvDg: "IGV / IPM DG",
  biDgng: "BI Gravado DGNG",
  igvDgng: "IGV / IPM DGNG",
  biDng: "BI Gravado DNG",
  igvDng: "IGV / IPM DNG",
  noGravado: "Valor Adq. NG",
  isc: "ISC",
  icbper: "ICBPER",
  otros: "Otros Trib/ Cargos",
  total: "Total CP",
} as const;

/** P-2: columnas monetarias o de rango sin equivalente en el puerto (requeridas; solo vacías o cero). */
const SIN_EQUIVALENTE = ["IMB", "Nro Final (Rango)"] as const;

const REQUERIDAS: readonly string[] = [...Object.values(C), ...SIN_EQUIVALENTE];

export function mapearCompras(txt: TxtLeido, esperado: EsperadoTxt): FilaPropuestaSire[] {
  const indice = columnas(txt.encabezado, REQUERIDAS);
  const i = Object.fromEntries(Object.entries(C).map(([k, n]) => [k, indice(n)])) as Record<keyof typeof C, number>;
  const iSinEquivalente = SIN_EQUIVALENTE.map(indice);
  verificarPropias(txt.filas, i.ruc, i.periodo, esperado);

  return txt.filas.map((f) => {
    const m = moneda(celda(f, i.moneda));
    const fila: FilaPropuestaSire = {
      tipo: obligatorio(celda(f, i.tipo)),
      serie: celda(f, i.serie),
      numero: obligatorio(celda(f, i.numero)),
      rucContraparte: celda(f, i.nroDoc),
      razonSocialContraparte: celda(f, i.razonSocial),
      fechaEmision: fecha(celda(f, i.fecha)),
      moneda: m,
      biDg: monto(celda(f, i.biDg), m),
      igvDg: monto(celda(f, i.igvDg), m),
      biDgng: monto(celda(f, i.biDgng), m),
      igvDgng: monto(celda(f, i.igvDgng), m),
      biDng: monto(celda(f, i.biDng), m),
      igvDng: monto(celda(f, i.igvDng), m),
      noGravado: monto(celda(f, i.noGravado), m),
      isc: monto(celda(f, i.isc), m),
      icbper: monto(celda(f, i.icbper), m),
      otros: monto(celda(f, i.otros), m),
      total: monto(celda(f, i.total), m),
    };
    const tipoDoc = celda(f, i.tipoDoc);
    if (tipoDoc !== "") fila.tipoDocContraparte = tipoDoc;
    if (m === "USD") fila.tipoCambio = tipoCambio(celda(f, i.tipoCambio));
    for (const j of iSinEquivalente) sinEquivalente(celda(f, j));
    return fila;
  });
}
