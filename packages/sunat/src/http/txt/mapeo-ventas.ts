/**
 * TXT de la propuesta de ventas (RVIE) → `FilaVentaSire` (plan 041, «Mapeo»; spec CA-4, CA-5, CA-6, CA-7, P-5).
 * Síncrona y pura. Columnas por nombre normalizado (`Ruc`; el BOM ya lo quitó `leerTxt`). Consumidor final (tipo y
 * número de documento vacíos) = `docContraparte` "-" sin `tipoDocContraparte`. Se valida TODO antes de devolver filas.
 */
import type { FilaVentaSire } from "../../puertos.js";
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

const C = {
  ruc: "Ruc",
  periodo: "Periodo",
  tipo: "Tipo CP/Doc.",
  serie: "Serie del CDP",
  numero: "Nro CP o Doc. Nro Inicial (Rango)",
  tipoDoc: "Tipo Doc Identidad",
  nroDoc: "Nro Doc Identidad",
  fecha: "Fecha de emisión",
  moneda: "Moneda",
  tipoCambio: "Tipo Cambio",
  baseGravada: "BI Gravada",
  igv: "IGV / IPM",
  exonerada: "Mto Exonerado",
  inafecta: "Mto Inafecto",
  isc: "ISC",
  icbper: "ICBPER",
  otros: "Otros Tributos",
  total: "Total CP",
} as const;

/** P-2: columnas monetarias o de rango sin equivalente en el puerto (requeridas; solo vacías o cero). */
const SIN_EQUIVALENTE = [
  "Valor Facturado Exportación",
  "Dscto BI",
  "Dscto IGV / IPM",
  "BI Grav IVAP",
  "IVAP",
  "Nro Final (Rango)",
  "Valor FOB Embarcado",
  "Valor OP Gratuitas",
] as const;

const REQUERIDAS: readonly string[] = [...Object.values(C), ...SIN_EQUIVALENTE];

const CONSUMIDOR_FINAL = "-";

export function mapearVentas(txt: TxtLeido, esperado: EsperadoTxt): FilaVentaSire[] {
  const indice = columnas(txt.encabezado, REQUERIDAS);
  const i = Object.fromEntries(Object.entries(C).map(([k, n]) => [k, indice(n)])) as Record<keyof typeof C, number>;
  const iSinEquivalente = SIN_EQUIVALENTE.map(indice);
  verificarPropias(txt.filas, i.ruc, i.periodo, esperado);

  return txt.filas.map((f) => {
    const m = moneda(celda(f, i.moneda));
    const tipoDoc = celda(f, i.tipoDoc);
    const nroDoc = celda(f, i.nroDoc);
    const fila: FilaVentaSire = {
      tipo: obligatorio(celda(f, i.tipo)),
      serie: celda(f, i.serie),
      numero: obligatorio(celda(f, i.numero)),
      docContraparte: nroDoc === "" ? CONSUMIDOR_FINAL : nroDoc,
      fechaEmision: fecha(celda(f, i.fecha)),
      moneda: m,
      baseGravada: monto(celda(f, i.baseGravada), m),
      igv: monto(celda(f, i.igv), m),
      exonerada: monto(celda(f, i.exonerada), m),
      inafecta: monto(celda(f, i.inafecta), m),
      isc: monto(celda(f, i.isc), m),
      icbper: monto(celda(f, i.icbper), m),
      otros: monto(celda(f, i.otros), m),
      total: monto(celda(f, i.total), m),
    };
    if (tipoDoc !== "") fila.tipoDocContraparte = tipoDoc;
    const tc = celda(f, i.tipoCambio);
    if (m === "USD" && tc !== "") fila.tipoCambio = tipoCambio(tc);
    for (const j of iSinEquivalente) sinEquivalente(celda(f, j));
    return fila;
  });
}
