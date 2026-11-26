// Spec 027 (T3, rojo): concurrencia de las funciones de gnd_ (R-6, R-7, D-2; CA-7, CA-9, CA-10, CA-16; plan: `pg_advisory_xact_lock` por estudio
// `gnd:<tenant>` y `FOR SHARE` del cliente). 10 rondas cada una: dos agregados que cruzan el limite de 2.000 dan uno CA421; la misma palabra
// a la vez da CA420 (nunca 23505); dos ediciones con la misma version dan una CA409 (palabra propia, umbral y global de plataforma);
// aprender a la vez que desactivar la misma palabra, que agregarla o que otro aprender no pierde ni duplica; archivar a la vez que fijar
// las categorias (o aprender) nunca deja una fila en un archivado; el guardado del CIIU del worker no se interbloquea. Ademas, pruebas
// deterministas con una transaccion retenida. Hasta T10 fallan: funciones y tablas ausentes. Modelo: `prorrata-concurrencia.spec.ts`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin, abrirApp, llamar as llamarAuth } from "./auth-soporte";
import { type ContappDb, type Tx } from "./soporte";
import { crearDb } from "./trabajos-soporte";
import { EscenarioPlanes } from "./planes-soporte";
import {
  barrera,
  conPlazo,
  EscenarioGnd,
  LIMITE_PROPIAS,
  SQL,
  SQL_PLATAFORMA,
  type ClientePrueba,
} from "./gnd-soporte";

let admin: Pool;
let app: Pool;
let eg: EscenarioGnd;
let pl: EscenarioPlanes;
let backend: ContappDb;
let worker: ContappDb;
let adminPlat: { id: string; token: Buffer };

beforeAll(async () => {
  admin = abrirAdmin(14);
  app = abrirApp(6);
  eg = new EscenarioGnd(admin);
  pl = new EscenarioPlanes(admin);
  backend = crearDb("contapp_backend", 8);
  worker = crearDb("contapp_worker", 4);
  const a = await pl.administrador();
  adminPlat = { id: a.usuario.id, token: a.sesion };
});
afterAll(async () => {
  await eg?.limpiar();
  await pl?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close(), eg?.cerrar()].map((p) =>
      p?.catch(() => undefined),
    ),
  );
  await app?.end();
  await admin?.end();
});

const RONDAS = 10;

