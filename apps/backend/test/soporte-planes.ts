/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y cuerpos JSON dinámicos en pruebas */
// Soporte de las pruebas de integración HTTP de 006 (T3). Encima de `soporte-acceso.ts`: planes propios por SQL
// (conexión de migraciones), estudios con el plan que cada prueba necesita (se cambia en BD sin reiniciar la app,
// CA-2), un super-admin real (alta en `admin_plataforma`, sin membresía, con sesión viva) y limpieza de lo que
// crea el registro público. Solo usa el contrato público: HTTP, `crearApp` y las tablas. Canarios sintéticos.
import { randomBytes } from "node:crypto";
import { createDb } from "@contapp/db";
import {
  abrirBanco,
  type Actor,
  type Banco,
  type Estudio,
} from "./soporte-acceso.js";
import { type Peticion, type Resp, type UsuarioPrueba } from "./soporte.js";

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
export interface OpcionesSuscripcion {
  estado?: "prueba" | "activa";
  rucsExtra?: number;
}
export interface SuperAdmin extends UsuarioPrueba {
  cookie: string;
  csrf: string;
}

export interface BancoPlanes {
  b: Banco;
  sql: Banco["sql"];
  /** Plan propio (código único `t3_…`), por omisión 10 RUCs, 3 usuarios, sin extra, activo. */
  plan(o?: OpcionesPlan): Promise<PlanPrueba>;
  /** Cambia por SQL el plan (y opcionalmente estado y extra) de la suscripción de un estudio. */
  fijarPlan(tenantId: string, plan: PlanPrueba | string, o?: OpcionesSuscripcion): Promise<void>;
  /** Edita por SQL columnas del plan (CA-2, CA-7: sin reiniciar la app). */
  editarPlan(plan: PlanPrueba, cambios: Record<string, unknown>): Promise<void>;
  /** Estudio con Dueño con sesión y suscripción a `plan` (o sin suscripción si `plan` es `null`). */
  estudio(plan: PlanPrueba | null, o?: OpcionesSuscripcion): Promise<Estudio>;
  /** Super-admin con sesión viva y sin membresías. */
  superAdmin(): Promise<SuperAdmin>;
  /** Petición HTTP como `a` a una ruta de plataforma o de cuenta (sin estudio activo, con CSRF). */
  como(a: { cookie: string; csrf: string }, metodo: NonNullable<Peticion["metodo"]>, ruta: string, cuerpo?: unknown, extra?: Partial<Peticion>): Promise<Resp>;
  /** Correo nuevo para el registro (se limpia al cerrar, con el estudio y la cuenta que cree). */
  correoRegistro(): string;
  /** Anota un correo cuyo estudio/cuenta/pendiente se borra al cerrar. */
  rastrearRegistro(correo: string): void;
  cerrar(): Promise<void>;
}

