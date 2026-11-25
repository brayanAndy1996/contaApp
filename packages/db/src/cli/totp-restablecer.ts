// `pnpm db:totp-restablecer --correo <correo>`: el operador restablece la verificación en dos pasos de un usuario (spec 029, U5).
//
// Uso (con MIGRATIONS_DATABASE_URL; funciona con NODE_ENV=production):
//   node dist/cli/totp-restablecer.js --correo <correo>
//
//  - Llama a `auth.totp_restablecer` (solo contapp_migrator): borra el TOTP y los códigos de recuperación, revoca TODAS las
//    sesiones del usuario (motivo `totp`) y deja el evento `totp_restablecido`. No toca la contraseña.
//  - Si tuvo efecto, avisa al usuario por correo (U8) con la fábrica de `@contapp/correo`, sin códigos, secretos ni enlaces.
//  - La salida es una sola línea fija, igual exista o no el correo o tenga o no TOTP (CA-9). Idempotente.
//  - Nunca imprime el correo, la URL de conexión ni secretos; los errores llevan mensajes fijos.
import {
  avisoSeguridad,
  crearCorreo,
  type Correo,
  type ConfigCorreo,
} from "@contapp/correo";
import { CorreoNoAsciiError, normalizarCorreo } from "@contapp/shared";
import { Client } from "pg";
import { ErrorCli, ejecutarSiDirecta, urlMigraciones } from "./comun";

/** Resultado de leer los argumentos del CLI: el correo ya normalizado (trim, minúsculas, NFC, ASCII). */
export interface ArgumentosRestablecer {
  correo: string;
}

export interface DependenciasRestablecer {
  /** Por omisión, la fábrica de `@contapp/correo` según el entorno. */
  correo?: Correo;
}

const CORREO_MAX = 254;
const PATRON_CORREO = /^[^\s@]+@[^\s@]+$/;
const USO = "use --correo <correo>";

export function parsearArgumentos(
  argv: readonly string[],
): ArgumentosRestablecer {
  let crudo: string | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    const clave = argv[i];
    const valor = argv[i + 1];
    if (clave !== "--correo") throw new ErrorCli(`argumento desconocido: ${USO}`);
    if (valor === undefined) throw new ErrorCli("falta el valor de --correo");
    if (crudo !== undefined) throw new ErrorCli("--correo se indica una sola vez");
    crudo = valor;
  }
  if (crudo === undefined) throw new ErrorCli(`falta --correo: ${USO}`);
  let correo: string;
  try {
    correo = normalizarCorreo(crudo);
  } catch (e) {
    if (e instanceof CorreoNoAsciiError)
      throw new ErrorCli("correo inválido: solo se admiten caracteres ASCII");
    throw e;
  }
  if (correo.length > CORREO_MAX || !PATRON_CORREO.test(correo))
    throw new ErrorCli("correo inválido");
  return { correo };
}

/** Misma elección que el backend y el worker: `consola` (no en producción) o `smtp` con SMTP_URL y CORREO_REMITENTE. */
function correoDesdeEntorno(env: NodeJS.ProcessEnv): Correo {
  const limpio = (v: string | undefined) =>
    v === undefined || v.trim() === "" ? undefined : v.trim();
  const provider = (env.CORREO_PROVIDER ?? "consola").trim().toLowerCase();
  if (provider !== "consola" && provider !== "smtp")
    throw new ErrorCli("CORREO_PROVIDER no soportado");
  if (provider === "consola" && env.NODE_ENV === "production")
    throw new ErrorCli("CORREO_PROVIDER no soportado en producción");
  const config: ConfigCorreo = {
    provider,
    remitente: limpio(env.CORREO_REMITENTE),
    smtpUrl: limpio(env.SMTP_URL),
  };
  try {
    return crearCorreo(config);
  } catch {
    // Solo un mensaje fijo: el error del transporte puede traer SMTP_URL.
    throw new ErrorCli("configuración de correo inválida");
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: DependenciasRestablecer = {},
): Promise<void> {
  const { correo } = parsearArgumentos(argv); // antes de abrir la conexión
  const salida = deps.correo ?? correoDesdeEntorno(env); // falla antes de cambiar nada
  const client = new Client({ connectionString: urlMigraciones() });
  await client.connect();
  let afectado: { correo: string; nombre: string | null } | undefined;
  try {
    const r = await client.query<{ correo: string; nombre: string | null }>(
      "select correo, nombre from auth.totp_restablecer($1)",
      [correo],
    );
    afectado = r.rows[0];
  } finally {
    await client.end();
  }
  if (afectado !== undefined) {
    const aviso = avisoSeguridad("totp_restablecido", {
      nombre: afectado.nombre,
      ocurridoEn: new Date(),
    });
    try {
      await salida.enviar({
        para: afectado.correo,
        asunto: aviso.asunto,
        texto: aviso.texto,
      });
    } catch {
      // El restablecimiento ya está hecho; el detalle del transporte no se muestra.
      throw new ErrorCli(
        "restablecimiento aplicado, pero no se pudo enviar el aviso",
      );
    }
  }
  console.log("solicitud procesada");
}

ejecutarSiDirecta(require.main, module, "totp-restablecer", () => main());
