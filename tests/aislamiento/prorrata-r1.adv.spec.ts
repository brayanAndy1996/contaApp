/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD dinamicas en pruebas */
// Spec 026 · T15 (adversario, ronda 1): funciones acotadas de 0066 atacadas en BD real. Foco: el trabajo que respalda la escritura del
// worker (`p_trabajo` terminado, `app.trabajo_id` de otro trabajo), periodo futuro (R-1) y concurrencia de las cinco escrituras del mismo
// mes con el archivado. Caja negra (contrato del plan) y luego caja blanca (0066: la comprobacion del trabajo solo mira tipo, cliente y
// `parametros.periodo`; el actor de la auditoria sale de `app.trabajo_id`, no de `p_trabajo`; no hay reloj en la funcion).
// Las que fallan son hallazgos H-026-1-n (ver el resultado de T15 en tasks.md).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin } from "./auth-soporte";
import { type ContappDb, type Tx } from "./soporte";
import { crearDb } from "./trabajos-soporte";
import {
  argsRegistrar,
  barrera,
  codigoDe,
  decl,
  EscenarioProrrata,
  llamar,
  SQL,
  ventana,
  type ClientePrueba,
} from "./prorrata-soporte";

let admin: Pool;
let ep: EscenarioProrrata;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let ux: string;

beforeAll(async () => {
  admin = abrirAdmin(14);
  ep = new EscenarioProrrata(admin);
  X = (await ep.estudio()).id;
  ux = await ep.usuarioDe(X);
  backend = crearDb("contapp_backend", 8);
  worker = crearDb("contapp_worker", 6);
});
afterAll(async () => {
  await ep?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close(), ep?.cerrar()].map((p) =>
      p?.catch(() => undefined),
    ),
  );
  await admin?.end();
});

const comoX = () => ({ tenantId: X, userId: ux });

/** Mes en curso en hora de Lima (UTC-5 todo el ano) y el siguiente, AAAAMM. */
function mesesLima(): { enCurso: string; siguiente: string } {
  const lima = new Date(Date.now() - 5 * 3_600_000);
  const a = lima.getUTCFullYear();
  const m = lima.getUTCMonth() + 1;
  const p = (y: number, mm: number) => `${y}${String(mm).padStart(2, "0")}`;
  return { enCurso: p(a, m), siguiente: m === 12 ? p(a + 1, 1) : p(a, m + 1) };
}

async function auditoriaObtencion(clienteId: string): Promise<any[]> {
  return (
    await admin.query(
      `select actor_tipo, trabajo_id, usuario_id, cliente_id from auditoria
        where cliente_id = $1 and accion = 'prorrata.declaraciones_obtenidas' order by ocurrida_en, id`,
      [clienteId],
    )
  ).rows;
}

