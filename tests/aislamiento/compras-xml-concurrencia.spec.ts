// Spec 016 (T5, rojo): concurrencia de la evaluacion numerada y del guardado de XML contra la BD real. Cubre CA-8 (una edicion y
// la llegada del XML a la vez, en cualquier orden, dejan la version final evaluada con el XML), la carrera de dos subidas (plan,
// «Riesgos»: advisory por comprobante + unica por n) y el orden de bloqueo (plan, «Orden de bloqueo»): advisory de XML -> advisory
// del periodo -> compra_periodo FOR SHARE -> compra_operacion -> compra por id ascendente, sin 40P01 con masiva y deshacer.
// Hasta T11 fallan porque las tablas y las funciones no existen. Contrato: encabezado de `compras-xml-soporte.ts`.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin } from "./auth-soporte";
import type { ContappDb } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import {
  barrera,
  dormir,
  MONTOS_DG,
  montos,
  PERIODO,
  transformarFalso,
  type DatosVersion,
} from "./compras-soporte";
import {
  aplicarAccion,
  aplicarMasiva,
  crearVersion,
  deshacer,
  entradaXml,
  EscenarioXml,
  evaluacionesDe,
  evaluadorXml,
  guardarDocumentoXml,
  hallazgosPorEvaluacion,
  leerHallazgosVigentes,
  punteroDe,
  reevaluarCompra,
  versionesN,
  xmlsDe,
  type IdentidadXml,
  type ResultadoGuardar,
} from "./compras-xml-soporte";

let admin: Pool;
let ec: EscenarioXml;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let ux: string;
let ux2: string;

beforeAll(async () => {
  admin = abrirAdmin(10);
  ec = new EscenarioXml(admin);
  X = (await ec.estudio()).id;
  ux = await ec.usuarioDe(X);
  ux2 = (await ec.miembro(X, "contador")).id;
  backend = crearDb("contapp_backend", 14);
  worker = crearDb("contapp_worker", 14);
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close()].map((p) => p?.catch(() => undefined)),
  );
  await admin?.end();
});

let consecutivo = 4000;
interface CompraK {
  id: string;
  ident: IdentidadXml;
}
/** Una compra con su evaluacion 1 y la identidad de su XML. */
const compraNueva = async (c: ClientePrueba): Promise<CompraK> => {
  const numero = String(++consecutivo);
  const s = await ec.compraXml(X, c, { serie: "F001", numero });
  return { id: s.id, ident: s.identidad };
};
const edicion = (): DatosVersion => ({
  montos: montos({
    ...MONTOS_DG,
    biDg: "900.00",
    igvDg: "162.00",
    total: undefined,
  }),
  excluida: false,
  motivo: null,
  clasificada: false,
});

/** Codigo de lo que lanzo una promesa liquidada, o 'ok'. */
const estado = (r: PromiseSettledResult<unknown>): string =>
  r.status === "fulfilled"
    ? "ok"
    : String(
        (r.reason as { codigo?: string; code?: string }).codigo ??
          (r.reason as { code?: string }).code ??
          "sin_codigo",
      );

/** La llegada de un XML como la hace el worker o «Subir XML»: guardar y re-evaluar en UNA transaccion (advisory de XML primero). */
const llegaXml = (
  db: ContappDb,
  c: ClientePrueba,
  k: CompraK,
  despues: () => Promise<void> = async () => undefined,
) =>
  db.withTenant({ tenantId: X }, async (tx) => {
    const g = await guardarDocumentoXml(
      tx,
      entradaXml(X, c.id, k.ident, { origen: "real" }),
    );
    if (g === "existente_no_simulado")
      throw new Error("no se esperaba un XML previo");
    await reevaluarCompra(tx, k.id, { evaluar: evaluadorXml().evaluar });
    await despues();
    return g;
  });

/** La edicion de la fila (version 2 sobre la 1), evaluada por `packages/db`. */
const editaFila = (
  k: CompraK,
  despues: () => Promise<void> = async () => undefined,
) =>
  backend.withTenant({ tenantId: X }, async (tx) => {
    const v = await crearVersion(
      tx,
      {
        compraId: k.id,
        versionBase: 1,
        datos: edicion(),
        accion: "editar",
        usuarioId: ux,
      },
      { evaluar: evaluadorXml().evaluar },
    );
    await despues();
    return v;
  });

