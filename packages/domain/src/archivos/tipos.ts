// Tipos públicos de archivos/ (spec 012b, plan, Contratos: Dominio). Stub de T1: solo contratos; T7 los implementa.
import type { Justificado } from "../correlatividad/index";
import type { Moneda } from "../dinero/index";
import type { CabeceraTxt } from "../formatos/tipos";
import type {
  FilaReemplazo,
  FilaReemplazoVenta,
  ResultadoPrevalidacion,
  ResumenCambios,
  ResumenCambiosVentas,
} from "../prevalidacion/index";
import type { ContextoReglas } from "../reglas/index";
import type { Entero } from "../texto/entero";

export type CodigoAvisoArchivo = "R-ISC" | "R-NEW" | "R-GP" | "SALTO_CORRELATIVIDAD" | "RAZON_SOCIAL_RECORTADA";

/** Aviso del previo: nunca bloquea y no entra en la huella. `filaId` es `null` en un salto de correlatividad. */
export interface AvisoArchivo {
  readonly codigo: CodigoAvisoArchivo;
  readonly filaId: string | null;
  readonly explicacion: string;
}

export type MotivoNoGenerable = "prevalidacion_fallida" | "formato_no_oficial";

export interface EntradaPrepararCompras {
  readonly libro: "compras";
  readonly cabecera: CabeceraTxt;
  readonly original: readonly FilaReemplazo[];
  readonly vigente: readonly FilaReemplazo[];
  readonly reglas?: ContextoReglas;
  readonly permitirProvisional: boolean;
}

export interface EntradaPrepararVentas {
  readonly libro: "ventas";
  readonly cabecera: CabeceraTxt;
  readonly original: readonly FilaReemplazoVenta[];
  readonly vigente: readonly FilaReemplazoVenta[];
  /** Saltos de correlatividad justificados (`venta_salto_justificado`). */
  readonly saltos?: readonly Justificado[];
  readonly permitirProvisional: boolean;
}

export interface ArchivoPreparado {
  readonly resultado: ResultadoPrevalidacion;
  readonly resumen: ResumenCambios | ResumenCambiosVentas;
  readonly avisos: readonly AvisoArchivo[];
  /** `apto` y (formato oficial o `permitirProvisional`). */
  readonly generable: boolean;
  readonly motivo: MotivoNoGenerable | null;
  /** Texto canónico `h1` de la huella; la huella es `sha256Hex(canon)` fuera del dominio. */
  readonly canon: string;
}

export interface EntradaCanonHuella {
  readonly cabecera: CabeceraTxt;
  readonly formato: { readonly id: string; readonly version: string; readonly oficial: boolean };
  readonly original: readonly FilaReemplazo[] | readonly FilaReemplazoVenta[];
  readonly vigente: readonly FilaReemplazo[] | readonly FilaReemplazoVenta[];
}

/** Lo que `packages/db` entrega de cada compra (estructuralmente igual a `CompraLeida` de 014). */
export interface CompraLeidaPlana {
  readonly id: string;
  readonly origen: "sire" | "agregada";
  readonly tipoDoc: string;
  readonly serie: string;
  readonly numero: string;
  readonly docTipo: string;
  readonly docNumero: string;
  readonly razonSocial: string | null;
  /** AAAA-MM-DD. */
  readonly fecha: string;
  readonly moneda: Moneda;
  readonly tipoCambio: string | null;
  readonly version: Entero;
  readonly excluida: boolean;
  readonly montos: Readonly<Record<string, string>>;
}

/** Lo que `packages/db` entrega de cada venta, con `excluida` = tiene una exclusión vigente. */
export interface VentaLeidaPlana {
  readonly id: string;
  readonly origen: "sire" | "manual";
  readonly tipo: string;
  readonly serie: string;
  readonly numero: string;
  /** AAAA-MM-DD. */
  readonly fecha: string;
  /** Vacío en el consumidor final. */
  readonly tipoDocContraparte: string;
  readonly docContraparte: string;
  readonly moneda: Moneda;
  readonly tipoCambio: string | null;
  readonly baseGravada: string;
  readonly igv: string;
  readonly exonerada: string;
  readonly inafecta: string;
  readonly isc: string;
  readonly icbper: string;
  readonly otros: string;
  readonly total: string;
  readonly excluida: boolean;
}