// =================================================================================================
describe("registrar: el trabajo que respalda la escritura (D-3, D-6)", () => {
  it("un trabajo ya terminado (completado, error o cancelado) no habilita una escritura nueva: 22023 y nada escrito", async () => {
    const observado: Record<string, string> = {};
    for (const estado of ["completado", "error", "cancelado"]) {
      const c = await ep.cliente(X);
      const job = await ep.jobDescarga(X, c, { periodo: "202610", estado });
      const antes = await ep.totales(c.id);
      const r = await llamar(
        worker,
        { tenantId: X, trabajoId: job },
        SQL.registrar,
        argsRegistrar(c, job),
      );
      observado[estado] = codigoDe(r);
      if (!r.ok)
        expect(await ep.totales(c.id), `${estado}: sin filas nuevas`).toEqual(
          antes,
        );
    }
    // Un trabajo terminado ya entrego su `resultado`: reusar su id para escribir otra obtencion (con su auditoria) es una repeticion
    // forjada, no la ejecucion del trabajo.
    expect(observado).toEqual({
      completado: "22023",
      error: "22023",
      cancelado: "22023",
    });
  });

  it("app.trabajo_id de OTRO trabajo (de otro cliente): se rechaza o la auditoria queda a nombre de p_trabajo, nunca del ajeno", async () => {
    const a = await ep.cliente(X);
    const b = await ep.cliente(X);
    const jobA = await ep.jobDescarga(X, a, { periodo: "202610" });
    const jobB = await ep.jobDescarga(X, b, { periodo: "202610" });
    const r = await llamar(
      worker,
      { tenantId: X, trabajoId: jobB },
      SQL.registrar,
      argsRegistrar(a, jobA),
    );
    if (!r.ok) {
      expect(["22023", "42501"]).toContain(r.code);
      expect((await ep.totales(a.id)).prorrata_obtencion).toBe(0);
      return;
    }
    const aud = await auditoriaObtencion(a.id);
    expect(aud).toHaveLength(1);
    // D-6: actor trabajo = el trabajo que obtuvo (el de la obtencion guardada), no el que diga la sesion.
    expect(
      { actor: aud[0].actor_tipo, trabajo: aud[0].trabajo_id },
      "la auditoria atribuye la obtencion del cliente A al trabajo del cliente B",
    ).toEqual({ actor: "trabajo", trabajo: jobA });
    const [ob] = await ep.obtenciones(a.id);
    expect(ob?.trabajo_id).toBe(jobA);
  });

  it("sin app.trabajo_id en la sesion del worker: se rechaza o la auditoria queda con actor trabajo y p_trabajo (D-6), no «sistema»", async () => {
    const c = await ep.cliente(X);
    const job = await ep.jobDescarga(X, c, { periodo: "202610" });
    const r = await llamar(
      worker,
      { tenantId: X },
      SQL.registrar,
      argsRegistrar(c, job),
    );
    if (!r.ok) {
      expect(["22023", "42501"]).toContain(r.code);
      expect((await ep.totales(c.id)).prorrata_obtencion).toBe(0);
      return;
    }
    const aud = await auditoriaObtencion(c.id);
    expect(aud).toHaveLength(1);
    expect({ actor: aud[0].actor_tipo, trabajo: aud[0].trabajo_id }).toEqual({
      actor: "trabajo",
      trabajo: job,
    });
  });
});

// =================================================================================================
describe("registrar: periodo futuro (R-1: M no puede ser posterior al mes en curso en hora de Lima)", () => {
  it("con un trabajo cuyo periodo es el mes siguiente al en curso: 22023 y nada escrito; el mes en curso si se admite (control)", async () => {
    const { enCurso, siguiente } = mesesLima();
    const control = await ep.cliente(X);
    const jobControl = await ep.jobDescarga(X, control, { periodo: enCurso });
    const ok = await llamar(
      worker,
      { tenantId: X, trabajoId: jobControl },
      SQL.registrar,
      argsRegistrar(control, jobControl, { hasta: enCurso, declaraciones: [] }),
    );
    expect(codigoDe(ok), "control: el mes en curso es valido").toBe("ok");

    const c = await ep.cliente(X);
    const job = await ep.jobDescarga(X, c, { periodo: siguiente });
    const r = await llamar(
      worker,
      { tenantId: X, trabajoId: job },
      SQL.registrar,
      argsRegistrar(c, job, { hasta: siguiente, declaraciones: [] }),
    );
    expect(codigoDe(r), `ventana de ${siguiente} (futuro) aceptada`).toBe(
      "22023",
    );
    expect(await ep.totales(c.id)).toEqual({
      prorrata_obtencion: 0,
      declaracion_mensual: 0,
      prorrata_mes_manual: 0,
      prorrata_usada_manual: 0,
    });
  });
});

// =================================================================================================
type Salida = { ok: true; v: number } | { ok: false; code: string };
async function en(
  db: ContappDb,
  ctx: { tenantId: string; userId?: string; trabajoId?: string },
  fn: (tx: Tx) => Promise<number>,
): Promise<Salida> {
  try {
    return { ok: true, v: await db.withTenant(ctx, fn) };
  } catch (e) {
    return { ok: false, code: String((e as { code?: string }).code ?? e) };
  }
}
const cod = (s: Salida) => (s.ok ? "ok" : s.code);
const num = (p: Promise<{ rows: any[] }>, k: string) =>
  p.then((r) => Number(r.rows[0][k]));

