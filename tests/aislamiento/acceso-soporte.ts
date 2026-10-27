// Soporte de las pruebas de BD de la spec 005 (T2). No es una prueba (no termina en .spec.ts).
// Cada archivo crea sus propios estudios, usuarios, clientes e invitaciones con la conexion administrativa
// (MIGRATIONS_DATABASE_URL, superusuario) y los borra al final; asi ninguna prueba depende del seed ni lo toca.
// Canarios y hashes sinteticos: nunca contrasenas ni tokens reales.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { Escenario, hashFalso, type UsuarioPrueba } from "./auth-soporte";

export type RolMembresia = "dueno" | "admin" | "contador" | "asistente" | "lectura";

export interface InvitacionPrueba {
  id: string;
  tenantId: string;
  correo: string;
  rol: RolMembresia;
  /** Token en claro SOLO dentro de la prueba; en BD se guarda su SHA-256 (32 B). */
  token: Buffer;
  tokenHash: Buffer;
}

export const sha256 = (b: Buffer): Buffer => createHash("sha256").update(b).digest();

export class EscenarioAcceso {
  readonly esc: Escenario;
  readonly estudios: string[] = [];
  private readonly usuariosPropios: string[] = [];
  private readonly correos: string[] = [];
  private n = 0;

  constructor(readonly admin: Pool) {
    this.esc = new Escenario(admin);
  }

  /** Estudio nuevo (fila de `tenant`); su nombre es unico para reconocerlo en las respuestas. */
  async estudio(): Promise<{ id: string; nombre: string }> {
    const id = randomUUID();
    const nombre = `Estudio T2 ${this.esc.marca}-${++this.n}`;
    await this.admin.query("insert into tenant (id, nombre) values ($1, $2)", [id, nombre]);
    this.estudios.push(id);
    return { id, nombre };
  }

  /** Usuario con credencial sintetica y SIN membresias. */
  async cuenta(): Promise<UsuarioPrueba> {
    const u = await this.esc.usuario({ estudios: [], contrasena: true });
    this.usuariosPropios.push(u.id);
    return u;
  }

  /** Usuario con membresia en `tenantId` con el rol dado (`desactivada` la deja desactivada). */
  async miembro(
    tenantId: string,
    rol: RolMembresia = "contador",
    o: { desactivada?: boolean } = {},
  ): Promise<UsuarioPrueba> {
    const u = await this.cuenta();
    await this.membresia(tenantId, u.id, rol, o);
    return u;
  }

  async membresia(
    tenantId: string,
    usuarioId: string,
    rol: RolMembresia,
    o: { desactivada?: boolean } = {},
  ): Promise<void> {
    await this.admin.query(
      `insert into membresia (tenant_id, usuario_id, rol, desactivada_en)
       values ($1, $2, $3, case when $4::boolean then now() else null end)`,
      [tenantId, usuarioId, rol, o.desactivada ?? false],
    );
  }

  private rucs = 0;

  /** Cliente con RUC unico dentro del estudio; devuelve el id. */
  async cliente(tenantId: string, razonSocial?: string): Promise<string> {
    const n = ++this.rucs;
    const r = await this.admin.query(
      "insert into cliente (tenant_id, ruc, razon_social) values ($1, $2, $3) returning id",
      [tenantId, this.ruc(n), razonSocial ?? `Cliente T2 ${this.esc.marca}-${n}`],
    );
    return r.rows[0].id as string;
  }

  /** `cuantos` clientes de una vez (razon social con relleno de ceros: el orden alfabetico es el de creacion). */
  async clientes(tenantId: string, cuantos: number): Promise<string[]> {
    const desde = this.rucs + 1;
    this.rucs += cuantos;
    const r = await this.admin.query(
      `insert into cliente (tenant_id, ruc, razon_social)
       select $1, '2' || $2 || lpad(g::text, 5, '0'), 'Cliente T2 ' || lpad(g::text, 5, '0')
         from generate_series($3::int, $4::int) g
       returning id, razon_social`,
      [tenantId, this.prefijoRuc(), desde, desde + cuantos - 1],
    );
    return (r.rows as { id: string; razon_social: string }[])
      .sort((x, y) => x.razon_social.localeCompare(y.razon_social))
      .map((x) => x.id);
  }

