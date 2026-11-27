import { createParamDecorator, SetMetadata, type ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import type { SesionResuelta } from "../auth.service.js";

// Por defecto toda ruta exige sesión y estudio activo (plan: Contratos HTTP). Estos decoradores lo
// relajan. El orden de los guards globales es Origen -> Sesion -> Estudio -> Csrf.
export const META_PUBLICO = "auth:publico";
export const META_SIN_ESTUDIO = "auth:sin-estudio";
export const META_SESION_OPCIONAL = "auth:sesion-opcional";
export const META_SIN_RENOVAR = "auth:sin-renovar-sesion";
export const META_SIN_ORIGEN = "auth:sin-origen";
/** 029: la ruta admite una sesión `pendiente` (login a medias). */
export const META_PERMITIR_PENDIENTE = "auth:permitir-pendiente";

/** Sin sesión ni CSRF (login, recuperación). `OrigenGuard` sigue aplicando. */
export const Publico = () => SetMetadata(META_PUBLICO, true);
/** Exige sesión pero no estudio activo (rutas de `/auth/*`). */
export const SinEstudio = () => SetMetadata(META_SIN_ESTUDIO, true);
/** Usa la sesión si es válida (con su CSRF); sin sesión válida sigue igual (logout). */
export const SesionOpcional = () => SetMetadata(META_SESION_OPCIONAL, true);
/** 008 D22: valida la sesión sin renovarla (no cuenta como actividad). Solo `GET /trabajos/stream`. */
export const SinRenovarSesion = () => SetMetadata(META_SIN_RENOVAR, true);

/**
 * 029 (CA-2): la sesión `pendiente` (contraseña correcta, falta el segundo factor) solo llega a las rutas con esta marca: verificar y
 * logout. En cualquier otra, `SesionGuard` responde 401 `sesion_invalida` como sin sesión. No es una familia de acceso (005 CA-11).
 */
export const PermitirPendiente = () => SetMetadata(META_PERMITIR_PENDIENTE, true);

/** 029: la ruta sin estudio está en la lista cerrada de la exigencia (U1–U3). */
export const META_PERMITIR_SIN_FACTOR = "auth:permitir-sin-factor";

/**
 * 029 (CA-4, U1–U3, plan: «Lista cerrada sin factor exigido»): si la cuenta exige el segundo factor y la sesión no lo verificó, una ruta
 * `@SinEstudio`/`@SesionOpcional` solo se atiende con esta marca: ver la sesión, listar y elegir estudio, enrolar, confirmar, verificar y
 * salir. Cualquier otra (también una nueva) responde 403 `segundo_factor_requerido` (`PermisoGuard`, falla cerrado).
 */
export const PermitirSinFactor = () => SetMetadata(META_PERMITIR_SIN_FACTOR, true);

/**
 * 028, D-4: la ruta queda fuera de `OrigenGuard`. Solo `POST /correo/baja`: el POST de un clic de RFC 8058 lo hace el servidor del
 * correo, sin `Origin` ni `Sec-Fetch-Site`; sin sesión ni cookies, la credencial es el token del enlace.
 */
export const SinOrigen = () => SetMetadata(META_SIN_ORIGEN, true);

/** Contexto de la petición (03 §4.1): lo fija `SesionGuard` fuera de `withTenant`. */
export interface ContextoPeticion {
  userId: string;
  tenantId: string | null;
  sesionId: string;
}

/** Clave no enumerable de la sesión resuelta en la petición (lleva el token: no se serializa). */
export const SESION = Symbol("auth:sesion");

export interface PeticionAuth {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  contexto?: ContextoPeticion;
  [SESION]?: SesionResuelta;
}

const METODOS_SEGUROS = new Set(["GET", "HEAD", "OPTIONS"]);

/** GET/HEAD/OPTIONS no cambian estado (CA-7): no se validan Origin ni CSRF. */
export function esMetodoSeguro(metodo: string): boolean {
  return METODOS_SEGUROS.has(metodo.toUpperCase());
}

export function marcada(reflector: Reflector, ctx: ExecutionContext, clave: string): boolean {
  return reflector.getAllAndOverride<boolean | undefined>(clave, [ctx.getHandler(), ctx.getClass()]) === true;
}

/** Guarda la sesión resuelta y el contexto público de la petición. */
export function fijarSesion(req: PeticionAuth, sesion: SesionResuelta): void {
  Object.defineProperty(req, SESION, { value: sesion, enumerable: false, configurable: true });
  req.contexto = { userId: sesion.usuarioId, tenantId: sesion.tenantActivo, sesionId: sesion.sesionId };
}

export function sesionDe(req: PeticionAuth): SesionResuelta | null {
  return req[SESION] ?? null;
}

/** Sesión resuelta por `SesionGuard` (null en rutas `@Publico()` o sin sesión en `@SesionOpcional()`). */
export function extraerSesion(_dato: unknown, ctx: ExecutionContext): SesionResuelta | null {
  return sesionDe(ctx.switchToHttp().getRequest<PeticionAuth>());
}

export const Sesion = createParamDecorator(extraerSesion);
