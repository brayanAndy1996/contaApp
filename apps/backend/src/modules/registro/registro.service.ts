import { Inject, Injectable } from "@nestjs/common";
import {
  AuthRepoError,
  type ConfirmacionNueva,
  type RegistroVigente,
} from "@contapp/db";
import {
  registroConfirmarConSesionSchema,
  registroConfirmarSchema,
  registroConsultarSchema,
  registroSolicitudSchema,
} from "@contapp/shared";
import { nombreValido } from "../acceso/invitaciones.service.js";
import { AccesoError } from "../acceso/errores.js";
import {
  claveCorreo,
  correoDeEntrada,
  type DbAuth,
  type Encolador,
  type SesionResuelta,
} from "../auth/auth.service.js";
import type { Hasher } from "../auth/contrasena/hasher.js";
import { validarContrasena } from "../auth/contrasena/politica.js";
import { AuthError, ContrasenaInvalidaError } from "../auth/errores.js";
import {
  APP_ORIGIN,
  COLA_CORREO,
  COMUNES,
  DB,
  HASHER,
} from "../auth/inyeccion.js";
import { sujetoIp } from "../auth/limites/ip.js";
import {
  generarToken,
  hashToken,
  tokenConFormatoValido,
} from "../auth/sesion/token.js";
import { RegistroError } from "./errores.js";
import { mensajeRegistro } from "./mensajes.js";

/** Forma mínima de un correo, sin caracteres de control (como en invitaciones, H-005-1b-2). */
const FORMA_CORREO = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+$/u;
/** Control y formato (ancho cero, bidi, BOM): ni en el nombre del estudio ni en el del titular. */
const CONTROL_O_FORMATO = /[\p{Cc}\p{Cf}]/u;
/** RFC 5321: la parte local de un correo tiene como máximo 64 octetos (el correo entero, 320). */
const LOCAL_MAX = 64;
const ESTUDIO_MIN = 2;
const ESTUDIO_MAX = 200;

export interface RegistroConsultado {
  estudio: { nombre: string };
  correo: string;
  cuentaExiste: boolean;
}
export interface RegistroConfirmadoConSesion {
  estudio: { id: string; nombre: string };
}

/** `registro_confirmar_nueva` -> error (null = creado). `cuenta_existe` no consume (D3). */
const TRAS_CONFIRMAR: Record<ConfirmacionNueva, (() => Error) | null> = {
  creado: null,
  cuenta_existe: () => new AccesoError("requiere_sesion"),
  invalida: () => new RegistroError("registro_invalido"),
  sin_plan: () => new RegistroError("registro_no_disponible"),
};

/**
 * Registro público de estudio (D3, CA-3, CA-4). Solo el SHA-256 del token va a la BD y nada de lo que se
 * responde lo lleva. El estudio se crea al confirmar, nunca al solicitar. Toda respuesta de enlace no vivo es
 * la misma (`registro_invalido`) y no calcula Argon2.
 */
@Injectable()
export class RegistroService {
  constructor(
    @Inject(DB) private readonly db: DbAuth,
    @Inject(HASHER) private readonly hasher: Hasher,
    @Inject(COLA_CORREO) private readonly cola: Encolador,
    @Inject(COMUNES) private readonly comunes: ReadonlySet<string>,
    @Inject(APP_ORIGIN) private readonly appOrigin: string,
  ) {}

  /**
   * Límite por IP -> zod -> datos -> límite por correo (429 igual exista o no la cuenta) -> token ->
   * `registro_crear` (mismo trabajo exista o no la cuenta) -> correo por la cola tras el commit. Siempre
   * `{ ok: true }`.
   */
  async solicitar(cuerpo: unknown, ip: string | undefined): Promise<{ ok: true }> {
    const porIp = await this.db.withAuth((a) =>
      a.limiteConsumir("registro_ip", sujetoIp(ip ?? "")),
    );
    if (!porIp) throw new AuthError("demasiados_intentos");
    const r = registroSolicitudSchema.safeParse(cuerpo);
    if (!r.success) throw new AccesoError("solicitud_invalida");
    const entrada = r.data;
    const correo = correoDeEntrada(entrada.correo);
    const estudio = entrada.estudio.trim();
    const nombre = entrada.nombre.trim();
    if (
      !FORMA_CORREO.test(correo) ||
      correo.indexOf("@") > LOCAL_MAX ||
      estudio.length < ESTUDIO_MIN ||
      estudio.length > ESTUDIO_MAX ||
      CONTROL_O_FORMATO.test(estudio) ||
      !nombreValido(nombre)
    )
      throw new AccesoError("solicitud_invalida");

    const sujeto = claveCorreo(correo).toString("hex");
    const porCorreo = await this.db.withAuth((a) =>
      a.limiteConsumir("registro_correo", sujeto),
    );
    if (!porCorreo) throw new AuthError("demasiados_intentos");

    const token = generarToken();
    await this.db.withAuth((a) =>
      a.registroCrear({
        correo,
        estudio,
        ruc: entrada.ruc ?? null,
        nombre,
        tokenHash: hashToken(token),
      }),
    );
    this.cola.encolar(mensajeRegistro(correo, this.appOrigin, token));
    return { ok: true };
  }

