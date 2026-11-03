// Soporte de las pruebas de BD de la spec 006 (T1). No es una prueba (no termina en .spec.ts).
// Cada archivo crea sus propios planes, estudios, cuentas y pendientes de registro con la conexion administrativa
// (MIGRATIONS_DATABASE_URL, superusuario) y los borra al final; nunca modifica los 5 planes del seed (los que una
// prueba necesita tocar, como el plan `prueba` inactivo, se restauran en un finally). Canarios y hashes sinteticos.
import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { EscenarioAcceso } from "./acceso-soporte";
import type { UsuarioPrueba } from "./auth-soporte";

export const sha256 = (b: Buffer): Buffer =>
  createHash("sha256").update(b).digest();
/** Hash de token de registro (32 B) nuevo; en BD se guarda solo este valor. */
export const tokenHashNuevo = (): Buffer => sha256(randomBytes(32));

/** Los 5 planes de 01 §3 sembrados por 006 (plan.md, "BD"). Precios como los devuelve `pg` (numeric -> string). */
export const PLANES_SEED = [
  {
    codigo: "prueba",
    precio_mensual: "0.00",
    precio_anual: null,
    max_rucs: 5,
    max_usuarios: 1,
    precio_ruc_extra: "0.00",
    max_rucs_extra: 0,
    frecuencia_buzon_min: 1440,
  },
  {
    codigo: "independiente",
    precio_mensual: "99.00",
    precio_anual: "990.00",
    max_rucs: 30,
    max_usuarios: 2,
    precio_ruc_extra: "4.00",
    max_rucs_extra: 6,
    frecuencia_buzon_min: 1440,
  },
  {
    codigo: "estudio",
    precio_mensual: "249.00",
    precio_anual: "2490.00",
    max_rucs: 100,
    max_usuarios: 5,
    precio_ruc_extra: "4.00",
    max_rucs_extra: 20,
    frecuencia_buzon_min: 720,
  },
  {
    codigo: "estudio_pro",
    precio_mensual: "599.00",
    precio_anual: "5990.00",
    max_rucs: 300,
    max_usuarios: 15,
    precio_ruc_extra: "4.00",
    max_rucs_extra: 60,
    frecuencia_buzon_min: 240,
  },
  {
    codigo: "corporativo",
    precio_mensual: "1200.00",
    precio_anual: null,
    max_rucs: 600,
    max_usuarios: null,
    precio_ruc_extra: "4.00",
    max_rucs_extra: 120,
    frecuencia_buzon_min: 60,
  },
] as const;

export interface PlanPrueba {
  id: string;
  codigo: string;
}

export interface OpcionesPlan {
  precioMensual?: string;
  precioAnual?: string | null;
  maxRucs?: number;
  /** `null` = ilimitado. */
  maxUsuarios?: number | null;
  precioRucExtra?: string;
  maxRucsExtra?: number;
  frecuenciaBuzonMin?: number;
  features?: Record<string, unknown>;
  activo?: boolean;
}

export interface SuscripcionPrueba {
  estado?: "prueba" | "activa";
  /** Intervalo SQL desde ahora (p. ej. '14 days'); por omision 14 dias si `estado = 'prueba'`, NULL si `activa`. */
  venceEn?: string | null;
  rucsExtra?: number;
}

/**
 * Escenario de 006: extiende EscenarioAcceso (estudios, cuentas, membresias, invitaciones, clientes) con planes,
 * suscripciones, administradores de plataforma y pendientes de registro. `limpiar()` deja la BD como estaba.
 */
export class EscenarioPlanes {
  readonly ea: EscenarioAcceso;
  readonly marca: string;
  private n = 0;
  private readonly admins: string[] = [];
  private readonly correosRegistro: string[] = [];
  private readonly nombresEstudio: string[] = [];

  constructor(readonly admin: Pool) {
    this.ea = new EscenarioAcceso(admin);
    this.marca = this.ea.esc.marca;
  }

  /** Plan propio (codigo unico `t1_<marca>_<n>`); por omision 10 RUCs, 5 usuarios, tope extra 2, activo. */
  async plan(o: OpcionesPlan = {}): Promise<PlanPrueba> {
    const codigo = `t1_${this.marca}_${++this.n}`;
    const r = await this.admin.query(
      `insert into plan (codigo, nombre, precio_mensual, precio_anual, max_rucs, max_usuarios, precio_ruc_extra,
                         max_rucs_extra, frecuencia_buzon_min, features, activo)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11) returning id`,
      [
        codigo,
        `Plan T1 ${codigo}`,
        o.precioMensual ?? "10.00",
        o.precioAnual === undefined ? null : o.precioAnual,
        o.maxRucs ?? 10,
        o.maxUsuarios === undefined ? 5 : o.maxUsuarios,
        o.precioRucExtra ?? "1.00",
        o.maxRucsExtra ?? 2,
        o.frecuenciaBuzonMin ?? 1440,
        JSON.stringify(o.features ?? {}),
        o.activo ?? true,
      ],
    );
    return { id: r.rows[0].id as string, codigo };
  }

  /** Codigo unico propio para pedirle a `plan_crear` que cree un plan (se borra en `limpiar`). */
  codigoNuevo(): string {
    return `t1_${this.marca}_${++this.n}`;
  }

