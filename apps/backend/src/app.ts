import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { json, raw } from "express";
import type { ContappDb } from "@contapp/db";
import { PREFIJO_POR_DEFECTO } from "@contapp/queue";
import { AppModule } from "./app.module.js";
import { FiltroErrores } from "./comun/filtro-errores.js";
import { leerEntorno, type EnvCrudo } from "./config/entorno.js";
import { ColaCorreo } from "./infra/correo/cola.js";
import type { Correo, MensajeCorreo } from "./infra/correo/correo.js";
import { crearCorreo } from "./infra/correo/fabrica.js";
import { crearDb } from "./infra/db.js";
import type { CupoUsuarios } from "./modules/acceso/cupo/cupo-usuarios.js";
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
import { CupoRucsPlanes, type CupoRucs } from "./modules/planes/cupo/cupo-rucs.js";
import { CupoUsuariosPlanes } from "./modules/planes/cupo/cupo-usuarios-planes.js";

// Nombres con los que las pruebas (test/soporte.ts) tipan lo que inyectan en `crearApp`.
export type MensajeCorreoApp = MensajeCorreo;
export type CorreoApp = Correo;
export type HasherApp = Hasher;

export interface OpcionesApp {
  correo?: CorreoApp;
  hasher?: HasherApp;
  env?: Record<string, string | undefined>;
  /** Límite de usuarios del plan (D11); por defecto `CupoUsuariosPlanes`. `CupoSinLimite` solo para pruebas. */
  cupoUsuarios?: CupoUsuarios;
  /** Límite de RUCs del plan (D4); por defecto `CupoRucsPlanes`. */
  cupoRucs?: CupoRucs;
  /**
   * Redis de trabajos (008): por defecto `REDIS_URL` del entorno y el prefijo `contapp:`. La conexión es perezosa:
   * con Redis caído la app arranca, las lecturas responden y encolar no espera.
   */
  redis?: { url?: string; prefijo?: string };
}

const REDIS_POR_DEFECTO = "redis://localhost:6379";

/** Límite del cuerpo JSON (plan: Decisiones, Argon2): más de 16 kB responde 413 sin procesar. */
const LIMITE_JSON = "16kb";

/**
 * Límite de las dos rutas de asignación masiva (plan 005): un lote de 501 UUID pesa ~19,6 kB y debe llegar a zod
 * (400), no cortarse en 413. El resto de rutas conserva `LIMITE_JSON`.
 */
export const LIMITE_JSON_LOTES = "32kb";
const RUTAS_LOTES = ["/asignaciones/por-usuario", "/asignaciones/por-cliente"];

/**
 * Acciones masivas de compras (014, D-15): hasta 5.000 `{ compraId, versionBase }`, unos 340 kB de JSON. 5.001 filas deben llegar
 * a zod (400 `solicitud_invalida`), no cortarse en 413. El resto de rutas conserva `LIMITE_JSON`.
 */
export const LIMITE_JSON_MASIVAS = "512kb";
const RUTAS_MASIVAS = ["/clientes/:clienteId/periodos/:periodo/compras/masivas"];

/**
 * Importación de clientes (007b): el cuerpo es el archivo crudo, `application/octet-stream` de hasta 2 MB. Con más, el
 * analizador responde 413 por `Content-Length` sin leer el cuerpo.
 */
export const LIMITE_ARCHIVO_IMPORTACION = "2mb";
const RUTAS_IMPORTACION = ["/clientes/importacion/vista-previa", "/clientes/importacion/confirmar"];

/**
 * Importación de la propuesta de ventas (013, D6, D10): también el archivo crudo, pero de hasta 8 MB (20.000 filas pesan
 * ~2,5 MB; `LIMITES_VENTAS.maxBytes`). Más de eso responde 413 por `Content-Length` sin leer el cuerpo. Los límites de la
 * importación de clientes no se tocan.
 */
export const LIMITE_ARCHIVO_VENTAS = "8mb";
const RUTAS_IMPORTACION_VENTAS = [
  "/clientes/:clienteId/periodos/:periodo/ventas/importar/vista-previa",
  "/clientes/:clienteId/periodos/:periodo/ventas/importar/confirmar",
];

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
      cupo: o.cupoUsuarios ?? new CupoUsuariosPlanes(),
      cupoRucs: o.cupoRucs ?? new CupoRucsPlanes(),
      redis: {
        url: o.redis?.url ?? env.REDIS_URL ?? REDIS_POR_DEFECTO,
        prefijo: o.redis?.prefijo ?? PREFIJO_POR_DEFECTO,
      },
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
  // El analizador de lotes va primero y solo en esas dos rutas; el global omite lo ya analizado.
  app.use(RUTAS_LOTES, json({ limit: LIMITE_JSON_LOTES }));
  app.use(RUTAS_MASIVAS, json({ limit: LIMITE_JSON_MASIVAS }));
  app.use(RUTAS_IMPORTACION, raw({ type: "application/octet-stream", limit: LIMITE_ARCHIVO_IMPORTACION }));
  app.use(RUTAS_IMPORTACION_VENTAS, raw({ type: "application/octet-stream", limit: LIMITE_ARCHIVO_VENTAS }));
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