const contiguas = (ns: number[]) => ns.map((_, i) => i + 1);

/** CA-8: la version final queda evaluada con el XML y la numeracion no tiene huecos ni repetidos. */
async function verificarConvergencia(
  compraId: string,
  xmlId: string,
  etiqueta: string,
) {
  expect(await versionesN(admin, compraId), `${etiqueta}: versiones`).toEqual([
    1, 2,
  ]);
  expect(await punteroDe(admin, compraId), `${etiqueta}: puntero`).toBe(2);
  const ev = await evaluacionesDe(admin, compraId);
  for (const v of [1, 2]) {
    const ns = ev.filter((e) => e.version_n === v).map((e) => e.n);
    expect(
      ns.length,
      `${etiqueta}: la version ${v} tiene evaluacion`,
    ).toBeGreaterThan(0);
    expect(
      ns,
      `${etiqueta}: evaluaciones de la version ${v} contiguas desde 1`,
    ).toEqual(contiguas(ns));
  }
  const ultima = ev.filter((e) => e.version_n === 2).at(-1)!;
  expect(
    ultima.documento_xml_id,
    `${etiqueta}: la ultima evaluacion de la version final lleva el XML`,
  ).toBe(xmlId);
  const h = (await hallazgosPorEvaluacion(admin, compraId)).filter(
    (x) => x.version_n === 2 && x.evaluacion_n === ultima.n,
  );
  expect(
    h.map((x) => x.lecturas),
    `${etiqueta}: la ultima evaluacion se calculo con el XML`,
  ).toEqual([{ xml: "real", version: "2" }]);
  const vigentes = await backend.withTenant({ tenantId: X }, (tx) =>
    leerHallazgosVigentes(tx, [compraId]),
  );
  expect(
    vigentes.get(compraId)?.map((x) => x.lecturas),
    `${etiqueta}: los vigentes son los de esa evaluacion`,
  ).toEqual([{ xml: "real", version: "2" }]);
}

const xmlIdDe = async (c: ClientePrueba, k: CompraK): Promise<string> => {
  const v = await xmlsDe(admin, c.id, k.ident);
  expect(v, "debe haber un solo XML guardado").toHaveLength(1);
  return v[0]!.id;
};

