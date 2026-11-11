// Soporte de las pruebas de BD de notificaciones de la spec 017 (T3, rojo). No es una prueba (no termina en .spec.ts).
// Cada archivo crea sus propios estudios, usuarios, clientes, credenciales y trabajos con la conexion administrativa
// (MIGRATIONS_DATABASE_URL, superusuario) y los borra al final; ninguna prueba depende del seed ni lo toca.
// Las limpiezas COMUNES (EscenarioAcceso.limpiar y demas) son de T2; este soporte solo agrega, antes de delegar en ellas,
// un borrado defensivo de las filas de `notificacion`, `plan_aviso` y `auditoria` de SUS estudios (modo replica: el trigger
// de inmutabilidad bloquea el DELETE incluso al superusuario), en una conexion que se destruye al terminar.
//
// CONTRATO que fijan las pruebas de T3 (lo implementan T7 = migracion 0043 y T8 = packages/db). Todo repositorio recibe la `tx`
// de withTenant como primer argumento; los cursores y filas salen en camelCase con Date para las fechas.
//   Tabla `notificacion` (D-8): id uuid v7, tenant_id, usuario_id, tipo ('credencial_invalida' | 'trabajo_terminado' |
//        'plan_limite' | 'buzon_critico'), cliente_id?, trabajo_id?, params jsonb objeto <= 1024 bytes, clave_dedupe text
//        unica por (tenant_id, usuario_id), creada_en, leida_en. Tabla `plan_aviso` sin grants a los roles de la app.
//   listarNotificaciones(tx, alcance, { antes?: { en: Date, id: string }, limite? }) -> FilaNotificacion[]
//        { id, tipo, creadaEn: Date, leidaEn: Date | null, clienteId: string | null, trabajoId: string | null, params }
//        (puede traer ademas `razonSocial`); solo las del usuario del contexto; de la mas nueva a la mas vieja por
//        (creadaEn, id) desc; `limite` por omision y maximo 50; el cursor es el `{ en: creadaEn, id }` de la ultima fila.
//   contarNoLeidas(tx, alcance, tope = 100) -> number   (min(no leidas visibles, tope))
//   marcarLeida(tx, id) -> boolean   (true si la notificacion es del usuario del contexto, aunque ya estuviera leida:
//        idempotente y `leida_en` conserva el primer valor; false si es ajena, de otro estudio o no existe, sin cambios)
//   marcarLeidasHasta(tx, alcance, hasta: Date) -> number   (marca las propias, visibles y no leidas con creada_en <= hasta;
//        devuelve cuantas marco)
//   destinatariosNuevos(tx) -> string[]   (usuarios, sin repetir, a los que esta transaccion les creo una notificacion)
//   purgarNotificaciones(tx, dias) -> number   (rol worker; envoltura de la funcion SQL notificacion_purgar)
//   resolverAutores(tx, ids: string[]) -> Map<string, { id, nombre: string | null, activo: boolean }>
//   SQL: notificaciones_de_esta_transaccion() -> setof uuid ; notificacion_purgar(p_dias int) -> int ; plan_aviso_recalcular(uuid).
//   Los avisos (credencial, trabajo, plan) los crean triggers SECURITY DEFINER en la misma transaccion del hecho (D-9).
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { EscenarioPlanes } from "./planes-soporte";
import { EscenarioTrabajos } from "./trabajos-soporte";

export type { ClientePrueba } from "./trabajos-soporte";
export { UUID, dormir, enTx, probar } from "./trabajos-soporte";
export { abrirAdmin, crearDb, exportado } from "./auth-soporte";

export interface FilaNotif {
  id: string;
  tenant_id: string;
  usuario_id: string;
  tipo: string;
  cliente_id: string | null;
  trabajo_id: string | null;
  params: Record<string, unknown>;
  clave_dedupe: string;
  creada_en: Date;
  leida_en: Date | null;
}

export interface OpcionesNotif {
  id?: string;
  tipo?: string;
  clienteId?: string | null;
  trabajoId?: string | null;
  params?: unknown;
  clave?: string;
  /** Antiguedad de `creada_en`, en segundos (sin microsegundos: los cursores viajan como Date). */
  hace?: number;
  /** Instante exacto de `creada_en` (gana sobre `hace`); sirve para empates. */
  creadaEn?: Date;
  leida?: boolean;
}

export const TIPOS_NOTIFICACION = [
  "credencial_invalida",
  "trabajo_terminado",
  "plan_limite",
  "buzon_critico",
] as const;

export const ROLES_APP_BD = ["contapp_backend", "contapp_worker", "contapp_app", "contapp_platform"] as const;

/** Escenario de 017/notificaciones: extiende los de 006 (planes) y 008 (trabajos y credenciales). */
export class EscenarioNotif {
  readonly et: EscenarioTrabajos;
  readonly ep: EscenarioPlanes;
  private n = 0;
  private readonly prefijo = String(parseInt(randomBytes(3).toString("hex"), 16) % 90000 + 10000);
  private rucs = 0;

  constructor(readonly admin: Pool) {
    this.et = new EscenarioTrabajos(admin);
    this.ep = new EscenarioPlanes(admin);
  }

  get estudios(): string[] {
    return [...this.et.ea.estudios, ...this.ep.ea.estudios];
  }

  /** Estudio sin suscripcion (credenciales y trabajos). */
  estudio() {
    return this.et.estudio();
  }

  /** Nombre unico para reconocer al usuario en las respuestas de `resolverAutores`. */
  async nombrar(usuarioId: string, nombre: string): Promise<void> {
    await this.admin.query("update usuario set nombre = $2 where id = $1", [usuarioId, nombre]);
  }

