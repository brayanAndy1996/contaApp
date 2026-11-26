import { Inject, Injectable } from "@nestjs/common";
import { avisoSeguridad, type TipoAvisoSeguridad } from "@contapp/correo";
import {
  confirmarTotpSchema,
  desactivarTotpSchema,
  enrolarTotpSchema,
  regenerarRecuperacionSchema,
  verificarSegundoFactorSchema,
} from "@contapp/shared";
import type { SesionEmitida, TotpFila } from "@contapp/db";
import {
  AuthService,
  maxAgeSesion,
  parsear,
  VIDA_SESION_S,
  type ConCookie,
  type DbAuth,
  type Encolador,
  type Estudio,
  type Origen,
  type RespuestaLogin,
  type SesionResuelta,
} from "../auth.service.js";
import { AuthError } from "../errores.js";
import { COLA_CORREO, DB, TOTP_CLAVES } from "../inyeccion.js";
import { construirCookie } from "../sesion/cookie.js";
import { generarToken, hashToken } from "../sesion/token.js";
import { cifrarSecreto, descifrarSecreto, type ClaveTotp } from "./cifrado.js";
import { generarCodigosRecuperacion, hashCodigoRecuperacion } from "./recuperacion.js";
import { generarSecretoTotp, uriOtpauth, verificarTotp } from "./rfc6238.js";

/** `TOTP_CLAVE` y, durante una rotación, `TOTP_CLAVE_ANTERIOR` (solo descifra y prueba códigos de recuperación viejos). */
export interface ClavesTotp {
  actual: ClaveTotp;
  anterior?: ClaveTotp;
}

/**
 * Casos de uso del segundo factor (spec 029, plan: Contratos HTTP y Decisiones). El secreto se cifra y se evalúa aquí (D1); la BD solo
 * guarda el cifrado, compara pasos y lleva el contador. Cada código se reserva en el contador de 004 D7 ANTES de evaluarse
 * (`totp_intento_reservar`, CA-3) y solo el fallido queda contado (`intento_acierto`). Nunca se registra ni se devuelve el secreto, el URI
 * (salvo en la respuesta de enrolar) ni los códigos (salvo al generarlos).
 */
@Injectable()
export class TotpService {
  constructor(
    @Inject(DB) private readonly db: DbAuth,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(COLA_CORREO) private readonly cola: Encolador,
    @Inject(TOTP_CLAVES) private readonly claves: ClavesTotp,
  ) {}

  /**
   * POST /auth/2fa/verificar (solo la sesión `pendiente`). Reserva el intento, evalúa el código TOTP (±1 paso, sin replay) o el de
   * recuperación (un uso) y rota a una sesión `verificado` de 12 h con el estudio como el login de 004.
   */
  async verificar(s: SesionResuelta, cuerpo: unknown, origen: Origen): Promise<ConCookie<RespuestaLogin>> {
    if (s.factor !== "pendiente") throw new AuthError("sesion_invalida");
    const entrada = parsear(verificarSegundoFactorSchema, cuerpo);
    const tokenHash = hashToken(s.token);
    await this.reservar(tokenHash);

    const estudios = await this.auth.estudiosDisponibles(s.usuarioId);
    const unico = estudios.length === 1 ? (estudios[0] as Estudio) : null;
    const token = generarToken();
    const tokenHashNuevo = hashToken(token);

    let usar: (tenantNuevo: string | null) => Promise<SesionEmitida | null>;
    let recuperacion = false;
    if ("codigo" in entrada) {
      const fila = await this.db.withAuth((_a, c) => c.totp.leer(s.usuarioId));
      const paso = this.evaluar(fila, "activo", s.usuarioId, entrada.codigo);
      usar = (tenantNuevo) =>
        this.db.withAuth((_a, c) => c.totp.verificarExito({ tokenHash, paso, tokenHashNuevo, tenantNuevo }));
    } else {
      recuperacion = true;
      const hashes = this.clavesVigentes().map((k) => hashCodigoRecuperacion(entrada.codigoRecuperacion, k));
      usar = async (tenantNuevo) => {
        for (const hash of hashes) {
          const e = await this.db.withAuth((_a, c) =>
            c.totp.recuperacionUsar({ tokenHash, hash, tokenHashNuevo, tenantNuevo }),
          );
          if (e !== null) return e;
        }
        return null;
      };
    }

    let activo = unico;
    let emitida = await usar(activo?.id ?? null);
    if (emitida === null && activo !== null) {
      // La membresía desapareció entre la lista y la sesión: se entra sin estudio (como en el login).
      activo = null;
      emitida = await usar(null);
    }
    if (emitida === null) throw new AuthError("codigo_invalido");
    if (recuperacion) this.avisar(s.usuarioId, "recuperacion_usada", origen);
    return {
      respuesta: { estudioActivo: activo, requiereEstudio: estudios.length > 1 },
      cookie: construirCookie(token, maxAgeSesion(emitida.expiraAbsoluta, VIDA_SESION_S)),
    };
  }

