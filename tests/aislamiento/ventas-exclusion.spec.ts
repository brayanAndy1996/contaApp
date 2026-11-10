// Spec 012b (T4, rojo): exclusion de ventas del SIRE con error (`venta_exclusion`, 0039; P-8, D12, CA-15, CA-16) contra la BD real:
// tabla, RLS, grants exactos, CHECK, triggers, una sola vigente por venta, repositorios (`excluirVenta`, `restaurarVenta`,
// `exclusionVigente`), la lectura de ventas con `exclusion` y las listas que usa el previo (`leerFilasReemplazoVentas`,
// `leerExcluidasVentas`). Hasta T10 fallan por tabla o funcion inexistente. Contrato: encabezado de `archivos-soporte.ts`.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auth-soporte";
import {
  abrirPool,
  filasRaw,
  intentar,
  type ContappDb,
  type Tx,
} from "./soporte";
import { codigo, crearDb, type ClientePrueba } from "./trabajos-soporte";
import { barrera } from "./compras-soporte";
import {
  checksDe,
  columnasDe,
  fksDe,
  funcionesSinSearchPath,
  grantsColumnas,
  grantsTabla,
  rlsDe,
  triggersDe,
  unicasDe,
} from "./archivos-catalogo";
import {
  codigoRepo,
  contarEn,
  EscenarioArchivos,
  PERIODO,
} from "./archivos-soporte";

interface ExclusionVenta {
  id: string;
  ventaId: string;
  motivo: string;
  excluidaPor: string;
  excluidaEn: Date;
  restauradaPor: string | null;
  restauradaEn: Date | null;
}
interface VentaConExclusion {
  id: string;
  clave: string;
  origen: string;
  baseGravada: string;
  exclusion: { motivo: string; por: string; en: Date } | null;
  [k: string]: unknown;
}
interface DatosExcluir {
  clienteId: string;
  periodo: string;
  ventaId: string;
  motivo: string;
  usuarioId: string;
}
const excluirVenta = (tx: Tx, d: DatosExcluir) =>
  exportado<(tx: Tx, d: DatosExcluir) => Promise<ExclusionVenta | null>>(
    "excluirVenta",
  )(tx, d);
const restaurarVenta = (tx: Tx, ventaId: string, usuarioId: string) =>
  exportado<(tx: Tx, v: string, u: string) => Promise<boolean>>(
    "restaurarVenta",
  )(tx, ventaId, usuarioId);
const exclusionVigente = (tx: Tx, ventaId: string) =>
  exportado<(tx: Tx, v: string) => Promise<ExclusionVenta | null>>(
    "exclusionVigente",
  )(tx, ventaId);
const listarVentas = (tx: Tx, c: string, p: string) =>
  exportado<
    (
      tx: Tx,
      c: string,
      p: string,
      f: unknown,
    ) => Promise<{ filas: VentaConExclusion[]; total: number }>
  >("listarVentas")(tx, c, p, { pagina: 1, tamano: 50 });
const leerFilasVentas = (tx: Tx, c: string, p: string) =>
  exportado<(tx: Tx, c: string, p: string) => Promise<VentaConExclusion[]>>(
    "leerFilasVentas",
  )(tx, c, p);
const leerFilasReemplazoVentas = <T>(
  tx: Tx,
  c: string,
  p: string,
  aFila: (v: VentaConExclusion) => T,
) =>
  exportado<
    (
      tx: Tx,
      c: string,
      p: string,
      f: (v: VentaConExclusion) => T,
    ) => Promise<{ original: T[]; vigente: T[] }>
  >("leerFilasReemplazoVentas")(tx, c, p, aFila);
const leerExcluidasVentas = (tx: Tx, c: string, p: string) =>
  exportado<
    (
      tx: Tx,
      c: string,
      p: string,
    ) => Promise<
      {
        ventaId: string;
        tipo: string;
        serie: string;
        numero: string;
        motivo: string;
      }[]
    >
  >("leerExcluidasVentas")(tx, c, p);

let admin: Pool;
let app: Pool;
let ec: EscenarioArchivos;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let cx: ClientePrueba;
let cy: ClientePrueba;
let ux: string;
let ux2: string;
let uy: string;

beforeAll(async () => {
  admin = abrirAdmin(10);
  app = abrirPool(2);
  ec = new EscenarioArchivos(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  cx = await ec.cliente(X);
  cy = await ec.cliente(Y);
  ux = await ec.usuarioDe(X);
  ux2 = (await ec.miembro(X, "contador")).id;
  uy = await ec.usuarioDe(Y);
  backend = crearDb("contapp_backend", 8);
  worker = crearDb("contapp_worker", 4);
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close()].map((d) => d?.catch(() => undefined)),
  );
  await app?.end();
  await admin?.end();
});

const comoBackend = <T>(fn: (tx: Tx) => Promise<T>, tenantId = X) =>
  backend.withTenant({ tenantId }, fn);
const comoWorker = <T>(fn: (tx: Tx) => Promise<T>, tenantId = X) =>
  worker.withTenant({ tenantId }, fn);
/** Venta del SIRE (con su propuesta) de un cliente; devuelve su id. */
const ventaSire = (
  c: ClientePrueba,
  numero: string,
  o: Parameters<EscenarioArchivos["venta"]>[2] = {},
  t = X,
) => ec.venta(t, c, { origen: "sire", serie: "B001", numero, ...o });
const datos = (
  c: ClientePrueba,
  ventaId: string,
  o: Partial<DatosExcluir> = {},
): DatosExcluir => ({
  clienteId: c.id,
  periodo: PERIODO,
  ventaId,
  motivo: "Descuadrada en el SIRE; se corrige en facturacion",
  usuarioId: ux,
  ...o,
});
const INSERTAR = `insert into venta_exclusion (cliente_id, periodo, venta_id, motivo, excluida_por) values ($1, $2, $3, $4, $5) returning id`;
const ins = (
  c: ClientePrueba,
  v: string,
  o: { periodo?: string; motivo?: string | null; por?: string } = {},
) => [
  c.id,
  o.periodo ?? PERIODO,
  v,
  "motivo" in o ? o.motivo : "Descuadrada",
  o.por ?? ux,
];
const cerrar = `update venta_exclusion set restaurada_por = $2, restaurada_en = now() where id = $1`;