// =================================================================================================
describe("CA-8 · una edicion de la fila y la llegada de su XML (D-5)", () => {
  it("5 rondas con la edicion primero (confirmada) y el XML despues: la version 2 se re-evalua con el XML (evaluacion 2)", async () => {
    for (let ronda = 0; ronda < 5; ronda++) {
      const c = await ec.cliente(X);
      const k = await compraNueva(c);
      await editaFila(k);
      await llegaXml(worker, c, k);
      await verificarConvergencia(k.id, await xmlIdDe(c, k), `ronda ${ronda}`);
      expect(
        (await evaluacionesDe(admin, k.id)).filter((e) => e.version_n === 2),
      ).toHaveLength(2);
    }
  }, 60_000);

  it("5 rondas con el XML primero (confirmado) y la edicion despues: la version 2 nace con el XML (evaluacion 1)", async () => {
    for (let ronda = 0; ronda < 5; ronda++) {
      const c = await ec.cliente(X);
      const k = await compraNueva(c);
      await llegaXml(worker, c, k);
      await editaFila(k);
      await verificarConvergencia(k.id, await xmlIdDe(c, k), `ronda ${ronda}`);
      const ev = await evaluacionesDe(admin, k.id);
      expect(ev.filter((e) => e.version_n === 1).map((e) => e.n)).toEqual([
        1, 2,
      ]);
      expect(ev.filter((e) => e.version_n === 2).map((e) => e.n)).toEqual([1]);
    }
  }, 60_000);

  it("5 rondas con la edicion EN CURSO cuando llega el XML (la edicion retiene el bloqueo de la fila): el XML espera y re-evalua la version 2", async () => {
    for (let ronda = 0; ronda < 5; ronda++) {
      const c = await ec.cliente(X);
      const k = await compraNueva(c);
      let enCurso!: () => void;
      const lista = new Promise<void>((r) => (enCurso = r));
      const e = editaFila(k, async () => {
        enCurso();
        await dormir(60);
      });
      await lista;
      const x = llegaXml(worker, c, k);
      const r = await Promise.allSettled([e, x]);
      expect(r.map(estado), `ronda ${ronda}`).toEqual(["ok", "ok"]);
      await verificarConvergencia(k.id, await xmlIdDe(c, k), `ronda ${ronda}`);
    }
  }, 60_000);

  it("5 rondas con el XML EN CURSO cuando llega la edicion (la llegada retiene el bloqueo de la fila): la edicion espera y la version 2 nace con el XML", async () => {
    for (let ronda = 0; ronda < 5; ronda++) {
      const c = await ec.cliente(X);
      const k = await compraNueva(c);
      let enCurso!: () => void;
      const lista = new Promise<void>((r) => (enCurso = r));
      const x = llegaXml(worker, c, k, async () => {
        enCurso();
        await dormir(60);
      });
      await lista;
      const e = editaFila(k);
      const r = await Promise.allSettled([x, e]);
      expect(r.map(estado), `ronda ${ronda}`).toEqual(["ok", "ok"]);
      await verificarConvergencia(k.id, await xmlIdDe(c, k), `ronda ${ronda}`);
    }
  }, 60_000);

  it("10 rondas simultaneas (barrera y desfases de 0 a 12 ms en cada sentido): sin 40P01, version final evaluada con el XML", async () => {
    const desfases = [0, 1, 3, 6, 12];
    for (let ronda = 0; ronda < 10; ronda++) {
      const c = await ec.cliente(X);
      const k = await compraNueva(c);
      const llegar = barrera(2);
      const d = desfases[ronda % desfases.length]!;
      const sentido = ronda % 2 === 0;
      const e = (async () => {
        await llegar();
        if (!sentido) await dormir(d);
        return editaFila(k);
      })();
      const x = (async () => {
        await llegar();
        if (sentido) await dormir(d);
        return llegaXml(worker, c, k);
      })();
      const r = await Promise.allSettled([e, x]);
      expect(r.map(estado), `ronda ${ronda}`).toEqual(["ok", "ok"]);
      await verificarConvergencia(k.id, await xmlIdDe(c, k), `ronda ${ronda}`);
    }
  }, 90_000);

  it("dos re-evaluaciones simultaneas de la misma version (dos XML que llegan o dos reintentos) numeran 2 y 3 sin choque", async () => {
    for (let ronda = 0; ronda < 10; ronda++) {
      const c = await ec.cliente(X);
      const k = await compraNueva(c);
      await ec.xml(X, c, k.ident, { origen: "real" });
      const llegar = barrera(2);
      const lanzar = (db: ContappDb) =>
        db.withTenant({ tenantId: X }, async (tx) => {
          await llegar();
          return reevaluarCompra(tx, k.id, { evaluar: evaluadorXml().evaluar });
        });
      const r = await Promise.allSettled([lanzar(backend), lanzar(worker)]);
      expect(r.map(estado), `ronda ${ronda}`).toEqual(["ok", "ok"]);
      expect(
        (await evaluacionesDe(admin, k.id)).map((e) => e.n),
        `ronda ${ronda}`,
      ).toEqual([1, 2, 3]);
      expect(await versionesN(admin, k.id)).toEqual([1]);
    }
  }, 60_000);
});