  /** POST /auth/totp/enrolar: con la contraseña actual, un secreto nuevo pendiente (10 min). Con el TOTP ya activo, 409 `totp_activo`. */
  async enrolar(s: SesionResuelta, cuerpo: unknown): Promise<{ uri: string }> {
    const { contrasena } = parsear(enrolarTotpSchema, cuerpo);
    const fila = await this.db.withAuth((_a, c) => c.totp.leer(s.usuarioId));
    if (fila?.activoCifrado != null) throw new AuthError("totp_activo");
    if (!(await this.auth.contrasenaCorrecta(s, contrasena))) throw new AuthError("credenciales_invalidas");
    const secreto = generarSecretoTotp();
    try {
      const { cifrado, version } = cifrarSecreto({ secreto, usuarioId: s.usuarioId, clave: this.claves.actual });
      await this.db.withAuth((_a, c) => c.totp.enrolarIniciar(s.usuarioId, cifrado, version));
      const { correo } = await this.auth.titular(s.usuarioId);
      return { uri: uriOtpauth({ secreto, correo }) };
    } finally {
      secreto.fill(0);
    }
  }

  /**
   * POST /auth/totp/confirmar: el primer código del pendiente activa el factor, emite 10 códigos de recuperación, revoca las demás
   * sesiones y rota la actual a `verificado` (U3, U4).
   */
  async confirmar(s: SesionResuelta, cuerpo: unknown, origen: Origen): Promise<ConCookie<{ codigosRecuperacion: string[] }>> {
    const { codigo } = parsear(confirmarTotpSchema, cuerpo);
    const tokenHash = hashToken(s.token);
    await this.reservar(tokenHash);
    const fila = await this.db.withAuth((_a, c) => c.totp.leer(s.usuarioId));
    const paso = this.evaluar(fila, "pendiente", s.usuarioId, codigo);
    const codigos = generarCodigosRecuperacion();
    const hashes = codigos.map((x) => hashCodigoRecuperacion(x, this.claves.actual));
    const token = generarToken();
    const tokenHashNuevo = hashToken(token);
    // `evaluar` ya comprobó que hay pendiente: se confirma ese mismo (CA-1), no uno que otra pestaña enroló después.
    const pendienteCifrado = fila!.pendienteCifrado!;
    const emitida = await this.db.withAuth((_a, c) =>
      c.totp.confirmar({ tokenHash, paso, hashes, tokenHashNuevo, pendienteCifrado }),
    );
    if (emitida === null) throw new AuthError("codigo_invalido");
    await this.db.withAuth((_a, c) => c.totp.intentoAcierto(tokenHashNuevo));
    this.avisar(s.usuarioId, "totp_activado", origen);
    return {
      respuesta: { codigosRecuperacion: codigos },
      cookie: construirCookie(token, maxAgeSesion(emitida.expiraAbsoluta, VIDA_SESION_S)),
    };
  }

  /** POST /auth/totp/desactivar (sesión `verificado`): contraseña y código; 409 `totp_exigido` si algún rol vigente lo exige (U1–U2). */
  async desactivar(s: SesionResuelta, cuerpo: unknown, origen: Origen): Promise<void> {
    const { contrasena, codigo } = parsear(desactivarTotpSchema, cuerpo);
    const tokenHash = hashToken(s.token);
    const paso = await this.contrasenaYCodigo(s, contrasena, codigo);
    const r = await this.db.withAuth((_a, c) => c.totp.desactivar(tokenHash, paso));
    if (r === "invalido") throw new AuthError("codigo_invalido");
    await this.db.withAuth((_a, c) => c.totp.intentoAcierto(tokenHash));
    if (r === "exigido") throw new AuthError("totp_exigido");
    this.avisar(s.usuarioId, "totp_desactivado", origen);
  }

