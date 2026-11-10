// «Agregar desde XML» (spec 016, HU-18, D-8, P-9): del `DetalleXml` del parser a los campos de la compra. Puro: sin IO. Los montos
// salen como cadenas decimales del propio parser (`redondearSunat` ya aplicado), nunca como `number`.
import type { DetalleXml } from "@contapp/domain";
import type { DestinoCompra, MontosColumnas } from "@contapp/shared";

/** Largo máximo de la razón social de una compra agregada (`proveedorCompraSchema`). */
const RAZON_SOCIAL_MAX = 100;

/** Lo que el XML aporta a la compra, sin destino ni tipo de cambio: los pone el usuario (P-9). */
export interface DatosDesdeXml {
  tipo: string;
  serie: string;
  numero: string;
  proveedor: { tipo: "6"; numero: string; razonSocial: string };
  fecha: string;
  moneda: DetalleXml["moneda"];
  /** Base gravada e IGV del XML: van al par de columnas del destino. */
  gravado: string;
  igv: string;
  /** Columnas que no dependen del destino. */
  fijos: Pick<MontosColumnas, "noGravado" | "isc" | "icbper" | "otrosTributos">;
}

/**
 * La razón social es texto no confiable de hasta 500 caracteres: se pasa a una línea (sin caracteres de control) y se recorta al
 * máximo de una compra. Sin razón social en el XML queda «RUC <ruc>», como al crear un cliente.
 */
function razonSocialDe(texto: string, ruc: string): string {
  const linea = texto.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, RAZON_SOCIAL_MAX).trim();
  return linea === "" ? `RUC ${ruc}` : linea;
}

export function datosDeXml(d: DetalleXml): DatosDesdeXml {
  const { identidad, totales } = d;
  return {
    tipo: identidad.tipo,
    serie: identidad.serie,
    numero: identidad.numero,
    proveedor: {
      tipo: "6",
      numero: identidad.emisor.ruc,
      razonSocial: razonSocialDe(identidad.emisor.razonSocial, identidad.emisor.ruc),
    },
    fecha: d.fecha,
    moneda: d.moneda,
    gravado: totales.gravado,
    igv: totales.igv,
    fijos: { noGravado: totales.noGravado, isc: totales.isc, icbper: totales.icbper, otrosTributos: totales.otros },
  };
}

/** El par (BI, IGV) de cada destino (010). */
const COLUMNAS_DESTINO = {
  DG: ["biDg", "igvDg"],
  DGNG: ["biDgng", "igvDgng"],
  DNG: ["biDng", "igvDng"],
} as const satisfies Record<DestinoCompra, readonly [keyof MontosColumnas, keyof MontosColumnas]>;

/** Las columnas de monto con la BI y el IGV del XML en el par del destino elegido. */
export function montosParaDestino(d: DatosDesdeXml, destino: DestinoCompra): MontosColumnas {
  const [bi, igv] = COLUMNAS_DESTINO[destino];
  return { [bi]: d.gravado, [igv]: d.igv, ...d.fijos };
}
