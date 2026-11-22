// Spec 026 (T3, rojo): concurrencia de las funciones de la prorrata (CA-4, CA-7; plan: Concurrencia). 10 rondas cada una: dos guardados
// con la misma version dejan uno CA409; guardar un manual y registrar la declaracion del mismo mes a la vez no dan 40P01 y terminan
// coherentes; dos registros del mismo cliente no duplican presentaciones; archivar y guardar (o registrar) se serializan por el
// `FOR SHARE` del cliente (nunca una fila en un archivado); prorrata usada y registro a la vez; guardados de periodos distintos del
// mismo cliente en paralelo no se interbloquean. Ademas, pruebas deterministas con una transaccion retenida. Hasta T10 fallan: funciones
// y tablas ausentes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin } from "./auth-soporte";
import { type ContappDb, type Tx } from "./soporte";
import { crearDb } from "./trabajos-soporte";
import {
  argsRegistrar,
  barrera,
  conPlazo,
  decl,
  EscenarioProrrata,
  SQL,
  type ArgsRegistrar,
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
  worker = crearDb("contapp_worker", 4);
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
const RONDAS = 10;

type Salida<T> = { ok: true; v: T } | { ok: false; code: string };
async function en<T>(
  db: ContappDb,
  ctx: { tenantId: string; userId?: string; trabajoId?: string },
  fn: (tx: Tx) => Promise<T>,
): Promise<Salida<T>> {
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
const codigoSalida = (s: Salida<unknown>) => (s.ok ? "ok" : s.code);

function diferido() {
  let resolver!: () => void;
  const promesa = new Promise<void>((r) => (resolver = r));
  return { promesa, resolver };
}

const guardarTx = (
  tx: Tx,
  c: ClientePrueba,
  periodo: string,
  version: number,
) =>
  tx
    .query(SQL.guardarManual, [
      c.id,
      periodo,
      "1000.00",
      "0.00",
      "200.00",
      "Motivo de prueba",
      version,
    ])
    .then((r) => Number(r.rows[0].version));
const eliminarTx = (
  tx: Tx,
  c: ClientePrueba,
  periodo: string,
  version: number,
) =>
  tx
    .query(SQL.eliminarManual, [c.id, periodo, "Se retira el mes", version])
    .then((r) => Number(r.rows[0].version));
const usarTx = (
  tx: Tx,
  c: ClientePrueba,
  periodo: string,
  version: number,
  porcentaje: string | null,
) =>
  tx
    .query(SQL.guardarUsada, [c.id, periodo, porcentaje, version])
    .then((r) => Number(r.rows[0].version));
const registrarTx = (
  tx: Tx,
  c: ClientePrueba,
  job: string,
  a: ArgsRegistrar = {},
) =>
  tx
    .query(SQL.registrar, argsRegistrar(c, job, a))
    .then((r) => Number(r.rows[0].n));
const registrarEn = (c: ClientePrueba, job: string, a: ArgsRegistrar = {}) =>
  en(worker, { tenantId: X, trabajoId: job }, (tx) =>
    registrarTx(tx, c, job, a),
  );
const archivarTx = (tx: Tx, c: ClientePrueba) =>
  tx.query("update cliente set archivado_at = now() where id = $1", [c.id]);

async function escenario(): Promise<{ c: ClientePrueba; job: string }> {
  const c = await ep.cliente(X);
  return { c, job: await ep.jobDescarga(X, c, { periodo: "202610" }) };
}

// =================================================================================================
describe("dos guardados con la misma version (CA-4: compare-and-set)", () => {
  it(`uno sale bien y el otro da CA409, con una sola fila nueva; version 0 y ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const c = await ep.cliente(X);
      const espera = barrera(2);
      const lanzar = () =>
        en(backend, comoX(), async (tx) => {
          await espera();
          return guardarTx(tx, c, "202609", 0);
        });
      const [a, b] = await Promise.all([lanzar(), lanzar()]);
      expect([a, b].map(codigoSalida).sort(), `ronda ${ronda}`).toEqual([
        "CA409",
        "ok",
      ]);
      const ok = [a, b].find((s) => s.ok) as { ok: true; v: number };
      expect(ok.v).toBe(1);
      const m = await ep.manuales(c.id, "202609");
      expect(
        m.map((x) => x.version),
        `ronda ${ronda}`,
      ).toEqual([1]);
    }
  }, 60_000);

  it(`con una version previa (1): uno sale bien (version 2) y el otro da CA409; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const c = await ep.cliente(X);
      await ep.manual(X, c, { periodo: "202609", version: 1 });
      const espera = barrera(2);
      const lanzar = () =>
        en(backend, comoX(), async (tx) => {
          await espera();
          return guardarTx(tx, c, "202609", 1);
        });
      const [a, b] = await Promise.all([lanzar(), lanzar()]);
      expect([a, b].map(codigoSalida).sort(), `ronda ${ronda}`).toEqual([
        "CA409",
        "ok",
      ]);
      expect(
        (await ep.manuales(c.id, "202609")).map((x) => x.version),
        `ronda ${ronda}`,
      ).toEqual([1, 2]);
    }
  }, 60_000);

  it(`dos eliminaciones con la misma version: una sale bien y la otra da CA409; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const c = await ep.cliente(X);
      await ep.manual(X, c, { periodo: "202609", version: 1 });
      const espera = barrera(2);
      const lanzar = () =>
        en(backend, comoX(), async (tx) => {
          await espera();
          return eliminarTx(tx, c, "202609", 1);
        });
      const [a, b] = await Promise.all([lanzar(), lanzar()]);
      expect([a, b].map(codigoSalida).sort(), `ronda ${ronda}`).toEqual([
        "CA409",
        "ok",
      ]);
      expect(
        (await ep.manuales(c.id, "202609")).map((x) => [x.version, x.accion]),
        `ronda ${ronda}`,
      ).toEqual([
        [1, "guardado"],
        [2, "eliminado"],
      ]);
    }
  }, 60_000);

  it(`guardar y eliminar a la vez sobre la version 1: solo uno gana (CA409 al otro); ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const c = await ep.cliente(X);
      await ep.manual(X, c, { periodo: "202609", version: 1 });
      const espera = barrera(2);
      const [g, e] = await Promise.all([
        en(backend, comoX(), async (tx) => {
          await espera();
          return guardarTx(tx, c, "202609", 1);
        }),
        en(backend, comoX(), async (tx) => {
          await espera();
          return eliminarTx(tx, c, "202609", 1);
        }),
      ]);
      expect([g, e].map(codigoSalida).sort(), `ronda ${ronda}`).toEqual([
        "CA409",
        "ok",
      ]);
      expect(
        (await ep.manuales(c.id, "202609")).map((x) => x.version),
        `ronda ${ronda}`,
      ).toEqual([1, 2]);
    }
  }, 60_000);
});