type Salida<T> = { ok: true; v: T } | { ok: false; code: string };
type Ctx = { tenantId: string; userId?: string };
async function en<T>(
  db: ContappDb,
  ctx: Ctx,
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

async function estudioNuevo() {
  const e = await eg.estudio();
  const u = await eg.usuarioDe(e.id);
  const c = await eg.cliente(e.id);
  return { id: e.id, u, c, ctx: { tenantId: e.id, userId: u } as Ctx };
}
type Est = Awaited<ReturnType<typeof estudioNuevo>>;

const agregarTx = (tx: Tx, palabra: string, categoria = "juguetes") =>
  tx
    .query(SQL.agregar, [palabra, categoria, []])
    .then((r) => r.rows[0].id as string);
const estadoTx = (tx: Tx, id: string, activa: boolean, version: number) =>
  tx
    .query(SQL.estado, [id, activa, version])
    .then((r) => Number(r.rows[0].version));
const umbralTx = (tx: Tx, n: number, version: number) =>
  tx.query(SQL.umbral, [n, version]).then((r) => Number(r.rows[0].version));
const categoriasTx = (
  tx: Tx,
  c: ClientePrueba,
  permitidas: string[],
  version: number,
) =>
  tx
    .query(SQL.categorias, [c.id, permitidas, [], version])
    .then((r) => Number(r.rows[0].version));
const aprenderTx = (
  tx: Tx,
  c: ClientePrueba,
  compra: string,
  terminos: string[],
) =>
  tx
    .query(SQL.aprender, [
      c.id,
      compra,
      JSON.stringify(
        terminos.map((t) => ({ termino: t, categoria: "entretenimiento" })),
      ),
    ])
    .then((r) => r.rows[0].r as { guardadas: string[]; omitidas: string[] });
const globalEstadoTx = (tx: Tx, id: string, activa: boolean) =>
  tx.query(SQL.globalEstado, [id, activa]).then(() => "ok");
const archivarTx = (tx: Tx, c: ClientePrueba) =>
  tx.query("update cliente set archivado_at = now() where id = $1", [c.id]);
const ciiuTx = (tx: Tx, entradas: { ruc: string; ciiu: string | null }[]) =>
  tx
    .query(SQL.ciiu, [JSON.stringify(entradas)])
    .then((r) => Number(r.rows[0].n));

/** Dos llamadas a la vez detras de una barrera, cada una en su transaccion. */
async function dos<A, B>(
  db: ContappDb,
  e: Est,
  a: (tx: Tx) => Promise<A>,
  b: (tx: Tx) => Promise<B>,
): Promise<[Salida<A>, Salida<B>]> {
  const espera = barrera(2);
  return Promise.all([
    en(db, e.ctx, async (tx) => {
      await espera();
      return a(tx);
    }),
    en(db, e.ctx, async (tx) => {
      await espera();
      return b(tx);
    }),
  ]);
}

// =================================================================================================
describe("el limite de 2.000 propias activas se serializa por estudio (plan: pg_advisory_xact_lock)", () => {
  it(`dos agregados a la vez con lugar para uno: uno sale bien y el otro da CA421; quedan 2.000 activas; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const e = await estudioNuevo();
      await eg.llenarPalabras(e.id, LIMITE_PROPIAS - 1);
      const [a, b] = await dos(
        backend,
        e,
        (tx) => agregarTx(tx, eg.palabraNueva()),
        (tx) => agregarTx(tx, eg.palabraNueva()),
      );
      expect([a, b].map(codigoSalida).sort(), `ronda ${ronda}`).toEqual([
        "CA421",
        "ok",
      ]);
      expect(await eg.activas(e.id), `ronda ${ronda}`).toBe(LIMITE_PROPIAS);
    }
  }, 120_000);

  it(`agregar a la vez que reactivar con lugar para uno: uno sale bien y el otro da CA421; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const e = await estudioNuevo();
      await eg.llenarPalabras(e.id, LIMITE_PROPIAS - 1);
      const inactiva = await eg.palabraEstudio(e.id, { activa: false });
      const [a, b] = await dos(
        backend,
        e,
        (tx) => agregarTx(tx, eg.palabraNueva()),
        (tx) => estadoTx(tx, inactiva.id, true, 1),
      );
      expect([a, b].map(codigoSalida).sort(), `ronda ${ronda}`).toEqual([
        "CA421",
        "ok",
      ]);
      expect(await eg.activas(e.id), `ronda ${ronda}`).toBe(LIMITE_PROPIAS);
    }
  }, 120_000);

  it(`aprender a la vez que agregar con lugar para uno: uno sale bien y el otro da CA421, sin dejar nada a medias; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const e = await estudioNuevo();
      const compra = await eg.compraExcluida(e.id, e.c);
      await eg.llenarPalabras(e.id, LIMITE_PROPIAS - 1);
      const nueva = eg.palabraNueva();
      const [a, b] = await dos(
        backend,
        e,
        (tx) => aprenderTx(tx, e.c, compra.id, [nueva]),
        (tx) => agregarTx(tx, eg.palabraNueva()),
      );
      expect([a, b].map(codigoSalida).sort(), `ronda ${ronda}`).toEqual([
        "CA421",
        "ok",
      ]);
      expect(await eg.activas(e.id), `ronda ${ronda}`).toBe(LIMITE_PROPIAS);
      if (!a.ok)
        expect(await eg.propia(e.id, nueva), `ronda ${ronda}`).toBeUndefined();
    }
  }, 120_000);
});

// =================================================================================================
describe("la misma palabra a la vez (CA420, R-7)", () => {
  it(`dos agregados de la misma palabra: uno sale bien y el otro da CA420 (nunca 23505); una sola fila; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const e = await estudioNuevo();
      const p = eg.palabraNueva();
      const [a, b] = await dos(
        backend,
        e,
        (tx) => agregarTx(tx, p),
        (tx) => agregarTx(tx, p),
      );
      expect([a, b].map(codigoSalida).sort(), `ronda ${ronda}`).toEqual([
        "CA420",
        "ok",
      ]);
      expect((await eg.propias(e.id)).map((f) => f.palabra)).toEqual([p]);
    }
  }, 60_000);

  it(`dos aprender del mismo termino: uno lo guarda y el otro lo omite; una sola fila y una sola auditoria; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const e = await estudioNuevo();
      const compra = await eg.compraExcluida(e.id, e.c);
      const p = eg.palabraNueva();
      const { filas } = await eg.capturar(
        e.id,
        "gnd.palabra_aprendida",
        async () => {
          const [a, b] = await dos(
            backend,
            e,
            (tx) => aprenderTx(tx, e.c, compra.id, [p]),
            (tx) => aprenderTx(tx, e.c, compra.id, [p]),
          );
          const r = [exito(a, "a"), exito(b, "b")];
          expect(
            r.map((x) => x.guardadas.length).sort(),
            `ronda ${ronda}`,
          ).toEqual([0, 1]);
          expect(
            r.map((x) => x.omitidas.length).sort(),
            `ronda ${ronda}`,
          ).toEqual([0, 1]);
        },
      );
      expect(filas, `ronda ${ronda}`).toHaveLength(1);
      expect((await eg.propias(e.id)).map((f) => f.palabra)).toEqual([p]);
    }
  }, 60_000);

  it(`aprender a la vez que agregar la misma palabra: queda una sola fila y los resultados son coherentes; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const e = await estudioNuevo();
      const compra = await eg.compraExcluida(e.id, e.c);
      const p = eg.palabraNueva();
      const [ap, ag] = await dos(
        backend,
        e,
        (tx) => aprenderTx(tx, e.c, compra.id, [p]),
        (tx) => agregarTx(tx, p),
      );
      const filas = await eg.propias(e.id);
      expect(filas, `ronda ${ronda}`).toHaveLength(1);
      if (ag.ok) {
        expect(exito(ap).omitidas, `ronda ${ronda}`).toEqual([p]);
        expect(filas[0]!.origen).toBe("manual");
      } else {
        expect(ag.code, `ronda ${ronda}`).toBe("CA420");
        expect(exito(ap).guardadas, `ronda ${ronda}`).toEqual([p]);
        expect(filas[0]!.origen).toBe("aprendida");
      }
    }
  }, 60_000);

  it(`aprender a la vez que desactivar la misma palabra: las dos salen bien (se omite lo que ya existe); queda desactivada, version 2, una auditoria de desactivacion y ninguna de aprendida; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const e = await estudioNuevo();
      const compra = await eg.compraExcluida(e.id, e.c);
      const existente = await eg.palabraEstudio(e.id);
      const des = await eg.capturar(
        e.id,
        "gnd.palabra_desactivada",
        async () => {
          const apr = await eg.capturar(
            e.id,
            "gnd.palabra_aprendida",
            async () => {
              const [a, b] = await dos(
                backend,
                e,
                (tx) => aprenderTx(tx, e.c, compra.id, [existente.palabra]),
                (tx) => estadoTx(tx, existente.id, false, 1),
              );
              expect(exito(a, "aprender").omitidas, `ronda ${ronda}`).toEqual([
                existente.palabra,
              ]);
              expect(exito(a).guardadas).toEqual([]);
              expect(exito(b, "desactivar"), `ronda ${ronda}`).toBe(2);
            },
          );
          expect(apr.filas, `ronda ${ronda}`).toHaveLength(0);
        },
      );
      expect(des.filas, `ronda ${ronda}`).toHaveLength(1);
      const f = (await eg.propia(e.id, existente.palabra))!;
      expect([f.activa, f.version, f.origen], `ronda ${ronda}`).toEqual([
        false,
        2,
        "manual",
      ]);
    }
  }, 60_000);

  it(`dos desactivaciones de la misma global por el mismo estudio: una sale bien y la otra da 22023 (sin cambios); una fila y una auditoria; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const e = await estudioNuevo();
      const g = await eg.palabraGlobal();
      const { filas } = await eg.capturar(
        e.id,
        "gnd.global_desactivada",
        async () => {
          const [a, b] = await dos(
            backend,
            e,
            (tx) => globalEstadoTx(tx, g.id, false),
            (tx) => globalEstadoTx(tx, g.id, false),
          );
          expect([a, b].map(codigoSalida).sort(), `ronda ${ronda}`).toEqual([
            "22023",
            "ok",
          ]);
        },
      );
      expect(filas, `ronda ${ronda}`).toHaveLength(1);
      expect(await eg.desactivadas(e.id)).toEqual([g.id]);
    }
  }, 60_000);
});