// =================================================================================================
describe("0039 · venta_exclusion: columnas, llaves y catalogo (P-8)", () => {
  it("tiene las 10 columnas del plan; solo restaurada_por y restaurada_en son opcionales", async () => {
    const cols = await columnasDe(admin, "venta_exclusion");
    expect(
      cols.map((c) => c.column_name).sort(),
      "falta venta_exclusion (migracion 0039)",
    ).toEqual(
      [
        "id",
        "tenant_id",
        "cliente_id",
        "periodo",
        "venta_id",
        "motivo",
        "excluida_por",
        "excluida_en",
        "restaurada_por",
        "restaurada_en",
      ].sort(),
    );
    expect(
      cols
        .filter((c) => c.is_nullable === "YES")
        .map((c) => c.column_name)
        .sort(),
    ).toEqual(["restaurada_en", "restaurada_por"]);
    const por = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(por.periodo.data_type).toBe("character");
    expect(por.venta_id.data_type).toBe("uuid");
    expect(por.excluida_en.data_type).toBe("timestamp with time zone");
    expect(por.excluida_en.defecto ?? "").toContain("now()");
  });

  it("FK compuestas: cliente, (tenant_id, venta_id) -> venta(tenant_id, id) y membresia para excluida_por y restaurada_por", async () => {
    const fk = await fksDe(admin, "venta_exclusion");
    expect(fk.find((f) => f.destino === "cliente")).toMatchObject({
      columnas: ["tenant_id", "cliente_id"],
      destinos: ["tenant_id", "id"],
    });
    expect(fk.find((f) => f.destino === "venta")).toMatchObject({
      columnas: ["tenant_id", "venta_id"],
      destinos: ["tenant_id", "id"],
    });
    const m = fk.filter((f) => f.destino === "membresia");
    expect(m.map((f) => f.columnas.join(",")).sort()).toEqual([
      "tenant_id,excluida_por",
      "tenant_id,restaurada_por",
    ]);
    for (const f of m) expect(f.destinos).toEqual(["tenant_id", "usuario_id"]);
  });

  it("unico PARCIAL (tenant_id, venta_id) WHERE restaurada_en IS NULL: una sola exclusion vigente por venta", async () => {
    const u = (await unicasDe(admin, "venta_exclusion")).find(
      (x) => !x.pk && x.columnas.join(",") === "tenant_id,venta_id",
    );
    expect(u, "falta el indice unico parcial").toBeDefined();
    expect(u?.parcial ?? "").toMatch(/restaurada_en IS NULL/i);
  });

  it("RLS ENABLE + FORCE con tenant_isolation FOR ALL; dueno contapp_migrator", async () => {
    const { tabla, politicas } = await rlsDe(admin, "venta_exclusion");
    expect(tabla, "falta venta_exclusion (0039)").toBeDefined();
    expect(tabla).toMatchObject({
      relrowsecurity: true,
      relforcerowsecurity: true,
      dueno: "contapp_migrator",
    });
    expect(politicas.map((p) => p.polname)).toEqual(["tenant_isolation"]);
    expect(politicas[0].polcmd).toBe("*");
    expect(politicas[0].usando).toContain("app.tenant_id");
    expect(politicas[0].con_check).toContain("app.tenant_id");
  });

  it("grants exactos: backend SELECT, INSERT y UPDATE solo de (restaurada_por, restaurada_en); worker solo SELECT; sin DELETE ni TRUNCATE", async () => {
    expect(await grantsTabla(admin, "venta_exclusion")).toEqual({
      contapp_backend: ["INSERT", "SELECT"],
      contapp_worker: ["SELECT"],
    });
    expect(await grantsColumnas(admin, "venta_exclusion")).toEqual({
      contapp_backend: { UPDATE: ["restaurada_en", "restaurada_por"] },
    });
  });

  it("triggers: uno BEFORE UPDATE OR DELETE y uno BEFORE INSERT, por fila, de dueno contapp_migrator y con search_path fijo", async () => {
    const t = await triggersDe(admin, "venta_exclusion");
    expect(t.length, "faltan los triggers de 0039").toBeGreaterThanOrEqual(2);
    expect(
      t.some((x) => x.porFila && x.antes && x.update && x.delete && !x.insert),
      "BEFORE UPDATE OR DELETE",
    ).toBe(true);
    expect(
      t.some((x) => x.porFila && x.antes && x.insert && !x.update),
      "BEFORE INSERT",
    ).toBe(true);
    for (const x of t) {
      expect(x.habilitado, x.nombre).toBe("O");
      expect(x.dueno, x.nombre).toBe("contapp_migrator");
    }
    expect(await funcionesSinSearchPath(admin, "venta_exclusion")).toEqual([]);
  });

  it("CHECK de motivo (1 a 200) y de restauracion completa existen", async () => {
    const defs = (await checksDe(admin, "venta_exclusion"))
      .map((c) => c.def)
      .join("\n");
    expect(defs, "falta la tabla").not.toBe("");
    expect(defs).toContain("motivo");
    expect(defs).toContain("restaurada_por");
    expect(defs).toContain("restaurada_en");
  });

  it("venta conserva su unica (tenant_id, id) para la FK, sin tocar sus filas", async () => {
    const u = (await unicasDe(admin, "venta")).map((x) => x.columnas.join(","));
    expect(u.some((c) => c === "tenant_id,id" || c === "id,tenant_id")).toBe(
      true,
    );
  });
});

