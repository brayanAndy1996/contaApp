// Detalle de la lupa (spec 016, D-6, D-9, plan «DetalleCompraDto»): de lo leído de la BD al DTO. Puro: sin IO. Se arma del
// `detalle` jsonb guardado (CA-18): nunca se re-parsea el XML. Los montos salen como cadenas decimales (`Money`), nunca `number`.
import { autorDe, type Autores } from "./autor.js";
import type { CompraHistorialProveedor, DetalleXmlLeido, XmlVigente } from "@contapp/db";
import { Money, type DetalleXml, type Moneda } from "@contapp/domain";
import {
  COLUMNAS_COMPARACION,
  type ColumnaComparacion,
  type ComparacionFila,
  type DetalleLupa,
  type EstadoXml,
  type HistorialProveedorFila,
  type HallazgoVista,
  type ItemXml,
} from "@contapp/shared";
import { aHallazgoVista } from "./vistas.js";

/** Columnas que cada regla de 011 puede explicar cuando SIRE y XML difieren (D-9). R-NEW y R-GP no tocan montos. */
const COLUMNAS_DE_REGLA: Readonly<Record<string, readonly ColumnaComparacion[]>> = {
  "R-ISC": ["bi", "isc"],
  "R-MIX": ["bi", "noGravado"],
  "R-RED": ["total"],
};

/** Tipos con XML (01, 03, 07, 08) y proveedor con RUC (doc 6): fuera de eso el XML es `no_aplica`. */
const TIPOS_CON_XML: ReadonlySet<string> = new Set(["01", "03", "07", "08"]);
export const aplicaXml = (tipoDoc: string, docTipo: string): boolean => TIPOS_CON_XML.has(tipoDoc) && docTipo === "6";

/** El código del catálogo 07 de SUNAT que la pantalla sabe nombrar; lo que no tiene código claro viaja con su nombre. */
const CODIGO_AFECTACION: Readonly<Record<string, string>> = {
  gravado: "10",
  exonerado: "20",
  inafecto: "30",
  exportacion: "40",
};

export function aItems(detalle: DetalleXml | null): ItemXml[] {
  if (detalle === null) return [];
  return detalle.items.map((i) => ({
    descripcion: i.descripcion,
    cantidad: i.cantidad,
    unidad: i.unidad,
    precioUnitario: i.precioUnitario,
    valor: i.valor,
    afectacion: CODIGO_AFECTACION[i.afectacion] ?? i.afectacion,
    igv: i.igv,
    isc: i.isc,
    icbper: i.icbper,
  }));
}

/**
 * Las 7 columnas de D-9 en orden fijo: Σ BI contra el gravado del XML, Σ IGV contra su IGV y el resto una a una. Sin XML, `xml`
 * es `null` y nada difiere. Una columna que difiere lleva la regla y la explicación del primer hallazgo vigente que la cubre.
 */
export function comparar(
  montos: DetalleXmlLeido["compra"]["montos"],
  moneda: Moneda,
  detalle: DetalleXml | null,
  hallazgos: readonly HallazgoVista[],
): ComparacionFila[] {
  const m = (v: string): Money => Money.desde(v, moneda);
  const sire: Record<ColumnaComparacion, Money> = {
    bi: Money.suma([m(montos.biDg), m(montos.biDgng), m(montos.biDng)], moneda),
    igv: Money.suma([m(montos.igvDg), m(montos.igvDgng), m(montos.igvDng)], moneda),
    noGravado: m(montos.noGravado),
    isc: m(montos.isc),
    icbper: m(montos.icbper),
    otrosTributos: m(montos.otrosTributos),
    total: m(montos.total),
  };
  const t = detalle?.totales;
  const xml: Record<ColumnaComparacion, Money> | null =
    t === undefined
      ? null
      : {
          bi: m(t.gravado),
          igv: m(t.igv),
          noGravado: m(t.noGravado),
          isc: m(t.isc),
          icbper: m(t.icbper),
          otrosTributos: m(t.otros),
          total: m(t.total),
        };
  return COLUMNAS_COMPARACION.map((columna): ComparacionFila => {
    const delXml = xml === null ? null : xml[columna];
    const difiere = delXml !== null && !delXml.igual(sire[columna]);
    const base: ComparacionFila = {
      columna,
      sire: sire[columna].toString(),
      xml: delXml === null ? null : delXml.toString(),
      difiere,
    };
    if (!difiere) return base;
    const cubre = hallazgos.find((h) => COLUMNAS_DE_REGLA[h.regla]?.includes(columna) === true);
    return cubre === undefined ? base : { ...base, regla: cubre.regla, explicacion: cubre.explicacion };
  });
}

