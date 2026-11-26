// Spec 030 (T1, rojo hasta 0082) · CA-11: el guard (`miembroActual`, que ahora trae rol, rol_id, permisos y alcance en la misma consulta), el listado
// de roles y `acceso.permisos_membresia` no crecen con los roles de OTROS estudios. Se mide contra la BD real: minimo de 6 corridas por tamano
// (intercalando las tres operaciones), sin tope absoluto en ms (la maquina de CI varia): lo que se protege es la complejidad. Una consulta que recorre
// `rol` / `rol_permiso` enteras crece ~ 20x al pasar de 2 000 a 40 000 roles ajenos; una por indice no crece. No se sube un tope para que pase.
// Va en `*.rendimiento.spec.ts` y queda fuera de la cobertura.
// Rojo por: las tablas rol / rol_permiso y la columna membresia.rol_id aun no existen (0082) y `listarRoles` no se exporta de @contapp/db.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auth-soporte";
import { minimoDe } from "./auth-totp-soporte";
import { EscenarioRoles, PERMISOS_ASIGNABLES } from "./roles-soporte";
import type { Tx } from "./soporte";

let admin: Pool;
let er: EscenarioRoles;
const marca = `Ruido-T1-${Math.random().toString(16).slice(2, 8)}-`;
const CORRIDAS = 6;
const LLAMADAS = 30;

beforeAll(() => {
  admin = abrirAdmin(6);
  er = new EscenarioRoles(admin);
});
afterAll(async () => {
  const c = await admin.connect();
  try {
    await c.query("SET session_replication_role = replica");
    const ids = "select id from tenant where nombre like $1";
    await c.query(`delete from rol_permiso where tenant_id in (${ids})`, [`${marca}%`]).catch(() => undefined);
    await c.query(`delete from rol where tenant_id in (${ids})`, [`${marca}%`]).catch(() => undefined);
    await c.query("delete from tenant where nombre like $1", [`${marca}%`]).catch(() => undefined);
  } finally {
    c.release(true); // la conexion con session_replication_role = replica no vuelve al pool
  }
  await er?.limpiar();
  await er?.cerrar();
  await admin?.end();
});

/** Agrega `estudios` estudios ajenos con 20 roles de 10 permisos cada uno (el tope de U9), por lotes SQL. */
async function ruido(desde: number, estudios: number): Promise<void> {
  const permisos = PERMISOS_ASIGNABLES.slice(0, 10);
  const patron = `${marca}${desde}-%`;
  await admin.query("insert into tenant (nombre) select $1::text || $2::text || '-' || g from generate_series(1, $3::int) g", [marca, desde, estudios]);
  await admin.query(
    `insert into rol (tenant_id, id, nombre, alcance)
     select t.id, gen_random_uuid(), 'Ruido ' || k, 'asignado' from tenant t cross join generate_series(1, 20) k where t.nombre like $1`,
    [patron],
  );
  await admin.query(
    `insert into rol_permiso (tenant_id, rol_id, permiso)
     select r.tenant_id, r.id, p from rol r join tenant t on t.id = r.tenant_id cross join unnest($2::text[]) p where t.nombre like $1`,
    [patron, permisos],
  );
  await admin.query("analyze rol");
  await admin.query("analyze rol_permiso");
}

describe("CA-11 · escala con los roles de otros estudios", () => {
  it(`miembroActual (guard), listarRoles y permisos_membresia: 40 000 roles ajenos no cuestan mas de 3x que 2 000 (minimo de ${CORRIDAS} corridas)`, async () => {
    const miembroActual = exportado<(tx: Tx, usuarioId: string) => Promise<unknown>>("miembroActual");
    const listarRoles = exportado<(tx: Tx) => Promise<unknown[]>>("listarRoles");
    const db = er.backend(4);
    const x = await er.estudio();
    await er.miembro(x.id, "dueno");
    const actor = await er.actor(x.id, ["clientes.ver", "buzon.ver", "sire.descargar", "reglas.ver"], "asignado");
    for (let i = 0; i < 4; i++) await er.rol(x.id, { permisos: ["clientes.ver", "buzon.ver"] });
    const ctx = { tenantId: x.id, userId: actor.id };

    // sanidad: lo que se mide devuelve lo correcto (no una respuesta vacia y rapida)
    const m = await db.withTenant(ctx, (tx) => miembroActual(tx, actor.id));
    expect(m).toMatchObject({ usuarioId: actor.id, rol: "propio", rolId: actor.rolId });
    expect((await db.withTenant(ctx, (tx) => listarRoles(tx))).length).toBe(5);
    expect((await admin.query("select permisos from acceso.permisos_membresia($1, $2)", [x.id, actor.id])).rows[0].permisos).toHaveLength(4);

    const medir = async () => {
      const guard = await minimoDe(CORRIDAS, async () => {
        for (let i = 0; i < LLAMADAS; i++) await db.withTenant(ctx, (tx) => miembroActual(tx, actor.id));
      });
      const listado = await minimoDe(CORRIDAS, async () => {
        for (let i = 0; i < LLAMADAS; i++) await db.withTenant(ctx, (tx) => listarRoles(tx));
      });
      const resolvedor = await minimoDe(CORRIDAS, async () => {
        for (let i = 0; i < LLAMADAS; i++) await admin.query("select * from acceso.permisos_membresia($1, $2)", [x.id, actor.id]);
      });
      return { guard, listado, resolvedor };
    };

    await ruido(1, 100); // 2 000 roles ajenos
    const chico = await medir();
    await ruido(2, 1900); // 38 000 mas: 40 000
    const grande = await medir();

    // piso de 5 ms por lado: con tiempos tan chicos el ruido del reloj dominaria la razon
    const razon = (g: number, c: number) => g / Math.max(c, 5);
    for (const k of ["guard", "listado", "resolvedor"] as const) {
      expect(razon(grande[k], chico[k]), `${k}: ${chico[k].toFixed(1)} ms -> ${grande[k].toFixed(1)} ms por ${LLAMADAS} llamadas`).toBeLessThanOrEqual(3);
    }
  }, 600_000);
});
