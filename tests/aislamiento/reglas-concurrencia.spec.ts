// Spec 021 (T3, rojo): concurrencia de las reglas aprendidas (CA-9; plan: Orden de bloqueo y Riesgos). Dos `recordarRegla` simultaneos
// dejan una sola regla y un `regla_cambiada`; editar, recordar o eliminar la regla DURANTE la descarga espera a que esta termine (la
// descarga lee con `FOR SHARE` en `reglas_historial_vigentes`) y todas las filas de esa descarga quedan con el mismo destino, sin
// interbloqueos, en 10 rondas; el interruptor del motor (advisory exclusivo `reglas_motor`) espera a la descarga en curso.
// Contrato en el encabezado de `reglas-soporte.ts`. Hasta T9 fallan: tablas y funciones ausentes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin, exportado } from "./auth-soporte";
import { type ContappDb, type Tx } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import { barrera, conPlazo } from "./compras-soporte";
import {
  aplicar,
  APRENDIDO,
  compraDelWorker,
  consolidar,
  DESCARGA,
  EscenarioReglas,
  FACTURA_DG,
  type Destino,
} from "./reglas-soporte";

let admin: Pool;
let ec: EscenarioReglas;
let worker: ContappDb;
let backend: ContappDb;
let X: string;
let ux: string;
let cx: ClientePrueba;
let propX: string;

beforeAll(async () => {
  admin = abrirAdmin(10);
  ec = new EscenarioReglas(admin);
  X = (await ec.estudio()).id;
  ux = await ec.usuarioDe(X);
  cx = await ec.cliente(X);
  worker = crearDb("contapp_worker", 6);
  backend = crearDb("contapp_backend", 6);
  propX = await ec.propuesta(X, cx, { libro: "compras", periodo: DESCARGA, nuevas: 50 });
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all(
    [worker?.close(), backend?.close(), ec?.cerrar()].map((p) =>
      p?.catch(() => undefined),
    ),
  );
  await admin?.end();
});

interface ReglaFila {
  id: string;
  destino: Destino;
  version: number;
  activa: boolean;
}
type Codigo = "regla_cambiada" | "proveedores_distintos" | "no_encontrada";
const recordar = (tx: Tx, e: unknown) =>
  exportado<(tx: Tx, e: unknown) => Promise<ReglaFila | Codigo>>("recordarRegla")(tx, e);
const editar = (tx: Tx, e: unknown) =>
  exportado<(tx: Tx, e: unknown) => Promise<ReglaFila | Codigo>>("editarRegla")(tx, e);
const eliminar = (tx: Tx, e: unknown) =>
  exportado<(tx: Tx, e: unknown) => Promise<"ok" | Codigo>>("eliminarRegla")(tx, e);
const fijarMotor = (tx: Tx, e: unknown) =>
  exportado<(tx: Tx, e: unknown) => Promise<void>>("fijarReglaMotor")(tx, e);

let consecutivo = 0;
const docNuevo = () => `20${String(900000000 + ++consecutivo)}`;
const comoX = <T>(fn: (tx: Tx) => Promise<T>) => backend.withTenant({ tenantId: X, userId: ux }, fn);

const compra = (c: ClientePrueba, prop: string, docNumero: string, periodo = APRENDIDO) =>
  ec.compra(X, c, { periodo, propuestaId: prop, docNumero }).then((x) => x.id);

