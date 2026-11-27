/** Motivos con los que un error de SUNAT agota el flujo de un trabajo (catálogo de `shared`). */
export type MotivoSunat =
  | "sunat_no_responde"
  | "credencial_invalida"
  | "datos_invalidos"
  | "portal_cambio";

export type ClaseError = "transitorio" | "credencial" | "datos" | "portal";

/**
 * Base de los errores del adaptador SUNAT. El `message` es fijo por clase: la causa (error crudo,
 * respuesta o datos de entrada) se descarta a propósito para que nunca llegue a un log, a un
 * `JSON.stringify` ni al `stack` (CA-16). `_causa` solo existe para la firma del constructor.
 */
export abstract class ErrorSunat extends Error {
  abstract readonly codigo: MotivoSunat;
  abstract readonly clase: ClaseError;

  protected constructor(mensaje: string, causa?: unknown) {
    super(mensaje);
    void causa; // descartada a propósito
    this.name = new.target.name;
  }
}

/** Timeout, 5xx o red caída: se reintenta. */
export class ErrorTransitorio extends ErrorSunat {
  readonly codigo = "sunat_no_responde";
  readonly clase = "transitorio";
  constructor(causa?: unknown) {
    super("SUNAT no respondió a tiempo", causa);
  }
}

/** 401/403 del OAuth: la credencial ya no sirve; no se reintenta. */
export class ErrorCredencial extends ErrorSunat {
  readonly codigo = "credencial_invalida";
  readonly clase = "credencial";
  constructor(causa?: unknown) {
    super("SUNAT rechazó la credencial", causa);
  }
}

/** Datos rechazados por SUNAT (4xx de negocio); no se reintenta. */
export class ErrorDatos extends ErrorSunat {
  readonly codigo = "datos_invalidos";
  readonly clase = "datos";
  constructor(causa?: unknown) {
    super("SUNAT rechazó los datos enviados", causa);
  }
}

/** El portal cambió de contrato o de forma; no se reintenta. */
export class ErrorPortal extends ErrorSunat {
  readonly codigo = "portal_cambio";
  readonly clase = "portal";
  constructor(causa?: unknown) {
    super("El portal de SUNAT cambió", causa);
  }
}

export interface Clasificacion {
  clase: ClaseError;
  motivo: MotivoSunat;
}

/** Clasifica cualquier valor lanzado. Nunca lanza; lo no clasificado cuenta como transitorio. */
export function clasificarError(e: unknown): Clasificacion {
  if (e instanceof ErrorSunat) return { clase: e.clase, motivo: e.codigo };
  return { clase: "transitorio", motivo: "sunat_no_responde" };
}

// ── Spec 041 · adaptador HTTP del SIRE ──────────────────────────────────────────────────────────────────────

/**
 * 401 de la API del SIRE con el token entregado: la caché de 008 (`conToken`) lo renueva una sola vez. Vive aquí porque
 * lo lanza el adaptador y el worker lo reexporta (plan 041). Mensaje fijo: nunca lleva el token.
 */
export class TokenRechazadoError extends Error {
  readonly codigo = "token_rechazado";
  constructor() {
    super("El servicio SIRE rechazó el token");
    this.name = "TokenRechazadoError";
  }
}

export type DetalleDatosSire = "respuesta_ajena" | "fila_invalida" | "columna_no_soportada" | "ticket_con_errores" | "sin_datos";
export type DetallePortalSire =
  | "encabezado"
  | "zip_invalido"
  | "codificacion"
  | "respuesta_inesperada"
  | "estado_desconocido"
  | "nombre_archivo";
export type DetalleTransitorioSire = "ticket_pendiente" | "red" | "timeout" | "servidor";

/** `ErrorDatos` del SIRE con un `detalle` literal (nunca datos de la respuesta). */
export class ErrorDatosSire extends ErrorDatos {
  constructor(readonly detalle: DetalleDatosSire) {
    super();
  }
}

/** `ErrorPortal` del SIRE con un `detalle` literal (nunca datos de la respuesta). */
export class ErrorPortalSire extends ErrorPortal {
  constructor(readonly detalle: DetallePortalSire) {
    super();
  }
}

/** `ErrorTransitorio` del SIRE con un `detalle` literal (nunca la causa original). */
export class ErrorTransitorioSire extends ErrorTransitorio {
  constructor(readonly detalle: DetalleTransitorioSire) {
    super();
  }
}
