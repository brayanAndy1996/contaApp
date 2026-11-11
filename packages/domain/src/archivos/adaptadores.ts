// Adaptadores de fila (spec 012b, D7, D12; plan, Contratos: Dominio): lo que entrega `packages/db` (cadenas)
// → filas de 012. `packages/db` no depende de `domain`: el backend y el worker inyectan estas funciones.
import { MontosComprobante } from "../comprobante/index";
import { aFilaReemplazo } from "../compras/index";
import { Money } from "../dinero/index";
import type { EstadoFilaVenta, FilaReemplazo, FilaReemplazoVenta } from "../prevalidacion/index";
import { COLUMNAS_VENTA } from "../ventas/columnas";
import type { ColumnaVenta } from "../ventas/columnas";
import type { AvisoArchivo, CompraLeidaPlana, VentaLeidaPlana } from "./tipos";

/** Máximo de la razón social en puntos de código (014 DU-25). */
const MAX_RAZON_SOCIAL = 100;

const RAZON_RECORTADA = `La razón social tiene más de ${MAX_RAZON_SOCIAL} caracteres: se recortó a ${MAX_RAZON_SOCIAL}`;

/**
 * D7: más de 100 puntos de código → los primeros 100 (un par sustituto nunca se parte). No limpia ningún
 * carácter: lo que quede inválido para el TXT sigue siendo error de `prevalidar` (012 D13).
 */
function recortarRazon(razon: string | null): { razon: string | null; recortada: boolean } {
  if (razon === null) return { razon, recortada: false };
  const puntos = Array.from(razon);
  if (puntos.length <= MAX_RAZON_SOCIAL) return { razon, recortada: false };
  return { razon: puntos.slice(0, MAX_RAZON_SOCIAL).join(""), recortada: true };
}

/** Compra de 014 → fila de 012. D7: razón social > 100 puntos de código se recorta y emite `RAZON_SOCIAL_RECORTADA`. */
export function compraLeidaAFila(c: CompraLeidaPlana): { fila: FilaReemplazo; avisos: AvisoArchivo[] } {
  const m = c.montos;
  const { razon, recortada } = recortarRazon(c.razonSocial);
  const fila = aFilaReemplazo({
    id: c.id,
    origen: c.origen,
    comprobante: { tipo: c.tipoDoc, serie: c.serie, numero: c.numero },
    proveedor: { tipo: c.docTipo, numero: c.docNumero, razonSocial: razon },
    fechaEmision: c.fecha,
    tipoCambio: c.tipoCambio,
    version: c.version,
    excluida: c.excluida,
    montos: MontosComprobante.desde(c.moneda, {
      biDg: m.biDg,
      igvDg: m.igvDg,
      biDgng: m.biDgng,
      igvDgng: m.igvDgng,
      biDng: m.biDng,
      igvDng: m.igvDng,
      noGravado: m.noGravado,
      isc: m.isc,
      icbper: m.icbper,
      otrosTributos: m.otrosTributos,
      total: m.total as string,
    }),
  });
  const avisos: AvisoArchivo[] = recortada
    ? [Object.freeze({ codigo: "RAZON_SOCIAL_RECORTADA", filaId: c.id, explicacion: RAZON_RECORTADA })]
    : [];
  return { fila, avisos };
}

/** Venta de 013 → fila de ventas: `excluida` → `excluida`; `manual` → `agregada`; `sire` → `original`. */
export function ventaAFila(v: VentaLeidaPlana): FilaReemplazoVenta {
  const montos = {} as Record<ColumnaVenta, Money>;
  for (const c of COLUMNAS_VENTA) montos[c] = Money.desde(v[c], v.moneda);
  let estado: EstadoFilaVenta = "original";
  if (v.excluida) estado = "excluida";
  else if (v.origen === "manual") estado = "agregada";
  return {
    id: v.id,
    estado,
    comprobante: { tipo: v.tipo, serie: v.serie, numero: v.numero },
    contraparte: v.tipoDocContraparte === "" ? { numero: v.docContraparte } : { tipo: v.tipoDocContraparte, numero: v.docContraparte },
    fechaEmision: v.fecha,
    montos,
    tipoCambio: v.moneda === "PEN" ? null : v.tipoCambio,
  };
}