export async function abrirBancoPlanes(cupo?: object, extra: Record<string, unknown> = {}): Promise<BancoPlanes> {
  const b = await abrirBanco(cupo, extra);
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!url) throw new Error("falta MIGRATIONS_DATABASE_URL para las pruebas de planes");
  const admin = createDb({ rolApp: "contapp_backend", url, poolMax: 2 });
  const sql: Banco["sql"] = async (texto, valores) => (await admin.pool.query(texto, valores)).rows;
  const marca = randomBytes(4).toString("hex");
  const admins: string[] = [];
  const correos: string[] = [];
  let n = 0;

  const plan: BancoPlanes["plan"] = async (o = {}) => {
    const codigo = `t3_${marca}_${++n}`;
    const filas = await sql<{ id: string }>(
      `insert into plan (codigo, nombre, precio_mensual, precio_anual, max_rucs, max_usuarios, precio_ruc_extra,
                         max_rucs_extra, frecuencia_buzon_min, features, activo)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11) returning id`,
      [
        codigo,
        `Plan T3 ${codigo}`,
        o.precioMensual ?? "50.00",
        o.precioAnual === undefined ? null : o.precioAnual,
        o.maxRucs ?? 10,
        o.maxUsuarios === undefined ? 3 : o.maxUsuarios,
        o.precioRucExtra ?? "4.00",
        o.maxRucsExtra ?? 0,
        o.frecuenciaBuzonMin ?? 1440,
        JSON.stringify(o.features ?? {}),
        o.activo ?? true,
      ],
    );
    return { id: filas[0]!.id, codigo };
  };

  const idDe = (p: PlanPrueba | string): string => (typeof p === "string" ? p : p.id);

  const fijarPlan: BancoPlanes["fijarPlan"] = async (tenantId, p, o = {}) => {
    const estado = o.estado ?? "activa";
    const r = await sql(
      `update suscripcion set plan_id = $2, estado = $3, rucs_extra_contratados = $4,
              prueba_vence_en = case when $3 = 'prueba' then now() + interval '14 days' else null end
        where tenant_id = $1 returning id`,
      [tenantId, idDe(p), estado, o.rucsExtra ?? 0],
    );
    if (r.length !== 1) throw new Error("el estudio de prueba no tiene suscripción (¿T5 aplicada?)");
  };

  const editarPlan: BancoPlanes["editarPlan"] = async (p, cambios) => {
    const cols = Object.keys(cambios);
    if (cols.length === 0) return;
    if (!cols.every((c) => /^[a-z_]+$/.test(c))) throw new Error("columna inválida");
    const set = cols.map((c, i) => `${c} = $${i + 2}`).join(", ");
    await sql(`update plan set ${set} where id = $1`, [p.id, ...cols.map((c) => cambios[c])]);
  };

  const estudio: BancoPlanes["estudio"] = async (p, o = {}) => {
    const e = await b.estudio(); // trae suscripción corporativo/activa
    if (p === null) await sql("delete from suscripcion where tenant_id = $1", [e.tenantId]);
    else await fijarPlan(e.tenantId, p, o);
    return e;
  };

  const como: BancoPlanes["como"] = (a, metodo, ruta, cuerpo, extra = {}) =>
    b.h.pedir({
      metodo,
      ruta,
      cuerpo: cuerpo ?? (metodo === "POST" || metodo === "PUT" || metodo === "PATCH" ? {} : undefined),
      cookie: a.cookie,
      csrf: a.csrf,
      ...extra,
    });

  const superAdmin: BancoPlanes["superAdmin"] = async () => {
    const u = await b.h.crearUsuario({ estudios: [] });
    await sql("insert into admin_plataforma (usuario_id) values ($1)", [u.id]);
    admins.push(u.id);
    const s = await b.h.entrar(u);
    return { ...u, cookie: s.cookie, csrf: s.csrf };
  };

  const correoRegistro = (): string => {
    const c = `reg${randomBytes(6).toString("hex")}@t006.contapp.test`;
    correos.push(c);
    return c;
  };

  /** Borra lo que el registro creó para `correos`: pendientes, sesiones, membresías, estudio(s) y cuenta. */
  async function limpiarRegistro(): Promise<void> {
    const c = await admin.pool.connect();
    // Consulta de limpieza de mejor esfuerzo; el texto llega por variable, como en soporte-acceso.ts.
    const q = async (texto: string, valores?: unknown[]) => c.query(texto, valores);
    const intentar = async (texto: string, valores?: unknown[]) => {
      try {
        await q(texto, valores);
      } catch {
        /* mejor esfuerzo */
      }
    };
    try {
      await intentar("delete from auth.registro_pendiente where correo = any($1)", [correos]);
      const us = (await q("select id from usuario where email = any($1)", [correos])).rows.map((f: any) => f.id);
      if (us.length === 0) return;
      const ts = (await q("select distinct tenant_id from membresia where usuario_id = any($1)", [us])).rows.map(
        (f: any) => f.tenant_id,
      );
      await q("begin");
      try {
        // El trigger del último Dueño impide borrar al único Dueño de un estudio de prueba.
        await q("alter table membresia disable trigger user");
        for (const t of ts) {
          await q("delete from auth.sesion where tenant_activo = $1", [t]);
          await q("delete from asignacion where tenant_id = $1", [t]);
          await q("delete from invitacion where tenant_id = $1", [t]);
          await q("delete from membresia where tenant_id = $1", [t]);
          await q("delete from cliente where tenant_id = $1", [t]);
          await q("delete from suscripcion where tenant_id = $1", [t]);
        }
        await q("alter table membresia enable trigger user");
        await q("commit");
      } catch {
        await intentar("rollback");
      }
      for (const id of us) {
        await intentar("delete from auth.sesion where usuario_id = $1", [id]);
        await intentar("delete from auth.token_recuperacion where usuario_id = $1", [id]);
        await intentar("delete from auth.usuario_contrasena where usuario_id = $1", [id]);
        await intentar("delete from membresia where usuario_id = $1", [id]);
        await intentar("delete from usuario where id = $1", [id]);
      }
      for (const t of ts) await intentar("delete from tenant where id = $1", [t]);
    } finally {
      c.release();
    }
  }

  return {
    b,
    sql,
    plan,
    fijarPlan,
    editarPlan,
    estudio,
    superAdmin,
    como,
    correoRegistro,
    rastrearRegistro: (c) => {
      correos.push(c);
    },
    cerrar: async () => {
      b.h.correo.liberar();
      await limpiarRegistro().catch(() => undefined);
      // Las suscripciones de los estudios de fixture se borran en b.cerrar(); los planes propios, después.
      if (admins.length > 0) {
        await sql("delete from admin_plataforma where usuario_id = any($1::uuid[])", [admins]).catch(() => undefined);
      }
      await b.cerrar();
      // Planes propios (de fixture o creados por la API de plataforma con código `t3_…`).
      await sql("delete from suscripcion where plan_id in (select id from plan where codigo like 't3\\_%')").catch(
        () => undefined,
      );
      await sql("delete from plan where codigo like 't3\\_%'").catch(() => undefined);
      await admin.close();
    },
  };
}

export type { Actor, Banco, Estudio };