// =================================================================================================
describe("dos ediciones con la misma version (compare-and-set)", () => {
  it(`palabra propia: una sale bien (version 2) y la otra da CA409; una sola auditoria; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const e = await estudioNuevo();
      const p = await eg.palabraEstudio(e.id);
      const [a, b] = await dos(
        backend,
        e,
        (tx) => estadoTx(tx, p.id, false, 1),
        (tx) => estadoTx(tx, p.id, false, 1),
      );
      expect([a, b].map(codigoSalida).sort(), `ronda ${ronda}`).toEqual([
        "CA409",
        "ok",
      ]);
      const f = (await eg.propia(e.id, p.palabra))!;
      expect([f.activa, f.version], `ronda ${ronda}`).toEqual([false, 2]);
      expect(
        (await eg.filas(e.id, "gnd.palabra_desactivada")).length,
        `ronda ${ronda}`,
      ).toBe(1);
    }
  }, 60_000);

  it(`desactivar y reactivar con la misma version a la vez: una sale bien y la otra da CA409 o 22023 (sin cambios), nunca las dos; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const e = await estudioNuevo();
      const p = await eg.palabraEstudio(e.id);
      const [a, b] = await dos(
        backend,
        e,
        (tx) => estadoTx(tx, p.id, false, 1),
        (tx) => estadoTx(tx, p.id, true, 1),
      );
      // reactivar una activa es «sin cambios» o pierde el CAS: nunca sale bien junto a desactivar
      expect(
        [a, b].filter((s) => s.ok),
        `ronda ${ronda}`,
      ).toHaveLength(1);
      const otro = [a, b].find((s) => !s.ok) as { code: string };
      expect(["CA409", "22023"], `ronda ${ronda}`).toContain(otro.code);
      expect((await eg.propia(e.id, p.palabra))!.version).toBe(2);
    }
  }, 60_000);

  it(`umbral: dos cambios con version 0 (sin fila): uno sale bien (version 1) y el otro da CA409; con version 1, igual; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const e = await estudioNuevo();
      const [a, b] = await dos(
        backend,
        e,
        (tx) => umbralTx(tx, 5, 0),
        (tx) => umbralTx(tx, 6, 0),
      );
      expect([a, b].map(codigoSalida).sort(), `ronda ${ronda}`).toEqual([
        "CA409",
        "ok",
      ]);
      const v1 = (await eg.configDe(e.id))!;
      expect(v1.version, `ronda ${ronda}`).toBe(1);
      const [c, d] = await dos(
        backend,
        e,
        (tx) => umbralTx(tx, 8, 1),
        (tx) => umbralTx(tx, 9, 1),
      );
      expect([c, d].map(codigoSalida).sort(), `ronda ${ronda}`).toEqual([
        "CA409",
        "ok",
      ]);
      expect((await eg.configDe(e.id))!.version).toBe(2);
      expect(
        (await eg.filas(e.id, "gnd.umbral_cambiado")).length,
        `ronda ${ronda}`,
      ).toBe(2);
    }
  }, 60_000);

  it(`categorias del cliente: dos cambios con la misma version: uno sale bien y el otro da CA409; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const e = await estudioNuevo();
      const [a, b] = await dos(
        backend,
        e,
        (tx) => categoriasTx(tx, e.c, ["juguetes"], 0),
        (tx) => categoriasTx(tx, e.c, ["calzado-ropa"], 0),
      );
      expect([a, b].map(codigoSalida).sort(), `ronda ${ronda}`).toEqual([
        "CA409",
        "ok",
      ]);
      expect((await eg.categoriasDe(e.c.id))!.version).toBe(1);
    }
  }, 60_000);

  it(`global de plataforma: dos ediciones con la misma version: una sale bien y la otra da CA409; una sola fila editada en el historial; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const g = await eg.palabraGlobal();
      const editar = (activa: boolean) =>
        llamarAuth(app, SQL_PLATAFORMA.editar, [
          adminPlat.token,
          g.id,
          "juguetes",
          [],
          activa,
          1,
        ]);
      const [a, b] = await Promise.all([editar(false), editar(true)]);
      expect(
        [a, b].map((r) => (r.ok ? "ok" : r.code)).sort(),
        `ronda ${ronda}`,
      ).toEqual(["CA409", "ok"]);
      expect((await eg.global(g.id))!.version).toBe(2);
      expect(
        (await eg.historial(g.id)).filter((h) => h.accion === "editada"),
        `ronda ${ronda}`,
      ).toHaveLength(1);
    }
  }, 60_000);

  it(`global de plataforma: dos agregados de la misma palabra: uno sale bien y el otro da CA420 (nunca 23505); ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const p = eg.palabraNueva();
      const agregar = () =>
        llamarAuth(app, SQL_PLATAFORMA.agregar, [
          adminPlat.token,
          p,
          "juguetes",
          [],
        ]);
      const [a, b] = await Promise.all([agregar(), agregar()]);
      expect(
        [a, b].map((r) => (r.ok ? "ok" : r.code)).sort(),
        `ronda ${ronda}`,
      ).toEqual(["CA420", "ok"]);
      const g = (await eg.globalPorPalabra(p))!;
      expect(await eg.historial(g.id), `ronda ${ronda}`).toHaveLength(1);
    }
  }, 60_000);
});

