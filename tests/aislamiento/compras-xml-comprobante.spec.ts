// Spec 016 · T23 · `reevaluarComprobante` (H-016-11) y la función de bloqueo del worker (H-016-8, 0038), contra PostgreSQL real.
// Caso feliz y de error por comportamiento público: re-evalúa TODAS las compras vivas del comprobante del cliente (cualquier
// periodo, con su entorno), nunca la descartada ni la de otro cliente o estudio; el bloqueo se elige por el privilegio del rol;
// la función acotada no se ejecuta sin estudio, con un parámetro inválido ni desde el backend.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auth-soporte";
import type { ContappDb, Tx } from "./soporte";
import { crearDb, probar, type ClientePrueba } from "./trabajos-soporte";
import type { Pool } from "pg";
import {
  EscenarioXml,
  evaluacionesDe,
  evaluadorXml,
  type EvaluarConXml,
  type IdentidadXml,
} from "./compras-xml-soporte";

type Reevaluar = (
  tx: Tx,
  clienteId: string,
  identidad: IdentidadXml,
  f: {
    evaluarDe: (periodo: string) => EvaluarConXml | Promise<EvaluarConXml>;
    bloqueo?: "funcion" | "fila" | "auto";
    excluir?: string[];
  },
) => Promise<
  Map<string, { version: number; n: number; documentoXmlId: string | null }>
>;
const reevaluarComprobante = (...a: Parameters<Reevaluar>) =>
  exportado<Reevaluar>("reevaluarComprobante")(...a);

let admin: Pool;
let ec: EscenarioXml;
let backend: ContappDb;
let worker: ContappDb;
let X: string;

beforeAll(async () => {
  admin = abrirAdmin(6);
  ec = new EscenarioXml(admin);
  X = (await ec.estudio()).id;
  backend = crearDb("contapp_backend", 4);
  worker = crearDb("contapp_worker", 4);
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close()].map((p) => p?.catch(() => undefined)),
  );
  await admin?.end();
});

let consecutivo = 9100;
const numero = () => String(++consecutivo);

/** El mismo comprobante en dos periodos (uno con el número con ceros a la izquierda), una descartada y otro cliente. */
async function escenario() {
  const c: ClientePrueba = await ec.cliente(X);
  const otro: ClientePrueba = await ec.cliente(X);
  const n = numero();
  const p1 = await ec.compraXml(X, c, {
    serie: "F001",
    numero: n,
    periodo: "202610",
  });
  const p2 = await ec.compraXml(X, c, {
    serie: "f001",
    numero: `00${n}`,
    periodo: "202609",
  });
  const descartada = await ec.compraXml(X, c, {
    origen: "agregada",
    serie: "F001",
    numero: n,
    periodo: "202608",
  });
  await admin.query("update compra set descartada_en = now() where id = $1", [
    descartada.id,
  ]);
  const deOtro = await ec.compraXml(X, otro, {
    serie: "F001",
    numero: n,
    periodo: "202610",
  });
  const otroNumero = await ec.compraXml(X, c, {
    serie: "F001",
    numero: numero(),
    periodo: "202610",
  });
  const xmlId = await ec.xml(X, c, p1.identidad, { origen: "real" });
  return { c, p1, p2, descartada, deOtro, otroNumero, xmlId };
}