// =================================================================================================
describe("guardar un manual y registrar la declaracion del mismo mes (R-5, CA-3)", () => {
  it(`sin 40P01: el registro siempre sale bien y el manual sale bien (queda en el historial) o da CA412; ${RONDAS} rondas`, async () => {
    let manualGano = 0;
    let declaradoGano = 0;
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const { c, job } = await escenario();
      const espera = barrera(2);
      const [m, r] = await Promise.all([
        en(backend, comoX(), async (tx) => {
          await espera();
          return guardarTx(tx, c, "202610", 0);
        }),
        en(worker, { tenantId: X, trabajoId: job }, async (tx) => {
          await espera();
          return registrarTx(tx, c, job);
        }),
      ]);
      expect(exito(r, `ronda ${ronda} registrar`), `ronda ${ronda}`).toBe(1);
      expect(["ok", "CA412"], `ronda ${ronda}: manual`).toContain(
        codigoSalida(m),
      );
      expect(
        (await ep.declaraciones(c.id, "202610")).length,
        `ronda ${ronda}`,
      ).toBe(1);
      const manuales = await ep.manuales(c.id, "202610");
      if (m.ok) {
        manualGano++;
        expect(
          manuales.map((x) => x.version),
          `ronda ${ronda}`,
        ).toEqual([1]);
      } else {
        declaradoGano++;
        expect(
          manuales,
          `ronda ${ronda}: ningun manual si la declaracion llego antes`,
        ).toEqual([]);
      }
    }
    expect(manualGano + declaradoGano).toBe(RONDAS);
  }, 60_000);

  it(`prorrata usada y registro de un PDT con prorrata a la vez: el registro sale bien y la usada sale bien o da CA413; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const { c, job } = await escenario();
      const espera = barrera(2);
      const [u, r] = await Promise.all([
        en(backend, comoX(), async (tx) => {
          await espera();
          return usarTx(tx, c, "202610", 0, "50.00");
        }),
        en(worker, { tenantId: X, trabajoId: job }, async (tx) => {
          await espera();
          return registrarTx(tx, c, job, {
            declaraciones: [
              decl({ periodo: "202610", prorrataUsada: "63.21" }),
            ],
          });
        }),
      ]);
      expect(exito(r, `ronda ${ronda} registrar`), `ronda ${ronda}`).toBe(1);
      expect(["ok", "CA413"], `ronda ${ronda}: usada`).toContain(
        codigoSalida(u),
      );
      expect((await ep.usadas(c.id, "202610")).length, `ronda ${ronda}`).toBe(
        u.ok ? 1 : 0,
      );
    }
  }, 60_000);
});

// =================================================================================================
describe("registrar a la vez sobre el mismo cliente (CA-1: una segunda obtencion no duplica)", () => {
  it(`dos registros con las mismas presentaciones suman cada presentacion una sola vez y no dan 40P01 ni 23505; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const { c, job } = await escenario();
      const decls = [
        decl({ periodo: "202610", numeroOrden: "1001" }),
        decl({ periodo: "202609", numeroOrden: "2001" }),
        decl({ periodo: "202608", numeroOrden: "3001" }),
      ];
      const espera = barrera(2);
      const lanzar = () =>
        en(worker, { tenantId: X, trabajoId: job }, async (tx) => {
          await espera();
          return registrarTx(tx, c, job, { declaraciones: decls });
        });
      const [a, b] = await Promise.all([lanzar(), lanzar()]);
      const na = exito(a, `ronda ${ronda} a`);
      const nb = exito(b, `ronda ${ronda} b`);
      expect(na + nb, `ronda ${ronda}: nuevas entre las dos`).toBe(3);
      expect(
        (await ep.declaraciones(c.id)).length,
        `ronda ${ronda}: sin duplicados`,
      ).toBe(3);
      expect(
        (await ep.obtenciones(c.id)).length,
        `ronda ${ronda}: una obtencion por llamada`,
      ).toBe(2);
    }
  }, 60_000);

  it(`dos registros con presentaciones distintas del mismo periodo (original y rectificatoria) se suman sin perder ninguna; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const { c, job } = await escenario();
      const espera = barrera(2);
      const lanzar = (orden: string, tipo: "original" | "rectificatoria") =>
        en(worker, { tenantId: X, trabajoId: job }, async (tx) => {
          await espera();
          return registrarTx(tx, c, job, {
            declaraciones: [
              decl({ periodo: "202610", numeroOrden: orden, tipo }),
            ],
          });
        });
      const [a, b] = await Promise.all([
        lanzar("1001", "original"),
        lanzar("1002", "rectificatoria"),
      ]);
      expect(exito(a, `ronda ${ronda} a`) + exito(b, `ronda ${ronda} b`)).toBe(
        2,
      );
      expect(
        (await ep.declaraciones(c.id, "202610")).map((d) => d.numero_orden),
        `ronda ${ronda}`,
      ).toEqual(["1001", "1002"]);
    }
  }, 60_000);
});

// =================================================================================================
describe("guardados de periodos distintos del mismo cliente en paralelo (orden fijo de bloqueo)", () => {
  it(`ocho periodos a la vez salen todos bien, sin 40P01; ${RONDAS} rondas`, async () => {
    const periodos = [
      "202603",
      "202604",
      "202605",
      "202606",
      "202607",
      "202608",
      "202609",
      "202610",
    ];
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const c = await ep.cliente(X);
      const espera = barrera(periodos.length);
      const orden = ronda % 2 === 0 ? periodos : [...periodos].reverse();
      const rs = await Promise.all(
        orden.map((p) =>
          en(backend, comoX(), async (tx) => {
            await espera();
            return guardarTx(tx, c, p, 0);
          }),
        ),
      );
      expect(rs.map(codigoSalida), `ronda ${ronda}`).toEqual(
        orden.map(() => "ok"),
      );
      expect((await ep.manuales(c.id)).length, `ronda ${ronda}`).toBe(
        periodos.length,
      );
    }
  }, 90_000);
});

// =================================================================================================
describe("archivar y guardar (o registrar) se serializan por el cliente (plan: FOR SHARE)", () => {
  it(`a la vez: si el guardado sale bien hay una fila; si no, 55000 y ninguna; nunca una fila que el guardado no confirme; ${RONDAS} rondas`, async () => {
    let guardados = 0;
    let rechazados = 0;
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const c = await ep.cliente(X);
      const espera = barrera(2);
      const [g, r] = await Promise.all([
        en(backend, comoX(), async (tx) => {
          await espera();
          return guardarTx(tx, c, "202609", 0);
        }),
        en(backend, comoX(), async (tx) => {
          await espera();
          await archivarTx(tx, c);
          return "ok";
        }),
      ]);
      expect(exito(r, `ronda ${ronda} archivar`)).toBe("ok");
      const filas = await ep.manuales(c.id);
      if (g.ok) {
        guardados++;
        expect(
          filas.map((x) => x.version),
          `ronda ${ronda}`,
        ).toEqual([1]);
      } else {
        rechazados++;
        expect(g.code, `ronda ${ronda}`).toBe("55000");
        expect(filas, `ronda ${ronda}: nunca una fila en un archivado`).toEqual(
          [],
        );
      }
    }
    expect(guardados + rechazados).toBe(RONDAS);
  }, 60_000);

  it(`a la vez: si el registro sale bien hay presentaciones y obtencion; si no, 55000 y nada; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const { c, job } = await escenario();
      const espera = barrera(2);
      const [g, r] = await Promise.all([
        en(worker, { tenantId: X, trabajoId: job }, async (tx) => {
          await espera();
          return registrarTx(tx, c, job);
        }),
        en(backend, comoX(), async (tx) => {
          await espera();
          await archivarTx(tx, c);
          return "ok";
        }),
      ]);
      expect(exito(r, `ronda ${ronda} archivar`)).toBe("ok");
      const t = await ep.totales(c.id);
      if (g.ok) {
        expect(t.declaracion_mensual, `ronda ${ronda}`).toBe(1);
        expect(t.prorrata_obtencion, `ronda ${ronda}`).toBe(1);
      } else {
        expect(g.code, `ronda ${ronda}`).toBe("55000");
        expect(
          (t.declaracion_mensual ?? 0) + (t.prorrata_obtencion ?? 0),
          `ronda ${ronda}: nada en un archivado`,
        ).toBe(0);
      }
    }
  }, 60_000);

  it("determinista: con el archivado sin confirmar, guardar espera y luego da 55000 sin crear la fila", async () => {
    const c = await ep.cliente(X);
    const hecho = diferido();
    const soltar = diferido();
    const arch = en(backend, comoX(), async (tx) => {
      await archivarTx(tx, c);
      hecho.resolver();
      await soltar.promesa;
      return "ok";
    });
    await hecho.promesa;
    try {
      const gua = en(backend, comoX(), (tx) => guardarTx(tx, c, "202609", 0));
      expect(
        await conPlazo(gua, 600),
        "guardar espera el FOR SHARE del cliente",
      ).toBe("pendiente");
      soltar.resolver();
      expect(exito(await arch)).toBe("ok");
      expect(codigoSalida(await gua)).toBe("55000");
      expect(await ep.manuales(c.id)).toEqual([]);
    } finally {
      soltar.resolver();
    }
  });

  it("determinista: con un guardado sin confirmar, archivar espera y termina despues; la fila queda", async () => {
    const c = await ep.cliente(X);
    const hecho = diferido();
    const soltar = diferido();
    const gua = en(backend, comoX(), async (tx) => {
      let v = 0;
      try {
        v = await guardarTx(tx, c, "202609", 0);
      } finally {
        hecho.resolver();
      }
      await soltar.promesa;
      return v;
    });
    await hecho.promesa;
    try {
      const arch = en(backend, comoX(), async (tx) => {
        await archivarTx(tx, c);
        return "ok";
      });
      expect(await conPlazo(arch, 600), "archivar espera al guardado").toBe(
        "pendiente",
      );
      soltar.resolver();
      expect(exito(await gua)).toBe(1);
      expect(exito(await arch)).toBe("ok");
      expect((await ep.manuales(c.id)).map((x) => x.version)).toEqual([1]);
    } finally {
      soltar.resolver();
    }
  });

  it("determinista: con el archivado sin confirmar, registrar espera y luego da 55000 sin crear nada", async () => {
    const { c, job } = await escenario();
    const hecho = diferido();
    const soltar = diferido();
    const arch = en(backend, comoX(), async (tx) => {
      await archivarTx(tx, c);
      hecho.resolver();
      await soltar.promesa;
      return "ok";
    });
    await hecho.promesa;
    try {
      const reg = registrarEn(c, job);
      expect(
        await conPlazo(reg, 600),
        "registrar espera el FOR SHARE del cliente",
      ).toBe("pendiente");
      soltar.resolver();
      expect(exito(await arch)).toBe("ok");
      expect(codigoSalida(await reg)).toBe("55000");
      expect(await ep.totales(c.id)).toEqual({
        prorrata_obtencion: 0,
        declaracion_mensual: 0,
        prorrata_mes_manual: 0,
        prorrata_usada_manual: 0,
      });
    } finally {
      soltar.resolver();
    }
  });
});