// =================================================================================================
describe("dos subidas simultaneas del mismo comprobante (D-4, P-6; plan «Riesgos»)", () => {
  const subir = (
    db: ContappDb,
    c: ClientePrueba,
    k: CompraK,
    llegar: () => Promise<void>,
  ): Promise<ResultadoGuardar> =>
    db.withTenant({ tenantId: X }, async (tx) => {
      await llegar();
      return guardarDocumentoXml(
        tx,
        entradaXml(X, c.id, k.ident, { origen: "subido", subidoPor: ux }),
      );
    });

  it("10 rondas con un simulado vigente: una subida gana con n = 2 y la otra ve la primera y recibe existente_no_simulado; n correlativo sin 23505 ni 40P01", async () => {
    for (let ronda = 0; ronda < 10; ronda++) {
      const c = await ec.cliente(X);
      const k = await compraNueva(c);
      await ec.xml(X, c, k.ident, { origen: "simulado" });
      const llegar = barrera(2);
      const r = await Promise.allSettled([
        subir(backend, c, k, llegar),
        subir(backend, c, k, llegar),
      ]);
      expect(r.map(estado), `ronda ${ronda}`).toEqual(["ok", "ok"]);
      const valores = r.map(
        (x) => (x as PromiseFulfilledResult<ResultadoGuardar>).value,
      );
      expect(
        valores.filter((v) => v === "existente_no_simulado"),
        `ronda ${ronda}`,
      ).toHaveLength(1);
      expect(valores.filter((v) => typeof v === "object")).toMatchObject([
        { n: 2 },
      ]);
      expect(
        (await xmlsDe(admin, c.id, k.ident)).map((x) => [x.n, x.origen]),
        `ronda ${ronda}`,
      ).toEqual([
        [1, "simulado"],
        [2, "subido"],
      ]);
    }
  }, 60_000);

  it("10 rondas sin XML previo y cuatro subidas a la vez: exactamente una inserta n = 1 y las demas reciben existente_no_simulado", async () => {
    for (let ronda = 0; ronda < 10; ronda++) {
      const c = await ec.cliente(X);
      const k = await compraNueva(c);
      const llegar = barrera(4);
      const r = await Promise.allSettled([
        subir(backend, c, k, llegar),
        subir(backend, c, k, llegar),
        subir(worker, c, k, llegar),
        subir(backend, c, k, llegar),
      ]);
      expect(r.map(estado), `ronda ${ronda}`).toEqual(["ok", "ok", "ok", "ok"]);
      const valores = r.map(
        (x) => (x as PromiseFulfilledResult<ResultadoGuardar>).value,
      );
      expect(valores.filter((v) => v === "existente_no_simulado")).toHaveLength(
        3,
      );
      expect(
        (await xmlsDe(admin, c.id, k.ident)).map((x) => x.n),
        `ronda ${ronda}`,
      ).toEqual([1]);
    }
  }, 60_000);

  it("la subida y la re-evaluacion de la misma fila a la vez (advisory del comprobante y luego la fila) no interbloquean", async () => {
    for (let ronda = 0; ronda < 10; ronda++) {
      const c = await ec.cliente(X);
      const k = await compraNueva(c);
      const llegar = barrera(3);
      const subida = backend.withTenant({ tenantId: X }, async (tx) => {
        await llegar();
        const g = await guardarDocumentoXml(
          tx,
          entradaXml(X, c.id, k.ident, { origen: "subido", subidoPor: ux }),
        );
        await reevaluarCompra(tx, k.id, { evaluar: evaluadorXml().evaluar });
        return g;
      });
      const edita = (async () => {
        await llegar();
        return editaFila(k);
      })();
      const reeval = worker.withTenant({ tenantId: X }, async (tx) => {
        await llegar();
        return reevaluarCompra(tx, k.id, { evaluar: evaluadorXml().evaluar });
      });
      const r = await Promise.allSettled([subida, edita, reeval]);
      expect(r.map(estado), `ronda ${ronda}`).toEqual(["ok", "ok", "ok"]);
      await verificarConvergencia(k.id, await xmlIdDe(c, k), `ronda ${ronda}`);
    }
  }, 60_000);
});