  /** Público y sin efectos. El estudio sale solo por nombre: nunca su ID. */
  async consultar(cuerpo: unknown): Promise<RegistroConsultado> {
    const r = registroConsultarSchema.safeParse(cuerpo);
    if (!r.success) throw new AccesoError("solicitud_invalida");
    const v = await this.vigente(r.data.token);
    return {
      estudio: { nombre: v.nombreEstudio },
      correo: v.correo,
      cuentaExiste: v.cuentaExiste,
    };
  }

  /**
   * zod -> política de 004 (antes de tocar el token) -> enlace vivo (si no, `registro_invalido` sin Argon2)
   * -> cuenta existente: 409 `requiere_sesion` sin consumir -> Argon2 -> `registro_confirmar_nueva` (todo o
   * nada en una transacción). Sin auto-login: no hay cookie.
   */
  async confirmar(cuerpo: unknown): Promise<void> {
    const r = registroConfirmarSchema.safeParse(cuerpo);
    if (!r.success) throw new AccesoError("solicitud_invalida");
    const { token, contrasena } = r.data;
    const motivo = validarContrasena(contrasena, this.comunes);
    if (motivo !== null) throw new ContrasenaInvalidaError(motivo);
    const v = await this.vigente(token);
    if (v.cuentaExiste) throw new AccesoError("requiere_sesion");

    const hash = await this.hasher.calcular(contrasena);
    const resultado = await this.db
      .withAuth((a) => a.registroConfirmarNueva(hashToken(token), hash))
      .catch((e: unknown): ConfirmacionNueva => {
        // Cuenta creada por otra vía entre la consulta y la confirmación (UNIQUE de `usuario.email`): gana una.
        if (e instanceof AuthRepoError && e.codigo === "23505") return "invalida";
        throw e;
      });
    const error = TRAS_CONFIRMAR[resultado];
    if (error !== null) throw error();
  }

  /**
   * El titular de la cuenta confirma con su sesión viva (mismo correo exacto): crea el estudio y su
   * membresía de Dueño sin tocar la contraseña. Otro correo, enlace sin cuenta o falso: `registro_invalido`.
   */
  async confirmarConSesion(
    s: SesionResuelta,
    cuerpo: unknown,
    xEstudio?: string,
  ): Promise<RegistroConfirmadoConSesion> {
    // Ruta sin estudio, pero un `X-Estudio` distinto del de la sesión no llega al negocio (HU-40).
    if (xEstudio !== undefined && xEstudio !== s.tenantActivo)
      throw new AuthError("estudio_desfasado");
    const r = registroConfirmarConSesionSchema.safeParse(cuerpo);
    if (!r.success) throw new AccesoError("solicitud_invalida");
    const { token } = r.data;
    if (!tokenConFormatoValido(token))
      throw new RegistroError("registro_invalido");
    const c = await this.db.withAuth((a) =>
      a.registroConfirmarExistente(hashToken(token), hashToken(s.token)),
    );
    if (c === null) throw new RegistroError("registro_invalido");
    return { estudio: { id: c.tenantId, nombre: c.estudioNombre } };
  }

  private async vigente(token: string): Promise<RegistroVigente> {
    if (!tokenConFormatoValido(token))
      throw new RegistroError("registro_invalido");
    const v = await this.db.withAuth((a) => a.registroVigente(hashToken(token)));
    if (v === null) throw new RegistroError("registro_invalido");
    return v;
  }
}
