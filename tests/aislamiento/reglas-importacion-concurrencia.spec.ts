// Spec 025 (T3, rojo): concurrencia de las funciones de importacion y candidatas (CA-4, CA-5; plan: Orden de bloqueo).
// 10 rondas cada una: dos activaciones de la misma candidata dejan una regla; activar y «Recordar» del mismo proveedor dejan una regla viva
// y la candidata en conflicto si gano «Recordar»; completar, activar y descartar a la vez no dan 40P01; dos iniciar a la vez, uno 23505;
// archivar y activar se serializan por el `FOR SHARE` del cliente (nunca una regla en un archivado); lotes en orden inverso no se
// interbloquean. Ademas, pruebas deterministas con una transaccion retenida. Hasta T10 fallan: funciones y columnas ausentes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin, exportado } from "./auth-soporte";
import { type ContappDb, type Tx } from "./soporte";
import { crearDb } from "./trabajos-soporte";
import { APRENDIDO, DESCARGA } from "./reglas-soporte";
import {
  barrera,
  carga,
  conPlazo,
  EscenarioImportacion,
  periodosHasta,
  resumen,
  SQL,
  type ClientePrueba,
} from "./reglas-importacion-soporte";

let admin: Pool;
let ei: EscenarioImportacion;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let ux: string;

beforeAll(async () => {
  admin = abrirAdmin(14);
  ei = new EscenarioImportacion(admin);
  X = (await ei.estudio()).id;
  ux = await ei.usuarioDe(X);
  backend = crearDb("contapp_backend", 8);
  worker = crearDb("contapp_worker", 4);
});
afterAll(async () => {
  await ei?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close(), ei?.cerrar()].map((p) =>
      p?.catch(() => undefined),
    ),
  );
  await admin?.end();
});

const comoX = () => ({ tenantId: X, userId: ux });
const RONDAS = 10;

type Salida<T> = { ok: true; v: T } | { ok: false; code: string };
async function en<T>(db: ContappDb, ctx: { tenantId: string; userId?: string }, fn: (tx: Tx) => Promise<T>): Promise<Salida<T>> {
  try {
    return { ok: true, v: await db.withTenant(ctx, fn) };
  } catch (e) {
    return { ok: false, code: String((e as { code?: string }).code ?? e) };
  }
}
function exito<T>(s: Salida<T>, nombre = ""): T {
  if (!s.ok) throw new Error(`${nombre}: fallo con ${s.code}`);
  return s.v;
}
const activarTx = (tx: Tx, cliente: string, ids: string[], todas: string | null = null) =>
  tx.query(SQL.activar, [cliente, todas ? null : JSON.stringify(ids.map((id) => ({ id }))), todas]).then((r) => r.rows as { candidata_id: string; resultado: string; regla_id: string | null }[]);

function diferido() {
  let resolver!: () => void;
  const promesa = new Promise<void>((r) => (resolver = r));
  return { promesa, resolver };
}

async function escenario(n: number): Promise<{ c: ClientePrueba; imp: string; cs: { id: string; docNumero: string }[] }> {
  const c = await ei.cliente(X);
  const imp = await ei.importacion(X, c, { periodoHasta: "202607" });
  return { c, imp, cs: await ei.candidatas(X, c, imp, n) };
}

// =================================================================================================
describe("dos activaciones de la misma candidata (CA-4)", () => {
  it(`dejan una sola regla: una da 'activada' y la otra 'no_pendiente'; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const { c, cs } = await escenario(1);
      const espera = barrera(2);
      const lanzar = () =>
        en(backend, comoX(), async (tx) => {
          await espera();
          return activarTx(tx, c.id, [cs[0]!.id]);
        });
      const [a, b] = await Promise.all([lanzar(), lanzar()]);
      const resultados = [exito(a, `ronda ${ronda} a`), exito(b, `ronda ${ronda} b`)].map((r) => r[0]!.resultado).sort();
      expect(resultados, `ronda ${ronda}`).toEqual(["activada", "no_pendiente"]);
      const vivas = await ei.reglasVivas(c.id, cs[0]!.docNumero);
      expect(vivas, `ronda ${ronda}: una sola regla viva`).toHaveLength(1);
      expect(vivas[0]).toMatchObject({ origen: "importacion", version: 1 });
      expect(await ei.filaCandidata(cs[0]!.id)).toMatchObject({ estado: "activada", regla_id: vivas[0]!.id });
    }
  }, 60_000);

  it(`lotes con los mismos ids en orden inverso no se interbloquean y cada candidata queda activada una vez; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const { c, cs } = await escenario(10);
      const ids = cs.map((x) => x.id);
      const espera = barrera(2);
      const lanzar = (lote: string[]) =>
        en(backend, comoX(), async (tx) => {
          await espera();
          return activarTx(tx, c.id, lote);
        });
      const [a, b] = await Promise.all([lanzar(ids), lanzar([...ids].reverse())]);
      const ra = exito(a, `ronda ${ronda} a`);
      const rb = exito(b, `ronda ${ronda} b`);
      for (const id of ids) {
        const res = [ra, rb].map((r) => r.find((x) => x.candidata_id === id)!.resultado).sort();
        expect(res, `ronda ${ronda} ${id}`).toEqual(["activada", "no_pendiente"]);
      }
      for (const k of cs) expect(await ei.reglasVivas(c.id, k.docNumero), `ronda ${ronda}`).toHaveLength(1);
    }
  }, 90_000);
});