// =================================================================================================
describe("0039 · el worker gana solo lectura de justificados y exclusiones (plan: «Nada mas»)", () => {
  it("venta_salto_justificado: el worker SELECT; el backend queda como estaba (SELECT, INSERT y UPDATE de revertido_*)", async () => {
    expect(await grantsTabla(admin, "venta_salto_justificado")).toEqual({
      contapp_backend: ["INSERT", "SELECT"],
      contapp_worker: ["SELECT"],
    });
    expect(await grantsColumnas(admin, "venta_salto_justificado")).toEqual({
      contapp_backend: { UPDATE: ["revertido_en", "revertido_por"] },
    });
  });

  it("el worker lee justificados y exclusiones de su estudio y de ningun otro", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    await ec.exclusion(X, c.id, v, { por: ux });
    const s = await ec.salto(X, c.id, { desde: 5, hasta: 5 });
    const leer = (tabla: string, id: string, t: string) =>
      comoWorker(
        (tx) => tx.query(`select id from ${tabla} where cliente_id = $1`, [id]),
        t,
      );
    expect((await leer("venta_exclusion", c.id, X)).rows).toHaveLength(1);
    expect(
      (await leer("venta_salto_justificado", c.id, X)).rows.map((r) => r.id),
    ).toEqual([s]);
    expect((await leer("venta_exclusion", c.id, Y)).rows).toEqual([]);
    expect((await leer("venta_salto_justificado", c.id, Y)).rows).toEqual([]);
  });

  it("el worker no escribe en ninguna de las dos: ni INSERT, ni UPDATE, ni DELETE (42501)", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    const e = await ec.exclusion(X, c.id, v, { por: ux });
    const s = await ec.salto(X, c.id, { desde: 7, hasta: 7 });
    const w = (sql: string, valores: unknown[]) =>
      intentar(worker, { tenantId: X }, sql, valores);
    expect(codigo(await w(INSERTAR, ins(c, v)))).toBe("42501");
    expect(codigo(await w(cerrar, [e, ux]))).toBe("42501");
    expect(
      codigo(
        await w("update venta_exclusion set motivo = 'x' where id = $1", [e]),
      ),
    ).toBe("42501");
    expect(
      codigo(await w("delete from venta_exclusion where id = $1", [e])),
    ).toBe("42501");
    expect(
      codigo(
        await w(
          "insert into venta_salto_justificado (cliente_id, periodo, tipo, serie, desde, hasta, comentario, usuario_id) values ($1, $2, '03', 'B001', 9, 9, 'x', $3)",
          [c.id, PERIODO, ux],
        ),
      ),
    ).toBe("42501");
    expect(
      codigo(
        await w(
          "update venta_salto_justificado set revertido_por = $2, revertido_en = now() where id = $1",
          [s, ux],
        ),
      ),
    ).toBe("42501");
    expect(
      codigo(await w("delete from venta_salto_justificado where id = $1", [s])),
    ).toBe("42501");
  });
});

// =================================================================================================
describe("0039 · CHECK de venta_exclusion (D12)", () => {
  it("motivo de 1 a 200 caracteres: vacio y 201 dan 23514; 1 y 200 entran; nulo da 23502", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    const b = (motivo: string | null) =>
      intentar(backend, { tenantId: X }, INSERTAR, ins(c, v, { motivo }));
    expect(codigo(await b(""))).toBe("23514");
    expect(codigo(await b("a".repeat(201)))).toBe("23514");
    expect(codigo(await b("a"))).toBe("ok");
    expect(codigo(await b("a".repeat(200)))).toBe("ok");
    expect(codigo(await b(null))).toBe("23502");
  });

  it("restauracion completa: restaurada_por sin restaurada_en, o al reves, no se guarda (23514)", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    const raw = (por: string | null, en: string | null) =>
      intentar(
        backend,
        { tenantId: X },
        `insert into venta_exclusion (cliente_id, periodo, venta_id, motivo, excluida_por, restaurada_por, restaurada_en)
         values ($1, $2, $3, 'm', $4, $5::uuid, $6::timestamptz)`,
        [c.id, PERIODO, v, ux, por, en],
      );
    expect(codigo(await raw(ux, null))).toBe("23514");
    expect(codigo(await raw(null, new Date().toISOString()))).toBe("23514");
    expect(codigo(await raw(ux, new Date().toISOString()))).toBe("ok");
    expect(codigo(await raw(null, null))).toBe("ok");
  });

  it("periodo AAAAMM; excluida_por y restaurada_por tienen que ser miembros del estudio (23503)", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    expect(
      codigo(
        await intentar(
          backend,
          { tenantId: X },
          INSERTAR,
          ins(c, v, { periodo: "2026-1" }),
        ),
      ),
    ).toBe("23514");
    expect(
      codigo(
        await intentar(
          backend,
          { tenantId: X },
          INSERTAR,
          ins(c, v, { por: uy }),
        ),
      ),
    ).toBe("23503");
  });
});

