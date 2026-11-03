import { createParamDecorator, SetMetadata, type ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import type { SesionResuelta } from "../auth.service.js";

// Por defecto toda ruta exige sesión y estudio activo (plan: Contratos HTTP). Estos decoradores lo
// relajan. El orden de los guards globales es Origen -> Sesion -> Estudio -> Csrf.
export const META_PUBLICO = "auth:publico";
export const META_SIN_ESTUDIO = "auth:sin-estudio";
export const META_SESION_OPCIONAL = "auth:sesion-opcional";
export const META_SIN_RENOVAR = "auth:sin-renovar-sesion";

/** Sin sesión ni CSRF (login, recuperación). `OrigenGuard` sigue aplicando. */
export const Publico = () => SetMetadata(META_PUBLICO, true);
/** Exige sesión pero no estudio activo (rutas de `/auth/*`). */
export const SinEstudio = () => SetMetadata(META_SIN_ESTUDIO, true);
/** Usa la sesión si es válida (con su CSRF); sin sesión válida sigue igual (logout). */
export const SesionOpcional = () => SetMetadata(META_SESION_OPCIONAL, true);
/** 008 D22: valida la sesión sin renovarla (no cuenta como actividad). Solo `GET /trabajos/stream`. */
export const SinRenovarSesion = () => SetMetadata(META_SIN_RENOVAR, true);

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