// =================================================================================================
describe("activar y «Recordar» del mismo proveedor (CA-4: un «Recordar» nunca queda sobrescrito)", () => {
  interface ReglaFila {
    id: string;
    destino: string;
    version: number;
  }
  const recordar = (tx: Tx, e: unknown) =>
    exportado<(tx: Tx, e: unknown) => Promise<ReglaFila | "regla_cambiada" | "proveedores_distintos" | "no_encontrada">>("recordarRegla")(tx, e);
  let cR: ClientePrueba;
  let impR: string;
  let propR: string;

  beforeAll(async () => {
    cR = await ei.cliente(X);
    impR = await ei.importacion(X, cR, { periodoHasta: "202607" });
    propR = await ei.propuesta(X, cR, { libro: "compras", periodo: DESCARGA, nuevas: 50 });
  });

  async function proveedor() {
    const docNumero = ei.docNuevo();
    const cand = await ei.candidata(X, cR, impR, { docNumero });
    const compra = (await ei.compra(X, cR, { periodo: APRENDIDO, propuestaId: propR, docNumero })).id;
    return { docNumero, cand, compra };
  }
  const recordarTx = (tx: Tx, compra: string) =>
    recordar(tx, { clienteId: cR.id, compraIds: [compra], destino: "DG", versionBase: null, usuarioId: ux });
  const confirmaciones = async (reglaId: string) =>
    Number((await admin.query("select count(*)::int as n from regla_confirmacion where regla_id = $1", [reglaId])).rows[0].n);

  it(`a la vez: una sola regla viva; si gana «Recordar» la candidata queda en conflicto; si gana la importacion «Recordar» recibe regla_cambiada; ${RONDAS} rondas`, async () => {
    let ganoRecordar = 0;
    let ganoImportacion = 0;
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const { docNumero, cand, compra } = await proveedor();
      const espera = barrera(2);
      const [a, r] = await Promise.all([
        en(backend, comoX(), async (tx) => {
          await espera();
          return activarTx(tx, cR.id, [cand]);
        }),
        en(backend, comoX(), async (tx) => {
          await espera();
          return recordarTx(tx, compra);
        }),
      ]);
      const act = exito(a, `ronda ${ronda} activar`)[0]!;
      const rec = exito(r, `ronda ${ronda} recordar`);
      const vivas = await ei.reglasVivas(cR.id, docNumero);
      expect(vivas, `ronda ${ronda}: una sola regla viva`).toHaveLength(1);
      const k = await ei.filaCandidata(cand);
      if (rec !== "regla_cambiada") {
        ganoRecordar++;
        expect((rec as ReglaFila).id).toBe(vivas[0]!.id);
        expect(vivas[0], `ronda ${ronda}`).toMatchObject({ origen: "contador", destino: "DG", version: 1 });
        expect(act.resultado, `ronda ${ronda}`).toBe("conflicto");
        expect(k, `ronda ${ronda}`).toMatchObject({ estado: "pendiente", regla_id: null });
        expect(await confirmaciones(vivas[0]!.id), "«Recordar» si confirma").toBe(1);
      } else {
        ganoImportacion++;
        expect(vivas[0], `ronda ${ronda}`).toMatchObject({ origen: "importacion", destino: "DNG", version: 1 });
        expect(act.resultado, `ronda ${ronda}`).toBe("activada");
        expect(k, `ronda ${ronda}`).toMatchObject({ estado: "activada", regla_id: vivas[0]!.id });
        expect(await confirmaciones(vivas[0]!.id), "activar nunca confirma (D-7)").toBe(0);
      }
    }
    expect(ganoRecordar + ganoImportacion).toBe(RONDAS);
  }, 90_000);

  it("determinista: con un «Recordar» sin confirmar, activar espera y luego informa conflicto; la regla de «Recordar» no se sobrescribe", async () => {
    const { docNumero, cand, compra } = await proveedor();
    const insertado = diferido();
    const soltar = diferido();
    const rec = en(backend, comoX(), async (tx) => {
      const r = await recordarTx(tx, compra);
      insertado.resolver();
      await soltar.promesa;
      return r;
    });
    await insertado.promesa;
    const act = en(backend, comoX(), (tx) => activarTx(tx, cR.id, [cand]));
    expect(await conPlazo(act, 600), "activar espera al indice unico de reglas vivas").toBe("pendiente");
    soltar.resolver();
    expect((exito(await rec) as ReglaFila).destino).toBe("DG");
    expect(exito(await act)[0]!.resultado).toBe("conflicto");
    expect(await ei.reglasVivas(cR.id, docNumero)).toMatchObject([{ origen: "contador", destino: "DG", version: 1 }]);
    expect(await ei.filaCandidata(cand)).toMatchObject({ estado: "pendiente", regla_id: null });
  });

  it("determinista: con una activacion sin confirmar, «Recordar» espera y recibe regla_cambiada; queda la regla importada", async () => {
    const { docNumero, cand, compra } = await proveedor();
    const hecho = diferido();
    const soltar = diferido();
    const act = en(backend, comoX(), async (tx) => {
      const r = await activarTx(tx, cR.id, [cand]);
      hecho.resolver();
      await soltar.promesa;
      return r;
    });
    await hecho.promesa;
    const rec = en(backend, comoX(), (tx) => recordarTx(tx, compra));
    expect(await conPlazo(rec, 600), "«Recordar» espera la insercion de la importacion").toBe("pendiente");
    soltar.resolver();
    expect(exito(await act)[0]!.resultado).toBe("activada");
    expect(exito(await rec)).toBe("regla_cambiada");
    expect(await ei.reglasVivas(cR.id, docNumero)).toMatchObject([{ origen: "importacion", destino: "DNG" }]);
  });
});

