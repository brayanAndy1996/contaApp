import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { miembroActual, schema, type ContappDb, type SesionValida } from "@contapp/db";
import {
  CONTRASENA_MAX_PUNTOS,
  cambiarContrasenaSchema,
  cambiarEstudioSchema,
  loginSchema,
  normalizarCorreo,
  type FactorSesion,
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
import { resumirDispositivo, truncarIp } from "./totp/dispositivo.js";
import { efectivoDe } from "../acceso/efectivo.js";
import { efectivoExigeFactor, rolExigeFactor } from "./totp/exigencia.js";

/** Lo que `auth` usa de `ContappDb`: `withAuth` (funciones `auth.*`) y `withUsuario` (RLS, P7). */
export type DbAuth = Pick<ContappDb, "withAuth" | "withUsuario" | "withTenant">;
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
/** 029 (CA-2): con TOTP activo, el login solo crea la sesión `pendiente`. */
export interface RespuestaSegundoFactor {
  segundoFactor: true;
  estudioActivo: null;
  csrf: string;
}
export interface EstadoSesion {
  usuario: { id: string; nombre: string; correo: string };
  estudioActivo: Estudio | null;
  csrf: string;
  /** 029: factor de la sesión, si la cuenta tiene TOTP activo y si alguno de sus roles vigentes lo exige (U1–U2). */
  factor: FactorSesion;
  totpActivo: boolean;
  factorExigido: boolean;
}
/** 029 (U6): de dónde viene la petición, ya resumido (lista cerrada) y truncado (/24 o /48). Nunca el User-Agent ni la IP completa. */
export interface Origen {
  dispositivo: string;
  ipRed: string | null;
}
/** 029 (U6): resume el User-Agent y trunca la IP antes de que lleguen a la BD o a un correo. */
export function origenDe(userAgent: unknown, ip: unknown): Origen {
  return { dispositivo: resumirDispositivo(userAgent), ipRed: truncarIp(ip) };
}
/** Membresía tal como la lee `withUsuario` para la regla de exigencia. */
interface MembresiaFactor {
  tenantId: string;
  usuarioId: string;
  rol: string;
  desactivadaEn: Date | null;
}
/**
 * 029 (U1–U2): alguna membresía VIGENTE del usuario tiene un rol que exige el segundo factor. 030 (CA-7): un rol propio decide por sus
 * permisos efectivos, leídos con `miembroActual` en el estudio de esa membresía (solo para las de rol propio y solo si ninguna de
 * sistema ya lo exige). Un rol propio que no se resuelve lo exige (falla cerrado).
 */
async function algunaExige(
  db: Pick<ContappDb, "withTenant">,
  membresias: MembresiaFactor[],
  usuarioId: string,
): Promise<boolean> {
  const vigentes = membresias.filter((m) => m.usuarioId === usuarioId && m.desactivadaEn === null);
  if (vigentes.some((m) => m.rol !== "propio" && rolExigeFactor(m.rol))) return true;
  for (const m of vigentes.filter((x) => x.rol === "propio")) {
    const leida = await db.withTenant({ tenantId: m.tenantId, userId: usuarioId }, (tx) => miembroActual(tx, usuarioId));
    // Desactivada entretanto: ya no cuenta.
    if (leida === null) continue;
    if (efectivoExigeFactor(efectivoDe(leida))) return true;
  }
  return false;
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

/**
 * D10 + T16 (decisión del usuario, H-r1b-4): correo normalizado; fuera de ASCII -> 400
 * `solicitud_invalida`. Depende solo del formato de la entrada (esa cuenta no puede existir: no enumera).
 */
export function correoDeEntrada(valor: string): string {
  try {
    return normalizarCorreo(valor);
  } catch {
    throw new AuthError("solicitud_invalida");
  }
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

/** Vida máxima de una sesión `pendiente` (029, CA-2) y de una sesión plena (004 D5), en segundos. */
export const VIDA_PENDIENTE_S = 5 * 60;
export const VIDA_SESION_S = 12 * 60 * 60;

/**
 * 029: Max-Age de la cookie acotado a la vida de la sesión. La caducidad la fija el reloj de la BD; con un reloj del servidor algo
 * atrasado, `segundosRestantes` pasaría de la vida real (p. ej. 307 s para una `pendiente` de 5 min).
 */
export function maxAgeSesion(expira: Date, tope: number): number {
  return Math.min(tope, segundosRestantes(expira));
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

  /**
   * POST /auth/login. Límite por IP -> zod -> verificación única -> sesión nueva (CA-1, CA-2, CA-5). 029: guarda el dispositivo y la red
   * (U6); con TOTP activo la BD crea la sesión `pendiente` (5 min, sin estudio) y aquí se responde `{ segundoFactor: true }`.
   */
  async login(
    cuerpo: unknown,
    ip: string | undefined,
    cabeceraCookie?: string,
    userAgent?: unknown,
  ): Promise<ConCookie<RespuestaLogin | RespuestaSegundoFactor>> {
    const permitido = await this.db.withAuth((a) => a.limiteConsumir("login_ip", sujetoIp(ip ?? "")));
    if (!permitido) throw new AuthError("demasiados_intentos");
    const entrada = parsear(loginSchema, cuerpo);
    const correo = correoDeEntrada(entrada.correo);

    const cred = await this.verificarCredencial(correo, entrada.contrasena);
    // CA-2: inexistente, contraseña errónea, bloqueada o demasiado larga salen por esta misma línea.
    if (cred === null) throw new AuthError("credenciales_invalidas");

    const estudios = await this.estudiosDe(cred.usuarioId);
    let activo = estudios.length === 1 ? (estudios[0] as Estudio) : null;
    const hashNuevo = this.hasher.necesitaRehash(cred.hash) ? await this.hasher.calcular(entrada.contrasena) : null;
    const anterior = leerTokenDeCookie(cabeceraCookie);
    const token = generarToken();
    const origen = origenDe(userAgent, ip);
    const args = {
      clave: cred.clave,
      usuarioId: cred.usuarioId,
      // O-1: la sesión solo se crea si la credencial sigue siendo la verificada (si no, el mismo 401).
      hashVerificado: cred.hash,
      tokenHash: hashToken(token),
      tenantActivo: activo?.id ?? null,
      hashNuevo,
      tokenAnteriorHash: anterior === null ? null : hashToken(anterior),
      dispositivo: origen.dispositivo,
      ipRed: origen.ipRed,
    };
    // El factor lo decide la BD (TOTP activo -> `pendiente`); se lee en la misma transacción, sin renovar la sesión.
    const crear = (tenantActivo: string | null) =>
      this.db.withAuth(async (a) => {
        const e = await a.loginExito({ ...args, tenantActivo });
        if (e === null) return null;
        const v = await a.sesionConsultar(args.tokenHash);
        return { ...e, pendiente: v === null || v.factor === "pendiente" };
      });
    let emitida = await crear(args.tenantActivo);
    if (emitida === null && activo !== null) {
      // La membresía desapareció entre la lista y la sesión: se entra sin estudio.
      activo = null;
      emitida = await crear(null);
    }
    if (emitida === null) throw new AuthError("credenciales_invalidas");
    const cookie = construirCookie(
      token,
      maxAgeSesion(emitida.expiraAbsoluta, emitida.pendiente ? VIDA_PENDIENTE_S : VIDA_SESION_S),
    );
    if (emitida.pendiente) return { respuesta: { segundoFactor: true, estudioActivo: null, csrf: derivarCsrf(token) }, cookie };
    return { respuesta: { estudioActivo: activo, requiereEstudio: estudios.length > 1 }, cookie };
  }

  /**
   * Para `SesionGuard`: cookie -> sesión válida o null (formato inválido: sin consultar la BD). Con
   * `{ renovar: false }` (008 D22, stream de trabajos) valida con `auth.sesion_consultar`: no cuenta como actividad.
   */
  async resolverSesion(
    cabeceraCookie: string | undefined,
    opciones: { renovar?: boolean } = {},
  ): Promise<SesionResuelta | null> {
    const token = leerTokenDeCookie(cabeceraCookie);
    if (token === null) return null;
    const hash = hashToken(token);
    const valida = await this.db.withAuth((a) =>
      opciones.renovar === false ? a.sesionConsultar(hash) : a.sesionValidar(hash),
    );
    return valida === null ? null : { ...valida, token };
  }

  /**
   * GET /auth/sesion: usuario, estudio activo y el token CSRF derivado (D6). 029: `factor` de la sesión, `totpActivo` y `factorExigido`
   * (super-admin o alguna membresía VIGENTE cuyo rol lo exige, U1–U2; la misma regla que `totp_desactivar` en SQL).
   */
  async estadoSesion(s: SesionResuelta): Promise<EstadoSesion> {
    const { usuarios, estudios, membresias } = await this.db.withUsuario({ userId: s.usuarioId }, async (tx) => ({
      usuarios: await tx.orm
        .select({ id: schema.usuario.id, nombre: schema.usuario.nombre, correo: schema.usuario.email })
        .from(schema.usuario),
      estudios: await tx.orm.select({ id: schema.tenant.id, nombre: schema.tenant.nombre }).from(schema.tenant),
      membresias: await tx.orm
        .select({
          tenantId: schema.membresia.tenantId,
          usuarioId: schema.membresia.usuarioId,
          rol: schema.membresia.rol,
          desactivadaEn: schema.membresia.desactivadaEn,
        })
        .from(schema.membresia),
    }));
    const u = usuarios.find((x) => x.id === s.usuarioId);
    if (u === undefined) throw new AuthError("sesion_invalida");
    const activo = estudios.find((e) => e.id === s.tenantActivo);
    const { plataforma, totpActivo } = await this.db.withAuth(async (a, c) => ({
      plataforma: (await a.plataformaYo(hashToken(s.token))) !== null,
      totpActivo: ((await c.totp.leer(s.usuarioId))?.activoCifrado ?? null) !== null,
    }));
    const exigido = plataforma || (await algunaExige(this.db, membresias, s.usuarioId));
    return {
      usuario: { id: u.id, nombre: u.nombre, correo: u.correo },
      estudioActivo: activo === undefined ? null : { id: activo.id, nombre: activo.nombre },
      csrf: derivarCsrf(s.token),
      factor: s.factor,
      totpActivo,
      factorExigido: exigido,
    };
  }

  /**
   * 029 (U1–U3): ¿la cuenta de la sesión exige el segundo factor? La misma regla que `factorExigido` de `GET /auth/sesion`: super-admin o
   * alguna membresía VIGENTE cuyo rol lo exige. Para la lista cerrada de las rutas sin estudio (`PermisoGuard`); solo se consulta con una
   * sesión sin factor verificado.
   */
  async factorExigido(s: SesionResuelta): Promise<boolean> {
    const plataforma = await this.db.withAuth((a) => a.plataformaYo(hashToken(s.token)));
    if (plataforma !== null) return true;
    const membresias = await this.db.withUsuario({ userId: s.usuarioId }, (tx) =>
      tx.orm
        .select({
          tenantId: schema.membresia.tenantId,
          usuarioId: schema.membresia.usuarioId,
          rol: schema.membresia.rol,
          desactivadaEn: schema.membresia.desactivadaEn,
        })
        .from(schema.membresia),
    );
    return algunaExige(this.db, membresias, s.usuarioId);
  }

  /** 029: estudios con membresía activa (para el estudio de la sesión verificada, como en el login). */
  estudiosDisponibles(userId: string): Promise<Estudio[]> {
    return this.estudiosDe(userId);
  }

  /** 029 (U8): correo y nombre del titular de la sesión para los avisos de seguridad. */
  async titular(userId: string): Promise<{ correo: string; nombre: string }> {
    const filas = await this.db.withUsuario({ userId }, (tx) =>
      tx.orm
        .select({ id: schema.usuario.id, correo: schema.usuario.email, nombre: schema.usuario.nombre })
        .from(schema.usuario),
    );
    const fila = filas.find((f) => f.id === userId);
    if (fila === undefined) throw new AuthError("sesion_invalida");
    return { correo: fila.correo, nombre: fila.nombre };
  }

  /**
   * 029: la contraseña actual del titular de la sesión, con el mismo contador de 004 D7 que el login (una verificación Argon2id). Si
   * acierta, la reserva se descuenta (`intento_acierto`): solo los fallos cuentan.
   */
  async contrasenaCorrecta(s: SesionResuelta, plano: string): Promise<boolean> {
    const correo = await this.correoDe(s.usuarioId);
    const cred = await this.verificarCredencial(correo, plano);
    if (cred === null || cred.usuarioId !== s.usuarioId) return false;
    await this.db.withAuth((_a, c) => c.totp.intentoAcierto(hashToken(s.token)));
    return true;
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

  /**
   * Estudios con membresía ACTIVA del usuario: la RLS de `tenant` y `membresia` en withUsuario solo deja
   * ver los suyos (P7) y aquí se descartan las membresías desactivadas (005, D9: lista y `requiereEstudio`).
   */
  private async estudiosDe(userId: string): Promise<Estudio[]> {
    const { filas, membresias } = await this.db.withUsuario({ userId }, async (tx) => ({
      filas: await tx.orm.select({ id: schema.tenant.id, nombre: schema.tenant.nombre }).from(schema.tenant),
      membresias: await tx.orm
        .select({ tenantId: schema.membresia.tenantId, desactivadaEn: schema.membresia.desactivadaEn })
        .from(schema.membresia),
    }));
    const activas = new Set(membresias.filter((m) => m.desactivadaEn === null).map((m) => m.tenantId));
    return filas
      .filter((f) => activas.has(f.id))
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