  async planSeed(codigo: string): Promise<string> {
    return (
      await this.admin.query("select id from plan where codigo = $1", [codigo])
    ).rows[0].id as string;
  }

  /** Suscripcion insertada directamente (sin pasar por las funciones). */
  async suscribir(
    tenantId: string,
    planId: string,
    o: SuscripcionPrueba = {},
  ): Promise<void> {
    const estado = o.estado ?? "activa";
    const vence =
      o.venceEn === undefined
        ? estado === "prueba"
          ? "14 days"
          : null
        : o.venceEn;
    await this.admin.query(
      `insert into suscripcion (tenant_id, plan_id, estado, prueba_vence_en, rucs_extra_contratados)
       values ($1, $2, $3, case when $4::interval is null then null else now() + $4::interval end, $5)`,
      [tenantId, planId, estado, vence, o.rucsExtra ?? 0],
    );
  }

  /** Estudio nuevo con suscripcion al plan dado. */
  async estudioConPlan(
    planId: string,
    o: SuscripcionPrueba = {},
  ): Promise<{ id: string; nombre: string }> {
    const x = await this.ea.estudio();
    await this.suscribir(x.id, planId, o);
    return x;
  }

  /** Cuenta con credencial y alta en `admin_plataforma`, SIN membresias, con una sesion viva sin estudio. */
  async administrador(): Promise<{ usuario: UsuarioPrueba; sesion: Buffer }> {
    const usuario = await this.ea.cuenta();
    await this.admin.query(
      "insert into admin_plataforma (usuario_id) values ($1)",
      [usuario.id],
    );
    this.admins.push(usuario.id);
    return { usuario, sesion: await this.ea.esc.sesion(usuario.id, null) };
  }

  /** Cuenta con credencial cuyo correo tambien queda anotado para borrar sus pendientes de registro. */
  async cuentaRegistro(): Promise<UsuarioPrueba> {
    const u = await this.ea.cuenta();
    this.correosRegistro.push(u.correo);
    return u;
  }

  /**
   * Estudio con suscripcion al plan dado (o sin suscripcion) y `activos` miembros activos (el primero es Dueño),
   * `desactivados` desactivados y `pendientes` invitaciones vigentes (D7); `vencidas` invitaciones vencidas.
   */
  async estudioConUsuarios(
    planId: string | null,
    o: {
      activos: number;
      desactivados?: number;
      pendientes?: number;
      vencidas?: number;
    },
  ) {
    const x =
      planId === null
        ? await this.ea.estudio()
        : await this.estudioConPlan(planId);
    const dueno = await this.ea.miembro(x.id, "dueno");
    const miembros = [dueno];
    for (let i = 1; i < o.activos; i++)
      miembros.push(await this.ea.miembro(x.id, "contador"));
    const desactivados: UsuarioPrueba[] = [];
    for (let i = 0; i < (o.desactivados ?? 0); i++)
      desactivados.push(
        await this.ea.miembro(x.id, "contador", { desactivada: true }),
      );
    const invitaciones = [];
    for (let i = 0; i < (o.pendientes ?? 0); i++)
      invitaciones.push(
        await this.ea.invitacion(x.id, { invitadoPor: dueno.id }),
      );
    for (let i = 0; i < (o.vencidas ?? 0); i++)
      await this.ea.invitacion(x.id, { invitadoPor: dueno.id, vencida: true });
    return { x, dueno, miembros, desactivados, invitaciones };
  }

  /** Correo nuevo para un registro; queda anotado para borrar su pendiente y el usuario que cree la confirmacion. */
  correoRegistro(): string {
    const c = this.ea.esc.correoNuevo();
    this.correosRegistro.push(c);
    this.ea.recordarCorreo(c);
    return c;
  }

  /** Nombre de estudio unico (para reconocer el estudio que crea la confirmacion). */
  nombreEstudio(): string {
    const nombre = `Estudio T1 ${this.marca}-${++this.n}`;
    this.nombresEstudio.push(nombre);
    return nombre;
  }

  /** Estudios (id) con ese nombre; los anota para la limpieza. */
  async estudiosPorNombre(nombre: string): Promise<string[]> {
    const ids = (
      await this.admin.query("select id from tenant where nombre = $1", [
        nombre,
      ])
    ).rows.map((x) => x.id as string);
    for (const id of ids)
      if (!this.ea.estudios.includes(id)) this.ea.estudios.push(id);
    return ids;
  }

  async limpiar(): Promise<void> {
    // Los estudios creados por las funciones se buscan por nombre para que EscenarioAcceso los borre.
    for (const nombre of this.nombresEstudio)
      await this.estudiosPorNombre(nombre).catch(() => undefined);
    const pasos: Array<[string, unknown[]]> = [
      [
        "delete from admin_plataforma where usuario_id = any($1::uuid[])",
        [this.admins],
      ],
      [
        "delete from auth.registro_pendiente where correo = any($1::text[])",
        [this.correosRegistro],
      ],
    ];
    for (const [sql, v] of pasos)
      await this.admin.query(sql, v).catch(() => undefined);
    await this.ea.limpiar();
    await this.admin
      .query("delete from plan where codigo like $1", [
        `t1\\_${this.marca}\\_%`,
      ])
      .catch(() => undefined);
  }
}