// =================================================================================================
describe("0039 · trigger de insercion: la venta es del SIRE y del mismo cliente y periodo (D12)", () => {
  it("una venta de origen sire del mismo cliente y periodo entra", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    expect(
      await intentar(backend, { tenantId: X }, INSERTAR, ins(c, v)),
    ).toEqual({ ok: true, rowCount: 1 });
  });

  it("una venta manual (agregada a mano) se rechaza (23514)", async () => {
    const c = await ec.cliente(X);
    const v = await ec.venta(X, c, {
      origen: "manual",
      serie: "B009",
      numero: "1",
    });
    expect(
      codigo(await intentar(backend, { tenantId: X }, INSERTAR, ins(c, v))),
    ).toBe("23514");
  });

  it("una venta de otro cliente del mismo estudio, o de otro periodo, se rechaza (23514)", async () => {
    const c = await ec.cliente(X);
    const otro = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    const vOtroPeriodo = await ventaSire(c, "2", { periodo: "202609" });
    expect(
      codigo(await intentar(backend, { tenantId: X }, INSERTAR, ins(otro, v))),
      "cliente ajeno",
    ).toBe("23514");
    expect(
      codigo(
        await intentar(
          backend,
          { tenantId: X },
          INSERTAR,
          ins(c, vOtroPeriodo),
        ),
      ),
      "periodo ajeno",
    ).toBe("23514");
    expect(
      codigo(
        await intentar(
          backend,
          { tenantId: X },
          INSERTAR,
          ins(c, vOtroPeriodo, { periodo: "202609" }),
        ),
      ),
      "mismo periodo que la venta",
    ).toBe("ok");
  });

  it("una venta inexistente o de otro estudio se rechaza (FK 23503 o el trigger 23514); nunca entra", async () => {
    const vy = await ventaSire(await ec.cliente(Y), "1", {}, Y);
    for (const venta of ["00000000-0000-4000-8000-000000000000", vy]) {
      const r = codigo(
        await intentar(backend, { tenantId: X }, INSERTAR, ins(cx, venta)),
      );
      expect(["23503", "23514"], venta).toContain(r);
    }
    expect(
      await contarEn(admin, "venta_exclusion", "venta_id = $1", [vy]),
    ).toBe(0);
  });

  it("el mensaje del trigger no lleva datos (ni la venta, ni el cliente, ni el motivo)", async () => {
    const c = await ec.cliente(X);
    const v = await ec.venta(X, c, {
      origen: "manual",
      serie: "B009",
      numero: "2",
    });
    const r = await intentar(
      backend,
      { tenantId: X },
      INSERTAR,
      ins(c, v, { motivo: "CANARIO-MOTIVO" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("23514");
      for (const d of [v, c.id, "CANARIO-MOTIVO", c.ruc])
        expect(r.message).not.toContain(d);
    }
  });
});

// =================================================================================================
describe("0039 · una sola exclusion vigente por venta (D12, CA-16)", () => {
  it("una segunda exclusion de la misma venta sin restaurar da 23505", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    await ec.exclusion(X, c.id, v, { por: ux });
    expect(
      codigo(await intentar(backend, { tenantId: X }, INSERTAR, ins(c, v))),
    ).toBe("23505");
  });

  it("5 rondas: dos inserciones simultaneas de la misma venta dejan una vigente; la otra recibe 23505", async () => {
    for (let ronda = 0; ronda < 5; ronda++) {
      const c = await ec.cliente(X);
      const v = await ventaSire(c, "1");
      const llegar = barrera(2);
      const una = () =>
        codigoRepo(
          comoBackend(async (tx) => {
            await llegar();
            return tx.query(INSERTAR, ins(c, v));
          }),
        );
      const r = await Promise.all([una(), una()]);
      expect(r.sort(), `ronda ${ronda}`).toEqual(["23505", "ok"]);
      expect(
        await contarEn(
          admin,
          "venta_exclusion",
          "venta_id = $1 and restaurada_en is null",
          [v],
        ),
      ).toBe(1);
    }
  });

  it("volver a excluir tras restaurar crea otra fila: quedan dos, una cerrada y una vigente", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    const e1 = await ec.exclusion(X, c.id, v, { por: ux, motivo: "primera" });
    await comoBackend((tx) => tx.query(cerrar, [e1, ux2]));
    expect(
      codigo(
        await intentar(
          backend,
          { tenantId: X },
          INSERTAR,
          ins(c, v, { motivo: "segunda" }),
        ),
      ),
    ).toBe("ok");
    await comoBackend((tx) =>
      tx.query(INSERTAR, ins(c, v, { motivo: "segunda" })),
    );
    const filas = await admin.query(
      "select motivo, restaurada_por, restaurada_en is null as vigente from venta_exclusion where venta_id = $1 order by excluida_en, id",
      [v],
    );
    expect(filas.rows).toEqual([
      { motivo: "primera", restaurada_por: ux2, vigente: false },
      { motivo: "segunda", restaurada_por: null, vigente: true },
    ]);
  });
});