// =================================================================================================
describe("recordarRegla simultaneos (CA-9, D-5)", () => {
  it("dos «Recordar» del mismo proveedor a la vez (versionBase null): una sola regla, un ReglaFila y un 'regla_cambiada'; 5 rondas", async () => {
    for (let ronda = 0; ronda < 5; ronda++) {
      const doc = docNuevo();
      const a = await compra(cx, propX, doc);
      const espera = barrera(2);
      const lanzar = (destino: Destino) =>
        comoX(async (tx) => {
          await espera();
          return recordar(tx, { clienteId: cx.id, compraIds: [a], destino, versionBase: null, usuarioId: ux });
        });
      const [r1, r2] = await Promise.all([lanzar("DNG"), lanzar("DG")]);
      const resultados = [r1, r2];
      expect(resultados.filter((r) => r === "regla_cambiada"), `ronda ${ronda}: ${JSON.stringify(resultados)}`).toHaveLength(1);
      const ganadora = resultados.find((r) => r !== "regla_cambiada") as ReglaFila;
      expect(ganadora.version).toBe(1);
      const filas = await admin.query(
        "select id, destino, version from regla_aprendida where cliente_id = $1 and doc_numero = $2 and eliminada_en is null",
        [cx.id, doc],
      );
      expect(filas.rows).toEqual([{ id: ganadora.id, destino: ganadora.destino, version: 1 }]);
      expect(
        (await admin.query("select count(*)::int as n from regla_confirmacion where regla_id = $1", [ganadora.id])).rows[0].n,
        "solo la que gano confirma",
      ).toBe(1);
    }
  });

  it("dos «Recordar» con la misma version vieja: gana uno (version + 1) y el otro recibe 'regla_cambiada'", async () => {
    const doc = docNuevo();
    const a = await compra(cx, propX, doc);
    const id = await ec.regla(X, cx, { docNumero: doc, destino: "DNG" });
    const espera = barrera(2);
    const lanzar = (destino: Destino) =>
      comoX(async (tx) => {
        await espera();
        return recordar(tx, { clienteId: cx.id, compraIds: [a], destino, versionBase: 1, usuarioId: ux });
      });
    const r = await Promise.all([lanzar("DG"), lanzar("DGNG")]);
    expect(r.filter((x) => x === "regla_cambiada")).toHaveLength(1);
    const fila = (await admin.query("select destino, version from regla_aprendida where id = $1", [id])).rows[0];
    expect(fila.version).toBe(2);
    expect((r.find((x) => x !== "regla_cambiada") as ReglaFila).destino).toBe(fila.destino);
  });

  it("recordar y editar a la vez con la misma version: una gana, la otra 'regla_cambiada'; nunca una excepcion de interbloqueo", async () => {
    const doc = docNuevo();
    const a = await compra(cx, propX, doc);
    const id = await ec.regla(X, cx, { docNumero: doc });
    const espera = barrera(2);
    const r = await Promise.all([
      comoX(async (tx) => {
        await espera();
        return recordar(tx, { clienteId: cx.id, compraIds: [a], destino: "DG", versionBase: 1, usuarioId: ux });
      }),
      comoX(async (tx) => {
        await espera();
        return editar(tx, { clienteId: cx.id, reglaId: id, versionBase: 1, destino: "DGNG", usuarioId: ux });
      }),
    ]);
    expect(r.filter((x) => x === "regla_cambiada")).toHaveLength(1);
    expect((await admin.query("select version from regla_aprendida where id = $1", [id])).rows[0].version).toBe(2);
  });
});

