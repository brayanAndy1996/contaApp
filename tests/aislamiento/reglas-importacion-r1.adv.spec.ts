// Spec 025 · T15 (ronda adversarial 1): funciones acotadas de 0062 en BD real. Ataques que no fija T3: reemplazar una regla viva
// pero DESACTIVADA (la candidata queda «activada» sin que nada se aplique), lote de «sin criterio claro» activado de una vez (U-8),
// completar en un cliente archivado a mitad de la importación, lote de 1.000 propias con una ajena y autocierre ∥ trabajo que
// termina tarde (determinista con una transacción retenida). Las que revelan un hallazgo quedan en rojo (H-025-1-n en tasks.md).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin } from "./auth-soporte";
import { type ContappDb, type Tx } from "./soporte";
import { crearDb } from "./trabajos-soporte";
import {
  carga,
  codigoDe,
  conPlazo,
  EscenarioImportacion,
  llamar,
  periodosHasta,
  resumen,
  SQL,
  type ClientePrueba,
  type Llamada,
} from "./reglas-importacion-soporte";

let admin: Pool;
let ei: EscenarioImportacion;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let ux: string;

beforeAll(async () => {
  admin = abrirAdmin(8);
  ei = new EscenarioImportacion(admin);
  X = (await ei.estudio()).id;
  ux = await ei.usuarioDe(X);
  backend = crearDb("contapp_backend", 4);
  worker = crearDb("contapp_worker", 4);
});
afterAll(async () => {
  await ei?.limpiar();
  await Promise.all([backend?.close(), worker?.close(), ei?.cerrar()].map((p) => p?.catch(() => undefined)));
  await admin?.end();
});

const comoX = () => ({ tenantId: X, userId: ux });
const comoWorker = () => ({ tenantId: X });
const cod = (r: Llamada) => codigoDe(r);
function filas(r: Llamada): any[] {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.rows;
}
const activar = (c: ClientePrueba, items: unknown) => llamar(backend, comoX(), SQL.activar, [c.id, JSON.stringify(items), null]);
const reemplazar = (c: ClientePrueba, cand: string, destino: string | null, version: number) =>
  llamar(backend, comoX(), SQL.reemplazar, [c.id, cand, destino, version]);

function diferido(): { promesa: Promise<void>; resolver: () => void } {
  let resolver!: () => void;
  const promesa = new Promise<void>((r) => (resolver = r));
  return { promesa, resolver };
}
type Salida<T> = { ok: true; v: T } | { ok: false; code: string };
async function en<T>(db: ContappDb, ctx: { tenantId: string; userId?: string }, fn: (tx: Tx) => Promise<T>): Promise<Salida<T>> {
  try {
    return { ok: true, v: await db.withTenant(ctx, fn) };
  } catch (e) {
    return { ok: false, code: String((e as { code?: string }).code ?? e) };
  }
}

describe("T15 · reemplazar (D-5, D-6)", () => {
  it("ADV-1 reemplazar una regla viva DESACTIVADA deja la candidata «activada»: la regla resultante debe quedar activa", async () => {
    const c = await ei.cliente(X);
    const imp = await ei.importacion(X, c, { periodoHasta: "202607" });
    const doc = ei.docNuevo();
    const cand = await ei.candidata(X, c, imp, { docNumero: doc }); // DNG 5 de 5
    const regla = await ei.regla(X, c, { docNumero: doc, destino: "DG", activa: false, version: 2, periodoAprendido: "202601" });
    const r = await reemplazar(c, cand, null, 2);
    if (!r.ok) return; // rechazar el reemplazo de una regla desactivada también es coherente
    const viva = (await ei.reglasVivas(c.id, doc))[0]!;
    expect(viva.id).toBe(regla);
    expect((await ei.filaCandidata(cand)).estado).toBe("activada");
    // «Activada» con una regla que la descarga no aplica (y que no saca al proveedor de R-STD): el contador cree que rige y no rige.
    expect(viva.activa, "candidata activada ⇒ regla activa").toBe(true);
  });
});

describe("T15 · «sin criterio claro» (U-8)", () => {
  it("ADV-2 varias sin criterio en UN lote de activar, cada una con destino: U-8 dice «solo de una en una»", async () => {
    const c = await ei.cliente(X);
    const imp = await ei.importacion(X, c, { periodoHasta: "202607" });
    const a = await ei.candidata(X, c, imp, { destino: null, dg: 2, dng: 2 });
    const b = await ei.candidata(X, c, imp, { destino: null, dg: 2, dng: 2 });
    const r = await activar(c, [
      { id: a, destino: "DG" },
      { id: b, destino: "DG" },
    ]);
    const activadas = r.ok ? r.rows.filter((x) => x.resultado === "activada").length : 0;
    expect(activadas, "un lote no activa más de una «sin criterio claro»").toBeLessThanOrEqual(1);
  });
});

