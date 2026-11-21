// Spec 025 · T16: correcciones de la ronda adversarial 1 en las funciones de 0062 (BD real), en rojo hasta T17.
//  - H-025-1-3 (D-5, D-6): reemplazar una regla viva DESACTIVADA deja la regla resultante activa (la descarga la aplica y el
//    proveedor sale de R-STD): destino nuevo, versión + 1, `activa = true`, candidata «activada» y el proveedor en
//    `reglas_proveedores_con_regla`. Rechazar el reemplazo ya no es una salida válida.
//  - H-025-1-5: `completar` sobre un cliente archivado durante la importación responde 55000 (el worker lo toma como «nada que
//    escribir» y termina bien sin escribir); no escribe candidatas ni reemplaza las pendientes de la importación anterior y la
//    importación no queda «completada».
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin } from "./auth-soporte";
import { type ContappDb } from "./soporte";
import { crearDb } from "./trabajos-soporte";
import { carga, codigoDe, EscenarioImportacion, llamar, resumen, SQL, type ClientePrueba, type Llamada } from "./reglas-importacion-soporte";

let admin: Pool;
let ei: EscenarioImportacion;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let ux: string;

beforeAll(async () => {
  admin = abrirAdmin(6);
  ei = new EscenarioImportacion(admin);
  X = (await ei.estudio()).id;
  ux = await ei.usuarioDe(X);
  backend = crearDb("contapp_backend", 3);
  worker = crearDb("contapp_worker", 3);
});
afterAll(async () => {
  await ei?.limpiar();
  await Promise.all([backend?.close(), worker?.close(), ei?.cerrar()].map((p) => p?.catch(() => undefined)));
  await admin?.end();
});

const comoX = () => ({ tenantId: X, userId: ux });
const comoWorker = () => ({ tenantId: X });
const cod = (r: Llamada) => codigoDe(r);
const reemplazar = (c: ClientePrueba, cand: string, destino: string | null, version: number) =>
  llamar(backend, comoX(), SQL.reemplazar, [c.id, cand, destino, version]);

describe("T16 · H-025-1-3: reemplazar sobre una regla viva desactivada", () => {
  it("la regla queda con el destino nuevo, versión + 1 y ACTIVA; la candidata «activada» y el proveedor deja de recibir R-STD", async () => {
    const c = await ei.cliente(X);
    const imp = await ei.importacion(X, c, { periodoHasta: "202607" });
    const doc = ei.docNuevo();
    const cand = await ei.candidata(X, c, imp, { docNumero: doc }); // propone DNG
    const regla = await ei.regla(X, c, { docNumero: doc, destino: "DG", activa: false, version: 2, periodoAprendido: "202601" });
    const antes = await llamar(backend, comoX(), "select * from public.reglas_proveedores_con_regla($1::uuid)", [c.id]);
    expect(antes.ok && antes.rows.some((x) => x.doc_numero === doc), "control: desactivada, el proveedor no cuenta como con regla").toBe(false);

    const r = await reemplazar(c, cand, null, 2);
    expect(r.ok, r.ok ? "" : `${r.code}: ${r.message}`).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0]).toMatchObject({ regla_id: regla, destino: "DNG", version: 3 });
    const viva = (await ei.reglasVivas(c.id, doc))[0]!;
    expect(viva).toMatchObject({ id: regla, destino: "DNG", version: 3, periodo_aprendido: "202607" });
    expect(viva.activa, "candidata activada ⇒ regla activa").toBe(true);
    expect((await ei.filaCandidata(cand)).estado).toBe("activada");
    const despues = await llamar(backend, comoX(), "select * from public.reglas_proveedores_con_regla($1::uuid)", [c.id]);
    expect(despues.ok && despues.rows.some((x) => x.doc_numero === doc), "el proveedor tiene regla activa: sale de R-STD").toBe(true);
  });

  it("control: sobre una regla viva ya activa, reemplazar la deja activa y con versión + 1", async () => {
    const c = await ei.cliente(X);
    const imp = await ei.importacion(X, c, { periodoHasta: "202607" });
    const doc = ei.docNuevo();
    const cand = await ei.candidata(X, c, imp, { docNumero: doc });
    await ei.regla(X, c, { docNumero: doc, destino: "DG", activa: true, version: 1, periodoAprendido: "202601" });
    const r = await reemplazar(c, cand, null, 1);
    expect(r.ok, r.ok ? "" : `${r.code}: ${r.message}`).toBe(true);
    expect((await ei.reglasVivas(c.id, doc))[0]).toMatchObject({ destino: "DNG", version: 2, activa: true });
  });
});

describe("T16 · H-025-1-5: completar sobre un cliente archivado", () => {
  it("55000: no escribe candidatas, no reemplaza las pendientes anteriores y la importación no queda completada", async () => {
    const c = await ei.cliente(X);
    const vieja = await ei.importacion(X, c, { periodoHasta: "202606", haceMin: 60 });
    const pendiente = await ei.candidata(X, c, vieja);
    const imp = await ei.importacion(X, c, { estado: "en_curso", periodoHasta: "202607" });
    await ei.archivar(c.id);
    const r = await llamar(worker, comoWorker(), SQL.completar, [imp, resumen(), JSON.stringify([carga({ docNumero: ei.docNuevo() })])]);
    expect(cod(r), "completar en un cliente archivado").toBe("55000");
    expect(await ei.cuantasCandidatas(imp), "ninguna candidata escrita").toBe(0);
    expect((await ei.filaCandidata(pendiente)).estado, "la revisión pendiente anterior sigue pendiente").toBe("pendiente");
    expect((await ei.filaImportacion(imp)).estado, "no queda completada").not.toBe("completada");
  });

  it("control: con el cliente sin archivar, completar escribe y reemplaza las pendientes anteriores (CA-5)", async () => {
    const c = await ei.cliente(X);
    const vieja = await ei.importacion(X, c, { periodoHasta: "202606", haceMin: 60 });
    const pendiente = await ei.candidata(X, c, vieja);
    const imp = await ei.importacion(X, c, { estado: "en_curso", periodoHasta: "202607" });
    const r = await llamar(worker, comoWorker(), SQL.completar, [imp, resumen({ candidatas: 1 }), JSON.stringify([carga({ docNumero: ei.docNuevo() })])]);
    expect(r.ok, r.ok ? "" : `${r.code}: ${r.message}`).toBe(true);
    expect(await ei.cuantasCandidatas(imp, "pendiente")).toBe(1);
    expect((await ei.filaCandidata(pendiente)).estado).toBe("reemplazada");
  });
});