// =================================================================================================
describe("archivar y fijar las categorias (o aprender) se serializan por el cliente (plan: FOR SHARE)", () => {
  it(`a la vez: si fijar sale bien hay una fila; si no, 55000 y ninguna; nunca una fila en un archivado; ${RONDAS} rondas`, async () => {
    let guardados = 0;
    let rechazados = 0;
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const e = await estudioNuevo();
      const espera = barrera(2);
      const [g, r] = await Promise.all([
        en(backend, e.ctx, async (tx) => {
          await espera();
          return categoriasTx(tx, e.c, ["juguetes"], 0);
        }),
        en(backend, e.ctx, async (tx) => {
          await espera();
          await archivarTx(tx, e.c);
          return "ok";
        }),
      ]);
      expect(exito(r, `ronda ${ronda} archivar`)).toBe("ok");
      const f = await eg.categoriasDe(e.c.id);
      if (g.ok) {
        guardados++;
        expect(f?.version, `ronda ${ronda}`).toBe(1);
      } else {
        rechazados++;
        expect(g.code, `ronda ${ronda}`).toBe("55000");
        expect(
          f,
          `ronda ${ronda}: nunca una fila en un archivado`,
        ).toBeUndefined();
      }
    }
    expect(guardados + rechazados).toBe(RONDAS);
  }, 60_000);

  it(`a la vez: si aprender sale bien hay una palabra; si no, 55000 y ninguna; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const e = await estudioNuevo();
      const compra = await eg.compraExcluida(e.id, e.c);
      const p = eg.palabraNueva();
      const espera = barrera(2);
      const [g, r] = await Promise.all([
        en(backend, e.ctx, async (tx) => {
          await espera();
          return aprenderTx(tx, e.c, compra.id, [p]);
        }),
        en(backend, e.ctx, async (tx) => {
          await espera();
          await archivarTx(tx, e.c);
          return "ok";
        }),
      ]);
      expect(exito(r, `ronda ${ronda} archivar`)).toBe("ok");
      const propias = await eg.propias(e.id);
      if (g.ok) {
        expect(g.v.guardadas, `ronda ${ronda}`).toEqual([p]);
        expect(propias.map((f) => f.palabra)).toEqual([p]);
      } else {
        expect(g.code, `ronda ${ronda}`).toBe("55000");
        expect(propias, `ronda ${ronda}: nada en un archivado`).toEqual([]);
      }
    }
  }, 60_000);

  it("determinista: con el archivado sin confirmar, fijar espera y luego da 55000 sin crear la fila", async () => {
    const e = await estudioNuevo();
    const hecho = diferido();
    const soltar = diferido();
    const arch = en(backend, e.ctx, async (tx) => {
      await archivarTx(tx, e.c);
      hecho.resolver();
      await soltar.promesa;
      return "ok";
    });
    await hecho.promesa;
    try {
      const gua = en(backend, e.ctx, (tx) =>
        categoriasTx(tx, e.c, ["juguetes"], 0),
      );
      expect(
        await conPlazo(gua, 600),
        "fijar espera el FOR SHARE del cliente",
      ).toBe("pendiente");
      soltar.resolver();
      expect(exito(await arch)).toBe("ok");
      expect(codigoSalida(await gua)).toBe("55000");
      expect(await eg.categoriasDe(e.c.id)).toBeUndefined();
    } finally {
      soltar.resolver();
    }
  });

  it("determinista: con fijar sin confirmar, archivar espera y termina despues; la fila queda", async () => {
    const e = await estudioNuevo();
    const hecho = diferido();
    const soltar = diferido();
    const gua = en(backend, e.ctx, async (tx) => {
      let v = 0;
      try {
        v = await categoriasTx(tx, e.c, ["juguetes"], 0);
      } finally {
        hecho.resolver();
      }
      await soltar.promesa;
      return v;
    });
    await hecho.promesa;
    try {
      const arch = en(backend, e.ctx, async (tx) => {
        await archivarTx(tx, e.c);
        return "ok";
      });
      expect(await conPlazo(arch, 600), "archivar espera a fijar").toBe(
        "pendiente",
      );
      soltar.resolver();
      expect(exito(await gua)).toBe(1);
      expect(exito(await arch)).toBe("ok");
      expect((await eg.categoriasDe(e.c.id))!.version).toBe(1);
    } finally {
      soltar.resolver();
    }
  });

  it("determinista: con el archivado sin confirmar, aprender espera y luego da 55000 sin guardar nada", async () => {
    const e = await estudioNuevo();
    const compra = await eg.compraExcluida(e.id, e.c);
    const hecho = diferido();
    const soltar = diferido();
    const arch = en(backend, e.ctx, async (tx) => {
      await archivarTx(tx, e.c);
      hecho.resolver();
      await soltar.promesa;
      return "ok";
    });
    await hecho.promesa;
    try {
      const apr = en(backend, e.ctx, (tx) =>
        aprenderTx(tx, e.c, compra.id, [eg.palabraNueva()]),
      );
      expect(
        await conPlazo(apr, 600),
        "aprender espera el FOR SHARE del cliente",
      ).toBe("pendiente");
      soltar.resolver();
      expect(exito(await arch)).toBe("ok");
      expect(codigoSalida(await apr)).toBe("55000");
      expect(await eg.propias(e.id)).toEqual([]);
    } finally {
      soltar.resolver();
    }
  });
});

// =================================================================================================
describe("el diccionario se serializa por estudio y no entre estudios (plan: advisory `gnd:<tenant>`)", () => {
  it("determinista: con un agregado sin confirmar en el estudio A, otro agregado de A espera; uno de B no espera", async () => {
    const a = await estudioNuevo();
    const b = await estudioNuevo();
    const hecho = diferido();
    const soltar = diferido();
    const primero = en(backend, a.ctx, async (tx) => {
      let id = "";
      try {
        id = await agregarTx(tx, eg.palabraNueva());
      } finally {
        hecho.resolver();
      }
      await soltar.promesa;
      return id;
    });
    await hecho.promesa;
    try {
      const mismo = en(backend, a.ctx, (tx) =>
        agregarTx(tx, eg.palabraNueva()),
      );
      const otro = en(backend, b.ctx, (tx) => agregarTx(tx, eg.palabraNueva()));
      expect(
        exito((await conPlazo(otro, 3000)) as Salida<string>),
        "otro estudio no espera",
      ).toMatch(/^[0-9a-f-]{36}$/);
      expect(await conPlazo(mismo, 600), "el mismo estudio espera").toBe(
        "pendiente",
      );
      soltar.resolver();
      expect(exito(await primero)).toMatch(/^[0-9a-f-]{36}$/);
      expect(exito(await mismo)).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      soltar.resolver();
    }
  });
});

// =================================================================================================
describe("gnd_ciiu_guardar del worker: sin interbloqueos ni duplicados (R-14)", () => {
  const ruc = (i: number) => `2011${String(i).padStart(7, "0")}`;

  it(`dos guardados del mismo RUC: los dos salen bien (el ultimo gana) y queda una fila; ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const e = await estudioNuevo();
      const espera = barrera(2);
      const lanzar = (ciiu: string) =>
        en(worker, { tenantId: e.id }, async (tx) => {
          await espera();
          return ciiuTx(tx, [{ ruc: ruc(1), ciiu }]);
        });
      const [a, b] = await Promise.all([lanzar("4752"), lanzar("4771")]);
      expect(
        a.ok && b.ok,
        `ronda ${ronda}: ${codigoSalida(a)} ${codigoSalida(b)}`,
      ).toBe(true);
      const f = await eg.ciiuDe(e.id);
      expect(f, `ronda ${ronda}`).toHaveLength(1);
      expect(["4752", "4771"]).toContain(f[0]!.ciiu);
    }
  }, 60_000);

  it(`dos guardados con los mismos RUC en orden contrario no dan 40P01 (la funcion los ordena); ${RONDAS} rondas`, async () => {
    for (let ronda = 0; ronda < RONDAS; ronda++) {
      const e = await estudioNuevo();
      const n = 40;
      const asc = Array.from({ length: n }, (_, i) => ({
        ruc: ruc(i),
        ciiu: "4752" as string | null,
      }));
      const desc = [...asc].reverse().map((x) => ({ ...x, ciiu: "4771" }));
      const espera = barrera(2);
      const lanzar = (entradas: typeof asc) =>
        en(worker, { tenantId: e.id }, async (tx) => {
          await espera();
          return ciiuTx(tx, entradas);
        });
      const [a, b] = await Promise.all([lanzar(asc), lanzar(desc)]);
      expect([a, b].map(codigoSalida), `ronda ${ronda}: sin 40P01`).toEqual([
        "ok",
        "ok",
      ]);
      expect(await eg.ciiuDe(e.id), `ronda ${ronda}`).toHaveLength(n);
    }
  }, 120_000);
});
