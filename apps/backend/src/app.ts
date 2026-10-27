import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { ContappDb } from "@contapp/db";
import { AppModule } from "./app.module.js";
import { FiltroErrores } from "./comun/filtro-errores.js";
import { leerEntorno, type EnvCrudo } from "./config/entorno.js";
import { ColaCorreo } from "./infra/correo/cola.js";
import type { Correo, MensajeCorreo } from "./infra/correo/correo.js";
import { crearCorreo } from "./infra/correo/fabrica.js";
import { crearDb } from "./infra/db.js";
import type { CupoUsuarios } from "./modules/acceso/cupo/cupo-usuarios.js";
import { CupoSinLimite } from "./modules/acceso/cupo/sin-limite.js";
import { ClienteScopeGuard } from "./modules/acceso/guards/cliente-scope.guard.js";
import { PermisoGuard } from "./modules/acceso/guards/permiso.guard.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { crearHasher, type Hasher } from "./modules/auth/contrasena/hasher.js";
import { cargarComunes } from "./modules/auth/contrasena/politica.js";
import { CsrfGuard } from "./modules/auth/guards/csrf.guard.js";
import { EstudioGuard } from "./modules/auth/guards/estudio.guard.js";
import { OrigenGuard } from "./modules/auth/guards/origen.guard.js";
import { SesionGuard } from "./modules/auth/guards/sesion.guard.js";
import { DB } from "./modules/auth/inyeccion.js";

// Nombres con los que las pruebas (test/soporte.ts) tipan lo que inyectan en `crearApp`.
export type MensajeCorreoApp = MensajeCorreo;
export type CorreoApp = Correo;
export type HasherApp = Hasher;

export interface OpcionesApp {
  correo?: CorreoApp;
  hasher?: HasherApp;
  env?: Record<string, string | undefined>;
  /** Límite de usuarios del plan (D11); por defecto `CupoSinLimite` (006 lo reemplaza). */
  cupoUsuarios?: CupoUsuarios;
}

/** Límite del cuerpo JSON (plan: Decisiones, Argon2): más de 16 kB responde 413 sin procesar. */
const LIMITE_JSON = "16kb";

/** `TRUST_PROXY`: un entero es el número de saltos de confianza; si no, la lista o alias de Express. */
export function confianzaProxy(valor: string): string | number {
  return /^\d{1,3}$/.test(valor) ? Number(valor) : valor;
}

/**
 * Arma la app HTTP de ContApp. Las pruebas inyectan `correo` y `hasher` (nunca por entorno); sin
 * ellos se usan los del entorno. Orden de los guards globales (plan: Contratos HTTP):
 * Origen -> Sesion -> Estudio -> Csrf (004) -> Permiso -> ClienteScope (005: CSRF antes que Permiso para
 * que una petición forjada no sondee permisos; Permiso antes que Alcance para que el 403 no revele el cliente).
 */
export async function crearApp(o: OpcionesApp = {}): Promise<INestApplication> {
  const env: EnvCrudo = o.env ?? process.env;
  const entorno = leerEntorno(env);
  const correo = o.correo ?? crearCorreo(entorno.correo);
  const hasher = o.hasher ?? (await crearHasher(entorno.argon2));

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.registrar({
      db: crearDb(env),
      hasher,
      cola: new ColaCorreo(correo),
      comunes: cargarComunes(),
      appOrigin: entorno.appOrigin,
      cupo: o.cupoUsuarios ?? new CupoSinLimite(),
    }),
    // El analizador de cuerpo se registra a mano: solo JSON y con límite propio.
    { bodyParser: false },
  );

  app.disable("x-powered-by");
  app.disable("etag");
  app.set("trust proxy", confianzaProxy(entorno.trustProxy));
  app.use((_req: unknown, res: { setHeader(n: string, v: string): void }, next: () => void) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.useBodyParser("json", { limit: LIMITE_JSON });

  const reflector = app.get(Reflector);
  const db = app.get<ContappDb>(DB);
  app.useGlobalGuards(
    new OrigenGuard(entorno.appOrigin),
    new SesionGuard(reflector, app.get(AuthService)),
    new EstudioGuard(reflector),
    new CsrfGuard(reflector),
    new PermisoGuard(reflector, db),
    new ClienteScopeGuard(reflector, db),
  );
  app.useGlobalFilters(new FiltroErrores());

  await app.init();
  return app;
}