// =================================================================================================
describe("0039 · cerrar una vez si; cambiar o borrar, nunca (trigger 42501, CA-16)", () => {
  it("el backend cierra una vigente una vez (restaurada_por y restaurada_en); la segunda vez da 42501 y no cambia nada", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    const e = await ec.exclusion(X, c.id, v, { por: ux });
    const primera = await comoBackend((tx) => tx.query(cerrar, [e, ux2]));
    expect(primera.rowCount).toBe(1);
    const antes = await admin.query(
      "select restaurada_por, restaurada_en from venta_exclusion where id = $1",
      [e],
    );
    expect(antes.rows[0].restaurada_por).toBe(ux2);
    expect(
      codigo(await intentar(backend, { tenantId: X }, cerrar, [e, ux])),
    ).toBe("42501");
    expect(
      (
        await admin.query(
          "select restaurada_por, restaurada_en from venta_exclusion where id = $1",
          [e],
        )
      ).rows,
    ).toEqual(antes.rows);
  });

  it("el backend no cambia el motivo, la venta, el cliente, el periodo ni quien excluyo (42501) y no borra (42501)", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    const e = await ec.exclusion(X, c.id, v, { por: ux, motivo: "original" });
    for (const sql of [
      "update venta_exclusion set motivo = 'cambiado' where id = $1",
      "update venta_exclusion set excluida_por = gen_random_uuid() where id = $1",
      "update venta_exclusion set venta_id = gen_random_uuid() where id = $1",
      "update venta_exclusion set periodo = '202601' where id = $1",
      "update venta_exclusion set excluida_en = now() - interval '1 day' where id = $1",
      "delete from venta_exclusion where id = $1",
    ]) {
      expect(
        codigo(await intentar(backend, { tenantId: X }, sql, [e])),
        sql,
      ).toBe("42501");
    }
    expect(
      (
        await admin.query("select motivo from venta_exclusion where id = $1", [
          e,
        ])
      ).rows,
    ).toEqual([{ motivo: "original" }]);
  });

  it("cerrar y cambiar el motivo a la vez, o reabrir una cerrada, tampoco (42501)", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    const e = await ec.exclusion(X, c.id, v, { por: ux, motivo: "original" });
    const mezcla = await admin
      .query(
        "update venta_exclusion set motivo = 'otro', restaurada_por = $2, restaurada_en = now() where id = $1",
        [e, ux],
      )
      .then(() => "ok")
      .catch((er: { code?: string }) => String(er.code));
    expect(mezcla, "superusuario: cerrar tocando otra columna").toBe("42501");
    const cerrada = await ec.exclusion(X, c.id, await ventaSire(c, "2"), {
      por: ux,
      restauradaPor: ux,
    });
    for (const sql of [
      "update venta_exclusion set restaurada_por = null, restaurada_en = null where id = $1",
      "update venta_exclusion set restaurada_en = now() where id = $1",
    ]) {
      const r = await admin
        .query(sql, [cerrada])
        .then(() => "ok")
        .catch((er: { code?: string }) => String(er.code));
      expect(["23514", "42501"], sql).toContain(r);
      expect(r, sql).not.toBe("ok");
    }
    expect(
      (
        await admin.query(
          "select restaurada_por is not null as cerrada from venta_exclusion where id = $1",
          [cerrada],
        )
      ).rows,
    ).toEqual([{ cerrada: true }]);
  });

  it("el superusuario tampoco cambia el motivo ni borra (el trigger aplica a todos); cerrar una cerrada da 42501", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    const e = await ec.exclusion(X, c.id, v, {
      por: ux,
      motivo: "original",
      restauradaPor: ux,
    });
    for (const [sql, valores] of [
      ["update venta_exclusion set motivo = 'cambiado' where id = $1", [e]],
      ["delete from venta_exclusion where id = $1", [e]],
      [
        "update venta_exclusion set restaurada_por = $2, restaurada_en = now() where id = $1",
        [e, ux2],
      ],
    ] as const) {
      const r = await admin
        .query(sql, [...valores])
        .then(() => "ok")
        .catch((er: { code?: string }) => String(er.code));
      expect(r, sql).toBe("42501");
    }
    expect(
      (
        await admin.query("select motivo from venta_exclusion where id = $1", [
          e,
        ])
      ).rows,
    ).toEqual([{ motivo: "original" }]);
  });

  it("cerrar con alguien que no es miembro del estudio da 23503; el estudio ajeno no cierra (0 filas)", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    const e = await ec.exclusion(X, c.id, v, { por: ux });
    expect(
      codigo(await intentar(backend, { tenantId: X }, cerrar, [e, uy])),
    ).toBe("23503");
    const ajeno = await backend.withTenant({ tenantId: Y }, (tx) =>
      tx.query(cerrar, [e, uy]),
    );
    expect(ajeno.rowCount).toBe(0);
    expect(
      await contarEn(
        admin,
        "venta_exclusion",
        "id = $1 and restaurada_en is null",
        [e],
      ),
    ).toBe(1);
  });
});

// =================================================================================================
describe("0039 · aislamiento por estudio (CA-9, CA-16)", () => {
  it("el otro estudio y la consulta sin contexto ven 0 filas; no se escribe con tenant ajeno", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    const e = await ec.exclusion(X, c.id, v, { por: ux });
    expect(
      (
        await comoBackend((tx) =>
          tx.query("select id from venta_exclusion where id = $1", [e]),
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await comoBackend(
          (tx) => tx.query("select id from venta_exclusion where id = $1", [e]),
          Y,
        )
      ).rows,
    ).toEqual([]);
    expect(
      await filasRaw(
        app,
        "contapp_backend",
        "select id from venta_exclusion where id = $1",
        [e],
      ),
    ).toEqual([]);
    const r = await intentar(
      backend,
      { tenantId: X },
      `insert into venta_exclusion (tenant_id, cliente_id, periodo, venta_id, motivo, excluida_por) values ($1, $2, $3, $4, 'x', $5)`,
      [Y, cy.id, PERIODO, await ventaSire(cy, "7", {}, Y), uy],
    );
    // El trigger de insercion corre antes que la politica y no ve la venta del estudio Y: 23514; la politica daria 42501.
    expect(["42501", "23514"]).toContain(codigo(r));
  });
});