// =================================================================================================
describe("completar, activar y descartar a la vez (plan: Orden de bloqueo)", () => {
  it(`sin interbloqueos (40P01) ni estados incoherentes: cada candidata termina activada, descartada o reemplazada; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const { c, cs } = await escenario(12);
      const ids = cs.map((x) => x.id);
      const nueva = await ei.importacion(X, c, { estado: "en_curso", periodoHasta: "202608" });
      const espera = barrera(3);
      const nuevas = Array.from({ length: 4 }, () => carga({ docNumero: ei.docNuevo() }));
      const [rc, ra, rd] = await Promise.all([
        en(worker, { tenantId: X }, async (tx) => {
          await espera();
          return (await tx.query(SQL.completar, [nueva, resumen({ candidatas: 4 }), JSON.stringify(nuevas)])).rows[0]!.n as number;
        }),
        en(backend, comoX(), async (tx) => {
          await espera();
          return activarTx(tx, c.id, ids.slice(0, 6));
        }),
        en(backend, comoX(), async (tx) => {
          await espera();
          return (await tx.query(SQL.descartar, [c.id, ids.slice(3, 9)])).rows as { candidata_id: string; descartada: boolean }[];
        }),
      ]);
      const n = exito(rc, `ronda ${ronda} completar`);
      const act = exito(ra, `ronda ${ronda} activar`);
      const des = exito(rd, `ronda ${ronda} descartar`);
      expect(n).toBe(4);
      const estados = new Map<string, any>();
      for (const k of cs) estados.set(k.id, await ei.filaCandidata(k.id));
      for (const k of cs) expect(["activada", "descartada", "reemplazada"], `ronda ${ronda} ${k.id}`).toContain(estados.get(k.id).estado);
      const activadas = ids.filter((id) => estados.get(id).estado === "activada");
      const descartadas = ids.filter((id) => estados.get(id).estado === "descartada");
      expect(act.filter((x) => x.resultado === "activada").map((x) => x.candidata_id).sort(), `ronda ${ronda}`).toEqual([...activadas].sort());
      expect(des.filter((x) => x.descartada).map((x) => x.candidata_id).sort(), `ronda ${ronda}`).toEqual([...descartadas].sort());
      for (const k of cs) {
        const vivas = await ei.reglasVivas(c.id, k.docNumero);
        const e = estados.get(k.id);
        if (e.estado === "activada") {
          expect(vivas.map((v) => v.id), `ronda ${ronda}`).toEqual([e.regla_id]);
        } else {
          expect(vivas, `ronda ${ronda}: sin regla si no se activo`).toEqual([]);
        }
      }
      expect((await ei.filaImportacion(nueva)).estado).toBe("completada");
      expect(await ei.cuantasCandidatas(nueva, "pendiente")).toBe(4);
    }
  }, 120_000);
});

// =================================================================================================
describe("dos iniciar a la vez (CA-5)", () => {
  it(`uno crea la importacion y el otro recibe 23505; una sola en curso y una sola auditoria; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const c = await ei.cliente(X);
      const espera = barrera(2);
      const lanzar = () =>
        en(backend, comoX(), async (tx) => {
          await espera();
          return (await tx.query(SQL.iniciar, [c.id, periodosHasta("202607", 6)])).rows[0]!.id as string;
        });
      const [a, b] = await Promise.all([lanzar(), lanzar()]);
      const salidas = [a, b];
      expect(salidas.filter((s) => s.ok), `ronda ${ronda}`).toHaveLength(1);
      expect(salidas.filter((s) => !s.ok).map((s) => (s as { code: string }).code), `ronda ${ronda}`).toEqual(["23505"]);
      const filas = (await admin.query("select id, estado from regla_importacion where cliente_id = $1", [c.id])).rows;
      expect(filas).toHaveLength(1);
      expect(filas[0].estado).toBe("en_curso");
      const aud = (await ei.filas(X, "regla.historial_importado")).filter((f) => f.cliente_id === c.id);
      expect(aud, `ronda ${ronda}: una sola auditoria`).toHaveLength(1);
    }
  }, 60_000);
});

