// Soporte de las pruebas de BD de la spec 004 (T5). No es una prueba (no termina en .spec.ts).
// Solo usa DATABASE_URL, MIGRATIONS_DATABASE_URL (superusuario: siembra, mueve marcas de tiempo y limpia)
// y @contapp/db. Nunca imprime URLs, contrasenas ni tokens; los hashes de contrasena son sinteticos.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import * as dbModule from "@contapp/db";
import { crearDb, tenantDe, type ContappDb } from "./soporte";

export const TABLAS_AUTH = [
  "usuario_contrasena",
  "sesion",
  "token_recuperacion",
  "intento_login",
  "limite_tasa",
] as const;

export const FUNCIONES_AUTH = [
  "contrasena_cambiar",
  // Spec 005 (T2): 15 funciones. 0013_acceso_auth.sql agrega las tres de invitacion; las demas conservan su firma.
  "invitacion_aceptar_existente",
  "invitacion_aceptar_nueva",
  "invitacion_vigente",
  "limite_consumir",
  "login_exito",
  "login_preparar",
  // Spec 008 (T3): 16 funciones. 0018_trabajos_rls.sql agrega `purgar` (D16, CA-13), la UNICA con EXECUTE para
  // contapp_worker y NO para contapp_backend (ver FUNCIONES_AUTH_SOLO_WORKER).
  "purgar",
  "recuperacion_consumir",
  "recuperacion_crear",
  "recuperacion_vigente", // 0008 (T16): consulta sin efectos antes de Argon2 en restablecer
  // Spec 008 (T11b, D22): 17 funciones. 0019_sesion_consultar.sql agrega `sesion_consultar`: valida como `sesion_validar`
  // pero sin escribir (no renueva ultimo_uso ni limpia tenant_activo); la usa el stream de trabajos para no contar como actividad.
  "sesion_consultar",
  "sesion_revocar",
  "sesion_rotar",
  "sesion_validar",
  "sesiones_cerrar_todas",
  "ultimo_estudio",
] as const;

/** Spec 008: funciones de `auth` que ejecuta contapp_worker (y no contapp_backend). */
export const FUNCIONES_AUTH_SOLO_WORKER = ["purgar"] as const;

/** Spec 008 (D18): funciones SECURITY DEFINER del esquema `sistema` (dueño contapp_enumerador, EXECUTE solo worker). */
export const FUNCIONES_SISTEMA = ["estudios_con_trabajos", "estudios_ids"] as const;

export const ROLES_SIN_ACCESO = ["contapp_backend", "contapp_worker", "contapp_platform", "contapp_app"] as const;

export function abrirAdmin(max = 4): Pool {
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!url) throw new Error("falta MIGRATIONS_DATABASE_URL para las pruebas de BD de auth");
  const p = new Pool({ connectionString: url, max });
  p.on("error", () => undefined);
  return p;
}

export function abrirApp(max = 30): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("falta DATABASE_URL");
  const p = new Pool({ connectionString: url, max });
  p.on("error", () => undefined);
  return p;
}

export type Llamada =
  | { ok: true; rows: any[] }
  | { ok: false; code: string; message: string };