describe("T15 · aislamiento en lote (CA-7)", () => {
  it("ADV-3 1.000 candidatas propias + 1 de otro cliente del estudio: P0002 a todo y ninguna regla nueva", async () => {
    const c = await ei.cliente(X);
    const otro = await ei.cliente(X);
    const imp = await ei.importacion(X, c, { periodoHasta: "202607" });
    const impO = await ei.importacion(X, otro, { periodoHasta: "202607" });
    const docs = Array.from({ length: 1000 }, () => ei.docNuevo());
    const r = await admin.query(
      `insert into regla_candidata (tenant_id, cliente_id, importacion_id, doc_tipo, doc_numero, destino_propuesto, n_dg, n_dgng, n_dng,
         n_mixto, n_total, periodos_con_proveedor, estado)
       select $1, $2, $3, '6', d, 'DNG', 0, 0, 5, 0, 5, 3, 'pendiente' from unnest($4::text[]) d returning id`,
      [X, c.id, imp, docs],
    );
    const propias = r.rows.map((x) => x.id as string);
    const ajena = await ei.candidata(X, otro, impO, { docNumero: docs[500]! }); // mismo proveedor en el otro cliente
    const items = [...propias.slice(0, 999).map((id) => ({ id })), { id: ajena }];
    const antes = await ei.contadoresAjenos(X);
    expect(cod(await activar(c, items))).toBe("P0002");
    expect(await ei.contadoresAjenos(X)).toEqual(antes);
    expect(await ei.reglasVivas(otro.id, docs[500]!)).toEqual([]);
    expect(await ei.cuantasCandidatas(imp, "pendiente")).toBe(1000);
  });
});

describe("T15 · completar y archivar", () => {
  it("ADV-4 cliente archivado mientras corría la importación: completar no escribe (55000) ni reemplaza las pendientes previas", async () => {
    const c = await ei.cliente(X);
    const vieja = await ei.importacion(X, c, { periodoHasta: "202606", haceMin: 60 });
    const pendiente = await ei.candidata(X, c, vieja);
    const imp = await ei.importacion(X, c, { estado: "en_curso", periodoHasta: "202607" });
    await ei.archivar(c.id);
    const r = await llamar(worker, comoWorker(), SQL.completar, [imp, resumen(), JSON.stringify([carga({ docNumero: ei.docNuevo() })])]);
    // Todo lo demás de 025 trata al archivado como de solo lectura (55000 en iniciar, activar, reemplazar y descartar).
    expect(cod(r), "completar en un cliente archivado").toBe("55000");
    expect((await ei.filaCandidata(pendiente)).estado, "la revisión pendiente no se pierde").toBe("pendiente");
    expect(await ei.cuantasCandidatas(imp)).toBe(0);
  });
});

describe("T15 · autocierre ∥ trabajo que termina tarde", () => {
  it("ADV-5 completar retenido de la importación con trabajo en error; iniciar espera y luego crea la nueva sin pisar la completada", async () => {
    const c = await ei.cliente(X);
    const job = await ei.job(X, c, { tipo: "reglas.historial.importar", estado: "error", motivo: "sunat_no_responde", hace: 120 });
    const vieja = await ei.importacion(X, c, { estado: "en_curso", trabajoId: job, haceMin: 30, periodoHasta: "202607" });
    const doc = ei.docNuevo();
    const hecho = diferido();
    const soltar = diferido();
    const tarde = en(worker, comoWorker(), async (tx) => {
      const r = await tx.query(SQL.completar, [vieja, resumen(), JSON.stringify([carga({ docNumero: doc })])]);
      hecho.resolver();
      await soltar.promesa;
      return r.rows[0].n as number;
    });
    await hecho.promesa;
    const nueva = en(backend, comoX(), async (tx) =>
      (await tx.query(SQL.iniciar, [c.id, periodosHasta("202607", 6)])).rows[0].id as string,
    );
    expect(await conPlazo(nueva, 600), "iniciar espera el FOR UPDATE de la importación").toBe("pendiente");
    soltar.resolver();
    const t = await tarde;
    const n = await nueva;
    expect(t).toEqual({ ok: true, v: 1 });
    expect(n.ok, JSON.stringify(n)).toBe(true);
    expect((await ei.filaImportacion(vieja)).estado).toBe("completada");
    expect((await ei.filaImportacion((n as { v: string }).v)).estado).toBe("en_curso");
    expect(await ei.cuantasCandidatas(vieja, "pendiente")).toBe(1);
  });
});

void filas;