// =================================================================================================
describe("excluirVenta · restaurarVenta · exclusionVigente (D12, CA-15)", () => {
  it("excluir devuelve la exclusion con quien, cuando y el motivo; exclusionVigente la lee", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    const e = await comoBackend((tx) =>
      excluirVenta(tx, datos(c, v, { motivo: "Descuadrada en el SIRE" })),
    );
    expect(e, "excluirVenta aun no esta implementada").toEqual({
      id: expect.any(String),
      ventaId: v,
      motivo: "Descuadrada en el SIRE",
      excluidaPor: ux,
      excluidaEn: expect.any(Date),
      restauradaPor: null,
      restauradaEn: null,
    });
    expect(await comoBackend((tx) => exclusionVigente(tx, v))).toEqual(e);
    expect(
      await comoWorker((tx) => exclusionVigente(tx, v)),
      "el worker la lee",
    ).toEqual(e);
  });

  it("excluir una venta ya excluida devuelve null (ya_excluida) y no crea otra fila", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    await comoBackend((tx) =>
      excluirVenta(tx, datos(c, v, { motivo: "primera" })),
    );
    expect(
      await comoBackend((tx) =>
        excluirVenta(tx, datos(c, v, { motivo: "segunda", usuarioId: ux2 })),
      ),
    ).toBeNull();
    expect(await contarEn(admin, "venta_exclusion", "venta_id = $1", [v])).toBe(
      1,
    );
    expect((await comoBackend((tx) => exclusionVigente(tx, v)))?.motivo).toBe(
      "primera",
    );
  });

  it("5 rondas: dos exclusiones simultaneas de la misma venta dejan una vigente: una devuelve la exclusion y la otra null", async () => {
    for (let ronda = 0; ronda < 5; ronda++) {
      const c = await ec.cliente(X);
      const v = await ventaSire(c, "1");
      const llegar = barrera(2);
      const una = (motivo: string) =>
        comoBackend(async (tx) => {
          await llegar();
          return excluirVenta(tx, datos(c, v, { motivo }));
        });
      const r = await Promise.all([una("a"), una("b")]);
      expect(
        r.filter((x) => x === null),
        `ronda ${ronda}`,
      ).toHaveLength(1);
      expect(
        r.filter((x) => x !== null),
        `ronda ${ronda}`,
      ).toHaveLength(1);
      expect(
        await contarEn(
          admin,
          "venta_exclusion",
          "venta_id = $1 and restaurada_en is null",
          [v],
        ),
      ).toBe(1);
    }
  });

  it("restaurar cierra la vigente (true) con quien y cuando; restaurar otra vez o una no excluida da false", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    const sinExcluir = await ventaSire(c, "2");
    await comoBackend((tx) => excluirVenta(tx, datos(c, v)));
    expect(await comoBackend((tx) => restaurarVenta(tx, v, ux2))).toBe(true);
    expect(await comoBackend((tx) => exclusionVigente(tx, v))).toBeNull();
    expect(
      await comoBackend((tx) => restaurarVenta(tx, v, ux2)),
      "ya restaurada",
    ).toBe(false);
    expect(
      await comoBackend((tx) => restaurarVenta(tx, sinExcluir, ux2)),
      "no excluida",
    ).toBe(false);
    expect(
      (
        await admin.query(
          "select excluida_por, restaurada_por, restaurada_en is not null as cerrada from venta_exclusion where venta_id = $1",
          [v],
        )
      ).rows,
    ).toEqual([{ excluida_por: ux, restaurada_por: ux2, cerrada: true }]);
  });

  it("5 rondas: dos restauraciones simultaneas: una devuelve true y la otra false", async () => {
    for (let ronda = 0; ronda < 5; ronda++) {
      const c = await ec.cliente(X);
      const v = await ventaSire(c, "1");
      await ec.exclusion(X, c.id, v, { por: ux });
      const llegar = barrera(2);
      const una = () =>
        comoBackend(async (tx) => {
          await llegar();
          return restaurarVenta(tx, v, ux2);
        });
      expect(
        (await Promise.all([una(), una()])).sort(),
        `ronda ${ronda}`,
      ).toEqual([false, true]);
    }
  });

  it("volver a excluir tras restaurar crea otra exclusion con su propio motivo; el registro anterior se conserva", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    const e1 = await comoBackend((tx) =>
      excluirVenta(tx, datos(c, v, { motivo: "primera" })),
    );
    await comoBackend((tx) => restaurarVenta(tx, v, ux2));
    const e2 = await comoBackend((tx) =>
      excluirVenta(tx, datos(c, v, { motivo: "segunda" })),
    );
    expect(e2?.id).not.toBe(e1?.id);
    expect((await comoBackend((tx) => exclusionVigente(tx, v)))?.motivo).toBe(
      "segunda",
    );
    expect(await contarEn(admin, "venta_exclusion", "venta_id = $1", [v])).toBe(
      2,
    );
  });

  it("una venta manual, de otro cliente o de otro periodo no se excluye: lanza VentasRepoError con el SQLSTATE del trigger", async () => {
    const c = await ec.cliente(X);
    const otro = await ec.cliente(X);
    const manual = await ec.venta(X, c, {
      origen: "manual",
      serie: "B009",
      numero: "1",
    });
    const v = await ventaSire(c, "1");
    const e1 = await codigoRepo(
      comoBackend((tx) => excluirVenta(tx, datos(c, manual))),
    );
    const e2 = await codigoRepo(
      comoBackend((tx) => excluirVenta(tx, datos(otro, v))),
    );
    const e3 = await codigoRepo(
      comoBackend((tx) => excluirVenta(tx, datos(c, v, { periodo: "202609" }))),
    );
    expect([e1, e2, e3]).toEqual(["23514", "23514", "23514"]);
    expect(
      await contarEn(admin, "venta_exclusion", "cliente_id = any($1::uuid[])", [
        [c.id, otro.id],
      ]),
    ).toBe(0);
  });

  it("aislamiento: otro estudio no excluye (error), no restaura (false) ni ve la exclusion (null)", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    await ec.exclusion(X, c.id, v, { por: ux });
    expect(
      await codigoRepo(
        comoBackend(
          (tx) => excluirVenta(tx, datos(c, v, { usuarioId: uy })),
          Y,
        ),
      ),
    ).not.toBe("ok");
    expect(await comoBackend((tx) => restaurarVenta(tx, v, uy), Y)).toBe(false);
    expect(await comoBackend((tx) => exclusionVigente(tx, v), Y)).toBeNull();
    expect(
      await contarEn(
        admin,
        "venta_exclusion",
        "venta_id = $1 and restaurada_en is null",
        [v],
      ),
    ).toBe(1);
  });

  it("el error de un repositorio conserva solo el SQLSTATE (sin el motivo ni la fila)", async () => {
    const c = await ec.cliente(X);
    const manual = await ec.venta(X, c, {
      origen: "manual",
      serie: "B009",
      numero: "1",
    });
    let error: unknown;
    await comoBackend((tx) =>
      excluirVenta(tx, datos(c, manual, { motivo: "CANARIO-MOTIVO" })),
    ).catch((e) => (error = e));
    expect(error).toBeInstanceOf(Error);
    expect(
      (error as { codigo?: string }).codigo,
      "lo rechaza el trigger de insercion",
    ).toBe("23514");
    const texto =
      String((error as Error).message) +
      JSON.stringify(error) +
      String((error as Error).stack);
    expect(texto).not.toContain("CANARIO-MOTIVO");
    expect(texto).not.toContain(manual);
  });
});

