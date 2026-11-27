// Siembra y limpieza de la cuenta segura por SQL (spec 029, T11). Misma regla que `siembra.ts`: solo opera sobre la BD de la
// E2E con la conexión de migraciones (superusuario).
//
//  - `superAdmin()`: un usuario con alta en `admin_plataforma` y SIN membresía (como `uPlataforma` del seed).
//  - `registrar()`: anota estudios y usuarios que creó la prueba (con `Siembra`) para borrarlos al terminar.
//  - `limpiar()`: en `session_replication_role = replica` borra, antes del usuario, `auth.totp_recuperacion`, `auth.totp`,
//    `auth.cuenta_evento` y las sesiones; y, antes del estudio, toda tabla con FK a `tenant` (descubierta por catálogo).
//    Lanza si algo queda. Con `E2E_CONSERVAR_BD=1` la BD sobrevive a la corrida, así que no deja datos de esta prueba.
import { randomUUID } from "node:crypto";
import { SEED } from "@contapp/db";
import { Pool, type PoolClient } from "pg";
import { BD_E2E } from "./pila/entorno.js";
import { correoUnico, type Estudio, type Usuario } from "./siembra.js";

export interface Cuenta {
  readonly id: string;
  readonly correo: string;
  readonly nombre: string;
  readonly contrasena: string;
}

interface FilaFk {
  tabla: string;
  columna: string;
}

const ident = (nombre: string): string => `"${nombre.replaceAll('"', '""')}"`;

export class SiembraCuenta {
  private readonly pool: Pool;
  private readonly usuarios = new Set<string>();
  private readonly estudios = new Set<string>();

  constructor(urlMigraciones: string) {
    if (new URL(urlMigraciones).pathname !== `/${BD_E2E}`) {
      throw new Error(`La siembra de cuenta solo opera sobre ${BD_E2E}.`);
    }
    this.pool = new Pool({ connectionString: urlMigraciones, max: 2 });
  }

  /** Un super-admin de plataforma real: alta en `admin_plataforma`, sin membresía y con la contraseña de desarrollo. */
  async superAdmin(): Promise<Cuenta> {
    const hash = SEED.credenciales[0]?.hash;
    if (hash === undefined) throw new Error("El seed no trae credenciales.");
    const correo = correoUnico();
    const nombre = `Super-admin E2E ${randomUUID().slice(0, 8)}`;
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const u = await c.query<{ id: string }>(
        "insert into usuario (email, nombre) values ($1, $2) returning id",
        [correo, nombre],
      );
      const id = u.rows[0]?.id;
      if (id === undefined) throw new Error("No se creó el super-admin.");
      await c.query(
        "insert into auth.usuario_contrasena (usuario_id, hash, actualizada_en) values ($1, $2, now())",
        [id, hash],
      );
      await c.query("insert into admin_plataforma (usuario_id) values ($1)", [
        id,
      ]);
      await c.query("commit");
      this.usuarios.add(id);
      return { id, correo, nombre, contrasena: SEED.contrasenaDesarrollo };
    } catch (error) {
      await c.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  }

  /** Anota lo que la prueba creó con `Siembra` para borrarlo en `limpiar()`. */
  registrar(estudio: Estudio, ...miembros: Usuario[]): void {
    this.estudios.add(estudio.tenantId);
    this.usuarios.add(estudio.dueno.id);
    for (const m of miembros) this.usuarios.add(m.id);
  }

  /** Lo que hay en `auth.totp` del usuario, como texto: para comprobar que el secreto no está en claro (CA-6, D1). */
  async volcadoTotp(usuarioId: string): Promise<string> {
    const r = await this.pool.query(
      "select t::text as fila from auth.totp t where t.usuario_id = $1",
      [usuarioId],
    );
    const r2 = await this.pool.query(
      "select r::text as fila from auth.totp_recuperacion r where r.usuario_id = $1",
      [usuarioId],
    );
    return [...r.rows, ...r2.rows].map((f) => String(f.fila)).join("\n");
  }

  /** Los tipos de evento de `auth.cuenta_evento` del usuario, del más viejo al más nuevo. */
  async eventos(usuarioId: string): Promise<string[]> {
    const r = await this.pool.query<{ tipo: string }>(
      "select tipo from auth.cuenta_evento where usuario_id = $1 order by creado_en, id",
      [usuarioId],
    );
    return r.rows.map((f) => f.tipo);
  }

