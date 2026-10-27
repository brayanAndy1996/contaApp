// Soporte de las pruebas de BD de la spec 008 (T3). No es una prueba (no termina en .spec.ts).
// Cada archivo crea sus propios estudios, usuarios y clientes con la conexion administrativa
// (MIGRATIONS_DATABASE_URL, superusuario) y los borra al final; asi ninguna prueba depende del seed ni lo toca.
// Canarios y bytes sinteticos: nunca secretos reales.
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { EscenarioAcceso, type RolMembresia } from "./acceso-soporte";
import { crearDb, exportado } from "./auth-soporte";
import type { ContappDb, Intento, Tx } from "./soporte";

export { crearDb, exportado };

export const COLAS = ["sire", "sol", "xml", "archivos", "programados", "notificaciones"] as const;
export const CANALES = ["sire", "sol", "ninguno"] as const;
export const PRIORIDADES = ["interactivo", "programado"] as const;
export const ESTADOS = ["en_cola", "ejecutando", "completado", "error", "cancelado"] as const;
export const VIVOS = ["en_cola", "ejecutando"] as const;
export const TERMINALES = ["completado", "error", "cancelado"] as const;
export const MOTIVOS = [
  "sunat_no_responde",
  "credencial_invalida",
  "datos_invalidos",
  "portal_cambio",
  "interrumpido",
  "acceso_retirado",
  "cancelado_usuario",
  "error_interno",
] as const;

export type Estado = (typeof ESTADOS)[number];

/** Columnas de job_registro (plan 008, "BD"), ordenadas. */
export const COLUMNAS_JOB = [
  "id",
  "tenant_id",
  "cliente_id",
  "ruc",
  "tipo",
  "cola",
  "canal",
  "prioridad",
  "estado",
  "parametros",
  "clave_dedupe",
  "creado_por",
  "intentos",
  "max_intentos",
  "motivo",
  "resultado",
  "disponible_desde",
  "creado_en",
  "iniciado_en",
  "terminado_en",
  "actualizado_en",
].sort();

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const codigo = (i: Intento): string => (i.ok ? "ok" : i.code);

export interface ClientePrueba {
  id: string;
  ruc: string;
}

export interface OpcionesJob {
  tipo?: string;
  cola?: string;
  canal?: string;
  prioridad?: string;
  estado?: string;
  parametros?: unknown;
  claveDedupe?: Buffer;
  creadoPor?: string | null;
  intentos?: number;
  maxIntentos?: number;
  motivo?: string | null;
  /** Antiguedad de `actualizado_en` (y de `terminado_en` si el estado es terminal), en segundos. */
  hace?: number;
  /** `disponible_desde` relativo a ahora, en segundos (negativo = ya disponible). */
  disponibleEn?: number;
}

/** Datos de prueba de un archivo (estudios, usuarios, clientes, credenciales y trabajos), borrados al final. */
export class EscenarioTrabajos {
  readonly ea: EscenarioAcceso;
  private readonly credenciales: string[] = [];

  constructor(readonly admin: Pool) {
    this.ea = new EscenarioAcceso(admin);
  }

  estudio() {
    return this.ea.estudio();
  }

  miembro(tenantId: string, rol: RolMembresia = "contador", o: { desactivada?: boolean } = {}) {
    return this.ea.miembro(tenantId, rol, o);
  }

  asignar(tenantId: string, clienteId: string, usuarioId: string, tipo: "responsable" | "colaborador" = "colaborador") {
    return this.ea.asignar(tenantId, clienteId, usuarioId, tipo);
  }

  async cliente(tenantId: string): Promise<ClientePrueba> {
    const id = await this.ea.cliente(tenantId);
    const r = await this.admin.query("select ruc from cliente where id = $1", [id]);
    return { id, ruc: String(r.rows[0].ruc) };
  }

