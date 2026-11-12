// Siembra por SQL (spec 018, D-4; plan «Soporte»): estudios, usuarios, membresías, clientes y compras
// directo en `contapp_e2e`, con la conexión de migraciones (superusuario), como `tests/aislamiento`.
// Cada prueba crea sus propios datos con correos únicos: no hay limpieza entre pruebas.
// Nunca toca otra BD que `contapp_e2e`: el constructor se niega con cualquier otra.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { SEED } from "@contapp/db";
import { Pool, type PoolClient } from "pg";
import { BD_E2E, RAIZ } from "./pila/entorno.js";

export type Rol = "dueno" | "admin" | "contador" | "asistente" | "lectura";
export type PlanCodigo =
  "prueba" | "independiente" | "estudio" | "estudio_pro" | "corporativo";
export type TipoAsignacion = "responsable" | "colaborador";

export interface Usuario {
  readonly id: string;
  readonly correo: string;
  readonly nombre: string;
  /** La contraseña de desarrollo del seed (`SEED.contrasenaDesarrollo`). */
  readonly contrasena: string;
  /** Estudio donde se creó; con varios estudios, pasa el otro a `entrar(usuario, tenantId)`. */
  readonly tenantId: string;
  readonly rol: Rol;
}

export interface Estudio {
  readonly tenantId: string;
  readonly nombre: string;
  readonly dueno: Usuario;
}

export interface Cliente {
  readonly id: string;
  readonly tenantId: string;
  readonly ruc: string;
  readonly razonSocial: string;
}

export interface OpcionesCliente {
  readonly ruc?: string;
  readonly razonSocial?: string;
  /** Usuario al que se asigna el cliente (el Dueño y el Admin ven todo sin asignación). */
  readonly asignadoA?: Usuario;
  readonly tipoAsignacion?: TipoAsignacion;
  readonly moneda?: "PEN" | "USD";
}

/** RUC de `fixtures/rucs-prueba.json` por rol, para que los flujos no repitan literales. */
export const RUCS = {
  contribuyente: "20700000002",
  sanJuan: "20700000011",
  mixta: "20700000045",
  icbper: "20700000053",
  usd: "20700000061",
  zapatilla: "20700000070",
  generico: "20700000096",
} as const;

interface RucPrueba {
  readonly ruc: string;
  readonly razonSocial: string;
}

function razonSocialDeFixture(ruc: string): string | undefined {
  const lista = JSON.parse(
    readFileSync(`${RAIZ}/fixtures/rucs-prueba.json`, "utf8"),
  ) as RucPrueba[];
  return lista.find((r) => r.ruc === ruc)?.razonSocial;
}

/** `e2e+<uuid>@contapp.test`: único por prueba. */
export function correoUnico(): string {
  return `e2e+${randomUUID()}@contapp.test`;
}

async function enTransaccion<T>(
  pool: Pool,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const salida = await fn(c);
    await c.query("commit");
    return salida;
  } catch (error) {
    await c.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}

/** Hash PHC argon2id de desarrollo: el mismo del primer usuario del seed (corresponde a `contrasenaDesarrollo`). */
function hashDesarrollo(): string {
  const hash = SEED.credenciales[0]?.hash;
  if (hash === undefined) throw new Error("El seed no trae credenciales.");
  return hash;
}

export class Siembra {
  private readonly pool: Pool;

  constructor(urlMigraciones: string) {
    if (new URL(urlMigraciones).pathname !== `/${BD_E2E}`) {
      throw new Error(`La siembra solo opera sobre ${BD_E2E}.`);
    }
    this.pool = new Pool({ connectionString: urlMigraciones, max: 3 });
  }

  async cerrar(): Promise<void> {
    await this.pool.end();
  }