/** Una sentencia como `contapp_backend`, en su propia transaccion que SE CONFIRMA (las funciones escriben). */
export async function llamar(pool: Pool, sql: string, values: unknown[] = [], rol = "contapp_backend"): Promise<Llamada> {
  if (!/^contapp_[a-z]+$/.test(rol)) throw new Error("rol invalido en la prueba");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL ROLE ${rol}`);
    const r = await c.query(sql, values);
    await c.query("COMMIT");
    return { ok: true, rows: r.rows };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    const err = e as { code?: string; message?: string };
    return { ok: false, code: String(err.code ?? ""), message: String(err.message ?? "") };
  } finally {
    c.release();
  }
}

/** Como `llamar`, pero lanza (con solo el SQLSTATE) si la funcion falla: asi el rojo dice por que. */
export async function exito(p: Promise<Llamada>): Promise<any[]> {
  const r = await p;
  if (!r.ok) throw new Error(`la funcion de auth fallo (SQLSTATE ${r.code})`);
  return r.rows;
}

export const clave = (correoNormalizado: string): Buffer => createHash("sha256").update(correoNormalizado).digest();
export const nuevoToken = (): Buffer => randomBytes(32);

/** Hash PHC sintetico (no es de ninguna contrasena real); cumple el CHECK de la tabla. */
export const hashFalso = (): string =>
  `$argon2id$v=19$m=19456,t=2,p=1$${randomBytes(16).toString("base64url")}$${randomBytes(32).toString("base64url")}`;

export interface UsuarioPrueba {
  id: string;
  correo: string;
  hash: string | null;
}

/** Datos de prueba de un archivo: usuarios, claves y sujetos propios, borrados al final con el rol administrativo. */
export class Escenario {
  readonly marca = randomBytes(4).toString("hex");
  private readonly usuarios: string[] = [];
  private readonly claves: Buffer[] = [];
  private readonly sujetos: string[] = [];
  private n = 0;

  constructor(readonly admin: Pool) {}

  correoNuevo(): string {
    return `t5-${this.marca}-${++this.n}@auth.test`;
  }

  /** Clave de intento_login de un correo ya normalizado; queda registrada para la limpieza. */
  clave(correo: string): Buffer {
    const k = clave(correo);
    this.claves.push(k);
    return k;
  }

  sujeto(prefijo: string): string {
    const s = `t5-${this.marca}-${prefijo}-${++this.n}`;
    this.sujetos.push(s);
    return s;
  }

  /** Crea un usuario (con membresia en los tenants dados y, si `contrasena`, con credencial sintetica). */
  async usuario(o: { estudios?: string[]; contrasena?: boolean } = {}): Promise<UsuarioPrueba> {
    const id = randomUUID();
    const correo = this.correoNuevo();
    this.usuarios.push(id);
    await this.admin.query("insert into usuario (id, email, nombre) values ($1, $2, 'Usuario T5')", [id, correo]);
    for (const tenantId of o.estudios ?? []) {
      await this.admin.query(
        "insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'contador')",
        [tenantId, id],
      );
    }
    let hash: string | null = null;
    if (o.contrasena ?? true) {
      hash = hashFalso();
      await this.admin.query("insert into auth.usuario_contrasena (usuario_id, hash, actualizada_en) values ($1, $2, now())", [
        id,
        hash,
      ]);
    }
    return { id, correo, hash };
  }

  /** Inserta una sesion vigente directamente (sin pasar por las funciones). */
  async sesion(usuarioId: string, tenantActivo: string | null = null): Promise<Buffer> {
    const token = nuevoToken();
    await this.admin.query(
      `insert into auth.sesion (token_hash, usuario_id, tenant_activo, creada_en, ultimo_uso, expira_absoluta)
       values ($1, $2, $3, now(), now(), now() + interval '12 hours')`,
      [token, usuarioId, tenantActivo],
    );
    return token;
  }

  /** Inserta un token de recuperacion vigente (30 min) directamente. */
  async tokenRecuperacion(usuarioId: string): Promise<Buffer> {
    const token = nuevoToken();
    await this.admin.query(
      `insert into auth.token_recuperacion (token_hash, usuario_id, creado_en, expira_en)
       values ($1, $2, now(), now() + interval '30 minutes')`,
      [token, usuarioId],
    );
    return token;
  }

  async limpiar(): Promise<void> {
    const pasos: Array<[string, unknown[]]> = [
      ["delete from auth.limite_tasa where sujeto = any($1::text[])", [this.sujetos]],
      ["delete from auth.intento_login where clave = any($1::bytea[])", [this.claves]],
      ["delete from auth.token_recuperacion where usuario_id = any($1::uuid[])", [this.usuarios]],
      ["delete from auth.sesion where usuario_id = any($1::uuid[])", [this.usuarios]],
      ["delete from auth.usuario_contrasena where usuario_id = any($1::uuid[])", [this.usuarios]],
      ["delete from membresia where usuario_id = any($1::uuid[])", [this.usuarios]],
      ["delete from usuario where id = any($1::uuid[])", [this.usuarios]],
    ];
    for (const [sql, v] of pasos) await this.admin.query(sql, v).catch(() => undefined);
  }
}

// --- withAuth: aun no existe; el rojo debe decirlo claro -------------------------------------------
export type RepoAuth = Record<string, (...a: any[]) => Promise<any>>;
export interface ConAuth {
  withAuth<T>(fn: (a: RepoAuth) => Promise<T>): Promise<T>;
}

export function conAuth(db: ContappDb): ConAuth {
  if (typeof (db as unknown as Partial<ConAuth>).withAuth !== "function") {
    throw new Error("ContappDb aun no expone withAuth (implementacion pendiente, T9)");
  }
  return db as unknown as ConAuth;
}

export function exportado<T>(nombre: string): T {
  const v = (dbModule as unknown as Record<string, unknown>)[nombre];
  if (v === undefined) throw new Error(`@contapp/db aun no exporta ${nombre} (implementacion pendiente, T9)`);
  return v as T;
}

export { crearDb, tenantDe };