  /** Inserta un trabajo directamente (superusuario, sin pasar por los repositorios). Devuelve su id. */
  async job(tenantId: string, c: ClientePrueba, o: OpcionesJob = {}): Promise<string> {
    const estado = o.estado ?? "en_cola";
    const terminal = (TERMINALES as readonly string[]).includes(estado);
    const hace = o.hace ?? 0;
    const r = await this.admin.query(
      `insert into job_registro
         (tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por,
          intentos, max_intentos, motivo, disponible_desde, creado_en, iniciado_en, terminado_en, actualizado_en)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14,
               now() + make_interval(secs => $15::int),
               now() - make_interval(secs => $16::int),
               case when $8 <> 'en_cola' then now() - make_interval(secs => $16::int) else null end,
               case when $17::boolean then now() - make_interval(secs => $16::int) else null end,
               now() - make_interval(secs => $16::int))
       returning id`,
      [
        tenantId,
        c.id,
        c.ruc,
        o.tipo ?? "prueba.eco",
        o.cola ?? "sire",
        o.canal ?? "sire",
        o.prioridad ?? "interactivo",
        estado,
        JSON.stringify(o.parametros ?? { n: 1 }),
        o.claveDedupe ?? randomBytes(32),
        o.creadoPor ?? null,
        o.intentos ?? 0,
        o.maxIntentos ?? 3,
        o.motivo ?? null,
        o.disponibleEn ?? 0,
        hace,
        terminal,
      ],
    );
    return r.rows[0].id as string;
  }

  /** Fila completa del trabajo (superusuario). */
  async fila(id: string): Promise<any | undefined> {
    return (await this.admin.query("select * from job_registro where id = $1", [id])).rows[0];
  }

  /** Credencial sintetica (bytes aleatorios) insertada con el superusuario. Devuelve su id. */
  async credencial(tenantId: string, clienteId: string, tipo: "sol" | "sire_api" = "sol"): Promise<string> {
    const r = await this.admin.query(
      `insert into credencial (tenant_id, cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version)
       values ($1, $2, $3, $4, $5, $6, $7, 'k1', 1) returning id`,
      [tenantId, clienteId, tipo, randomBytes(64), randomBytes(12), randomBytes(16), randomBytes(512)],
    );
    this.credenciales.push(r.rows[0].id);
    return r.rows[0].id as string;
  }

  async limpiar(): Promise<void> {
    const t = this.ea.estudios;
    await this.admin.query("delete from job_registro where tenant_id = any($1::uuid[])", [t]).catch(() => undefined);
    await this.admin.query("delete from credencial where tenant_id = any($1::uuid[])", [t]).catch(() => undefined);
    await this.ea.limpiar();
  }
}

/** Ejecuta `fn` en una conexion del pool dentro de BEGIN ... ROLLBACK; `rol` opcional con SET LOCAL ROLE. */
export async function enTx<T>(pool: Pool, rol: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    if (rol) {
      if (!/^contapp_[a-z]+$/.test(rol)) throw new Error("rol invalido en la prueba");
      await c.query(`SET LOCAL ROLE ${rol}`);
    }
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

/** Sentencia dentro de un SAVEPOINT: devuelve el resultado o el error de PG sin abortar la transaccion. */
export async function probar(
  c: { query(t: string, v?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> },
  sql: string,
  valores: unknown[] = [],
): Promise<Intento & { rows?: any[] }> {
  await c.query("SAVEPOINT prueba");
  try {
    const r = await c.query(sql, valores);
    await c.query("RELEASE SAVEPOINT prueba");
    return { ok: true, rowCount: r.rowCount ?? 0, rows: r.rows };
  } catch (e) {
    await c.query("ROLLBACK TO SAVEPOINT prueba");
    const err = e as { code?: string; message?: string };
    return { ok: false, code: String(err.code ?? ""), message: String(err.message ?? "") };
  }
}

export interface SistemaDb extends ContappDb {
  withSistema<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

/** Una base como `rolApp` con `withSistema` (aun no existe: el rojo debe decirlo claro). */
export function conSistema(rolApp: "contapp_backend" | "contapp_worker", poolMax = 2): SistemaDb {
  const db = crearDb(rolApp, poolMax);
  if (typeof (db as Partial<SistemaDb>).withSistema !== "function") {
    // cerramos el pool que acabamos de abrir antes de fallar
    void db.close().catch(() => undefined);
    throw new Error("ContappDb aun no expone withSistema (implementacion pendiente, T7)");
  }
  return db as SistemaDb;
}

export const uuidNuevo = (): string => randomUUID();
