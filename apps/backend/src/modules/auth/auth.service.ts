import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { schema, type ContappDb, type SesionValida } from "@contapp/db";
import {
  CONTRASENA_MAX_PUNTOS,
  cambiarContrasenaSchema,
  cambiarEstudioSchema,
  loginSchema,
  normalizarCorreo,
} from "@contapp/shared";
import type { MensajeCorreo } from "../../infra/correo/correo.js";
import type { Hasher } from "./contrasena/hasher.js";
import { validarContrasena } from "./contrasena/politica.js";
import { AuthError, ContrasenaInvalidaError } from "./errores.js";
import { COLA_CORREO, COMUNES, DB, HASHER } from "./inyeccion.js";
import { sujetoIp } from "./limites/ip.js";
import { mensajeBloqueo, mensajeContrasenaCambiada } from "./mensajes.js";
import { construirCookie, cookieBorrada, leerTokenDeCookie } from "./sesion/cookie.js";
import { derivarCsrf } from "./sesion/csrf.js";
import { generarToken, hashToken } from "./sesion/token.js";

/** Lo que `auth` usa de `ContappDb`: `withAuth` (funciones `auth.*`) y `withUsuario` (RLS, P7). */
export type DbAuth = Pick<ContappDb, "withAuth" | "withUsuario">;
/** Lo que `auth` usa de `ColaCorreo`: encolar sin esperar (D8). */
export interface Encolador {
  encolar(m: MensajeCorreo): void;
}

/** Sesión válida de la petición. Lleva el token en claro: nunca se registra ni se devuelve. */
export interface SesionResuelta extends SesionValida {
  token: string;
}
export interface Estudio {
  id: string;
  nombre: string;
}
export interface RespuestaLogin {
  estudioActivo: Estudio | null;
  requiereEstudio: boolean;
}
export interface EstadoSesion {
  usuario: { id: string; nombre: string; correo: string };
  estudioActivo: Estudio | null;
  csrf: string;
}
/** Respuesta más el valor de `Set-Cookie` que el controlador debe emitir. */
export interface ConCookie<T> {
  respuesta: T;
  cookie: string;
}

interface Esquema<T> {
  safeParse(valor: unknown): { success: boolean; data?: T };
}

/** zod -> 400 `solicitud_invalida` sin eco de la entrada. */
export function parsear<T>(esquema: Esquema<T>, cuerpo: unknown): T {
  const r = esquema.safeParse(cuerpo);
  if (!r.success) throw new AuthError("solicitud_invalida");
  return r.data as T;
}

/** D7: clave del contador de intentos = SHA-256 del correo ya normalizado. */
export function claveCorreo(correoNormalizado: string): Buffer {
  return createHash("sha256").update(correoNormalizado, "utf8").digest();
}

/** Más de 128 puntos de código (más de 256 unidades UTF-16 ya lo implica): no llega a Argon2. */
export function excedeMaximo(plano: string): boolean {
  return plano.length > CONTRASENA_MAX_PUNTOS * 2 || [...plano].length > CONTRASENA_MAX_PUNTOS;
}

/** Segundos de caducidad absoluta restantes (Max-Age de la cookie, D5). */
export function segundosRestantes(expira: Date, ahora = Date.now()): number {
  return Math.max(0, Math.floor((expira.getTime() - ahora) / 1000));
}

interface Credencial {
  clave: Buffer;
  usuarioId: string;
  hash: string;
}

