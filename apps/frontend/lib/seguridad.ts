import { sesionCuentaSchema, type SesionCuenta } from "@contapp/shared";

// Textos y ayudas de las pantallas de seguridad de la cuenta (spec 029). Solo presentación.

export const MENSAJES_SEGURIDAD = {
  codigoIncorrecto: "El código no es correcto.",
  contrasenaOCodigo: "La contraseña o el código no son correctos.",
  contrasenaIncorrecta: "La contraseña no es correcta.",
  totpExigido:
    "Tu rol exige la verificación en dos pasos; no se puede desactivar.",
  desactivada: "Verificación en dos pasos desactivada.",
  exigidoAviso:
    "Tu cuenta exige la verificación en dos pasos. Actívala para continuar.",
  errorRevocar: "No se pudo revocar la sesión. Inténtalo de nuevo.",
  errorSesiones: "No se pudieron cargar las sesiones. Inténtalo de nuevo.",
  demasiadosIntentos:
    "Demasiados intentos. Inténtalo de nuevo en unos minutos.",
  errorGeneral: "Ocurrió un error. Inténtalo de nuevo.",
  sesionCaducada: "La sesión caducó. Ingresa de nuevo.",
} as const;

export const codigoDe = (datos: unknown): string | undefined =>
  (datos as { codigo?: string } | null)?.codigo;

/** Filas de `GET /auth/sesiones` reducidas a los campos del contrato; descarta lo que sobre (nunca se pinta). */
export function sesionesDeRespuesta(datos: unknown): SesionCuenta[] {
  if (!Array.isArray(datos)) return [];
  const filas: SesionCuenta[] = [];
  for (const fila of datos as Record<string, unknown>[]) {
    const r = sesionCuentaSchema.safeParse({
      id: fila?.id,
      creadaEn: fila?.creadaEn,
      ultimoUso: fila?.ultimoUso,
      dispositivo: fila?.dispositivo,
      ip: fila?.ip,
      actual: fila?.actual,
    });
    if (r.success) filas.push(r.data);
  }
  return filas;
}

const formato = new Intl.DateTimeFormat("es-PE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Lima",
});

export function fechaHora(iso: string): string {
  const fecha = new Date(iso);
  return Number.isNaN(fecha.getTime()) ? "" : formato.format(fecha);
}