// =================================================================================================
describe("orden de bloqueo: llegada de XML con masiva, accion de fila y deshacer (plan «Orden de bloqueo»)", () => {
  const PERMITIDOS = new Set([
    "ok",
    "version_obsoleta",
    "fila_cambiada",
    "nada_que_deshacer",
    "fila_excluida",
  ]);

  it("10 rondas: 12 llegadas de XML (una transaccion por comprobante), dos masivas en orden opuesto, una edicion y un deshacer terminan sin 40P01 y cada fila queda evaluada con su XML", async () => {
    for (let ronda = 0; ronda < 10; ronda++) {
      const c = await ec.cliente(X);
      const filas: CompraK[] = [];
      for (let i = 0; i < 12; i++) filas.push(await compraNueva(c));
      // El deshacer de ux2 necesita una operacion vigente suya: una masiva sobre las 4 primeras, ya confirmada.
      const previas = [...filas.slice(0, 4)].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      await backend.withTenant({ tenantId: X }, (tx) =>
        aplicarMasiva(
          tx,
          {
            clienteId: c.id,
            periodo: PERIODO,
            usuarioId: ux2,
            accion: "clasificar",
            parametros: { tipo: "dng" },
            items: previas.map((f) => ({ compraId: f.id, versionBase: 1 })),
          },
          { transformar: transformarFalso, evaluar: evaluadorXml().evaluar },
        ),
      );
      const asc = [...filas]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((f) => ({ compraId: f.id, versionBase: 1 }));
      const llegar = barrera(12 + 4);
      const llegadas = filas.map((k, i) =>
        (i % 2 === 0 ? worker : backend).withTenant(
          { tenantId: X },
          async (tx) => {
            await llegar();
            const g = await guardarDocumentoXml(
              tx,
              entradaXml(X, c.id, k.ident, { origen: "real" }),
            );
            if (g === "existente_no_simulado")
              throw new Error("XML previo inesperado");
            await reevaluarCompra(tx, k.id, {
              evaluar: evaluadorXml().evaluar,
            });
          },
        ),
      );
      const masiva = (items: typeof asc, u: string) =>
        backend.withTenant({ tenantId: X }, async (tx) => {
          await llegar();
          return aplicarMasiva(
            tx,
            {
              clienteId: c.id,
              periodo: PERIODO,
              usuarioId: u,
              accion: "clasificar",
              parametros: { tipo: "dng" },
              items,
            },
            { transformar: transformarFalso, evaluar: evaluadorXml().evaluar },
          );
        });
      const accion = backend.withTenant({ tenantId: X }, async (tx) => {
        await llegar();
        return aplicarAccion(
          tx,
          {
            compraId: filas[7]!.id,
            versionBase: 1,
            accion: "editar",
            parametros: { tipo: "bi", valor: "5.00" },
            usuarioId: ux,
          },
          { transformar: transformarFalso, evaluar: evaluadorXml().evaluar },
        );
      });
      const revierte = backend.withTenant({ tenantId: X }, async (tx) => {
        await llegar();
        return deshacer(
          tx,
          { clienteId: c.id, periodo: PERIODO, usuarioId: ux2 },
          { evaluar: evaluadorXml().evaluar },
        );
      });
      const r = await Promise.allSettled([
        ...llegadas,
        masiva(asc, ux),
        masiva([...asc].reverse(), ux),
        accion,
        revierte,
      ]);
      // Las 12 llegadas de XML nunca pueden fallar; masiva, edicion y deshacer solo con los rechazos de negocio de 014.
      expect(
        r.slice(0, 12).map(estado),
        `ronda ${ronda}: llegadas de XML`,
      ).toEqual(Array(12).fill("ok"));
      const resto = r.slice(12).map(estado);
      expect(
        resto.filter((e) => e === "40P01"),
        `ronda ${ronda}: interbloqueos`,
      ).toEqual([]);
      expect(
        resto.every((e) => PERMITIDOS.has(e)),
        `ronda ${ronda}: ${resto.join(",")}`,
      ).toBe(true);

      for (const k of filas) {
        const xmlId = await xmlIdDe(c, k);
        const versiones = await versionesN(admin, k.id);
        const vigente = await punteroDe(admin, k.id);
        expect(vigente, `ronda ${ronda}: puntero de ${k.ident.numero}`).toBe(
          versiones.at(-1),
        );
        const ev = await evaluacionesDe(admin, k.id);
        for (const v of versiones) {
          const ns = ev.filter((e) => e.version_n === v).map((e) => e.n);
          expect(
            ns,
            `ronda ${ronda}: ${k.ident.numero} v${v}: evaluaciones contiguas`,
          ).toEqual(contiguas(ns));
          expect(
            ns.length,
            `ronda ${ronda}: ${k.ident.numero} v${v}: evaluada`,
          ).toBeGreaterThan(0);
        }
        const ultima = ev.filter((e) => e.version_n === vigente).at(-1)!;
        expect(
          ultima.documento_xml_id,
          `ronda ${ronda}: ${k.ident.numero}: la version vigente quedo evaluada con el XML`,
        ).toBe(xmlId);
      }
    }
  }, 180_000);
});
