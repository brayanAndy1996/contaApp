// Spec 021 (T15): `reglasHistorialVigentes` (packages/db/src/reglas/aplicar.ts) y las guardas de versión de `editarRegla` /
// `eliminarRegla` contra la BD real. La función SQL de 0048 ya se prueba cruda en reglas-funciones.spec.ts; aquí se ejecuta el
// wrapper TypeScript que usa el worker (P-5, CA-4, CA-5) y se comprueba que una versión inválida no escribe nada.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin, exportado } from "./auth-soporte";
import { type ContappDb, type Tx } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import { APRENDIDO, DESCARGA, EscenarioReglas } from "./reglas-soporte";

let admin: Pool;
let ec: EscenarioReglas;
let worker: ContappDb;
let backend: ContappDb;
let X: string;
let Y: string;
let Z: string; // R-HIS apagado
let ux: string;
let A: ClientePrueba;
let D: ClientePrueba;
let E: ClientePrueba;
let errSiembra: unknown;
const ids: Record<string, string> = {};

interface Vigente {
  reglaId: string;
  docTipo: string;
  docNumero: string;
  destino: string;
  version: number;
}
const vigentes = (tx: Tx, cliente: string, periodo: string) =>
  exportado<(tx: Tx, c: string, p: string) => Promise<Vigente[]>>("reglasHistorialVigentes")(tx, cliente, periodo);

beforeAll(async () => {
  admin = abrirAdmin(6);
  ec = new EscenarioReglas(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  Z = (await ec.estudio()).id;
  A = await ec.cliente(X);
  D = await ec.cliente(Y);
  E = await ec.cliente(Z);
  ux = await ec.usuarioDe(X);
  worker = crearDb("contapp_worker", 3);
  backend = crearDb("contapp_backend", 3);
  try {
    await ec.interruptor(Z, "R-HIS", false);
    ids.vigente = await ec.regla(X, A, { docNumero: "20501000001", destino: "DNG", periodoAprendido: APRENDIDO, version: 3 });
    ids.antigua = await ec.regla(X, A, { docNumero: "20501000002", destino: "DGNG", periodoAprendido: "202608" });
    ids.inactiva = await ec.regla(X, A, { docNumero: "20501000003", activa: false });
    ids.eliminada = await ec.regla(X, A, { docNumero: "20501000004", eliminada: true });
    ids.futura = await ec.regla(X, A, { docNumero: "20501000005", periodoAprendido: "202611" });
    ids.deOtroEstudio = await ec.regla(Y, D, { docNumero: "20501000006" });
    ids.apagada = await ec.regla(Z, E, { docNumero: "20501000007" });
  } catch (e) {
    errSiembra = e;
  }
});
beforeEach(() => {
  if (errSiembra) throw errSiembra;
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all([worker?.close(), backend?.close(), ec?.cerrar()].map((p) => p?.catch(() => undefined)));
  await admin?.end();
});

describe("reglasHistorialVigentes (wrapper del worker)", () => {
  it("devuelve solo las vivas, activas y aprendidas antes del periodo, con la forma pública", async () => {
    const r = await worker.withTenant({ tenantId: X }, (tx) => vigentes(tx, A.id, DESCARGA));
    expect(r.map((x) => x.reglaId).sort()).toEqual([ids.vigente, ids.antigua].sort());
    expect(r.find((x) => x.reglaId === ids.vigente)).toEqual({
      reglaId: ids.vigente,
      docTipo: "6",
      docNumero: "20501000001",
      destino: "DNG",
      version: 3,
    });
  });

  it("el periodo acota: antes de que se aprendiera, ninguna", async () => {
    const r = await worker.withTenant({ tenantId: X }, (tx) => vigentes(tx, A.id, "202608"));
    expect(r).toEqual([]);
  });

  it("un cliente de otro estudio, o inexistente, no devuelve nada (CA-5)", async () => {
    expect(await worker.withTenant({ tenantId: X }, (tx) => vigentes(tx, D.id, DESCARGA))).toEqual([]);
    expect(
      await worker.withTenant({ tenantId: X }, (tx) => vigentes(tx, "00000000-0000-7000-8000-0000000000bb", DESCARGA)),
    ).toEqual([]);
  });

  it("con R-HIS apagado en el estudio devuelve vacío aunque haya reglas vivas", async () => {
    expect(await worker.withTenant({ tenantId: Z }, (tx) => vigentes(tx, E.id, DESCARGA))).toEqual([]);
  });

  it("el backend no puede ejecutarla: la BD la rechaza y no devuelve reglas", async () => {
    await expect(backend.withTenant({ tenantId: X, userId: ux }, (tx) => vigentes(tx, A.id, DESCARGA))).rejects.toThrow();
  });
});

describe("editarRegla / eliminarRegla: versión inválida no escribe (CA-7)", () => {
  const version = async (id: string) =>
    (await admin.query("select version, eliminada_en, destino, activa from regla_aprendida where id = $1", [id])).rows[0];
  const editar = (e: unknown) =>
    backend.withTenant({ tenantId: X, userId: ux }, (tx) =>
      exportado<(tx: Tx, e: unknown) => Promise<unknown>>("editarRegla")(tx, e),
    );
  const eliminar = (e: unknown) =>
    backend.withTenant({ tenantId: X, userId: ux }, (tx) =>
      exportado<(tx: Tx, e: unknown) => Promise<unknown>>("eliminarRegla")(tx, e),
    );

  it.each([0, -1, 1.5, Number.NaN, "3", null])("editar con versión %j sobre una regla viva: regla_cambiada y la fila no cambia", async (v) => {
    const antes = await version(ids.vigente!);
    expect(await editar({ clienteId: A.id, reglaId: ids.vigente, versionBase: v, destino: "DG", usuarioId: ux })).toBe("regla_cambiada");
    expect(await version(ids.vigente!)).toEqual(antes);
  });

  it("editar con versión inválida sobre una regla eliminada o de otro estudio: no_encontrada", async () => {
    expect(await editar({ clienteId: A.id, reglaId: ids.eliminada, versionBase: 0, destino: "DG", usuarioId: ux })).toBe("no_encontrada");
    expect(await editar({ clienteId: D.id, reglaId: ids.deOtroEstudio, versionBase: 0, destino: "DG", usuarioId: ux })).toBe("no_encontrada");
  });

  it.each([0, -1, 1.5, Number.NaN, "3", null])("eliminar con versión %j sobre una regla viva: regla_cambiada y no se da de baja", async (v) => {
    expect(await eliminar({ clienteId: A.id, reglaId: ids.vigente, versionBase: v, usuarioId: ux })).toBe("regla_cambiada");
    expect((await version(ids.vigente!)).eliminada_en).toBeNull();
  });

  it("ids que no son UUID: no_encontrada sin error de la BD", async () => {
    expect(await editar({ clienteId: "x", reglaId: ids.vigente, versionBase: 3, usuarioId: ux })).toBe("no_encontrada");
    expect(await editar({ clienteId: A.id, reglaId: "x", versionBase: 3, usuarioId: ux })).toBe("no_encontrada");
    expect(await eliminar({ clienteId: "x", reglaId: ids.vigente, versionBase: 3, usuarioId: ux })).toBe("no_encontrada");
    expect(await eliminar({ clienteId: A.id, reglaId: "x", versionBase: 3, usuarioId: ux })).toBe("no_encontrada");
  });
});