  /** Inserta una notificacion directamente (superusuario, sin pasar por los triggers de aviso). Devuelve su id. */
  async notificar(tenantId: string, usuarioId: string, o: OpcionesNotif = {}): Promise<string> {
    const id = o.id ?? randomUUID();
    await this.admin.query(
      `insert into notificacion (id, tenant_id, usuario_id, tipo, cliente_id, trabajo_id, params, clave_dedupe, creada_en, leida_en)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8,
               coalesce($11::timestamptz, date_trunc('milliseconds', now() - make_interval(secs => $9::int))),
               case when $10::boolean then now() else null end)`,
      [
        id,
        tenantId,
        usuarioId,
        o.tipo ?? "trabajo_terminado",
        o.clienteId ?? null,
        o.trabajoId ?? null,
        JSON.stringify(o.params ?? { tipoTrabajo: "prueba.eco", estado: "completado", motivo: null }),
        o.clave ?? `prueba:${id}`,
        o.hace ?? 0,
        o.leida ?? false,
        o.creadaEn ?? null,
      ],
    );
    return id;
  }

  /** `cuantas` notificaciones sin leer de golpe (clave unica por serie), de la mas vieja a la mas nueva. */
  async notificarVarias(tenantId: string, usuarioId: string, cuantas: number): Promise<void> {
    const serie = `serie:${++this.n}:${randomUUID()}`;
    await this.admin.query(
      `insert into notificacion (tenant_id, usuario_id, tipo, params, clave_dedupe, creada_en)
       select $1, $2, 'trabajo_terminado', '{"tipoTrabajo":"prueba.eco","estado":"completado","motivo":null}'::jsonb,
              $3 || ':' || g, date_trunc('milliseconds', now() - make_interval(secs => ($4::int - g)))
         from generate_series(1, $4::int) g`,
      [tenantId, usuarioId, serie, cuantas],
    );
  }

  /** Notificaciones del estudio (superusuario, ignora la RLS), de la mas vieja a la mas nueva. */
  async notifs(
    tenantId: string,
    f: { usuarioId?: string; tipo?: string; clienteId?: string } = {},
  ): Promise<FilaNotif[]> {
    const r = await this.admin.query(
      `select * from notificacion
        where tenant_id = $1
          and ($2::uuid is null or usuario_id = $2)
          and ($3::text is null or tipo = $3)
          and ($4::uuid is null or cliente_id = $4)
        order by creada_en, id`,
      [tenantId, f.usuarioId ?? null, f.tipo ?? null, f.clienteId ?? null],
    );
    return r.rows as FilaNotif[];
  }

  /** Avisos de limite del plan de un recurso y umbral, de un estudio: `[usuarioId, ...]` ordenados. */
  async avisosPlan(tenantId: string, recurso: "rucs" | "usuarios", umbral: 90 | 100): Promise<FilaNotif[]> {
    return (await this.notifs(tenantId, { tipo: "plan_limite" })).filter(
      (x) => x.params.recurso === recurso && Number(x.params.umbral) === umbral,
    );
  }

  /** `cuantos` clientes de una vez con RUC unico; acepta el pool o una conexion con transaccion abierta. */
  async clientes(
    tenantId: string,
    cuantos: number,
    c: Pick<Pool | PoolClient, "query"> = this.admin,
  ): Promise<string[]> {
    const desde = this.rucs + 1;
    this.rucs += cuantos;
    const r = await c.query(
      `insert into cliente (tenant_id, ruc, razon_social)
       select $1, '3' || $2 || lpad(g::text, 5, '0'), 'Cliente T3 ' || $2 || '-' || g
         from generate_series($3::int, $4::int) g
       returning id`,
      [tenantId, this.prefijo, desde, desde + cuantos - 1],
    );
    return (r.rows as { id: string }[]).map((x) => x.id);
  }

  /** Borrado defensivo de las filas de 017 de estos estudios (ver cabecera); luego delega en las limpiezas de 006 y 008. */
  async limpiar(): Promise<void> {
    const c = await this.admin.connect();
    try {
      await c.query("SET session_replication_role = replica");
      for (const tabla of ["notificacion", "plan_aviso", "auditoria"]) {
        await c.query(`delete from ${tabla} where tenant_id = any($1::uuid[])`, [this.estudios]).catch(() => undefined);
      }
    } catch {
      /* limpieza de mejor esfuerzo */
    } finally {
      c.release(true); // se destruye: no vuelve al pool con session_replication_role = replica
    }
    await this.et.limpiar();
    await this.ep.limpiar();
  }
}

export const sobreFalso = () => ({
  ciphertext: randomBytes(64),
  nonce: randomBytes(12),
  tag: randomBytes(16),
  dekEnvuelta: randomBytes(512),
  kekId: "k1",
  version: 1 as const,
});

/** Privilegio de tabla de un rol (false tambien si el rol no tiene ninguno). */
export async function privTabla(pool: Pool, rol: string, tabla: string, priv: string): Promise<boolean> {
  const r = await pool.query("select has_table_privilege($1, $2, $3) as ok", [rol, `public.${tabla}`, priv]);
  return r.rows[0].ok === true;
}

/** Columnas de la tabla sobre las que el rol tiene el privilegio (por columna o heredado de la tabla). */
export async function columnasConPriv(pool: Pool, rol: string, tabla: string, priv: string): Promise<string[]> {
  const r = await pool.query(
    `select a.attname as col
       from pg_attribute a
      where a.attrelid = $2::regclass and a.attnum > 0 and not a.attisdropped
        and has_column_privilege($1, $2::regclass, a.attname, $3)
      order by a.attname`,
    [rol, `public.${tabla}`, priv],
  );
  return r.rows.map((x) => x.col as string);
}
