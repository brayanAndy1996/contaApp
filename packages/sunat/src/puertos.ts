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
