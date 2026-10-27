/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y cuerpos JSON dinámicos en pruebas */
// Soporte de las pruebas de integración HTTP de 005 (T4). Encima de `soporte.ts` (004): estudios
// dedicados por archivo (así no chocan con otros procesos de prueba ni con el seed), miembros por rol
// con sesión viva, clientes y asignaciones sembrados por SQL (conexión de migraciones) y un espía de
// `CupoUsuarios`. Solo usa el contrato público: HTTP, `crearApp` y las tablas.
import { randomBytes, randomUUID } from "node:crypto";
import { createDb } from "@contapp/db";
import {
  abrirHarness,
  COOKIE,
  cookieSesion,
  hashViejo,
  PWD,
  type Harness,
  type Peticion,
  type Resp,
  type UsuarioPrueba,
} from "./soporte.js";

export type RolSistema = "dueno" | "admin" | "contador" | "asistente" | "lectura";
export const ROLES: readonly RolSistema[] = ["dueno", "admin", "contador", "asistente", "lectura"];

/** Quien llama: usuario de prueba con su rol, su estudio activo y su sesión viva. */
export interface Actor extends UsuarioPrueba {
  rol: RolSistema;
  tenantId: string;
  cookie: string;
  csrf: string;
}
export interface Estudio {
  tenantId: string;
  titular: Actor;
}

/* ---------------- Banco de pruebas ---------------- */
export interface Banco {
  h: Harness;
  /** Estudio nuevo con un Dueño titular que ya tiene sesión. */
  estudio(): Promise<Estudio>;
  /** Miembro activo con ese rol; `sesion: false` lo crea sin iniciar sesión (más barato). */
  miembro(tenantId: string, rol: RolSistema, o?: { sesion?: boolean }): Promise<Actor>;
  /** Inicia sesión y deja `tenantId` como estudio activo. */
  sesion(u: UsuarioPrueba, tenantId: string): Promise<{ cookie: string; csrf: string }>;
  /** `n` clientes ordenados por razón social (nombres con índice de 4 dígitos). */
  clientes(tenantId: string, n: number): Promise<string[]>;
  /** `n` usuarios con membresía activa, sin credenciales ni sesión. Devuelve sus IDs. */
  miembrosMasivos(tenantId: string, n: number, rol?: RolSistema): Promise<string[]>;
  /** Siembra una asignación por SQL (sin pasar por la API). */
  asignar(tenantId: string, clienteId: string, usuarioId: string, tipo: "responsable" | "colaborador"): Promise<void>;
  /** Una petición autenticada como `a` (cookie, CSRF y `X-Estudio` del estudio activo). */
  llamar(
    a: { cookie: string; csrf: string; tenantId: string },
    metodo: NonNullable<Peticion["metodo"]>,
    ruta: string,
    cuerpo?: unknown,
    extra?: Partial<Peticion>,
  ): Promise<Resp>;
  /** Correo que no existe en la plataforma (se limpia al cerrar). */
  correoNuevo(): string;
  /** Registra un usuario creado fuera de `crearUsuario` (p. ej. por aceptar una invitación) para limpiarlo. */
  rastrearCorreo(correo: string): void;
  /** Invita con `a` y devuelve la respuesta y el token del correo (si lo hubo). */
  invitar(a: Actor, correo: string, rol: RolSistema): Promise<{ r: Resp; token: string | null }>;
  /** Token del último correo enviado a `correo` (espera a la cola). */
  tokenDe(correo: string): Promise<string>;
  /** Filas por SQL de migraciones. */
  sql<T = any>(texto: string, valores?: unknown[]): Promise<T[]>;
  cerrar(): Promise<void>;
}