// =================================================================================================
describe("la lectura de ventas trae la exclusion vigente (CA-15)", () => {
  it("listarVentas y leerFilasVentas: `exclusion` {motivo, por, en} en la excluida y null en el resto; restaurada vuelve a null", async () => {
    const c = await ec.cliente(X);
    const a = await ventaSire(c, "1");
    const b = await ventaSire(c, "2");
    const m = await ec.venta(X, c, {
      origen: "manual",
      serie: "B009",
      numero: "1",
    });
    await comoBackend((tx) =>
      excluirVenta(tx, datos(c, b, { motivo: "Descuadrada" })),
    );
    const por = (xs: VentaConExclusion[]) =>
      Object.fromEntries(xs.map((x) => [x.id, x]));
    const lista = por(
      (await comoBackend((tx) => listarVentas(tx, c.id, PERIODO))).filas,
    );
    const todas = por(
      await comoBackend((tx) => leerFilasVentas(tx, c.id, PERIODO)),
    );
    for (const r of [lista, todas]) {
      expect(Object.keys(r).sort()).toEqual([a, b, m].sort());
      expect(r[b].exclusion).toEqual({
        motivo: "Descuadrada",
        por: ux,
        en: expect.any(Date),
      });
      expect(r[a].exclusion).toBeNull();
      expect(r[m].exclusion).toBeNull();
    }
    await comoBackend((tx) => restaurarVenta(tx, b, ux2));
    expect(
      por(await comoBackend((tx) => leerFilasVentas(tx, c.id, PERIODO)))[b]
        .exclusion,
    ).toBeNull();
  });

  it("tras restaurar y excluir de nuevo, la lectura trae solo la vigente (una fila por venta, sin duplicar)", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    await comoBackend((tx) =>
      excluirVenta(tx, datos(c, v, { motivo: "primera" })),
    );
    await comoBackend((tx) => restaurarVenta(tx, v, ux2));
    await comoBackend((tx) =>
      excluirVenta(tx, datos(c, v, { motivo: "segunda" })),
    );
    const filas = await comoBackend((tx) => leerFilasVentas(tx, c.id, PERIODO));
    expect(filas).toHaveLength(1);
    expect(filas[0].exclusion).toMatchObject({ motivo: "segunda" });
    const pagina = await comoBackend((tx) => listarVentas(tx, c.id, PERIODO));
    expect([pagina.total, pagina.filas.length]).toEqual([1, 1]);
  });

  it("el otro estudio no ve la venta ni su exclusion; los montos siguen llegando como cadenas", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1", {
      montos: { baseGravada: "21.48", igv: "1.61", total: "23.09" },
    });
    await ec.exclusion(X, c.id, v, { por: ux });
    expect(
      await comoBackend((tx) => leerFilasVentas(tx, c.id, PERIODO), Y),
    ).toEqual([]);
    const [f] = await comoBackend((tx) => leerFilasVentas(tx, c.id, PERIODO));
    expect(f).toMatchObject({
      baseGravada: "21.48",
      igv: "1.61",
      total: "23.09",
    });
  });
});

