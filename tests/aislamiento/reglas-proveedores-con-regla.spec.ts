// Spec 025 (T11a, migración 0063): `reglas_proveedores_con_regla(p_cliente)`, la lectura acotada del worker de los proveedores con
// regla aprendida activa de un cliente (D-8, D-9, CA-9). R-STD nunca se sugiere a un proveedor con regla activa, sea cual sea el
// interruptor de R-HIS; una regla desactivada o eliminada no cuenta. Frentes: catálogo y grants, quién llama, aislamiento (otro
// estudio, cliente ajeno), estado de la regla, R-HIS apagado, columnas devueltas y el bloqueo FOR SHARE hasta el fin de la transacción.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin } from "./auth-soporte";
import { type ContappDb } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import { comoRolSql, conExecute, infoFuncion, llamar, ROLES_FUNCION, type Llamada } from "./reglas-importacion-soporte";
import { EscenarioReglas } from "./reglas-soporte";

const FIRMA = "reglas_proveedores_con_regla(uuid)";
const SQL = "select * from public.reglas_proveedores_con_regla($1::uuid)";

let admin: Pool;
let ec: EscenarioReglas;
let worker: ContappDb;
let backend: ContappDb;
let X: string;
let Y: string;
let ux: string;
let cx: ClientePrueba; // cliente de X con reglas en todos los estados
let cx2: ClientePrueba; // otro cliente de X
let cy: ClientePrueba; // cliente de Y
const ids: Record<string, string> = {};