/** `cupo`: adaptador de `CupoUsuarios` a inyectar en `crearApp` (por defecto, el sin límite de 005). */
export async function abrirBanco(cupo?: object): Promise<Banco> {
  const h = await abrirHarness(cupo ? { cupoUsuarios: cupo } : {});
  const urlAdmin = process.env.MIGRATIONS_DATABASE_URL;
  if (!urlAdmin) throw new Error("falta MIGRATIONS_DATABASE_URL para las pruebas de acceso");
  const admin = createDb({ rolApp: "contapp_backend", url: urlAdmin, poolMax: 2 });

  const tenants: string[] = [];
  const usuarios = new Set<string>();
  const correos: string[] = [];
  const contadorRuc = new Map<string, number>();
  let hashRapido: string | null = null;

  const sql: Banco["sql"] = async (texto, valores) => (await admin.pool.query(texto, valores)).rows;

  const sesion: Banco["sesion"] = async (u, tenantId) => {
    const s = await h.entrar(u);
    let { cookie, csrf } = s;
    if (s.estudioActivo?.id !== tenantId) {
      const r = await h.pedir({ ruta: "/auth/estudio", cuerpo: { tenantId }, cookie, csrf });
      if (r.status !== 200) throw new Error(`no se pudo elegir el estudio de prueba: HTTP ${r.status}`);
      cookie = `${COOKIE}=${cookieSesion(r)!.valor}`;
      const e = await h.pedir({ ruta: "/auth/sesion", cookie });
      csrf = e.body.csrf;
    }
    return { cookie, csrf };
  };

  const miembro: Banco["miembro"] = async (tenantId, rol, o = {}) => {
    const conSesion = o.sesion !== false;
    if (!conSesion && hashRapido === null) hashRapido = await hashViejo(PWD);
    const u = await h.crearUsuario(conSesion ? {} : { hash: hashRapido as string });
    usuarios.add(u.id);
    await h.sql("insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, $3)", [tenantId, u.id, rol]);
    const s = conSesion ? await sesion(u, tenantId) : { cookie: "", csrf: "" };
    return { ...u, rol, tenantId, ...s };
  };

  const llamar: Banco["llamar"] = (a, metodo, ruta, cuerpo, extra = {}) =>
    h.pedir({
      metodo,
      ruta,
      cuerpo: cuerpo ?? (metodo === "POST" || metodo === "PUT" || metodo === "PATCH" ? {} : undefined),
      cookie: a.cookie,
      csrf: a.csrf,
      estudio: a.tenantId,
      ...extra,
    });

  const tokenDe: Banco["tokenDe"] = async (correo) => {
    await h.correo.esperar(correo, 1);
    return h.correo.tokenDe(correo);
  };

  async function limpiar(): Promise<void> {
    const c = await admin.pool.connect();
    let enTx = false;
    const intentar = async (texto: string, valores?: unknown[]) => {
      try {
        if (enTx) await c.query("savepoint paso");
        await c.query(texto, valores);
        if (enTx) await c.query("release savepoint paso");
      } catch {
        /* limpieza de mejor esfuerzo, como en soporte.ts */
        if (enTx) await c.query("rollback to savepoint paso").catch(() => undefined);
      }
    };
    try {
      const todos = [...usuarios];
      if (correos.length > 0) {
        const r = await c.query("select id from usuario where email = any($1)", [correos]).catch(() => null);
        for (const f of r?.rows ?? []) todos.push(f.id);
      }
      await c.query("begin");
      enTx = true;
      // El trigger del último Dueño (D10) impide borrar al único Dueño de un estudio de prueba.
      await intentar("alter table membresia disable trigger user");
      for (const t of tenants) {
        await intentar("delete from auth.sesion where tenant_activo = $1", [t]);
        await intentar("delete from asignacion where tenant_id = $1", [t]);
        await intentar("delete from invitacion where tenant_id = $1", [t]);
        await intentar("delete from membresia where tenant_id = $1", [t]);
        await intentar("delete from cliente where tenant_id = $1", [t]);
      }
      await intentar("alter table membresia enable trigger user");
      await c.query("commit").catch(() => c.query("rollback"));
      enTx = false;
      for (const id of todos) {
        await intentar("delete from auth.sesion where usuario_id = $1", [id]);
        await intentar("delete from auth.token_recuperacion where usuario_id = $1", [id]);
        await intentar("delete from auth.usuario_contrasena where usuario_id = $1", [id]);
        await intentar("delete from membresia where usuario_id = $1", [id]);
        await intentar("delete from usuario where id = $1", [id]);
      }
      for (const t of tenants) await intentar("delete from tenant where id = $1", [t]);
    } finally {
      c.release();
    }
  }

  return {
    h,
    estudio: async () => {
      const id = randomUUID();
      await h.sql("insert into tenant (id, nombre) values ($1, $2)", [id, `Estudio t005 ${id.slice(0, 8)}`]);
      tenants.push(id);
      const titular = await miembro(id, "dueno");
      return { tenantId: id, titular };
    },
    miembro,
    sesion,
    clientes: async (tenantId, n) => {
      const desde = (contadorRuc.get(tenantId) ?? 0) + 1;
      contadorRuc.set(tenantId, desde + n - 1);
      const filas = await sql<{ id: string }>(
        `with ins as (
           insert into cliente (tenant_id, ruc, razon_social)
           select $1, '20' || lpad(g::text, 9, '0'), 'Cliente ' || lpad(g::text, 4, '0')
             from generate_series($2::int, $3::int) g
           returning id, ruc)
         select id from ins order by ruc`,
        [tenantId, desde, desde + n - 1],
      );
      return filas.map((f) => f.id);
    },
    miembrosMasivos: async (tenantId, n, rol = "contador") => {
      const sufijo = randomBytes(4).toString("hex");
      const filas = await sql<{ id: string }>(
        `insert into usuario (email, nombre)
         select 'm' || g || '-' || $1 || '@t005.contapp.test', 'Miembro ' || g
           from generate_series(1, $2::int) g
         returning id`,
        [sufijo, n],
      );
      const ids = filas.map((f) => f.id);
      for (const id of ids) usuarios.add(id);
      await sql(
        "insert into membresia (tenant_id, usuario_id, rol) select $1, u, $3 from unnest($2::uuid[]) u",
        [tenantId, ids, rol],
      );
      return ids;
    },
    asignar: async (tenantId, clienteId, usuarioId, tipo) => {
      await sql("insert into asignacion (tenant_id, cliente_id, usuario_id, tipo) values ($1, $2, $3, $4)", [
        tenantId,
        clienteId,
        usuarioId,
        tipo,
      ]);
    },
    llamar,
    correoNuevo: () => {
      const c = h.correoInexistente();
      correos.push(c);
      return c;
    },
    rastrearCorreo: (c) => {
      correos.push(c);
    },
    invitar: async (a, correo, rol) => {
      const r = await llamar(a, "POST", "/invitaciones", { correo, rol });
      if (r.status !== 201) return { r, token: null };
      return { r, token: await tokenDe(correo) };
    },
    tokenDe,
    sql,
    cerrar: async () => {
      h.correo.liberar();
      await limpiar();
      await h.cerrar();
      await admin.close();
    },
  };
}

/** Estado de una respuesta comparable: `2xx` o el código exacto. */
export const clase = (r: Resp): number | "2xx" => (r.status >= 200 && r.status < 300 ? "2xx" : r.status);