// =================================================================================================
describe("la regla cambia durante la descarga (CA-9, plan: Orden de bloqueo)", () => {
  /**
   * Una descarga del worker: lee las reglas vigentes (FOR SHARE), avisa, espera la puerta y crea 3 compras del proveedor aplicando el
   * destino que LEYO en su transaccion. Devuelve lo leido.
   */
  function descarga(
    c: ClientePrueba,
    prop: string,
    doc: string,
    pasos: { antes?: () => Promise<void>; tras?: () => Promise<void> } = {},
  ) {
    return worker.withTenant({ tenantId: X }, async (tx) => {
      if (pasos.antes) await pasos.antes();
      const vig = (await tx.query("select * from public.reglas_historial_vigentes($1, $2)", [c.id, DESCARGA])).rows;
      if (pasos.tras) await pasos.tras();
      for (let i = 0; i < 3; i++) {
        const id = await compraDelWorker(tx, c.id, prop, DESCARGA, { serie: "F88", numero: String(++consecutivo), docNumero: doc });
        const r = vig.find((v) => v.doc_numero === doc);
        if (r) await aplicar(tx, id, r.regla_id as string, consolidar(FACTURA_DG, r.destino as Destino));
      }
      return vig as { regla_id: string; doc_numero: string; destino: Destino; version: number }[];
    });
  }

  const destinosDe = async (c: ClientePrueba, doc: string) =>
    (
      await admin.query(
        `select v.accion, case when v.bi_dg > 0 then 'DG' when v.bi_dgng > 0 then 'DGNG' when v.bi_dng > 0 then 'DNG' end as destino
           from compra c join compra_version v on v.compra_id = c.id and v.n = c.version_vigente
          where c.cliente_id = $1 and c.doc_numero = $2 and c.serie = 'F88'`,
        [c.id, doc],
      )
    ).rows as { accion: string; destino: string }[];

  const VIAS = ["editar", "recordar", "eliminar"] as const;

  async function verificarRonda(
    ronda: number,
    via: (typeof VIAS)[number],
    c: ClientePrueba,
    doc: string,
    id: string,
    d: Promise<{ destino: Destino }[]>,
    escritura: Promise<unknown>,
  ) {
    const [vig, res] = await Promise.all([d, escritura]);
    expect(vig.map((v) => v.destino), `ronda ${ronda}: la descarga leyo la version previa`).toEqual(["DNG"]);
    const filas = await destinosDe(c, doc);
    expect(filas, `ronda ${ronda}`).toHaveLength(3);
    expect(new Set(filas.map((f) => f.destino)), `ronda ${ronda}: un solo destino`).toEqual(new Set(["DNG"]));
    expect(filas.every((f) => f.accion === "historial")).toBe(true);
    const regla = (await admin.query("select destino, version, eliminada_en from regla_aprendida where id = $1", [id])).rows[0];
    if (via === "eliminar") {
      expect(res).toBe("ok");
      expect(regla.eliminada_en).not.toBeNull();
    } else {
      expect((res as ReglaFila).version).toBe(2);
      expect(regla).toMatchObject({ destino: "DG", version: 2, eliminada_en: null });
    }
  }


  it("10 rondas (editar, recordar y eliminar sobre la regla): la escritura espera a la descarga, todas las filas quedan con el destino leido y no hay interbloqueos", async () => {
    for (let ronda = 0; ronda < 10; ronda++) {
      const via = VIAS[ronda % VIAS.length]!;
      const c = await ec.cliente(X);
      const prop = await ec.propuesta(X, c, { libro: "compras", periodo: DESCARGA, nuevas: 10 });
      const doc = docNuevo();
      const id = await ec.regla(X, c, { docNumero: doc, destino: "DNG" });
      const previa = via === "recordar" ? await compra(c, prop, doc) : null;
      let leido!: () => void;
      const yaLeyo = new Promise<void>((r) => (leido = r));
      let soltar!: () => void;
      const puerta = new Promise<void>((r) => (soltar = r));
      const d = descarga(c, prop, doc, {
        tras: async () => {
          leido();
          await puerta;
        },
      });
      try {
        await Promise.race([yaLeyo, d]); // si la descarga falla antes de leer, el error sale aqui
        const escritura = comoX<unknown>((tx) =>
          via === "editar"
            ? editar(tx, { clienteId: c.id, reglaId: id, versionBase: 1, destino: "DG", usuarioId: ux })
            : via === "recordar"
              ? recordar(tx, { clienteId: c.id, compraIds: [previa!], destino: "DG", versionBase: 1, usuarioId: ux })
              : eliminar(tx, { clienteId: c.id, reglaId: id, versionBase: 1, usuarioId: ux }),
        );
        escritura.catch(() => undefined); // si no esta implementada, el error se reporta abajo; no queda sin manejar
        expect(await conPlazo(escritura, 250), `ronda ${ronda} (${via}): debe esperar a la descarga`).toBe("pendiente");
        soltar();
        await verificarRonda(ronda, via, c, doc, id, d, escritura);
      } finally {
        soltar(); // pase lo que pase, la descarga suelta sus bloqueos (si no, la limpieza espera para siempre)
        await d.catch(() => undefined);
      }
    }
  });

  it("10 rondas sin puerta (sueltas, en paralelo): las filas de cada descarga comparten destino y ningun lado falla por interbloqueo (40P01)", async () => {
    for (let ronda = 0; ronda < 10; ronda++) {
      const c = await ec.cliente(X);
      const prop = await ec.propuesta(X, c, { libro: "compras", periodo: DESCARGA, nuevas: 10 });
      const doc = docNuevo();
      const id = await ec.regla(X, c, { docNumero: doc, destino: "DNG" });
      const espera = barrera(2);
      const resultados = await Promise.allSettled([
        descarga(c, prop, doc, { antes: espera }),
        comoX(async (tx) => {
          await espera();
          return editar(tx, { clienteId: c.id, reglaId: id, versionBase: 1, destino: "DG", usuarioId: ux });
        }),
      ]);
      for (const r of resultados) {
        if (r.status === "rejected") {
          expect((r.reason as { code?: string }).code, `ronda ${ronda}: ${String(r.reason)}`).not.toBe("40P01");
        }
      }
      expect(resultados.map((r) => r.status), `ronda ${ronda}: ambas terminan bien`).toEqual(["fulfilled", "fulfilled"]);
      const filas = await destinosDe(c, doc);
      expect(filas, `ronda ${ronda}`).toHaveLength(3);
      expect(new Set(filas.map((f) => f.destino)).size, `ronda ${ronda}: mismo destino`).toBe(1);
      expect((await admin.query("select destino, version from regla_aprendida where id = $1", [id])).rows[0]).toEqual({ destino: "DG", version: 2 });
    }
  });

  it("dos descargas a la vez, con la lectura de reglas abierta en ambas, no se bloquean entre si (FOR SHARE compartido)", async () => {
    const c1 = await ec.cliente(X);
    const c2 = await ec.cliente(X);
    const docUno = docNuevo();
    const docDos = docNuevo();
    const p1 = await ec.propuesta(X, c1, { libro: "compras", periodo: DESCARGA, nuevas: 10 });
    const p2 = await ec.propuesta(X, c2, { libro: "compras", periodo: DESCARGA, nuevas: 10 });
    await ec.regla(X, c1, { docNumero: docUno });
    await ec.regla(X, c2, { docNumero: docDos });
    const espera = barrera(2);
    const ambas = Promise.all([
      descarga(c1, p1, docUno, { tras: espera }),
      descarga(c2, p2, docDos, { tras: espera }),
    ]);
    expect(await conPlazo(ambas, 5000), "una espero a la otra: interbloqueo o bloqueo indebido").not.toBe("pendiente");
  });
});