beforeAll(async () => {
  admin = abrirAdmin(8);
  ec = new EscenarioReglas(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  ux = await ec.usuarioDe(X);
  cx = await ec.cliente(X);
  cx2 = await ec.cliente(X);
  cy = await ec.cliente(Y);
  ids.activa = await ec.regla(X, cx, { docNumero: "20630000001", destino: "DNG" });
  ids.futura = await ec.regla(X, cx, { docNumero: "20630000002", destino: "DG", periodoAprendido: "202612" });
  ids.dni = await ec.regla(X, cx, { docTipo: "1", docNumero: "40630001", destino: "DGNG" });
  ids.desactivada = await ec.regla(X, cx, { docNumero: "20630000003", activa: false });
  ids.eliminada = await ec.regla(X, cx, { docNumero: "20630000004", eliminada: true });
  ids.otroCliente = await ec.regla(X, cx2, { docNumero: "20630000005" });
  ids.otroEstudio = await ec.regla(Y, cy, { docNumero: "20630000006" });
  worker = crearDb("contapp_worker", 4);
  backend = crearDb("contapp_backend", 4);
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all([worker?.close(), backend?.close(), ec?.cerrar()].map((p) => p?.catch(() => undefined)));
  await admin?.end();
});

function filas(r: Llamada): Record<string, unknown>[] {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.rows;
}
const proveedores = async (cliente: string, tenantId = X) =>
  filas(await llamar(worker, { tenantId }, SQL, [cliente], { revertir: true }))
    .map((f) => `${String(f.doc_tipo)}:${String(f.doc_numero)}`)
    .sort();

describe("0063 · reglas_proveedores_con_regla en el catalogo", () => {
  it("SECURITY DEFINER de contapp_migrator (sin superusuario ni BYPASSRLS), search_path fijo, sin PUBLIC; solo contapp_worker", async () => {
    expect(await infoFuncion(admin, FIRMA)).toEqual({
      secdef: true,
      config: ["search_path=pg_catalog, pg_temp"],
      dueno: "contapp_migrator",
      duenoSuper: false,
      duenoBypass: false,
    });
    expect(await conExecute(admin, FIRMA, ROLES_FUNCION)).toEqual(["contapp_worker"]);
  });

  it("devuelve solo (doc_tipo, doc_numero): ni ids, ni destino, ni cliente, ni estudio", async () => {
    const r = await llamar(worker, { tenantId: X }, SQL, [cx.id], { revertir: true });
    for (const f of filas(r)) expect(Object.keys(f).sort()).toEqual(["doc_numero", "doc_tipo"]);
  });
});

describe("0063 · quien llama", () => {
  it("sin app.tenant_id o con uno que no es uuid: 42501; cliente nulo: 22023", async () => {
    const sin = await comoRolSql(admin, "contapp_worker", {}, SQL, [cx.id]);
    expect(sin.ok ? "ok" : sin.code).toBe("42501");
    const malo = await comoRolSql(admin, "contapp_worker", { tenantId: "no-es-uuid" }, SQL, [cx.id]);
    expect(malo.ok ? "ok" : malo.code).toBe("42501");
    const nulo = await comoRolSql(admin, "contapp_worker", { tenantId: X }, SQL, [null]);
    expect(nulo.ok ? "ok" : nulo.code).toBe("22023");
  });

  it("el backend y los demas roles de la app no la ejecutan (42501)", async () => {
    const b = await llamar(backend, { tenantId: X, userId: ux }, SQL, [cx.id], { revertir: true });
    expect(b.ok ? "ok" : b.code).toBe("42501");
    for (const rol of ROLES_FUNCION.filter((r) => r !== "contapp_worker")) {
      const r = await comoRolSql(admin, rol, { tenantId: X, userId: ux }, SQL, [cx.id]);
      expect(r.ok ? "ok" : r.code, rol).toBe("42501");
    }
  });
});

describe("0063 · aislamiento y estado de la regla (D-8)", () => {
  it("solo las reglas vivas y activas del cliente, sea cual sea su periodo; la desactivada y la eliminada no cuentan", async () => {
    expect(await proveedores(cx.id)).toEqual(["1:40630001", "6:20630000001", "6:20630000002"]);
  });

  it("no mezcla clientes: el otro cliente del estudio solo ve la suya", async () => {
    expect(await proveedores(cx2.id)).toEqual(["6:20630000005"]);
  });

  it("otro estudio: el cliente de Y desde X, o el de X desde Y, no devuelve nada; cada estudio ve lo suyo", async () => {
    expect(await proveedores(cy.id, X)).toEqual([]);
    expect(await proveedores(cx.id, Y)).toEqual([]);
    expect(await proveedores(cy.id, Y)).toEqual(["6:20630000006"]);
  });

  it("cliente inexistente: vacio", async () => {
    expect(await proveedores("00000000-0000-7000-8000-0000000063aa")).toEqual([]);
  });

  it("con R-HIS (y R-STD) apagados en el estudio devuelve lo mismo: no depende del interruptor", async () => {
    await ec.interruptor(X, "R-HIS", false);
    await ec.interruptor(X, "R-STD", false);
    try {
      expect(await proveedores(cx.id)).toEqual(["1:40630001", "6:20630000001", "6:20630000002"]);
      // Control: la lectura de R-HIS de 021 sí queda vacía con el interruptor apagado.
      const vig = await llamar(worker, { tenantId: X }, "select * from public.reglas_historial_vigentes($1, '999912')", [cx.id], {
        revertir: true,
      });
      expect(filas(vig)).toEqual([]);
    } finally {
      await ec.interruptor(X, "R-HIS", true);
      await ec.interruptor(X, "R-STD", true);
    }
  });

  it("al reactivar o desactivar la regla cambia la lectura siguiente", async () => {
    await admin.query("update regla_aprendida set activa = true where id = $1", [ids.desactivada]);
    await admin.query("update regla_aprendida set activa = false where id = $1", [ids.activa]);
    try {
      expect(await proveedores(cx.id)).toEqual(["1:40630001", "6:20630000002", "6:20630000003"]);
    } finally {
      await admin.query("update regla_aprendida set activa = false where id = $1", [ids.desactivada]);
      await admin.query("update regla_aprendida set activa = true where id = $1", [ids.activa]);
    }
  });
});

describe("0063 · bloqueo (CA-9)", () => {
  it("las reglas leidas quedan FOR SHARE hasta el fin de la transaccion del worker: cambiarlas espera; las demas no", async () => {
    const intentarCambio = async (id: string): Promise<string> => {
      const c = await admin.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL lock_timeout = '300ms'");
        await c.query("update regla_aprendida set version = version where id = $1", [id]);
        return "ok";
      } catch (e) {
        return String((e as { code?: string }).code ?? "");
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    };
    // Una lectura confirmada ya no bloquea.
    expect((await llamar(worker, { tenantId: X }, SQL, [cx.id])).ok).toBe(true);
    expect(await intentarCambio(ids.activa)).toBe("ok");
    const dentro = await worker.withTenant({ tenantId: X }, async (tx) => {
      await tx.query(SQL, [cx.id]);
      return {
        leida: await intentarCambio(ids.activa),
        desactivada: await intentarCambio(ids.desactivada),
        otroCliente: await intentarCambio(ids.otroCliente),
      };
    });
    expect(dentro).toEqual({ leida: "55P03", desactivada: "ok", otroCliente: "ok" });
  });
});
