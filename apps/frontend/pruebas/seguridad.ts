import {
  CODIGOS_ERROR_SEGURIDAD,
  codigosRecuperacionRespuestaSchema,
  enrolarTotpRespuestaSchema,
  errorSeguridadSchema,
  estadoFactorSchema,
  loginSegundoFactorRespuestaSchema,
  sesionesCuentaRespuestaSchema,
} from "@contapp/shared";

// Soporte de las pruebas de 029 (cuenta segura, T4): sesión con factor y mensajes exactos que las
// pantallas deben mostrar (contrato para T9). La forma de `GET /auth/sesion` sale del plan 029.

export const MENSAJES_SEG = {
  codigoIncorrecto: "El código no es correcto.",
  // Contraseña o código erróneos al desactivar / regenerar: un único texto.
  contrasenaOCodigo: "La contraseña o el código no son correctos.",
  // Contraseña actual errónea al iniciar el enrolamiento.
  contrasenaIncorrecta: "La contraseña no es correcta.",
  totpExigido:
    "Tu rol exige la verificación en dos pasos; no se puede desactivar.",
  desactivada: "Verificación en dos pasos desactivada.",
  exigidoAviso:
    "Tu cuenta exige la verificación en dos pasos. Actívala para continuar.",
  errorRevocar: "No se pudo revocar la sesión. Inténtalo de nuevo.",
  demasiadosIntentos:
    "Demasiados intentos. Inténtalo de nuevo en unos minutos.",
} as const;

export type Factor = "pendiente" | "verificado" | "sin_factor";

/** Código de error del contrato (`CODIGOS_ERROR_SEGURIDAD` de `shared`, plan 029). */
export type CodigoErrorSeguridad = (typeof CODIGOS_ERROR_SEGURIDAD)[number];

/** Cuerpo de error `{ codigo }` validado con `errorSeguridadSchema`. */
export function errorSeg(codigo: CodigoErrorSeguridad) {
  return errorSeguridadSchema.parse({ codigo });
}

/** Respuesta 200 del login con TOTP activo, validada con `loginSegundoFactorRespuestaSchema`. */
export function respuestaSegundoFactor() {
  return loginSegundoFactorRespuestaSchema.parse({
    segundoFactor: true,
    estudioActivo: null,
  });
}

/** `{ uri }` de `POST /auth/totp/enrolar`, validada con `enrolarTotpRespuestaSchema`. */
export function respuestaEnrolar() {
  return enrolarTotpRespuestaSchema.parse({ uri: URI_CANARIO });
}

/** `{ codigosRecuperacion }` (10 códigos), validada con `codigosRecuperacionRespuestaSchema`. */
export function respuestaCodigos() {
  return codigosRecuperacionRespuestaSchema.parse({
    codigosRecuperacion: CODIGOS_RECUPERACION,
  });
}

/** Lista de `GET /auth/sesiones` validada con `sesionesCuentaRespuestaSchema` (estricto: sin hash ni token). */
export function sesionesCuenta<T extends object>(filas: T[]) {
  return sesionesCuentaRespuestaSchema.parse(filas) as unknown as T[];
}

export interface OpcionesSesion {
  factor?: Factor;
  totpActivo?: boolean;
  factorExigido?: boolean;
  estudio?: { id: string; nombre: string } | null;
  csrf?: string;
}

/** Cuerpo de `GET /auth/sesion` con los campos nuevos de 029 (`factor`, `totpActivo`, `factorExigido`). */
export function sesionSegura(o: OpcionesSesion = {}) {
  const estudio =
    o.estudio === undefined ? { id: "e-1", nombre: "Estudio Uno" } : o.estudio;
  const estado = estadoFactorSchema.parse({
    factor: o.factor ?? "sin_factor",
    totpActivo: o.totpActivo ?? false,
    factorExigido: o.factorExigido ?? false,
  });
  return {
    usuario: { id: "u-1", nombre: "Ana Prueba", correo: "ana@ejemplo.test" },
    estudioActivo: estudio,
    csrf: o.csrf ?? "csrf-canario-1",
    ...estado,
  };
}

/** Diez códigos de recuperación canarios con la forma `XXXX-XXXX-XXXX` (base32: A-Z, 2-7). */
export const CODIGOS_RECUPERACION = Array.from({ length: 10 }, (_, i) => {
  const letra = String.fromCharCode(65 + i);
  return `${letra}CAN-${letra}ARI-${letra}O${(i % 6) + 2}${(i % 5) + 2}`;
});

/** URI `otpauth://` canario: no debe quedar en el DOM, el almacenamiento ni la consola. */
export const URI_CANARIO =
  "otpauth://totp/ContApp:ana%40ejemplo.test?secret=CANARIOSECRETOTOTP234567&issuer=ContApp&algorithm=SHA1&digits=6&period=30";
export const SECRETO_CANARIO = "CANARIOSECRETOTOTP234567";
