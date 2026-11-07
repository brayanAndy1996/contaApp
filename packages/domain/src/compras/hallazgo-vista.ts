// Lo que la vista de una fila necesita de un hallazgo guardado (spec 014, D-4, D-15): el destino, la explicación del catálogo y
// el dato que pide aplicarlo. La tabla `compra_hallazgo` guarda solo la regla, la sugerencia, las lecturas y si pide
// confirmación (cadenas); el resto se reconstruye aquí con el catálogo fijo de 011, sin releer el periodo ni evaluar de nuevo.
// Puro, sin IO. Sin XML en la fila (016 lo traerá) la explicación es la de la regla sin respaldo; nunca lleva texto externo
// salvo la palabra del diccionario de R-GP.
import type { ColumnaCompra, Destino } from "../comprobante/index";
import { Money } from "../dinero/index";
import {
  ISC_XML_EXACTO,
  MARCA_ISC_SIN_XML,
  PROVEEDOR_NUEVO,
  SUFIJO_MIX_RANGO_VACIO,
  gastoPersonal,
  iscSinXml,
  mix,
  red,
  sufijoMixExacto,
} from "../reglas/explicaciones";
import { sugerenciaEsMasiva } from "./masivas";
import type { Hallazgo } from "../reglas/index";

/** Un hallazgo tal como lo guarda `compra_hallazgo`: montos como cadenas decimales. */
export interface HallazgoGuardado {
  readonly regla: string;
  readonly sugerencia: unknown;
  readonly lecturas: Readonly<Record<string, string>>;
  readonly requiereConfirmacion: boolean;
}

export interface DetalleHallazgo {
  readonly destino: Destino | null;
  readonly explicacion: string;
  readonly dato: "gravado" | "destino" | null;
  /** `sugerenciaEsMasiva` de D-15. */
  readonly masiva: boolean;
}

/** Texto cuando el hallazgo guardado no se puede reconstruir (regla desconocida o lecturas ilegibles). */
export const EXPLICACION_GENERICA = "Revisar la fila";

const PAR_DE_BI: Readonly<Record<string, { destino: Destino; igv: string }>> = {
  biDg: { destino: "DG", igv: "igvDg" },
  biDgng: { destino: "DGNG", igv: "igvDgng" },
  biDng: { destino: "DNG", igv: "igvDng" },
};
const BIS: readonly string[] = ["biDg", "biDgng", "biDng"];
const COLUMNAS_RED: readonly ColumnaCompra[] = [
  "biDg", "igvDg", "biDgng", "igvDgng", "biDng", "igvDng", "noGravado", "isc", "icbper", "otrosTributos",
];

const registro = (v: unknown): Readonly<Record<string, unknown>> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Readonly<Record<string, unknown>>) : null;

const monto = (lecturas: Readonly<Record<string, string>>, k: string): Money => Money.desde(lecturas[k] ?? "0.00", "PEN");

function detalleIsc(h: HallazgoGuardado, s: Readonly<Record<string, unknown>> | null): DetalleHallazgo {
  const origen = s !== null && s.tipo === "mover" && typeof s.origen === "string" ? s.origen : null;
  const par = origen === null ? undefined : PAR_DE_BI[origen];
  const masiva = esMasiva(h, null);
  if (par === undefined || origen === null) return { destino: null, explicacion: MARCA_ISC_SIN_XML, dato: null, masiva };
  const bi = monto(h.lecturas, origen);
  return {
    destino: par.destino,
    explicacion: h.requiereConfirmacion ? iscSinXml(bi) : ISC_XML_EXACTO,
    dato: null,
    masiva,
  };
}

function detalleMix(h: HallazgoGuardado, s: Readonly<Record<string, unknown>> | null): DetalleHallazgo {
  const separar = s !== null && s.tipo === "separar";
  const bi = separar && typeof s.columnaBi === "string" && s.columnaBi in PAR_DE_BI
    ? s.columnaBi
    : BIS.find((c) => PAR_DE_BI[c] !== undefined && PAR_DE_BI[c].igv in h.lecturas && c in h.lecturas);
  const par = bi === undefined ? undefined : PAR_DE_BI[bi];
  if (bi === undefined || par === undefined) return { destino: null, explicacion: EXPLICACION_GENERICA, dato: null, masiva: false };
  const exacto = separar && typeof s.exacto === "string" ? Money.desde(s.exacto, "PEN") : null;
  const base = mix(monto(h.lecturas, par.igv), monto(h.lecturas, bi));
  const explicacion = !separar ? base + SUFIJO_MIX_RANGO_VACIO : exacto === null ? base : base + sufijoMixExacto(exacto);
  const dato = separar && exacto === null ? "gravado" : null;
  return { destino: par.destino, explicacion, dato, masiva: esMasiva(h, dato) };
}

function detalleRed(h: HallazgoGuardado): DetalleHallazgo {
  const suma = Money.suma(COLUMNAS_RED.map((c) => monto(h.lecturas, c)), "PEN");
  return { destino: null, explicacion: red(suma, monto(h.lecturas, "total")), dato: null, masiva: esMasiva(h, null) };
}

function esMasiva(h: HallazgoGuardado, dato: "gravado" | "destino" | null): boolean {
  const parcial = { sugerencia: h.sugerencia ?? null, requiereConfirmacion: h.requiereConfirmacion, dato };
  return sugerenciaEsMasiva(parcial as unknown as Hallazgo);
}

/**
 * Destino, explicación, dato y marca de masiva de un hallazgo guardado. R-ISC y R-MIX toman el destino de la columna de su
 * sugerencia; R-MIX pide el gravado cuando no hay monto exacto y R-NEW pide el destino. Una regla desconocida o unas lecturas
 * ilegibles dan la explicación genérica, sin lanzar.
 */
export function detallarHallazgo(h: HallazgoGuardado): DetalleHallazgo {
  const s = registro(h.sugerencia);
  try {
    switch (h.regla) {
      case "R-ISC":
        return detalleIsc(h, s);
      case "R-MIX":
        return detalleMix(h, s);
      case "R-RED":
        return detalleRed(h);
      case "R-NEW":
        return { destino: null, explicacion: PROVEEDOR_NUEVO, dato: "destino", masiva: false };
      case "R-GP":
        return {
          destino: null,
          explicacion: s !== null && typeof s.palabra === "string" ? gastoPersonal(s.palabra) : EXPLICACION_GENERICA,
          dato: null,
          masiva: false,
        };
      default:
        return { destino: null, explicacion: EXPLICACION_GENERICA, dato: null, masiva: false };
    }
  } catch {
    return { destino: null, explicacion: EXPLICACION_GENERICA, dato: null, masiva: false };
  }
}

