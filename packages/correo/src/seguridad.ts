// Spec 029 (U8, CA-6, CA-10). Avisos de seguridad de la cuenta: texto plano, sin IO, sin códigos,
// secretos, URI ni enlaces. Los valores insertados se escapan y se acotan; el llamador pone `para`.

export const TIPOS_AVISO_SEGURIDAD = [
  "totp_activado",
  "totp_desactivado",
  "recuperacion_usada",
  "totp_restablecido",
] as const;

export type TipoAvisoSeguridad = (typeof TIPOS_AVISO_SEGURIDAD)[number];

export interface DatosAvisoSeguridad {
  nombre?: string | null;
  ocurridoEn: Date;
  dispositivo?: string | null;
  ip?: string | null;
}

export interface AvisoSeguridad {
  asunto: string;
  texto: string;
}

const MAX_NOMBRE = 80;
const MAX_DISPOSITIVO = 60;
const MAX_IP = 45;

// Controles C0/C1, separadores de línea y párrafo, y marcas de dirección (bidi): se vuelven espacio.
const PELIGROSOS = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]+",
  "g",
);

/** Una sola línea sin caracteres de control, con espacios colapsados y largo acotado. */
function limpiar(valor: string | null | undefined, max: number): string {
  if (typeof valor !== "string") return "";
  const texto = valor.replace(PELIGROSOS, " ").replace(/\s+/g, " ").trim();
  return [...texto].slice(0, max).join("").trim();
}

function fechaLima(fecha: Date): string {
  if (Number.isNaN(fecha.getTime())) return "fecha no disponible";
  const partes = new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(fecha);
  const p = (tipo: string) => partes.find((x) => x.type === tipo)?.value ?? "";
  return `${p("day")}/${p("month")}/${p("year")} ${p("hour")}:${p("minute")} (hora de Lima)`;
}

const ASUNTOS: Record<TipoAvisoSeguridad, string> = {
  totp_activado: "Activaste la verificación en dos pasos en ContApp",
  totp_desactivado: "Desactivaste la verificación en dos pasos en ContApp",
  recuperacion_usada: "Se usó un código de recuperación en tu cuenta de ContApp",
  totp_restablecido:
    "Se restableció la verificación en dos pasos de tu cuenta de ContApp",
};

const CUERPOS: Record<TipoAvisoSeguridad, string> = {
  totp_activado:
    "Se activó la verificación en dos pasos en tu cuenta de ContApp. A partir de ahora, al iniciar sesión se te pedirá un código de tu aplicación autenticadora. Las demás sesiones abiertas de tu cuenta se cerraron.",
  totp_desactivado:
    "Se desactivó la verificación en dos pasos en tu cuenta de ContApp. Desde ahora solo se pedirá tu contraseña al iniciar sesión.",
  recuperacion_usada:
    "Se usó uno de tus códigos de recuperación para iniciar sesión en tu cuenta de ContApp. Ese código ya no sirve. Si te quedan pocos, genera un conjunto nuevo desde la sección Seguridad de tu cuenta.",
  totp_restablecido:
    "El operador de ContApp restableció la verificación en dos pasos de tu cuenta, a pedido tuyo o por una verificación de identidad. Tu aplicación autenticadora anterior ya no sirve y tendrás que configurar la verificación de nuevo al iniciar sesión.",
};

const SI_NO_FUISTE =
  "Si no reconoces este cambio, cambia tu contraseña de inmediato y avisa al administrador de tu estudio.";

/** Aviso de seguridad (U8) en texto plano. Determinista: depende solo de sus argumentos. */
export function avisoSeguridad(
  tipo: TipoAvisoSeguridad,
  datos: DatosAvisoSeguridad,
): AvisoSeguridad {
  const nombre = limpiar(datos.nombre, MAX_NOMBRE);
  const dispositivo = limpiar(datos.dispositivo, MAX_DISPOSITIVO);
  const ip = limpiar(datos.ip, MAX_IP);

  const lineas = [
    nombre ? `Hola, ${nombre}:` : "Hola:",
    "",
    CUERPOS[tipo],
    "",
    `Fecha: ${fechaLima(datos.ocurridoEn)}`,
  ];
  if (dispositivo) lineas.push(`Dispositivo: ${dispositivo}`);
  if (ip) lineas.push(`Red: ${ip}`);
  lineas.push("", SI_NO_FUISTE);

  return { asunto: ASUNTOS[tipo], texto: lineas.join("\n") };
}
