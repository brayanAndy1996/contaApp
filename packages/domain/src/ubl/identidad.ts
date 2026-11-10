// Spec 016 (D-3, CA-12): ¿el XML es de esta compra? Coinciden RUC del emisor, tipo, serie (sin distinguir mayúsculas) y
// número (sin ceros a la izquierda), y el receptor es el RUC del cliente. Si no, devuelve solo los NOMBRES de los campos
// que difieren, en un orden fijo; nunca los valores.
import type { DetalleXml } from "./tipos";

export type CampoIdentidad = "ruc" | "tipo" | "serie" | "numero" | "receptor";

export interface CompraIdentificable {
  readonly docTipo: string;
  readonly docNumero: string;
  readonly tipoDoc: string;
  readonly serie: string;
  readonly numero: string;
}

export type ResultadoIdentidad = { readonly ok: true } | { readonly ok: false; readonly campos: readonly CampoIdentidad[] };

const TIPO_RUC = "6";
const CEROS_IZQUIERDA = /^0+(?=[0-9])/;

const serie = (s: string): string => s.trim().toUpperCase();
const numero = (s: string): string => s.trim().replace(CEROS_IZQUIERDA, "");

export function compararIdentidad(
  detalle: DetalleXml,
  e: { readonly rucCliente: string; readonly compra: CompraIdentificable },
): ResultadoIdentidad {
  const { identidad } = detalle;
  const { compra } = e;
  const iguales: readonly (readonly [CampoIdentidad, boolean])[] = [
    ["ruc", compra.docTipo.trim() === TIPO_RUC && compra.docNumero.trim() === identidad.emisor.ruc],
    ["tipo", compra.tipoDoc.trim() === identidad.tipo],
    ["serie", serie(compra.serie) === serie(identidad.serie)],
    ["numero", numero(compra.numero) === numero(identidad.numero)],
    ["receptor", identidad.receptor.tipoDoc === TIPO_RUC && identidad.receptor.numero === e.rucCliente.trim()],
  ];
  const campos = iguales.filter(([, igual]) => !igual).map(([campo]) => campo);
  return campos.length === 0 ? { ok: true } : { ok: false, campos };
}