  /** Un estudio con su suscripción y un Dueño que puede entrar. Plan por defecto: `corporativo` (sin tope). */
  async estudio(
    opciones: { plan?: PlanCodigo; nombre?: string } = {},
  ): Promise<Estudio> {
    const plan = opciones.plan ?? "corporativo";
    const nombre = opciones.nombre ?? `Estudio E2E ${randomUUID().slice(0, 8)}`;
    return enTransaccion(this.pool, async (c) => {
      const t = await c.query<{ id: string }>(
        "insert into tenant (nombre) values ($1) returning id",
        [nombre],
      );
      const tenantId = t.rows[0]?.id;
      if (tenantId === undefined) throw new Error("No se creó el estudio.");
      const enPrueba = plan === "prueba";
      const s = await c.query(
        `insert into suscripcion (tenant_id, plan_id, estado, prueba_vence_en)
         select $1::uuid, p.id, $3, case when $3 = 'prueba' then now() + interval '30 days' end
           from plan p where p.codigo = $2`,
        [tenantId, plan, enPrueba ? "prueba" : "activa"],
      );
      if (s.rowCount !== 1) throw new Error(`No existe el plan ${plan}.`);
      const dueno = await this.insertarUsuario(c, tenantId, "dueno", {
        nombre: "Dueño E2E",
      });
      return { tenantId, nombre, dueno };
    });
  }

  /** Un usuario nuevo con membresía activa en el estudio. */
  async miembro(
    tenantId: string,
    rol: Rol,
    opciones: { nombre?: string; correo?: string } = {},
  ): Promise<Usuario> {
    return enTransaccion(this.pool, (c) =>
      this.insertarUsuario(c, tenantId, rol, {
        nombre: opciones.nombre ?? `${rol} E2E`,
        ...(opciones.correo === undefined ? {} : { correo: opciones.correo }),
      }),
    );
  }

  /** Suma una membresía a un usuario que ya existe (usuario en dos estudios). Devuelve su vista en el nuevo estudio. */
  async membresia(
    usuario: Usuario,
    tenantId: string,
    rol: Rol,
  ): Promise<Usuario> {
    await this.pool.query(
      "insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, $3)",
      [tenantId, usuario.id, rol],
    );
    return { ...usuario, tenantId, rol };
  }

  /** Un cliente del estudio; por defecto el contribuyente de prueba (RUC 20700000002) y, si se pide, asignado. */
  async cliente(
    tenantId: string,
    opciones: OpcionesCliente = {},
  ): Promise<Cliente> {
    const ruc = opciones.ruc ?? RUCS.contribuyente;
    const razonSocial =
      opciones.razonSocial ?? razonSocialDeFixture(ruc) ?? `CLIENTE E2E ${ruc}`;
    return enTransaccion(this.pool, async (c) => {
      const r = await c.query<{ id: string }>(
        `insert into cliente (tenant_id, ruc, razon_social, moneda_habitual)
         values ($1, $2, $3, $4) returning id`,
        [tenantId, ruc, razonSocial, opciones.moneda ?? "PEN"],
      );
      const id = r.rows[0]?.id;
      if (id === undefined) throw new Error("No se creó el cliente.");
      if (opciones.asignadoA !== undefined) {
        await c.query(
          `insert into asignacion (tenant_id, cliente_id, usuario_id, tipo) values ($1, $2, $3, $4)`,
          [
            tenantId,
            id,
            opciones.asignadoA.id,
            opciones.tipoAsignacion ?? "responsable",
          ],
        );
      }
      return { id, tenantId, ruc, razonSocial };
    });
  }

  /** Asigna un cliente a un usuario del mismo estudio. */
  async asignar(
    cliente: Cliente,
    usuario: Usuario,
    tipo: TipoAsignacion = "colaborador",
  ): Promise<void> {
    await this.pool.query(
      `insert into asignacion (tenant_id, cliente_id, usuario_id, tipo) values ($1, $2, $3, $4)`,
      [cliente.tenantId, cliente.id, usuario.id, tipo],
    );
  }