/**
 * Núcleo de autenticación (spec 004): login con una sola verificación Argon2id por intento,
 * sesión por cookie, cambio de estudio, logout, cerrar todas y cambio de contraseña. Sin SQL: todo
 * pasa por `AuthRepo` (`withAuth`) y por `withUsuario` (RLS) para los datos de usuario y estudios.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: DbAuth,
    @Inject(HASHER) private readonly hasher: Hasher,
    @Inject(COLA_CORREO) private readonly cola: Encolador,
    @Inject(COMUNES) private readonly comunes: ReadonlySet<string>,
  ) {}

  /** POST /auth/login. Límite por IP -> zod -> verificación única -> sesión nueva (CA-1, CA-2, CA-5). */
  async login(cuerpo: unknown, ip: string | undefined, cabeceraCookie?: string): Promise<ConCookie<RespuestaLogin>> {
    const permitido = await this.db.withAuth((a) => a.limiteConsumir("login_ip", sujetoIp(ip ?? "")));
    if (!permitido) throw new AuthError("demasiados_intentos");
    const entrada = parsear(loginSchema, cuerpo);
    const correo = normalizarCorreo(entrada.correo);

    const cred = await this.verificarCredencial(correo, entrada.contrasena);
    // CA-2: inexistente, contraseña errónea, bloqueada o demasiado larga salen por esta misma línea.
    if (cred === null) throw new AuthError("credenciales_invalidas");

    const estudios = await this.estudiosDe(cred.usuarioId);
    let activo = estudios.length === 1 ? (estudios[0] as Estudio) : null;
    const hashNuevo = this.hasher.necesitaRehash(cred.hash) ? await this.hasher.calcular(entrada.contrasena) : null;
    const anterior = leerTokenDeCookie(cabeceraCookie);
    const token = generarToken();
    const args = {
      clave: cred.clave,
      usuarioId: cred.usuarioId,
      tokenHash: hashToken(token),
      tenantActivo: activo?.id ?? null,
      hashNuevo,
      tokenAnteriorHash: anterior === null ? null : hashToken(anterior),
    };
    let emitida = await this.db.withAuth((a) => a.loginExito(args));
    if (emitida === null && activo !== null) {
      // La membresía desapareció entre la lista y la sesión: se entra sin estudio.
      activo = null;
      emitida = await this.db.withAuth((a) => a.loginExito({ ...args, tenantActivo: null }));
    }
    if (emitida === null) throw new AuthError("credenciales_invalidas");
    return {
      respuesta: { estudioActivo: activo, requiereEstudio: estudios.length > 1 },
      cookie: construirCookie(token, segundosRestantes(emitida.expiraAbsoluta)),
    };
  }

  /** Para `SesionGuard`: cookie -> sesión válida o null (formato inválido: sin consultar la BD). */
  async resolverSesion(cabeceraCookie: string | undefined): Promise<SesionResuelta | null> {
    const token = leerTokenDeCookie(cabeceraCookie);
    if (token === null) return null;
    const valida = await this.db.withAuth((a) => a.sesionValidar(hashToken(token)));
    return valida === null ? null : { ...valida, token };
  }

  /** GET /auth/sesion: usuario, estudio activo y el token CSRF derivado (D6). */
  async estadoSesion(s: SesionResuelta): Promise<EstadoSesion> {
    const { usuarios, estudios } = await this.db.withUsuario({ userId: s.usuarioId }, async (tx) => ({
      usuarios: await tx.orm
        .select({ id: schema.usuario.id, nombre: schema.usuario.nombre, correo: schema.usuario.email })
        .from(schema.usuario),
      estudios: await tx.orm.select({ id: schema.tenant.id, nombre: schema.tenant.nombre }).from(schema.tenant),
    }));
    const u = usuarios.find((x) => x.id === s.usuarioId);
    if (u === undefined) throw new AuthError("sesion_invalida");
    const activo = estudios.find((e) => e.id === s.tenantActivo);
    return {
      usuario: { id: u.id, nombre: u.nombre, correo: u.correo },
      estudioActivo: activo === undefined ? null : { id: activo.id, nombre: activo.nombre },
      csrf: derivarCsrf(s.token),
    };
  }

  /** GET /auth/estudios: membresías propias (withUsuario) con el último usado marcado. */
  async listarEstudios(s: SesionResuelta): Promise<(Estudio & { ultimoUsado: boolean })[]> {
    const ultimo = await this.db.withAuth((a) => a.ultimoEstudio(hashToken(s.token)));
    const estudios = await this.estudiosDe(s.usuarioId);
    return estudios.map((e) => ({ ...e, ultimoUsado: e.id === ultimo }));
  }

  /** POST /auth/estudio: comprueba la membresía con withUsuario y rota el token (D4, D12, CA-9). */
  async cambiarEstudio(s: SesionResuelta, cuerpo: unknown): Promise<ConCookie<{ estudioActivo: Estudio }>> {
    const { tenantId } = parsear(cambiarEstudioSchema, cuerpo);
    const estudio = (await this.estudiosDe(s.usuarioId)).find((e) => e.id === tenantId);
    if (estudio === undefined) throw new AuthError("estudio_no_disponible");
    const token = generarToken();
    const emitida = await this.db.withAuth((a) => a.sesionRotar(hashToken(s.token), hashToken(token), tenantId));
    if (emitida === null) throw new AuthError("estudio_no_disponible");
    return {
      respuesta: { estudioActivo: estudio },
      cookie: construirCookie(token, segundosRestantes(emitida.expiraAbsoluta)),
    };
  }

  /** POST /auth/logout: revoca la sesión si la hay; siempre borra la cookie. */
  async logout(s: SesionResuelta | null): Promise<string> {
    if (s !== null) await this.db.withAuth((a) => a.sesionRevocar(hashToken(s.token)));
    return cookieBorrada();
  }

  /** POST /auth/sesiones/cerrar-todas (P2): revoca todas las sesiones del usuario de la sesión. */
  async cerrarTodas(s: SesionResuelta): Promise<string> {
    await this.db.withAuth((a) => a.sesionesCerrarTodas(hashToken(s.token)));
    return cookieBorrada();
  }

  /**
   * POST /auth/contrasena (P11): política (P5) -> contraseña actual verificada con el mismo contador
   * de intentos del login -> hash -> rota la sesión actual y revoca las demás -> aviso (P9).
   * Devuelve la cookie rotada.
   */
  async cambiarContrasena(s: SesionResuelta, cuerpo: unknown): Promise<string> {
    const { actual, nueva } = parsear(cambiarContrasenaSchema, cuerpo);
    const motivo = validarContrasena(nueva, this.comunes);
    if (motivo !== null) throw new ContrasenaInvalidaError(motivo);

    const correo = await this.correoDe(s.usuarioId);
    const cred = await this.verificarCredencial(correo, actual);
    if (cred === null || cred.usuarioId !== s.usuarioId) throw new AuthError("credenciales_invalidas");

    const hashNuevo = await this.hasher.calcular(nueva);
    const token = generarToken();
    const avisar = await this.db.withAuth((a) => a.contrasenaCambiar(hashToken(s.token), hashNuevo, hashToken(token)));
    if (avisar === null) throw new AuthError("sesion_invalida");
    this.cola.encolar(mensajeContrasenaCambiada(avisar));
    return construirCookie(token, segundosRestantes(s.expiraAbsoluta));
  }

  /**
   * D9 / CA-2 / CA-3: reserva el intento de forma atómica (`login_preparar`) y hace UNA verificación,
   * contra el hash real si es utilizable o contra el ficticio si no (inexistente, bloqueada, sin
   * credencial). Una contraseña de más de 128 puntos no se verifica ni cuenta. El aviso de bloqueo
   * (P3) sale por la cola solo si esta reserva bloqueó una cuenta existente y la verificación falló.
   */
  private async verificarCredencial(correo: string, plano: string): Promise<Credencial | null> {
    if (excedeMaximo(plano)) return null;
    const clave = claveCorreo(correo);
    const prep = await this.db.withAuth((a) => a.loginPreparar(correo, clave));
    const usuarioId = prep.permitido ? prep.usuarioId : null;
    const hash = usuarioId === null ? null : prep.hash;
    const ok = await this.verificar(hash ?? this.hasher.hashFicticio, plano);
    if (ok && usuarioId !== null && hash !== null) return { clave, usuarioId, hash };
    if (prep.alcanzaBloqueo && prep.usuarioId !== null) this.cola.encolar(mensajeBloqueo(correo));
    return null;
  }

  /** Un fallo del hasher cuenta como contraseña errónea (sin propagar su mensaje, CA-10). */
  private async verificar(phc: string, plano: string): Promise<boolean> {
    try {
      return await this.hasher.verificar(phc, plano);
    } catch {
      return false;
    }
  }

  /** Estudios con membresía del usuario: la RLS de `tenant` en withUsuario solo deja ver esos (P7). */
  private async estudiosDe(userId: string): Promise<Estudio[]> {
    const filas = await this.db.withUsuario({ userId }, (tx) =>
      tx.orm.select({ id: schema.tenant.id, nombre: schema.tenant.nombre }).from(schema.tenant),
    );
    return filas
      .map((f) => ({ id: f.id, nombre: f.nombre }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre) || a.id.localeCompare(b.id));
  }

  /** Correo del usuario de la sesión (withUsuario: la RLS solo deja ver la propia fila). */
  private async correoDe(userId: string): Promise<string> {
    const filas = await this.db.withUsuario({ userId }, (tx) =>
      tx.orm.select({ id: schema.usuario.id, correo: schema.usuario.email }).from(schema.usuario),
    );
    const fila = filas.find((f) => f.id === userId);
    if (fila === undefined) throw new AuthError("sesion_invalida");
    return fila.correo;
  }
}
