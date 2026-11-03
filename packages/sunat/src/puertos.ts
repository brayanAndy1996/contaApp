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