  private prefijoRuc(): string {
    return String(parseInt(this.esc.marca, 16) % 100000).padStart(5, "0");
  }

  private ruc(n: number): string {
    return `2${this.prefijoRuc()}${String(n).padStart(5, "0")}`;
  }

  async asignar(
    tenantId: string,
    clienteId: string,
    usuarioId: string,
    tipo: "responsable" | "colaborador" = "colaborador",
  ): Promise<void> {
    await this.admin.query(
      "insert into asignacion (tenant_id, cliente_id, usuario_id, tipo) values ($1, $2, $3, $4)",
      [tenantId, clienteId, usuarioId, tipo],
    );
  }

  /** Invitacion insertada directamente (sin pasar por el repositorio). */
  async invitacion(
    tenantId: string,
    o: {
      invitadoPor: string;
      correo?: string;
      rol?: RolMembresia;
      vencida?: boolean;
      aceptada?: boolean;
      revocada?: boolean;
    },
  ): Promise<InvitacionPrueba> {
    const correo = o.correo ?? this.esc.correoNuevo();
    this.correos.push(correo);
    const token = randomBytes(32);
    const tokenHash = sha256(token);
    const rol = o.rol ?? "contador";
    const r = await this.admin.query(
      `insert into invitacion (tenant_id, correo, rol, invitado_por, token_hash, creada_en, vence_en, aceptada_en, revocada_en)
       values ($1, $2, $3, $4, $5,
               now() - case when $6::boolean then interval '4 days' else interval '0' end,
               case when $6::boolean then now() - interval '1 day' else now() + interval '72 hours' end,
               case when $7::boolean then now() else null end,
               case when $8::boolean then now() else null end)
       returning id`,
      [tenantId, correo, rol, o.invitadoPor, tokenHash, o.vencida ?? false, o.aceptada ?? false, o.revocada ?? false],
    );
    return { id: r.rows[0].id as string, tenantId, correo, rol, token, tokenHash };
  }

  /** Registra un correo para que la limpieza borre el usuario que cree `invitacion_aceptar_nueva`. */
  recordarCorreo(correo: string): void {
    this.correos.push(correo);
  }

  async limpiar(): Promise<void> {
    // Cada paso va por separado y tolera que falte una tabla (en rojo, antes de las migraciones de 005, ni
    // `asignacion` ni `invitacion` existen y aun asi hay que borrar los estudios y usuarios creados).
    const c = await this.admin.connect();
    try {
      // Sin disparadores: el trigger del ultimo Dueño (005) impediria borrar al Dueño de un estudio de prueba.
      await c.query("SET session_replication_role = replica");
      const usuarios = (
        await c.query("select id from usuario where email = any($1::text[]) or id = any($2::uuid[])", [
          this.correos,
          this.usuariosPropios,
        ])
      ).rows.map((x) => x.id as string);
      const t = this.estudios;
      const pasos: Array<[string, unknown[]]> = [
        ["delete from asignacion where tenant_id = any($1::uuid[])", [t]],
        ["delete from invitacion where tenant_id = any($1::uuid[])", [t]],
        ["delete from auth.sesion where usuario_id = any($1::uuid[])", [usuarios]],
        ["delete from auth.token_recuperacion where usuario_id = any($1::uuid[])", [usuarios]],
        ["delete from auth.usuario_contrasena where usuario_id = any($1::uuid[])", [usuarios]],
        ["delete from membresia where tenant_id = any($1::uuid[]) or usuario_id = any($2::uuid[])", [t, usuarios]],
        ["delete from cliente where tenant_id = any($1::uuid[])", [t]],
        ["delete from usuario where id = any($1::uuid[])", [usuarios]],
        ["delete from tenant where id = any($1::uuid[])", [t]],
      ];
      for (const [sql, v] of pasos) await c.query(sql, v).catch(() => undefined);
    } catch {
      /* limpieza de mejor esfuerzo */
    } finally {
      c.release(true); // se destruye la conexion: no vuelve al pool con session_replication_role = replica
    }
    await this.esc.limpiar();
  }
}

export const hashDeContrasenaFalso = hashFalso;
