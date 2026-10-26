import { Inject, Injectable } from "@nestjs/common";
import { normalizarCorreo, recuperarSchema, restablecerSchema } from "@contapp/shared";
import { claveCorreo, parsear, type DbAuth, type Encolador } from "./auth.service.js";
import type { Hasher } from "./contrasena/hasher.js";
import { validarContrasena } from "./contrasena/politica.js";
import { AuthError, ContrasenaInvalidaError } from "./errores.js";
import { APP_ORIGIN, COLA_CORREO, COMUNES, DB, HASHER } from "./inyeccion.js";
import { sujetoIp } from "./limites/ip.js";
import { mensajeContrasenaCambiada, mensajeRecuperacion } from "./mensajes.js";
import { generarToken, hashToken, tokenConFormatoValido } from "./sesion/token.js";

/** Forma mínima de un correo (sin espacios, una arroba con texto a ambos lados). */
const FORMA_CORREO = /^[^\s@]+@[^\s@]+$/;

/**
 * Recuperación de contraseña (D8, CA-8, P9): token de un solo uso de 30 min que solo viaja por correo
 * y se guarda como SHA-256; la respuesta de la solicitud no depende de que el correo exista.
 */
@Injectable()
export class RecuperacionService {
  constructor(
    @Inject(DB) private readonly db: DbAuth,
    @Inject(HASHER) private readonly hasher: Hasher,
    @Inject(COLA_CORREO) private readonly cola: Encolador,
    @Inject(COMUNES) private readonly comunes: ReadonlySet<string>,
    @Inject(APP_ORIGIN) private readonly appOrigin: string,
  ) {}

  /**
   * POST /auth/recuperar: límite por IP -> zod -> límite por correo (429 igual exista o no) -> token
   * -> `recuperacion_crear` -> correo por la cola solo si el correo existe. Siempre `{ ok: true }`.
   */
  async solicitar(cuerpo: unknown, ip: string | undefined): Promise<{ ok: true }> {
    const porIp = await this.db.withAuth((a) => a.limiteConsumir("recup_ip", sujetoIp(ip ?? "")));
    if (!porIp) throw new AuthError("demasiados_intentos");
    const correo = normalizarCorreo(parsear(recuperarSchema, cuerpo).correo);
    if (!FORMA_CORREO.test(correo)) throw new AuthError("solicitud_invalida");
    const sujeto = claveCorreo(correo).toString("hex");
    const porCorreo = await this.db.withAuth((a) => a.limiteConsumir("recup_correo", sujeto));
    if (!porCorreo) throw new AuthError("demasiados_intentos");

    const token = generarToken();
    const creado = await this.db.withAuth((a) => a.recuperacionCrear(correo, hashToken(token)));
    if (creado) this.cola.encolar(mensajeRecuperacion(correo, this.appOrigin, token));
    return { ok: true };
  }

  /**
   * POST /auth/recuperar/restablecer: política (P5) antes de tocar el token; token mal formado ->
   * `token_invalido` sin consultar; consumo atómico; aviso al titular (P9).
   */
  async restablecer(cuerpo: unknown): Promise<void> {
    const { token, contrasena } = parsear(restablecerSchema, cuerpo);
    const motivo = validarContrasena(contrasena, this.comunes);
    if (motivo !== null) throw new ContrasenaInvalidaError(motivo);
    if (!tokenConFormatoValido(token)) throw new AuthError("token_invalido");

    const hash = await this.hasher.calcular(contrasena);
    const consumido = await this.db.withAuth((a) => a.recuperacionConsumir(hashToken(token), hash));
    if (consumido === null) throw new AuthError("token_invalido");
    this.cola.encolar(mensajeContrasenaCambiada(consumido.correo));
  }
}