// =================================================================================================
describe("archivar y activar se serializan por el cliente (plan: FOR SHARE)", () => {
  const archivarTx = (tx: Tx, c: ClientePrueba) => tx.query("update cliente set archivado_at = now() where id = $1", [c.id]);

  it(`a la vez: si la activacion sale bien hay una regla; si no, 55000 y ninguna; nunca regla sin que la activacion lo diga; ${RONDAS} rondas`, async () => {
    let activadas = 0;
    let rechazadas = 0;
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const { c, cs } = await escenario(1);
      const espera = barrera(2);
      const [a, r] = await Promise.all([
        en(backend, comoX(), async (tx) => {
          await espera();
          return activarTx(tx, c.id, [cs[0]!.id]);
        }),
        en(backend, comoX(), async (tx) => {
          await espera();
          await archivarTx(tx, c);
          return "ok";
        }),
      ]);
      expect(exito(r, `ronda ${ronda} archivar`)).toBe("ok");
      const vivas = await ei.reglasVivas(c.id, cs[0]!.docNumero);
      if (a.ok) {
        activadas++;
        expect(a.v[0]!.resultado).toBe("activada");
        expect(vivas, `ronda ${ronda}`).toHaveLength(1);
      } else {
        rechazadas++;
        expect(a.code, `ronda ${ronda}`).toBe("55000");
        expect(vivas, `ronda ${ronda}: nunca una regla en un archivado`).toEqual([]);
        expect((await ei.filaCandidata(cs[0]!.id)).estado).toBe("pendiente");
      }
    }
    expect(activadas + rechazadas).toBe(RONDAS);
  }, 60_000);

  it("determinista: con el archivado sin confirmar, activar espera y luego da 55000 sin crear la regla", async () => {
    const { c, cs } = await escenario(1);
    const hecho = diferido();
    const soltar = diferido();
    const arch = en(backend, comoX(), async (tx) => {
      await archivarTx(tx, c);
      hecho.resolver();
      await soltar.promesa;
      return "ok";
    });
    await hecho.promesa;
    const act = en(backend, comoX(), (tx) => activarTx(tx, c.id, [cs[0]!.id]));
    expect(await conPlazo(act, 600), "activar espera el FOR SHARE del cliente").toBe("pendiente");
    soltar.resolver();
    expect(exito(await arch)).toBe("ok");
    const s = await act;
    expect(s.ok ? "ok" : s.code).toBe("55000");
    expect(await ei.reglasVivas(c.id, cs[0]!.docNumero)).toEqual([]);
  });

  it("determinista: con una activacion sin confirmar, archivar espera y termina despues; la regla queda", async () => {
    const { c, cs } = await escenario(1);
    const hecho = diferido();
    const soltar = diferido();
    const act = en(backend, comoX(), async (tx) => {
      const r = await activarTx(tx, c.id, [cs[0]!.id]);
      hecho.resolver();
      await soltar.promesa;
      return r;
    });
    await hecho.promesa;
    const arch = en(backend, comoX(), async (tx) => {
      await archivarTx(tx, c);
      return "ok";
    });
    expect(await conPlazo(arch, 600), "archivar espera a la activacion").toBe("pendiente");
    soltar.resolver();
    expect(exito(await act)[0]!.resultado).toBe("activada");
    expect(exito(await arch)).toBe("ok");
    expect(await ei.reglasVivas(c.id, cs[0]!.docNumero)).toHaveLength(1);
  });
});