describe("reevaluarComprobante (H-016-11)", () => {
  it("worker: re-evalúa las compras vivas del comprobante en cada periodo con su entorno y el XML vigente; nada más", async () => {
    const s = await escenario();
    const { evaluar, llamadas } = evaluadorXml();
    const periodos: string[] = [];
    const r = await worker.withTenant({ tenantId: X }, (tx) =>
      reevaluarComprobante(tx, s.c.id, s.p1.identidad, {
        evaluarDe: (p) => {
          periodos.push(p);
          return evaluar;
        },
      }),
    );
    expect([...r.keys()].sort()).toEqual([s.p1.id, s.p2.id].sort());
    expect(periodos.sort()).toEqual(["202609", "202610"]);
    expect(llamadas.map((l) => l.xml?.origen)).toEqual(["real", "real"]);
    for (const id of [s.p1.id, s.p2.id]) {
      expect(r.get(id)).toEqual({ version: 1, n: 2, documentoXmlId: s.xmlId });
      expect(
        (await evaluacionesDe(admin, id)).map((e) => [e.n, e.documento_xml_id]),
      ).toEqual([
        [1, null],
        [2, s.xmlId],
      ]);
    }
    for (const id of [s.descartada.id, s.deOtro.id, s.otroNumero.id])
      expect(await evaluacionesDe(admin, id), id).toHaveLength(1);
  });

  it("backend (bloqueo fila o auto) y `excluir`: la excluida no se toca; sin compras del comprobante no escribe nada", async () => {
    const s = await escenario();
    const { evaluar } = evaluadorXml();
    for (const bloqueo of ["fila", "auto"] as const) {
      const r = await backend.withTenant({ tenantId: X }, (tx) =>
        reevaluarComprobante(tx, s.c.id, s.p1.identidad, {
          evaluarDe: () => evaluar,
          bloqueo,
          excluir: [s.p1.id.toUpperCase()],
        }),
      );
      expect([...r.keys()], bloqueo).toEqual([s.p2.id]);
    }
    expect(await evaluacionesDe(admin, s.p1.id)).toHaveLength(1);
    expect((await evaluacionesDe(admin, s.p2.id)).map((e) => e.n)).toEqual([
      1, 2, 3,
    ]);
    const vacio = await worker.withTenant({ tenantId: X }, (tx) =>
      reevaluarComprobante(
        tx,
        s.c.id,
        { ...s.p1.identidad, numero: "99999999" },
        { evaluarDe: () => evaluar },
      ),
    );
    expect(vacio.size).toBe(0);
  });

  it("error: con `bloqueo: funcion` el backend no puede ejecutar la función del worker (42501) y no queda nada", async () => {
    const s = await escenario();
    const { evaluar } = evaluadorXml();
    const codigo = await backend
      .withTenant({ tenantId: X }, (tx) =>
        reevaluarComprobante(tx, s.c.id, s.p1.identidad, {
          evaluarDe: () => evaluar,
          bloqueo: "funcion",
        }),
      )
      .then(() => "ok")
      .catch((e: { code?: string; codigo?: string }) =>
        String(e.code ?? e.codigo),
      );
    expect(codigo).toBe("42501");
    expect(await evaluacionesDe(admin, s.p1.id)).toHaveLength(1);
  });
});

describe("bloquear_compras_reevaluar (H-016-8, 0038)", () => {
  const SQL =
    "select id from public.bloquear_compras_reevaluar($1::uuid[]) as b(id)";

  it("bloquea y devuelve solo las compras vivas del estudio pedidas, en orden de id", async () => {
    const s = await escenario();
    const otroEstudio = (await ec.estudio()).id;
    const ajena = await ec.compraXml(
      otroEstudio,
      await ec.cliente(otroEstudio),
      { serie: "F001", numero: numero() },
    );
    const ids = [s.p2.id, s.descartada.id, ajena.id, s.p1.id];
    const r = await worker.withTenant({ tenantId: X }, (tx) =>
      probar(tx, SQL, [ids]),
    );
    expect(r).toMatchObject({ ok: true });
    expect((r as { rows: { id: string }[] }).rows.map((f) => f.id)).toEqual(
      [s.p1.id, s.p2.id].sort(),
    );
  });

  it("error: sin estudio (42501), con un parámetro nulo o de dos dimensiones (22023)", async () => {
    const s = await escenario();
    const r = await worker.withTenant({ tenantId: X }, async (tx) => ({
      nulo: await probar(
        tx,
        "select * from public.bloquear_compras_reevaluar(null)",
      ),
      matriz: await probar(
        tx,
        "select * from public.bloquear_compras_reevaluar($1::uuid[])",
        [[[s.p1.id], [s.p2.id]]],
      ),
    }));
    expect(r.nulo).toMatchObject({ ok: false, code: "22023" });
    expect(r.matriz).toMatchObject({ ok: false, code: "22023" });
    const sinEstudio = await worker.withTenant({ tenantId: X }, async (tx) => {
      await tx.query("select set_config('app.tenant_id', '', true)");
      return probar(tx, SQL, [[s.p1.id]]);
    });
    expect(sinEstudio).toMatchObject({ ok: false, code: "42501" });
  });
});
