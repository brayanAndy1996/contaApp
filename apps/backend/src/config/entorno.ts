// Lectura y validación del entorno de 004. Todo fallo es síncrono e impide arrancar; los mensajes
// nombran la variable, nunca su valor (SMTP_URL es un secreto, CA-10).

export type EnvCrudo = Record<string, string | undefined>;

export interface Entorno {
  appOrigin: string;
  trustProxy: string;
  produccion: boolean;
  argon2: { memoriaKib: number; iteraciones: number; paralelismo: number };
  correo: {
    provider: "consola" | "smtp";
    remitente?: string;
    smtpUrl?: string;
  };
}

/** Piso de Argon2id (D1, OWASP): por debajo no se arranca. */
export const PISO_ARGON2 = {
  memoriaKib: 19456,
  iteraciones: 2,
  paralelismo: 1,
} as const;

export class EntornoInvalidoError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(`Entorno inválido: ${variable}`);
    this.name = "EntornoInvalidoError";
    this.variable = variable;
  }
}

/** Mismo criterio que `esProduccion` de la spec 003: sin distinguir mayúsculas ni espacios. */
function esProduccion(nodeEnv: string | undefined): boolean {
  return (
    typeof nodeEnv === "string" && nodeEnv.trim().toLowerCase() === "production"
  );
}

function vacio(valor: string | undefined): valor is undefined {
  return valor === undefined || valor.trim() === "";
}

/** Entero decimal estricto (sin signo, decimales ni notación científica) y no menor que el piso. */
function entero(env: EnvCrudo, variable: string, piso: number): number {
  const crudo = env[variable];
  if (vacio(crudo)) return piso;
  const texto = crudo.trim();
  if (!/^\d{1,9}$/.test(texto)) throw new EntornoInvalidoError(variable);
  const valor = Number(texto);
  if (valor < piso) throw new EntornoInvalidoError(variable);
  return valor;
}

function origen(env: EnvCrudo, produccion: boolean): string {
  const crudo = env.APP_ORIGIN;
  if (vacio(crudo)) {
    if (produccion) throw new EntornoInvalidoError("APP_ORIGIN");
    return "http://localhost:3000";
  }
  const valor = crudo.trim();
  let url: URL;
  try {
    url = new URL(valor);
  } catch {
    throw new EntornoInvalidoError("APP_ORIGIN");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== valor
  ) {
    throw new EntornoInvalidoError("APP_ORIGIN");
  }
  return valor;
}

function correo(env: EnvCrudo, produccion: boolean): Entorno["correo"] {
  const provider = (env.CORREO_PROVIDER ?? "consola").trim().toLowerCase();
  const remitente = vacio(env.CORREO_REMITENTE)
    ? undefined
    : env.CORREO_REMITENTE.trim();
  if (provider === "consola") {
    if (produccion) throw new EntornoInvalidoError("CORREO_PROVIDER");
    return remitente === undefined ? { provider } : { provider, remitente };
  }
  if (provider === "smtp") {
    if (vacio(env.SMTP_URL)) throw new EntornoInvalidoError("SMTP_URL");
    if (remitente === undefined)
      throw new EntornoInvalidoError("CORREO_REMITENTE");
    return { provider, remitente, smtpUrl: env.SMTP_URL.trim() };
  }
  throw new EntornoInvalidoError("CORREO_PROVIDER");
}

export function leerEntorno(env: EnvCrudo): Entorno {
  const produccion = esProduccion(env.NODE_ENV);
  return {
    appOrigin: origen(env, produccion),
    trustProxy: vacio(env.TRUST_PROXY) ? "loopback" : env.TRUST_PROXY.trim(),
    produccion,
    argon2: {
      memoriaKib: entero(env, "ARGON2_MEMORIA_KIB", PISO_ARGON2.memoriaKib),
      iteraciones: entero(env, "ARGON2_ITERACIONES", PISO_ARGON2.iteraciones),
      paralelismo: entero(env, "ARGON2_PARALELISMO", PISO_ARGON2.paralelismo),
    },
    correo: correo(env, produccion),
  };
}