  /** POST /auth/totp/recuperacion (sesión `verificado`): contraseña y código; 10 códigos nuevos, los anteriores dejan de valer (U4). */
  async regenerar(s: SesionResuelta, cuerpo: unknown): Promise<{ codigosRecuperacion: string[] }> {
    const { contrasena, codigo } = parsear(regenerarRecuperacionSchema, cuerpo);
    const tokenHash = hashToken(s.token);
    const paso = await this.contrasenaYCodigo(s, contrasena, codigo);
    const codigos = generarCodigosRecuperacion();
    const hashes = codigos.map((x) => hashCodigoRecuperacion(x, this.claves.actual));
    const ok = await this.db.withAuth((_a, c) => c.totp.recuperacionRegenerar(tokenHash, paso, hashes));
    if (!ok) throw new AuthError("codigo_invalido");
    await this.db.withAuth((_a, c) => c.totp.intentoAcierto(tokenHash));
    return { codigosRecuperacion: codigos };
  }

  /** Desactivar y regenerar: sesión `verificado`, la contraseña (contador de 004) y luego el código (reservado antes de evaluarse). */
  private async contrasenaYCodigo(s: SesionResuelta, contrasena: string, codigo: string): Promise<bigint> {
    if (s.factor !== "verificado") throw new AuthError("segundo_factor_requerido");
    if (!(await this.auth.contrasenaCorrecta(s, contrasena))) throw new AuthError("credenciales_invalidas");
    await this.reservar(hashToken(s.token));
    const fila = await this.db.withAuth((_a, c) => c.totp.leer(s.usuarioId));
    return this.evaluar(fila, "activo", s.usuarioId, codigo);
  }

  /** CA-3: reserva el intento antes de evaluar. Sesión que no sirve: 401; cuenta bloqueada: 429 `demasiados_intentos`. */
  private async reservar(tokenHash: Buffer): Promise<void> {
    const r = await this.db.withAuth((_a, c) => c.totp.intentoReservar(tokenHash));
    if (r === null) throw new AuthError("sesion_invalida");
    if (!r.permitido) throw new AuthError("demasiados_intentos");
  }

  /**
   * Descifra el secreto (activo o pendiente vigente) y evalúa el código en ±1 paso sin repetir uno ya usado (D3). Cualquier fallo
   * (sin secreto, vencido, clave desconocida, código erróneo) es el mismo 401 `codigo_invalido`. El secreto se borra de la memoria.
   */
  private evaluar(fila: TotpFila | null, cual: "activo" | "pendiente", usuarioId: string, codigo: string): bigint {
    const cifrado = cual === "activo" ? fila?.activoCifrado : fila?.pendienteCifrado;
    const version = cual === "activo" ? fila?.activoVersion : fila?.pendienteVersion;
    if (fila == null || cifrado == null || version == null) throw new AuthError("codigo_invalido");
    if (cual === "pendiente" && (fila.pendienteExpira === null || fila.pendienteExpira.getTime() <= Date.now())) {
      throw new AuthError("codigo_invalido");
    }
    let secreto: Buffer;
    try {
      secreto = descifrarSecreto({ cifrado, version, usuarioId, claves: this.clavesVigentes() });
    } catch {
      throw new AuthError("codigo_invalido");
    }
    try {
      const paso = verificarTotp({ secreto, codigo, ahoraMs: Date.now(), ultimoPaso: Number(fila.ultimoPaso) });
      if (paso === null) throw new AuthError("codigo_invalido");
      return BigInt(paso);
    } finally {
      secreto.fill(0);
    }
  }

  private clavesVigentes(): ClaveTotp[] {
    return this.claves.anterior === undefined ? [this.claves.actual] : [this.claves.actual, this.claves.anterior];
  }

  /** U8: aviso por la cola (fuera de la petición, de mejor esfuerzo; un fallo del correo no afecta la operación). */
  private avisar(usuarioId: string, tipo: TipoAvisoSeguridad, origen: Origen): void {
    void this.auth
      .titular(usuarioId)
      .then(({ correo, nombre }) => {
        const { asunto, texto } = avisoSeguridad(tipo, {
          nombre,
          ocurridoEn: new Date(),
          dispositivo: origen.dispositivo,
          ip: origen.ipRed,
        });
        this.cola.encolar({ para: correo, asunto, texto });
      })
      .catch(() => undefined);
  }
}
