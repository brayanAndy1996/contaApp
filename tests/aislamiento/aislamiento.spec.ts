// CA-5 (aislamiento entre estudios, HU-40): simetrico (A contra B y B contra A) y para ambos roles.
// Todo cambio se hace dentro de una transaccion que se revierte (enRollback / intentar).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clientesDe,
  crearDb,
  enRollback,
  idsDe,
  intentar,
  otro,
  ROLES_APP,
  TABLAS_NEGOCIO,
  tenantDe,
  usuarioNoMiembro,
  type ContappDb,
  type Estudio,
  type TablaNegocio,
} from "./soporte";

const DIRECCIONES: { yo: Estudio; ajeno: Estudio }[] = [
  { yo: "A", ajeno: "B" },
  { yo: "B", ajeno: "A" },
];

function insercion(tabla: TablaNegocio, tenantId: string, usuarioId: string, ruc: string): [string, unknown[]] {
  return tabla === "cliente"
    ? [`insert into cliente (tenant_id, ruc, razon_social) values ($1, $2, 'Nuevo')`, [tenantId, ruc]]
    : [`insert into membresia (tenant_id, usuario_id, rol) values ($1, $2, 'admin')`, [tenantId, usuarioId]];
}

// 005: membresia.rol tiene CHECK (D21) y el trigger del ultimo Dueno (D10) impide degradar al unico Dueno de
// cada estudio; 'rol = rol' es un valor valido que no cambia el rol, y rowCount sigue midiendo cuantas filas
// alcanza el UPDATE (solo las propias), que es lo que prueba el aislamiento.
const asignacion = (tabla: TablaNegocio) => (tabla === "cliente" ? "razon_social = 'hackeado'" : "rol = rol");

describe.each(ROLES_APP)("CA-5 rol %s", (rolApp) => {
  let db: ContappDb;
  beforeAll(() => {
    db = crearDb(rolApp);
  });
  afterAll(async () => {
    await db?.close();
  });

  describe.each(DIRECCIONES)("withTenant($yo) contra datos de $ajeno", ({ yo, ajeno }) => {
    const ctx = () => ({ tenantId: tenantDe(yo) });

    it.each(TABLAS_NEGOCIO)("%s: ve sus filas y ninguna del otro estudio", async (tabla) => {
      const propios = await idsDe(db, yo, tabla);
      const ajenos = await idsDe(db, ajeno, tabla);
      expect(propios.length).toBeGreaterThan(0);
      expect(ajenos.length).toBeGreaterThan(0);
      const vistos = await db.withTenant(
        ctx(),
        async (tx) => (await tx.query(`select id, tenant_id from ${tabla}`)).rows,
      );
      expect(vistos.map((r) => r.id).sort()).toEqual([...propios].sort());
      expect(vistos.every((r) => r.tenant_id === tenantDe(yo))).toBe(true);
      expect(propios.some((id) => ajenos.includes(id))).toBe(false);
    });

    it.each(TABLAS_NEGOCIO)("%s: leer por ID filas del otro estudio devuelve 0", async (tabla) => {
      const ajenos = await idsDe(db, ajeno, tabla);
      const r = await db.withTenant(ctx(), async (tx) => {
        const porId = [];
        for (const id of ajenos) porId.push((await tx.query(`select * from ${tabla} where id = $1`, [id])).rows.length);
        const porTenant = (await tx.query(`select * from ${tabla} where tenant_id = $1`, [tenantDe(ajeno)])).rows
          .length;
        return { porId, porTenant };
      });
      expect(r.porId.every((n) => n === 0)).toBe(true);
      expect(r.porTenant).toBe(0);
    });

    it.each(TABLAS_NEGOCIO)("%s: lote que mezcla IDs propios y ajenos devuelve solo los propios", async (tabla) => {
      const propios = await idsDe(db, yo, tabla);
      const ajenos = await idsDe(db, ajeno, tabla);
      const r = await db.withTenant(
        ctx(),
        async (tx) =>
          (await tx.query(`select id from ${tabla} where id = any($1::uuid[])`, [[...propios, ...ajenos]])).rows,
      );
      expect(r.map((x) => x.id).sort()).toEqual([...propios].sort());
      const soloAjenos = await db.withTenant(
        ctx(),
        async (tx) => (await tx.query(`select id from ${tabla} where id = any($1::uuid[])`, [ajenos])).rows,
      );
      expect(soloAjenos).toHaveLength(0);
    });

    it.each(TABLAS_NEGOCIO)("%s: UPDATE y DELETE sobre filas del otro estudio afectan 0 filas", async (tabla) => {
      const ajenos = await idsDe(db, ajeno, tabla);
      const u = await intentar(db, ctx(), `update ${tabla} set ${asignacion(tabla)} where id = any($1::uuid[])`, [
        ajenos,
      ]);
      const d = await intentar(db, ctx(), `delete from ${tabla} where id = any($1::uuid[])`, [ajenos]);
      expect(u).toEqual({ ok: true, rowCount: 0 });
      expect(d).toEqual({ ok: true, rowCount: 0 });
      // un UPDATE/DELETE sin WHERE solo alcanza las filas propias
      const propios = await idsDe(db, yo, tabla);
      const uTodo = await intentar(db, ctx(), `update ${tabla} set ${asignacion(tabla)}`);
      expect(uTodo).toEqual({ ok: true, rowCount: propios.length });
    });

    it.each(TABLAS_NEGOCIO)("%s: INSERT con tenant_id del otro estudio es rechazado por WITH CHECK", async (tabla) => {
      const [sql, valores] = insercion(tabla, tenantDe(ajeno), usuarioNoMiembro(ajeno), "20999999991");
      const r = await intentar(db, ctx(), sql, valores);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("42501");
        expect(r.message).toMatch(/row-level security/i);
      }
    });

    it.each(TABLAS_NEGOCIO)("%s: UPDATE que cambia tenant_id al del otro estudio es rechazado", async (tabla) => {
      const propios = await idsDe(db, yo, tabla);
      const r = await intentar(db, ctx(), `update ${tabla} set tenant_id = $1 where id = $2`, [
        tenantDe(ajeno),
        propios[0],
      ]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("42501");
    });

    it.each(TABLAS_NEGOCIO)("%s: control positivo, INSERT con el tenant propio funciona", async (tabla) => {
      const [sql, valores] = insercion(tabla, tenantDe(yo), usuarioNoMiembro(yo), "20999999991");
      const r = await intentar(db, ctx(), sql, valores);
      expect(r).toEqual({ ok: true, rowCount: 1 });
    });

    it("el tenant_id por defecto de un INSERT es el del contexto", async () => {
      const r = await enRollback(
        db,
        ctx(),
        async (tx) =>
          (
            await tx.query(
              `insert into cliente (ruc, razon_social) values ('20999999992', 'Sin tenant explicito') returning tenant_id`,
            )
          ).rows[0],
      );
      expect(r.tenant_id).toBe(tenantDe(yo));
    });
  });

  it("los clientes del seed de cada estudio son los esperados (3 por estudio)", async () => {
    for (const e of ["A", "B"] as Estudio[]) {
      const ids = await idsDe(db, e, "cliente");
      expect(ids.sort()).toEqual(
        clientesDe(e)
          .map((c) => c.id)
          .sort(),
      );
      expect(otro(e)).not.toBe(e);
    }
  });
});