  /**
   * `n` compras del SIRE ya cargadas (E-06, 5.000 filas) sin pasar por la descarga: una propuesta, las
   * compras y su versión 1 (`original`), todo con `generate_series`. Facturas F001 con BI 100.00, IGV 18.00
   * y total 118.00 de proveedores sintéticos; los números terminan en 0-6 (sin centinelas del mock).
   */
  async comprasPorSql(
    clienteId: string,
    periodo: string,
    n: number,
  ): Promise<void> {
    if (!/^\d{4}(0[1-9]|1[0-2])$/.test(periodo)) {
      throw new Error("El periodo debe ser AAAAMM.");
    }
    if (!Number.isInteger(n) || n < 1 || n > 20_000) {
      throw new Error("n debe ser un entero de 1 a 20.000.");
    }
    await enTransaccion(this.pool, async (c) => {
      const f = await c.query<{ tenant_id: string; usuario_id: string }>(
        `select c.tenant_id, m.usuario_id
           from cliente c
           join membresia m on m.tenant_id = c.tenant_id and m.rol = 'dueno'
          where c.id = $1 limit 1`,
        [clienteId],
      );
      const fila = f.rows[0];
      if (fila === undefined)
        throw new Error("Cliente sin Dueño o inexistente.");
      const propuestaId = randomUUID();
      const hash = randomUUID().replaceAll("-", "").repeat(2);
      await c.query(
        `insert into propuesta (id, tenant_id, cliente_id, periodo, libro, fuente, hash, filas_recibidas,
                                filas_nuevas, filas_iguales, filas_distintas, usuario_id)
         values ($1, $2, $3, $4, 'compras', 'api', $5, $6, $6, 0, 0, $7)`,
        [
          propuestaId,
          fila.tenant_id,
          clienteId,
          periodo,
          hash,
          n,
          fila.usuario_id,
        ],
      );
      // Número: i = 7q + r  ->  10q + r, que termina en 0-6.
      await c.query(
        `with g as (
           select i, ((i / 7) * 10 + (i % 7) + 1) as numero,
                  gen_random_uuid() as id
             from generate_series(0, $6::int - 1) as i
         ), c as (
           insert into compra (id, tenant_id, cliente_id, periodo, propuesta_id, clave, tipo_doc, serie, numero,
                               doc_tipo, doc_numero, razon_social, fecha, moneda, origen, version_vigente)
           select id, $1::uuid, $2::uuid, $3::text, $4::uuid,
                  '01|F001|' || numero || '|6|' || $5::text,
                  '01', 'F001', numero::text, '6', $5::text,
                  'PRUEBA PROVEEDOR ' || lpad(i::text, 5, '0') || ' S.A.C.',
                  (to_date($3::text || '01', 'YYYYMMDD') + (i % 28)), 'PEN', 'sire', 1
             from g
           returning id
         )
         insert into compra_version (tenant_id, compra_id, n, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng,
                                     no_gravado, isc, icbper, otros_tributos, total, accion)
         select $1::uuid, id, 1, 100.00, 18.00, 0, 0, 0, 0, 0, 0, 0, 0, 118.00, 'original' from c`,
        [fila.tenant_id, clienteId, periodo, propuestaId, RUCS.generico, n],
      );
    });
  }

  private async insertarUsuario(
    c: PoolClient,
    tenantId: string,
    rol: Rol,
    datos: { nombre: string; correo?: string },
  ): Promise<Usuario> {
    const correo = datos.correo ?? correoUnico();
    const u = await c.query<{ id: string }>(
      "insert into usuario (email, nombre) values ($1, $2) returning id",
      [correo, datos.nombre],
    );
    const id = u.rows[0]?.id;
    if (id === undefined) throw new Error("No se creó el usuario.");
    await c.query(
      "insert into auth.usuario_contrasena (usuario_id, hash, actualizada_en) values ($1, $2, now())",
      [id, hashDesarrollo()],
    );
    await c.query(
      "insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, $3)",
      [tenantId, id, rol],
    );
    return {
      id,
      correo,
      nombre: datos.nombre,
      contrasena: SEED.contrasenaDesarrollo,
      tenantId,
      rol,
    };
  }
}