// =================================================================================================
describe("leerFilasReemplazoVentas · las dos listas del previo y del worker (D12, plan «Contratos: BD»)", () => {
  it("original = ventas del SIRE (todas, tambien las excluidas, sin exclusion); vigente = todas con su exclusion vigente", async () => {
    const c = await ec.cliente(X);
    const s1 = await ventaSire(c, "1", {
      montos: { baseGravada: "21.48", igv: "1.61", total: "23.09" },
    });
    const s2 = await ventaSire(c, "2");
    const s3 = await ventaSire(c, "3");
    const m1 = await ec.venta(X, c, {
      origen: "manual",
      serie: "B002",
      numero: "1",
    });
    await ventaSire(c, "4", { periodo: "202609" });
    await ventaSire(cx, "5");
    await comoBackend((tx) =>
      excluirVenta(tx, datos(c, s2, { motivo: "Descuadrada" })),
    );
    await comoBackend((tx) =>
      excluirVenta(tx, datos(c, s3, { motivo: "USD sin TC" })),
    );
    await comoBackend((tx) => restaurarVenta(tx, s3, ux2));

    const r = await comoBackend((tx) =>
      leerFilasReemplazoVentas(tx, c.id, PERIODO, (v) => v),
    );
    expect(
      r.original.map((v) => v.id),
      "original: las del SIRE por clave, tambien la excluida",
    ).toEqual([s1, s2, s3]);
    for (const v of r.original)
      expect(v, v.id).toMatchObject({ origen: "sire", exclusion: null });
    expect(
      r.vigente.map((v) => v.id),
      "vigente: todas, por clave",
    ).toEqual([s1, s2, s3, m1]);
    const por = Object.fromEntries(r.vigente.map((v) => [v.id, v]));
    expect(por[s2].exclusion).toEqual({
      motivo: "Descuadrada",
      por: ux,
      en: expect.any(Date),
    });
    expect(por[s3].exclusion, "restaurada: ya no esta excluida").toBeNull();
    expect(por[s1].exclusion).toBeNull();
    expect(por[m1]).toMatchObject({ origen: "manual", exclusion: null });
    expect(por[s1]).toMatchObject({
      baseGravada: "21.48",
      igv: "1.61",
      total: "23.09",
      clave: "03|B001|1",
    });
    for (const k of [
      "baseGravada",
      "igv",
      "exonerada",
      "inafecta",
      "isc",
      "icbper",
      "otros",
      "total",
    ])
      expect(typeof (por[s1] as Record<string, unknown>)[k], k).toBe("string");
  });

  it("lo que devuelve aFila pasa tal cual; un periodo sin ventas da listas vacias; otro estudio no ve nada", async () => {
    const c = await ec.cliente(X);
    expect(
      await comoBackend((tx) =>
        leerFilasReemplazoVentas(tx, c.id, PERIODO, (v) => v),
      ),
    ).toEqual({ original: [], vigente: [] });
    const v = await ventaSire(c, "1");
    const r = await comoBackend((tx) =>
      leerFilasReemplazoVentas(tx, c.id, PERIODO, (x) => ({
        marca: x.clave,
        excluida: x.exclusion !== null,
      })),
    );
    expect(r).toEqual({
      original: [{ marca: "03|B001|1", excluida: false }],
      vigente: [{ marca: "03|B001|1", excluida: false }],
    });
    expect(
      await comoBackend(
        (tx) => leerFilasReemplazoVentas(tx, c.id, PERIODO, (x) => x),
        Y,
      ),
    ).toEqual({ original: [], vigente: [] });
    expect(v).toBeTruthy();
  });

  it("el worker las lee igual (genera el archivo con su rol)", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    await ec.exclusion(X, c.id, v, { por: ux });
    const r = await comoWorker((tx) =>
      leerFilasReemplazoVentas(tx, c.id, PERIODO, (x) => x),
    );
    expect(r.original.map((x) => x.id)).toEqual([v]);
    expect(r.vigente[0].exclusion).toMatchObject({
      motivo: "Descuadrada en el SIRE",
    });
  });
});

// =================================================================================================
describe("leerExcluidasVentas · la lista del previo (comprobante y motivo)", () => {
  it("solo las vigentes, en el orden de la grilla (numero numerico), con tipo, serie, numero y motivo", async () => {
    const c = await ec.cliente(X);
    const v10 = await ventaSire(c, "10");
    const v2 = await ventaSire(c, "2");
    const v5 = await ventaSire(c, "5");
    await ventaSire(c, "7");
    await comoBackend((tx) =>
      excluirVenta(tx, datos(c, v10, { motivo: "USD sin TC" })),
    );
    await comoBackend((tx) =>
      excluirVenta(tx, datos(c, v2, { motivo: "Descuadrada" })),
    );
    await comoBackend((tx) =>
      excluirVenta(tx, datos(c, v5, { motivo: "otra" })),
    );
    await comoBackend((tx) => restaurarVenta(tx, v5, ux2));
    const r = await comoBackend((tx) => leerExcluidasVentas(tx, c.id, PERIODO));
    expect(r).toEqual([
      {
        ventaId: v2,
        tipo: "03",
        serie: "B001",
        numero: "2",
        motivo: "Descuadrada",
      },
      {
        ventaId: v10,
        tipo: "03",
        serie: "B001",
        numero: "10",
        motivo: "USD sin TC",
      },
    ]);
  });

  it("tras restaurar y excluir de nuevo aparece una sola vez con el motivo nuevo; otro cliente, periodo o estudio no aparece", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    await comoBackend((tx) =>
      excluirVenta(tx, datos(c, v, { motivo: "primera" })),
    );
    await comoBackend((tx) => restaurarVenta(tx, v, ux2));
    await comoBackend((tx) =>
      excluirVenta(tx, datos(c, v, { motivo: "segunda" })),
    );
    expect(
      (await comoBackend((tx) => leerExcluidasVentas(tx, c.id, PERIODO))).map(
        (x) => x.motivo,
      ),
    ).toEqual(["segunda"]);
    expect(
      await comoBackend((tx) => leerExcluidasVentas(tx, c.id, "202609")),
    ).toEqual([]);
    const otroCliente = await ec.cliente(X);
    expect(
      await comoBackend((tx) =>
        leerExcluidasVentas(tx, otroCliente.id, PERIODO),
      ),
    ).toEqual([]);
    expect(
      await comoBackend((tx) => leerExcluidasVentas(tx, c.id, PERIODO), Y),
    ).toEqual([]);
  });

  it("el worker las lee (para el resumen y el aviso de correlatividad)", async () => {
    const c = await ec.cliente(X);
    const v = await ventaSire(c, "1");
    await ec.exclusion(X, c.id, v, { por: ux, motivo: "Descuadrada" });
    expect(
      (await comoWorker((tx) => leerExcluidasVentas(tx, c.id, PERIODO))).map(
        (x) => x.motivo,
      ),
    ).toEqual(["Descuadrada"]);
  });
});
