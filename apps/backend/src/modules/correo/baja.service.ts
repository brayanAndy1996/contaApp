import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { bajaSchema } from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import { AuthError } from "../auth/errores.js";
import { DB } from "../auth/inyeccion.js";
import type { DbAuth } from "../auth/auth.service.js";
import { sujetoIpValidado } from "../auth/limites/ip.js";
import { hashToken, tokenConFormatoValido } from "../auth/sesion/token.js";

/** Cuerpo exacto de RFC 8058 (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`). */
const CUERPO_UN_CLIC = "List-Unsubscribe=One-Click";

/**
 * Baja por enlace (spec 028; R-7, D-4, U-12, U-18; CA-8). Sin sesión ni estudio: el token (43 caracteres base64url, SHA-256 del texto) es la
 * credencial y `AuthRepo.aplicarBaja` (`auth.correo_baja_aplicar`, de un solo uso: H-028-1-5) la única vía. La respuesta es la misma con un
 * token válido o no. Límites (H-028-1-6): uno alto por IP solo contra abuso masivo (`correo_baja_ip`, 500 cada 10 min: el POST de RFC 8058
 * lo hace el servidor del proveedor para todos sus usuarios) y otro por token (`correo_baja_token`, 10 cada 10 min, desde cualquier IP; el
 * sujeto es un SHA-256 con prefijo del token, nunca el token). Nunca registra el token, su hash, la consulta ni el cuerpo.
 */
@Injectable()
export class BajaService {
  constructor(@Inject(DB) private readonly db: Pick<DbAuth, "withAuth">) {}

  /** `POST /correo/baja` con `{token}` (botón de `/baja`): límite por IP -> `bajaSchema` (400) -> límite del token -> baja. */
  async confirmar(cuerpo: unknown, ip: string | undefined): Promise<Record<string, never>> {
    await this.limitar(ip);
    const r = bajaSchema.safeParse(cuerpo);
    if (!r.success) throw new AccesoError("solicitud_invalida");
    await this.limitarToken(r.data.token);
    await this.aplicar(r.data.token);
    return {};
  }

  /**
   * `POST /correo/baja?t=` (RFC 8058, cliente de correo): límite por IP -> solo con el cuerpo exacto y un token con forma de token se
   * cuenta en el límite del token (el mismo contador que la página) y se aplica; todo lo demás es 200 sin efectos (el cliente de correo no
   * debe ver un error).
   */
  async unClic(token: unknown, cuerpo: unknown, ip: string | undefined): Promise<Record<string, never>> {
    await this.limitar(ip);
    const exacto = Buffer.isBuffer(cuerpo) && cuerpo.toString("latin1") === CUERPO_UN_CLIC;
    if (exacto && tokenConFormatoValido(token)) {
      await this.limitarToken(token);
      await this.aplicar(token);
    }
    return {};
  }

  private async limitar(ip: string | undefined): Promise<void> {
    const permitido = await this.db.withAuth((a) => a.limiteConsumir("correo_baja_ip", sujetoIpValidado(ip)));
    if (!permitido) throw new AuthError("demasiados_intentos");
  }

  private async limitarToken(token: string): Promise<void> {
    const sujeto = createHash("sha256").update(`correo_baja:${token}`, "utf8").digest("hex");
    const permitido = await this.db.withAuth((a) => a.limiteConsumir("correo_baja_token", sujeto));
    if (!permitido) throw new AuthError("demasiados_intentos");
  }

  private async aplicar(token: string): Promise<void> {
    const hashHex = hashToken(token).toString("hex");
    await this.db.withAuth((a) => a.aplicarBaja(hashHex));
  }
}