describe("concurrencia: guardar ∥ guardar ∥ eliminar ∥ prorrata usada ∥ registrar ∥ archivar sobre el mismo mes", () => {
  const RONDAS = 12;
  it(`sin 40P01, 40001 ni 23505; cada operacion termina con un codigo del contrato y las versiones quedan contiguas; ${RONDAS} rondas`, async () => {
    const vistos = new Set<string>();
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const c: ClientePrueba = await ep.cliente(X);
      const job = await ep.jobDescarga(X, c, { periodo: "202610" });
      // El mes ya tiene un manual vivo (v1) para que eliminar compita de verdad.
      await ep.manual(X, c, { periodo: "202610", version: 1 });
      const espera = barrera(6);
      const P = "202610";
      const [g1, g2, el, us, rg, ar] = await Promise.all([
        en(backend, comoX(), async (tx) => {
          await espera();
          return num(
            tx.query(SQL.guardarManual, [c.id, P, "1.00", "0.00", "2.00", "g1", 1]),
            "version",
          );
        }),
        en(backend, comoX(), async (tx) => {
          await espera();
          return num(
            tx.query(SQL.guardarManual, [c.id, P, "3.00", "0.00", "4.00", "g2", 1]),
            "version",
          );
        }),
        en(backend, comoX(), async (tx) => {
          await espera();
          return num(tx.query(SQL.eliminarManual, [c.id, P, "el", 1]), "version");
        }),
        en(backend, comoX(), async (tx) => {
          await espera();
          return num(tx.query(SQL.guardarUsada, [c.id, P, "50.00", 0]), "version");
        }),
        en(worker, { tenantId: X, trabajoId: job }, async (tx) => {
          await espera();
          return num(
            tx.query(
              SQL.registrar,
              argsRegistrar(c, job, {
                declaraciones: [decl({ periodo: P, prorrataUsada: "63.21" })],
                leidos: ventana(P),
              }),
            ),
            "n",
          );
        }),
        (async (): Promise<Salida> => {
          await espera();
          try {
            await admin.query(
              "update cliente set archivado_at = now() where id = $1",
              [c.id],
            );
            return { ok: true, v: 0 };
          } catch (e) {
            return { ok: false, code: String((e as { code?: string }).code) };
          }
        })(),
      ]);
      for (const s of [g1, g2, el, us, rg, ar]) vistos.add(cod(s));
      const ctx = `ronda ${ronda}: g1=${cod(g1)} g2=${cod(g2)} el=${cod(el)} us=${cod(us)} rg=${cod(rg)}`;
      expect(["ok", "CA409", "CA412", "55000"], ctx).toContain(cod(g1));
      expect(["ok", "CA409", "CA412", "55000"], ctx).toContain(cod(g2));
      expect(["ok", "CA409", "55000"], ctx).toContain(cod(el));
      expect(["ok", "CA413", "55000"], ctx).toContain(cod(us));
      expect(["ok", "55000"], ctx).toContain(cod(rg));
      // Compare-and-set: de los tres que parten de la version 1, a lo sumo uno gana.
      expect(
        [g1, g2, el].filter((s) => s.ok).length,
        ctx,
      ).toBeLessThanOrEqual(1);
      const manuales = await ep.manuales(c.id, P);
      expect(
        manuales.map((m) => m.version),
        ctx,
      ).toEqual(manuales.map((_, i) => i + 1));
      expect(manuales.length, ctx).toBe(
        1 + [g1, g2, el].filter((s) => s.ok).length,
      );
      expect((await ep.usadas(c.id, P)).length, ctx).toBe(us.ok ? 1 : 0);
      expect((await ep.declaraciones(c.id, P)).length, ctx).toBe(
        rg.ok ? 1 : 0,
      );
    }
    expect([...vistos].filter((x) => ["40P01", "40001", "23505"].includes(x)))
      .toEqual([]);
  }, 120_000);
});