// =================================================================================================
describe("interruptor del motor durante la descarga (plan: advisory `reglas_motor`)", () => {
  it("apagar R-HIS espera a la descarga en curso; esta aplica con el interruptor que leyo y la siguiente ya no aplica", async () => {
    const n = await ec.estudio();
    const u = await ec.usuarioDe(n.id);
    const c = await ec.cliente(n.id);
    const prop = await ec.propuesta(n.id, c, { libro: "compras", periodo: DESCARGA, nuevas: 10 });
    const doc = docNuevo();
    await ec.regla(n.id, c, { docNumero: doc, destino: "DNG" });
    let leido!: () => void;
    const yaLeyo = new Promise<void>((r) => (leido = r));
    let soltar!: () => void;
    const puerta = new Promise<void>((r) => (soltar = r));
    const d = worker.withTenant({ tenantId: n.id }, async (tx) => {
      const vig = (await tx.query("select * from public.reglas_historial_vigentes($1, $2)", [c.id, DESCARGA])).rows;
      leido();
      await puerta;
      const id = await compraDelWorker(tx, c.id, prop, DESCARGA, { serie: "F99", numero: "1", docNumero: doc });
      await aplicar(tx, id, vig[0].regla_id as string, consolidar(FACTURA_DG, vig[0].destino as Destino));
      return vig.length;
    });
    try {
      await Promise.race([yaLeyo, d]);
      const apagar = backend.withTenant({ tenantId: n.id, userId: u }, (tx) =>
        fijarMotor(tx, { codigo: "R-HIS", activa: false, usuarioId: u }),
      );
      apagar.catch(() => undefined);
      expect(await conPlazo(apagar, 250), "el PUT del interruptor espera a la descarga").toBe("pendiente");
      soltar();
      expect(await d).toBe(1);
      await apagar;
    } finally {
      soltar();
      await d.catch(() => undefined);
    }
    const aplicadas = (
      await admin.query("select count(*)::int as n from regla_aplicacion a join compra c on c.id = a.compra_id where c.cliente_id = $1", [c.id])
    ).rows[0].n;
    expect(aplicadas, "la descarga en curso aplico con el interruptor que leyo").toBe(1);
    const siguiente = await worker.withTenant({ tenantId: n.id }, async (tx) =>
      (await tx.query("select * from public.reglas_historial_vigentes($1, $2)", [c.id, DESCARGA])).rows,
    );
    expect(siguiente, "la siguiente descarga ya no ve reglas").toEqual([]);
  });
});