/**
 * Estado del XML (D-8): `disponible` (con quién lo subió y el aviso de moneda), `pendiente`, `no_disponible` (por el resultado
 * de la obtención o por `no_aplica`) o `sin_solicitar`. `no_aplica` se decide por la compra y no necesita fila de obtención.
 */
export function estadoXml(d: DetalleXmlLeido): EstadoXml {
  const { xml, obtencion, compra } = d;
  if (xml !== null) return disponible(xml, compra.moneda);
  if (!aplicaXml(compra.tipoDoc, compra.docTipo)) return { estado: "no_disponible", codigo: "no_aplica" };
  if (obtencion === null) return { estado: "sin_solicitar" };
  if (obtencion.estado === "pendiente") return { estado: "pendiente" };
  return { estado: "no_disponible", codigo: obtencion.estado };
}

function disponible(xml: XmlVigente, monedaFila: Moneda): EstadoXml {
  const monedaXml = (xml.detalle as DetalleXml).moneda;
  return {
    estado: "disponible",
    origen: xml.origen,
    ...(xml.origen === "subido" && xml.subidoPor !== null
      ? { subidoPor: xml.subidoPor, subidoEn: xml.creadaEn.toISOString() }
      : {}),
    ...(monedaXml !== monedaFila ? { avisoMoneda: { monedaXml, monedaFila } } : {}),
  };
}

const origenSerie = (serie: string): "E" | "F" | null => {
  const inicial = serie.charAt(0).toUpperCase();
  return inicial === "E" || inicial === "F" ? inicial : null;
};

/** D-12: agrega `autor` al XML subido por una persona (el simulado o el real no tienen `subidoPor` ni `autor`). */
export function conAutorXml(dto: DetalleLupa, autores: Autores): DetalleLupa {
  const xml = dto.xml;
  if (xml.estado !== "disponible" || xml.subidoPor === undefined) return dto;
  return { ...dto, xml: { ...xml, autor: autorDe(autores, xml.subidoPor)! } };
}

/** El DTO de la lupa (`detalleLupaSchema`). Ni la ruta de storage, ni el hash, ni el tenant salen. */
export function aDetalleLupa(d: DetalleXmlLeido, historial: readonly CompraHistorialProveedor[]): DetalleLupa {
  const { compra } = d;
  const detalle = d.xml === null ? null : (d.xml.detalle as DetalleXml);
  const hallazgos = d.hallazgos.map(aHallazgoVista);
  return {
    cabecera: {
      ruc: compra.docNumero,
      razonSocial: compra.razonSocial,
      proveedorNuevo: d.proveedorNuevo,
      tipo: compra.tipoDoc,
      serie: compra.serie,
      numero: compra.numero,
      fecha: compra.fecha,
      moneda: compra.moneda,
      tipoCambio: compra.tipoCambio,
      origenSerie: origenSerie(compra.serie),
    },
    items: aItems(detalle),
    comparacion: comparar(compra.montos, compra.moneda, detalle, hallazgos),
    hallazgos,
    historialProveedor: historial.map((h): HistorialProveedorFila => ({ ...h })),
    xml: estadoXml(d),
  };
}
