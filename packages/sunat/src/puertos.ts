import type { OrigenXml } from "@contapp/shared";

export interface CredencialSire {
  clientId: string;
  clientSecret: string;
  usuarioSol: string;
  claveSol: string;
  ruc: string;
}

export interface TokenSire {
  token: string;
  expiraEn: Date;
}

/** Puerto de autenticación OAuth del SIRE. Solo el worker lo usa (el backend nunca llama a SUNAT). */
export interface SireAuth {
  obtenerToken(credencial: CredencialSire): Promise<TokenSire>;
}

export interface DatosRuc {
  razonSocial: string;
  estado: string;
  condicion: string;
}

/**
 * Puerto de consulta de datos de un RUC (padrón). Solo el worker lo usa. Un fallo de red o 5xx es
 * `ErrorTransitorio`; un RUC que el padrón no acepta es `ErrorDatos`.
 */
export interface ConsultaRuc {
  consultar(ruc: string): Promise<DatosRuc>;
}

export interface CredencialSol {
  ruc: string;
  usuarioSol: string;
  claveSol: string;
}

/**
 * Puerto de verificación de la clave SOL contra el portal. Solo el worker lo usa. Resuelve sin valor si
 * la acepta; `ErrorCredencial` si la rechaza; `ErrorTransitorio` si el portal no responde.
 */
export interface SolAuth {
  verificar(credencial: CredencialSol): Promise<void>;
}

export type LibroSire = "compras" | "ventas";

/**
 * Datos de la fila del SIRE que el mock usa para fabricar un XML coherente cuando no hay fixture.
 * Montos como cadenas decimales (nunca `number`). El proveedor real ignora `referencia`.
 */
export interface ReferenciaXml {
  /** AAAA-MM-DD */
  fechaEmision: string;
  moneda: "PEN" | "USD";
  tipoCambio?: string;
  baseGravada: string;
  igv: string;
  noGravado: string;
  isc: string;
  icbper: string;
  otros: string;
  total: string;
  /**
   * RUC del cliente (el receptor del comprobante), 11 dígitos. El worker lo pasa para que el XML sintético sea el de ese
   * cliente (spec 016, D-3). Sin él, el mock deja el receptor sin identificar.
   */
  rucReceptor?: string;
}

export interface SolicitudXml {
  rucEmisor: string;
  /** Tipo de comprobante (catálogo 01 de SUNAT, p. ej. "01" factura, "03" boleta). */
  tipo: string;
  serie: string;
  numero: string;
  /** Solo la usa el mock; el proveedor real la ignora. */
  referencia?: ReferenciaXml;
}

export interface RespuestaXml {
  xml: string;
  origen: OrigenXml;
  fuente: "fixture" | "sintetico" | "inyectado";
}

/**
 * Puerto de obtención del XML de un comprobante. Solo el worker lo usa. Lanza `ErrorTransitorio`
 * (red/5xx), `ErrorCredencial` (acceso rechazado) o `ErrorDatos` (comprobante inexistente o solicitud
 * fuera de contrato). El proveedor real ignora `referencia`.
 */
export interface XmlProvider {
  obtener(solicitud: SolicitudXml): Promise<RespuestaXml>;
}

export interface SolicitudPropuesta {
  ruc: string;
  /** AAAAMM */
  periodo: string;
  libro: LibroSire;
}

/**
 * Fila de la propuesta del SIRE. Montos como cadenas decimales. En ventas solo se usan `biDg`, `igvDg`,
 * `noGravado`, `isc`, `icbper`, `otros` y `total`.
 */
export interface FilaPropuestaSire {
  tipo: string;
  serie: string;
  numero: string;
  rucContraparte: string;
  /** Tipo de documento del proveedor (catálogo 06). Ausente = «6» (RUC). */
  tipoDocContraparte?: string;
  /** Razón social del proveedor. */
  razonSocialContraparte?: string;
  /** AAAA-MM-DD */
  fechaEmision: string;
  moneda: "PEN" | "USD";
  tipoCambio?: string;
  biDg: string;
  igvDg: string;
  biDgng: string;
  igvDgng: string;
  biDng: string;
  igvDng: string;
  noGravado: string;
  isc: string;
  icbper: string;
  otros: string;
  total: string;
}

/**
 * Fila de la propuesta de ventas del SIRE (RVIE). Montos como cadenas decimales (nunca `number`). Las
 * columnas son las del layout provisional de 013 (D14b) y no las de compras: `docContraparte` es el
 * documento del cliente (`-` en una boleta de consumidor final) y los tres tipos de venta no gravada van
 * separados (`exonerada`, `inafecta`, `otros`).
 */
export interface FilaVentaSire {
  tipo: string;
  serie: string;
  numero: string;
  tipoDocContraparte?: string;
  docContraparte: string;
  /** AAAA-MM-DD */
  fechaEmision: string;
  moneda: "PEN" | "USD";
  tipoCambio?: string;
  baseGravada: string;
  igv: string;
  exonerada: string;
  inafecta: string;
  isc: string;
  icbper: string;
  otros: string;
  total: string;
}

/** Propuesta de compras: sus filas son `FilaPropuestaSire` (sin cambios desde 009). */
export interface PropuestaComprasSire {
  libro: "compras";
  periodo: string;
  filas: FilaPropuestaSire[];
}

/** Propuesta de ventas: sus filas son `FilaVentaSire` (013). */
export interface PropuestaVentasSire {
  libro: "ventas";
  periodo: string;
  filas: FilaVentaSire[];
}

/** Unión por `libro`: quien lea `filas` estrecha primero por `libro`. */
export type PropuestaSire = PropuestaComprasSire | PropuestaVentasSire;

/**
 * Puerto de descarga de la propuesta mensual del SIRE. Solo el worker lo usa (el backend nunca llama a
 * SUNAT). Lanza `ErrorCredencial` si el token no sirve, `ErrorTransitorio` si SUNAT no responde y
 * `ErrorDatos` si el RUC o el periodo no son válidos. No conserva el token.
 */
export interface SireApiClient {
  descargarPropuesta(token: TokenSire, solicitud: SolicitudPropuesta): Promise<PropuestaSire>;
}
