// Mapeo de una compra a la FilaReemplazo de 012 (spec 014, D-10, nota [012b]).
import type { MontosComprobante } from "../comprobante/index";
import type { FilaReemplazo } from "../prevalidacion/index";
import type { EstadoFila } from "../prevalidacion/index";
import type { IdComprobante } from "../reglas/index";
import type { Entero } from "../texto/entero";

export interface CompraParaReemplazo {
  /** Id de la compra; pasa tal cual a FilaReemplazo.id. */
  readonly id: string;
  readonly origen: "sire" | "agregada";
  readonly comprobante: IdComprobante;
  readonly proveedor: { readonly tipo: string; readonly numero: string; readonly razonSocial: string | null };
  /** AAAA-MM-DD. */
  readonly fechaEmision: string;
  /** Lo guardado en la compra. */
  readonly tipoCambio: string | null;
  /** n de la versión que se mapea (1 = tal como vino). */
  readonly version: Entero;
  readonly excluida: boolean;
  /** Los montos de esa versión. */
  readonly montos: MontosComprobante;
}

/**
 * `excluida` si está excluida; si no `agregada` si nació a mano (aunque tenga más versiones); si no
 * `modificada` si su versión es mayor que 1; si no `original`. Excluir una agregada equivale a descartarla
 * (DU-16): una agregada excluida no llega aquí. El tipo de cambio es `null` en PEN y el guardado en USD;
 * `origenUsd` siempre `null` y nunca hay `xml`.
 */
export function aFilaReemplazo(compra: CompraParaReemplazo): FilaReemplazo {
  const { proveedor } = compra;
  return {
    id: compra.id,
    estado: estadoDe(compra),
    comprobante: { tipo: compra.comprobante.tipo, serie: compra.comprobante.serie, numero: compra.comprobante.numero },
    proveedor:
      typeof proveedor.razonSocial === "string"
        ? { tipo: proveedor.tipo, numero: proveedor.numero, razonSocial: proveedor.razonSocial }
        : { tipo: proveedor.tipo, numero: proveedor.numero },
    fechaEmision: compra.fechaEmision,
    montos: compra.montos,
    tipoCambio: compra.montos.moneda === "PEN" ? null : compra.tipoCambio,
    origenUsd: null,
  };
}

function estadoDe(c: CompraParaReemplazo): EstadoFila {
  if (c.excluida) return "excluida";
  if (c.origen === "agregada") return "agregada";
  return c.version > 1 ? "modificada" : "original";
}
