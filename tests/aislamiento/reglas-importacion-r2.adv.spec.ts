// Spec 025 · T18 (ronda adversarial 2) sobre las funciones de 0064 (BD real):
//  - El caso que T17 dejó fuera: activar o reemplazar sobre una regla viva DESACTIVADA que ya tiene el MISMO destino. D-6 dice que
//    con una regla viva del mismo destino la candidata queda «ya aprendida» y no se activa, y que nunca se sobrescribe una regla sola:
//    reactivarla por la importación sería decidir por el contador (la desactivó él). Se fija como regresión (verde).
//  - U-8 / H-025-1-4 en 0064: una «sin criterio claro» con destino elegido va SOLA en la petición; se intenta esquivar con variantes
//    del lote (destino nulo explícito, la otra sin la clave `destino`, ids en mayúsculas, orden inverso).
// Las que revelan un hallazgo quedan en rojo (H-025-2-n en tasks.md).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin } from "./auth-soporte";
import { type ContappDb } from "./soporte";
import { crearDb } from "./trabajos-soporte";
import { codigoDe, EscenarioImportacion, llamar, SQL, type ClientePrueba, type Llamada } from "./reglas-importacion-soporte";

let admin: Pool;
let ei: EscenarioImportacion;
let backend: ContappDb;
let X: string;
let ux: string;

beforeAll(async () => {
  admin = abrirAdmin(6);
  ei = new EscenarioImportacion(admin);
  X = (await ei.estudio()).id;
  ux = await ei.usuarioDe(X);
  backend = crearDb("contapp_backend", 3);
});
afterAll(async () => {
  await ei?.limpiar();
  await Promise.all([backend?.close(), ei?.cerrar()].map((p) => p?.catch(() => undefined)));
  await admin?.end();
});

const comoX = () => ({ tenantId: X, userId: ux });
const activar = (c: ClientePrueba, items: unknown) => llamar(backend, comoX(), SQL.activar, [c.id, JSON.stringify(items), null]);
const resultados = (r: Llamada) => (r.ok ? Object.fromEntries(r.rows.map((x) => [x.candidata_id, x.resultado])) : r.code);

describe("T18 · regla viva desactivada con el mismo destino (caso que T17 dejó fuera; D-6)", () => {
  it("ADV2-10 activar → «ya_aprendida» sin tocar la regla; reemplazar con ese destino → 55000; la regla sigue inactiva y en su versión", async () => {
    const c = await ei.cliente(X);
    const imp = await ei.importacion(X, c, { periodoHasta: "202607" });
    const doc = ei.docNuevo();
    const cand = await ei.candidata(X, c, imp, { docNumero: doc }); // propone DNG
    const regla = await ei.regla(X, c, { docNumero: doc, destino: "DNG", activa: false, version: 4, periodoAprendido: "202601" });
    const antes = (await ei.reglasVivas(c.id, doc))[0];

    const a = await activar(c, [{ id: cand }]);
    expect(resultados(a)).toEqual({ [cand]: "ya_aprendida" });
    const t = await llamar(backend, comoX(), SQL.activar, [c.id, null, imp]);
    expect(resultados(t), "«Activar todas» también la omite").toEqual({ [cand]: "ya_aprendida" });
    const r = await llamar(backend, comoX(), SQL.reemplazar, [c.id, cand, "DNG", 4]);
    expect(codigoDe(r), "no hay conflicto «distinto» que reemplazar").toBe("55000");

    const despues = (await ei.reglasVivas(c.id, doc))[0];
    expect(despues, "la regla del contador queda como la dejó (desactivada, misma versión)").toEqual(antes);
    expect(despues).toMatchObject({ id: regla, activa: false, version: 4 });
    expect((await ei.filaCandidata(cand)).estado, "la candidata sigue pendiente (se puede descartar)").toBe("pendiente");
  });
});

describe("T18 · U-8 en 0064: la «sin criterio claro» con destino elegido va sola", () => {
  it("ADV2-11 variantes del lote no la esquivan (22023 y nada cambia); sola, o junto a una sin criterio SIN destino, se activa una", async () => {
    const c = await ei.cliente(X);
    const imp = await ei.importacion(X, c, { periodoHasta: "202607" });
    const sin = async () => ei.candidata(X, c, imp, { destino: null, dg: 2, dng: 2 });
    const s1 = await sin();
    const s2 = await sin();
    const s3 = await sin();
    const prop = await ei.candidata(X, c, imp); // propone DNG
    const intentos: Array<[string, unknown]> = [
      ["dos con destino", [{ id: s1, destino: "DG" }, { id: s2, destino: "DNG" }]],
      ["orden inverso", [{ id: s2, destino: "DNG" }, { id: s1, destino: "DG" }]],
      ["la otra es una propuesta SIN la clave destino", [{ id: prop }, { id: s1, destino: "DG" }]],
      ["la propuesta con destino nulo explícito", [{ id: s1, destino: "DG" }, { id: prop, destino: null }]],
      ["id en mayúsculas", [{ id: s1.toUpperCase(), destino: "DG" }, { id: s2, destino: "DGNG" }]],
      ["tres, una sin destino", [{ id: s3 }, { id: s1, destino: "DG" }, { id: s2, destino: "DG" }]],
    ];
    for (const [nombre, items] of intentos) {
      expect(codigoDe(await activar(c, items)), nombre).toBe("22023");
    }
    for (const k of [s1, s2, s3, prop]) expect((await ei.filaCandidata(k)).estado).toBe("pendiente");
    const reglas = await admin.query("select count(*)::int as n from regla_aprendida where cliente_id = $1", [c.id]);
    expect(reglas.rows[0].n, "ninguna regla creada").toBe(0);

    const una = await activar(c, [{ id: s3 }, { id: s1, destino: "DG" }]);
    expect(resultados(una)).toEqual({ [s1]: "activada", [s3]: "sin_criterio" });
    const sola = await activar(c, [{ id: s2.toUpperCase(), destino: "DGNG" }]);
    expect(resultados(sola)).toEqual({ [s2]: "activada" });
  });
});