  /** `auth.sesion` vigentes (no revocadas) del usuario. */
  async sesionesVigentes(usuarioId: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      "select count(*)::text as n from auth.sesion where usuario_id = $1 and revocada_en is null",
      [usuarioId],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  /** ¿El usuario tiene una membresía en ese estudio? (para comprobar que una invitación no se aceptó). */
  async esMiembro(usuarioId: string, tenantId: string): Promise<boolean> {
    const r = await this.pool.query(
      "select 1 from membresia where usuario_id = $1 and tenant_id = $2",
      [usuarioId, tenantId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async cerrar(): Promise<void> {
    await this.pool.end();
  }

  /** Borra lo registrado (usuarios y estudios) y cierra la conexión. Lanza si algo queda. */
  async limpiar(): Promise<void> {
    try {
      const usuarios = [...this.usuarios];
      const estudios = [...this.estudios];
      if (usuarios.length === 0 && estudios.length === 0) return;
      const c = await this.pool.connect();
      try {
        await c.query("begin");
        await c.query("set local session_replication_role = replica");
        await this.borrarUsuarios(c, usuarios);
        await this.borrarEstudios(c, estudios);
        await c.query("commit");
      } catch (error) {
        await c.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        c.release();
      }
      await this.verificarVacio(usuarios, estudios);
    } finally {
      await this.cerrar();
    }
  }

  private async fkA(
    c: Pool | PoolClient,
    tabla: "public.usuario" | "public.tenant",
  ): Promise<FilaFk[]> {
    const r = await c.query<FilaFk>(
      `select format('%I.%I', n.nspname, cl.relname) as tabla, a.attname as columna
         from pg_constraint k
         join pg_class cl on cl.oid = k.conrelid
         join pg_namespace n on n.oid = cl.relnamespace
         join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
        where k.contype = 'f' and k.confrelid = $1::regclass and cardinality(k.conkey) = 1`,
      [tabla],
    );
    return r.rows;
  }

  private async borrarUsuarios(c: PoolClient, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    // Primero lo de la cuenta segura (no depende de que la FK exista), luego sesiones y todo lo que apunte al usuario.
    const primero = [
      ["auth.cuenta_evento", "usuario_id"],
      ["auth.totp_recuperacion", "usuario_id"],
      ["auth.totp", "usuario_id"],
      ["auth.sesion", "usuario_id"],
      ["auth.token_recuperacion", "usuario_id"],
    ] as const;
    for (const [tabla, columna] of primero) {
      await c.query(`delete from ${tabla} where ${columna} = any($1::uuid[])`, [
        ids,
      ]);
    }
    const resto = (await this.fkA(c, "public.usuario")).filter(
      (f) => f.tabla !== "public.usuario",
    );
    for (const f of resto) {
      await c.query(
        `delete from ${f.tabla} where ${ident(f.columna)} = any($1::uuid[])`,
        [ids],
      );
    }
    await c.query("delete from public.usuario where id = any($1::uuid[])", [
      ids,
    ]);
  }

  private async borrarEstudios(c: PoolClient, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    for (const f of await this.fkA(c, "public.tenant")) {
      await c.query(
        `delete from ${f.tabla} where ${ident(f.columna)} = any($1::uuid[])`,
        [ids],
      );
    }
    await c.query("delete from public.tenant where id = any($1::uuid[])", [
      ids,
    ]);
  }

  private async verificarVacio(
    usuarios: string[],
    estudios: string[],
  ): Promise<void> {
    const pool = new Pool({
      connectionString: process.env.MIGRATIONS_DATABASE_URL,
      max: 1,
    });
    try {
      const restos: string[] = [];
      const revisar = async (
        tabla: string,
        columna: string,
        ids: string[],
      ): Promise<void> => {
        if (ids.length === 0) return;
        const r = await pool.query<{ n: string }>(
          `select count(*)::text as n from ${tabla} where ${ident(columna)} = any($1::uuid[])`,
          [ids],
        );
        if (Number(r.rows[0]?.n ?? 0) > 0) restos.push(`${tabla}.${columna}`);
      };
      for (const t of [
        "auth.cuenta_evento",
        "auth.totp_recuperacion",
        "auth.totp",
        "auth.sesion",
      ]) {
        await revisar(t, "usuario_id", usuarios);
      }
      for (const f of await this.fkA(pool, "public.usuario")) {
        await revisar(f.tabla, f.columna, usuarios);
      }
      await revisar("public.usuario", "id", usuarios);
      for (const f of await this.fkA(pool, "public.tenant")) {
        await revisar(f.tabla, f.columna, estudios);
      }
      await revisar("public.tenant", "id", estudios);
      if (restos.length > 0) {
        throw new Error(
          `La limpieza de la cuenta segura dejó filas en: ${restos.join(", ")}.`,
        );
      }
    } finally {
      await pool.end();
    }
  }
}
