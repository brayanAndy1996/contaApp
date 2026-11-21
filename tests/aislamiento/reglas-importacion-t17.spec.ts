// Spec 025 · T17 (corrección de la ronda 1, decisión del orquestador sobre H-025-1-6): una importación que no leyó ningún periodo
// no reemplaza la revisión pendiente de la anterior. `reglas_importacion_completar` con periodos_leidos = 0 responde 22023 (el
// worker la cierra fallida con datos_invalidos) y no toca nada; con un periodo leído, completa y reemplaza (CA-5).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin } from "./auth-soporte";
import { type ContappDb } from "./soporte";
import { crearDb } from "./trabajos-soporte";
import { carga, codigoDe, EscenarioImportacion, llamar, periodosHasta, resumen, SQL } from "./reglas-importacion-soporte";

let admin: Pool;
let ei: EscenarioImportacion;
let worker: ContappDb;
let X: string;

beforeAll(async () => {
  admin = abrirAdmin(4);
  ei = new EscenarioImportacion(admin);
  X = (await ei.estudio()).id;
  worker = crearDb("contapp_worker", 2);
});
afterAll(async () => {
  await ei?.limpiar();
  await Promise.all([worker?.close(), ei?.cerrar()].map((p) => p?.catch(() => undefined)));
  await admin?.end();
});

const comoWorker = () => ({ tenantId: X });

describe("T17 · completar sin ningún periodo leído", () => {
  it("periodos_leidos = 0 (todos sin datos): 22023, nada escrito y la revisión pendiente anterior sigue pendiente", async () => {
    const c = await ei.cliente(X);
    const vieja = await ei.importacion(X, c, { periodoHasta: "202606", haceMin: 60 });
    const pendiente = await ei.candidata(X, c, vieja);
    const imp = await ei.importacion(X, c, { estado: "en_curso", periodoHasta: "202607" });
    const r = await llamar(worker, comoWorker(), SQL.completar, [
      imp,
      resumen({ leidos: 0, sinDatos: periodosHasta("202607", 6) }),
      JSON.stringify([]),
    ]);
    expect(codigoDe(r)).toBe("22023");
    expect((await ei.filaCandidata(pendiente)).estado).toBe("pendiente");
    expect((await ei.filaImportacion(imp)).estado).toBe("en_curso");
    expect(await ei.cuantasCandidatas(imp)).toBe(0);
  });

  it("control: con un periodo leído y el resto sin datos, completa y reemplaza la revisión anterior", async () => {
    const c = await ei.cliente(X);
    const vieja = await ei.importacion(X, c, { periodoHasta: "202606", haceMin: 60 });
    const pendiente = await ei.candidata(X, c, vieja);
    const imp = await ei.importacion(X, c, { estado: "en_curso", periodoHasta: "202607" });
    const r = await llamar(worker, comoWorker(), SQL.completar, [
      imp,
      resumen({ leidos: 1, sinDatos: periodosHasta("202607", 6).slice(1), candidatas: 1 }),
      JSON.stringify([carga({ docNumero: ei.docNuevo(), periodos: 1 })]),
    ]);
    expect(r.ok, r.ok ? "" : `${r.code}: ${r.message}`).toBe(true);
    expect((await ei.filaImportacion(imp)).estado).toBe("completada");
    expect((await ei.filaCandidata(pendiente)).estado).toBe("reemplazada");
  });
});
