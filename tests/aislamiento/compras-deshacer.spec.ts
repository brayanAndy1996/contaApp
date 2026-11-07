// Spec 014 (T6, rojo): deshacer y rehacer persistentes por usuario y periodo contra la BD real (CA-11, CA-18; D-14, DU-3, DU-14).
// `evaluar` y `transformar` son funciones de prueba (compras-soporte.ts); `packages/db` no importa el dominio.
//
// FIRMAS que fija (T12):
//   deshacer(tx, { clienteId, periodo, usuarioId }, { evaluar }): Promise<{ operacionId: string; filas: number }>
//   rehacer (tx, { clienteId, periodo, usuarioId }, { evaluar }): Promise<{ operacionId: string; filas: number }>
//       deshacer toma la ULTIMA operacion `vigente` de la pila del propio usuario en ese cliente y periodo (solo las de clasificar,
//       editar, aceptar/sugerencia, excluir y restaurar; las de tipo deshacer y rehacer no entran, y agregar/descartar no crean
//       operacion). Si todas sus filas siguen en la version que ella creo, escribe por cada fila UNA version nueva con
//       accion = 'deshacer' que COPIA los valores de la version anterior a la de la operacion (nada se borra ni se actualiza), la
//       evalua (hallazgos con version_n nueva) y marca la operacion `deshecha` con deshecha_en. Todas las versiones nuevas llevan el
//       operacion_id de una compra_operacion nueva (tipo 'deshacer', referencia_id = la operacion deshecha) que es la que
//       devuelve `operacionId`; `filas` = cuantas filas restauro. Una masiva es un paso.
//       rehacer toma la ultima operacion `deshecha` del usuario (hasta su siguiente accion nueva, que las pasa a `caducada`) y
//       repone los valores que tenia con versiones nuevas accion = 'rehacer' (nueva operacion tipo 'rehacer', referencia_id = la
//       repuesta); despues se puede volver a deshacer.
//       Errores (ComprasReglaError): 'nada_que_deshacer' | 'nada_que_rehacer'; 'fila_cambiada' con `ids` = las filas cuya version
//       vigente ya no es la que dejo la operacion (otra persona, o el mismo usuario desde otra pestana): no se escribe nada y la
//       operacion queda como estaba.
//   La pila vive en la BD: sobrevive a recargar la sesion (otra conexion u otra instancia de createDb la ve).
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auth-soporte";
import type { ContappDb, Tx } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import {
  barrera,
  codigoDe,
  contarFilas,
  EscenarioCompras,
  errorDe,
  evaluadorFalso,
  MONTOS_DG,
  PERIODO,
  sinHallazgos,
  transformarFalso,
  type Evaluar,
  type ParametrosFalsos,
} from "./compras-soporte";

type Pila = { clienteId: string; periodo: string; usuarioId: string };
type Hecho = { operacionId: string; filas: number };
const deshacer = (tx: Tx, e: Pila, f: { evaluar: Evaluar }) =>
  exportado<(tx: Tx, e: Pila, f: unknown) => Promise<Hecho>>("deshacer")(
    tx,
    e,
    f,
  );
const rehacer = (tx: Tx, e: Pila, f: { evaluar: Evaluar }) =>
  exportado<(tx: Tx, e: Pila, f: unknown) => Promise<Hecho>>("rehacer")(
    tx,
    e,
    f,
  );
const aplicarAccion = (tx: Tx, e: unknown, f: unknown) =>
  exportado<
    (tx: Tx, e: unknown, f: unknown) => Promise<{ operacionId: string }>
  >("aplicarAccion")(tx, e, f);
const aplicarMasiva = (tx: Tx, e: unknown, f: unknown) =>
  exportado<
    (
      tx: Tx,
      e: unknown,
      f: unknown,
    ) => Promise<{ operacionId: string | null; aplicadas: number }>
  >("aplicarMasiva")(tx, e, f);

let admin: Pool;
let ec: EscenarioCompras;
let backend: ContappDb;
let X: string;
let cx: ClientePrueba;
let ux: string;
let ux2: string;
let propX: string;

beforeAll(async () => {
  admin = abrirAdmin(8);
  ec = new EscenarioCompras(admin);
  X = (await ec.estudio()).id;
  cx = await ec.cliente(X);
  ux = await ec.usuarioDe(X);
  ux2 = (await ec.miembro(X, "contador")).id;
  backend = crearDb("contapp_backend", 10);
  propX = await ec.propuesta(X, cx, { libro: "compras", nuevas: 1 });
});
afterAll(async () => {
  await ec?.limpiar();
  await backend?.close().catch(() => undefined);
  await admin?.end();
});

const comoBackend = <T>(fn: (tx: Tx) => Promise<T>, db: ContappDb = backend) =>
  db.withTenant({ tenantId: X }, fn);
const F = { transformar: transformarFalso };
const versionesDe = async (id: string) =>
  (
    await admin.query(
      "select * from compra_version where compra_id = $1 order by n",
      [id],
    )
  ).rows;
const estadoOp = async (id: string) =>
  (
    await admin.query(
      "select estado, deshecha_en from compra_operacion where id = $1",
      [id],
    )
  ).rows[0];
const pila = (
  c: ClientePrueba,
  usuarioId: string,
  periodo = PERIODO,
): Pila => ({ clienteId: c.id, periodo, usuarioId });

const accion = (
  compraId: string,
  base: number,
  p: ParametrosFalsos,
  usuarioId = ux,
  nombre?: string,
) =>
  comoBackend((tx) =>
    aplicarAccion(
      tx,
      {
        compraId,
        versionBase: base,
        accion: nombre ?? (p.tipo === "dng" ? "clasificar" : p.tipo),
        parametros: p,
        usuarioId,
      },
      { ...F, evaluar: sinHallazgos().evaluar },
    ),
  );
const masiva = (
  c: ClientePrueba,
  ids: string[],
  p: ParametrosFalsos,
  usuarioId = ux,
  base = 1,
) =>
  comoBackend((tx) =>
    aplicarMasiva(
      tx,
      {
        clienteId: c.id,
        periodo: PERIODO,
        usuarioId,
        accion: "clasificar",
        parametros: p,
        items: ids.map((compraId) => ({ compraId, versionBase: base })),
      },
      { ...F, evaluar: sinHallazgos().evaluar },
    ),
  );
const deshacerComo = (
  c: ClientePrueba,
  u = ux,
  e = sinHallazgos(),
  periodo = PERIODO,
) =>
  comoBackend((tx) =>
    deshacer(tx, pila(c, u, periodo), { evaluar: e.evaluar }),
  );
const rehacerComo = (
  c: ClientePrueba,
  u = ux,
  e = sinHallazgos(),
  periodo = PERIODO,
) =>
  comoBackend((tx) => rehacer(tx, pila(c, u, periodo), { evaluar: e.evaluar }));
async function sembrar(c: ClientePrueba, n: number, prefijo: string) {
  const r = [];
  for (let i = 1; i <= n; i++)
    r.push(
      await ec.compra(X, c, {
        serie: prefijo,
        numero: String(i),
        propuestaId: propX,
        montos: MONTOS_DG,
      }),
    );
  return r;
}

// =================================================================================================
describe("deshacer · revierte la ultima operacion propia sin borrar nada (D-14, CA-11)", () => {
  it("restaura los valores anteriores en una version nueva accion = deshacer; la historia queda intacta y la operacion pasa a deshecha", async () => {
    const c = await ec.cliente(X);
    const [f] = await sembrar(c, 1, "FD01");
    const op = await accion(f.id, 1, { tipo: "dng" });
    const antes = await versionesDe(f.id);
    const e = evaluadorFalso();
    const r = await deshacerComo(c, ux, e);
    expect(r).toEqual({ operacionId: expect.any(String), filas: 1 });
    const v = await versionesDe(f.id);
    expect(v.map((x) => x.n)).toEqual([1, 2, 3]);
    expect(v.slice(0, 2), "las versiones 1 y 2 no cambian").toEqual(antes);
    expect(v[2]).toMatchObject({
      accion: "deshacer",
      operacion_id: r.operacionId,
      usuario_id: ux,
      bi_dg: "1000.00",
      igv_dg: "180.00",
      bi_dng: "0.00",
      igv_dng: "0.00",
      total: "1180.00",
      clasificada: false,
      excluida: false,
    });
    expect(
      (
        await admin.query("select version_vigente from compra where id = $1", [
          f.id,
        ])
      ).rows[0].version_vigente,
    ).toBe(3);
    expect(await estadoOp(op.operacionId)).toMatchObject({
      estado: "deshecha",
      deshecha_en: expect.any(Date),
    });
    const nueva = (
      await admin.query(
        "select tipo, referencia_id, usuario_id from compra_operacion where id = $1",
        [r.operacionId],
      )
    ).rows[0];
    expect(nueva).toEqual({
      tipo: "deshacer",
      referencia_id: op.operacionId,
      usuario_id: ux,
    });
    expect(e.llamadas).toHaveLength(1);
    expect(e.llamadas[0].version).toBe(3);
    expect(
      (
        await admin.query(
          "select version_n from compra_hallazgo where compra_id = $1",
          [f.id],
        )
      ).rows,
    ).toEqual([{ version_n: 3 }]);
  });

  it("una masiva es un paso: deshacer revierte las 8 filas de una vez (CA-18)", async () => {
    const c = await ec.cliente(X);
    const filas = await sembrar(c, 8, "FD02");
    const m = await masiva(
      c,
      filas.map((x) => x.id),
      { tipo: "dng" },
    );
    expect(m.aplicadas).toBe(8);
    const r = await deshacerComo(c);
    expect(r.filas).toBe(8);
    for (const f of filas) {
      const v = await versionesDe(f.id);
      expect(v.map((x) => x.n)).toEqual([1, 2, 3]);
      expect(v[2]).toMatchObject({
        accion: "deshacer",
        operacion_id: r.operacionId,
        bi_dg: "1000.00",
        bi_dng: "0.00",
      });
    }
    expect(
      await contarFilas(admin, "compra_version", "operacion_id = $1", [
        r.operacionId,
      ]),
    ).toBe(8);
  });

  it("la pila es una pila: deshace la ultima, luego la anterior, y despues no hay nada que deshacer (las operaciones deshacer no entran)", async () => {
    const c = await ec.cliente(X);
    const [a, b] = await sembrar(c, 2, "FD03");
    const opA = await accion(a.id, 1, { tipo: "dng" });
    const opB = await accion(
      b.id,
      1,
      { tipo: "bi", valor: "500.00" },
      ux,
      "editar",
    );
    await deshacerComo(c);
    expect((await versionesDe(b.id)).at(-1)).toMatchObject({
      accion: "deshacer",
      bi_dg: "1000.00",
    });
    expect((await versionesDe(a.id)).length, "A todavia no se toco").toBe(2);
    expect((await estadoOp(opB.operacionId)).estado).toBe("deshecha");
    expect((await estadoOp(opA.operacionId)).estado).toBe("vigente");
    await deshacerComo(c);
    expect((await versionesDe(a.id)).at(-1)).toMatchObject({
      accion: "deshacer",
      bi_dng: "0.00",
    });
    expect(await codigoDe(deshacerComo(c))).toBe("nada_que_deshacer");
  });

  it("deshacer una exclusion devuelve la fila a las listas (restaura excluida = false y sin motivo)", async () => {
    const c = await ec.cliente(X);
    const [f] = await sembrar(c, 1, "FD04");
    await accion(f.id, 1, { tipo: "excluir", motivo: "zapatillas" });
    await deshacerComo(c);
    expect((await versionesDe(f.id)).at(-1)).toMatchObject({
      excluida: false,
      motivo: null,
      accion: "deshacer",
    });
  });

  it("sin operaciones propias: nada_que_deshacer, y no se escribe nada", async () => {
    const c = await ec.cliente(X);
    const [f] = await sembrar(c, 1, "FD05");
    expect(await codigoDe(deshacerComo(c))).toBe("nada_que_deshacer");
    expect(await versionesDe(f.id)).toHaveLength(1);
  });

  it("la pila de un usuario no toca la de otro (CA-11)", async () => {
    const c = await ec.cliente(X);
    const [a, b] = await sembrar(c, 2, "FD06");
    const opA = await accion(a.id, 1, { tipo: "dng" }, ux);
    const opB = await accion(b.id, 1, { tipo: "dng" }, ux2);
    expect(
      await codigoDe(deshacerComo(c, (await ec.miembro(X, "contador")).id)),
    ).toBe("nada_que_deshacer");
    await deshacerComo(c, ux2);
    expect((await estadoOp(opB.operacionId)).estado).toBe("deshecha");
    expect(
      (await estadoOp(opA.operacionId)).estado,
      "la de ux sigue vigente",
    ).toBe("vigente");
    expect(await versionesDe(a.id)).toHaveLength(2);
  });

  it("solo ve su cliente y su periodo: las operaciones de otro periodo u otro cliente no se deshacen", async () => {
    const c = await ec.cliente(X);
    const otro = await ec.cliente(X);
    const f = await ec.compra(X, c, { periodo: "202609", propuestaId: propX });
    const g = await ec.compra(X, otro, { propuestaId: propX });
    const o1 = await comoBackend((tx) =>
      aplicarAccion(
        tx,
        {
          compraId: f.id,
          versionBase: 1,
          accion: "clasificar",
          parametros: { tipo: "dng" },
          usuarioId: ux,
        },
        { ...F, evaluar: sinHallazgos().evaluar },
      ),
    );
    await accion(g.id, 1, { tipo: "dng" });
    expect(await codigoDe(deshacerComo(c, ux, sinHallazgos(), PERIODO))).toBe(
      "nada_que_deshacer",
    );
    expect((await estadoOp(o1.operacionId)).estado).toBe("vigente");
    expect((await deshacerComo(c, ux, sinHallazgos(), "202609")).filas).toBe(1);
  });

  it("la pila sobrevive a recargar la sesion: otra instancia de createDb (otra conexion) la ve", async () => {
    const c = await ec.cliente(X);
    const [f] = await sembrar(c, 1, "FD07");
    await accion(f.id, 1, { tipo: "dng" });
    const otraSesion = crearDb("contapp_backend", 2);
    try {
      const r = await comoBackend(
        (tx) => deshacer(tx, pila(c, ux), { evaluar: sinHallazgos().evaluar }),
        otraSesion,
      );
      expect(r.filas).toBe(1);
    } finally {
      await otraSesion.close();
    }
  });

  it("no hay escritura parcial: si evaluar lanza en la segunda fila, ninguna fila cambia y la operacion sigue vigente", async () => {
    const c = await ec.cliente(X);
    const filas = await sembrar(c, 4, "FD08");
    const m = await masiva(
      c,
      filas.map((x) => x.id),
      { tipo: "dng" },
    );
    let n = 0;
    const mala: Evaluar = () => {
      if (++n === 2) throw new Error("la regla fallo");
      return [];
    };
    expect(
      await codigoDe(
        comoBackend((tx) => deshacer(tx, pila(c, ux), { evaluar: mala })),
      ),
    ).not.toBe("ok");
    for (const f of filas)
      expect(await versionesDe(f.id), f.clave).toHaveLength(2);
    expect((await estadoOp(m.operacionId!)).estado).toBe("vigente");
    expect(
      await contarFilas(
        admin,
        "compra_operacion",
        "tipo = 'deshacer' and cliente_id = $1",
        [c.id],
      ),
    ).toBe(0);
  });

  it("dos deshacer simultaneos con una sola operacion: uno gana y el otro recibe nada_que_deshacer; una sola version nueva", async () => {
    for (let ronda = 0; ronda < 10; ronda++) {
      const c = await ec.cliente(X);
      const [f] = await sembrar(c, 1, "FD09");
      await accion(f.id, 1, { tipo: "dng" });
      const llegar = barrera(2);
      const una = () =>
        comoBackend(async (tx) => {
          await llegar();
          return deshacer(tx, pila(c, ux), { evaluar: sinHallazgos().evaluar });
        });
      const r = await Promise.allSettled([una(), una()]);
      expect(
        r.filter((x) => x.status === "fulfilled"),
        `ronda ${ronda}`,
      ).toHaveLength(1);
      const mal = r.find(
        (x): x is PromiseRejectedResult => x.status === "rejected",
      )!;
      expect((mal.reason as { codigo?: string }).codigo, `ronda ${ronda}`).toBe(
        "nada_que_deshacer",
      );
      expect(
        (await versionesDe(f.id)).map((x) => x.n),
        `ronda ${ronda}`,
      ).toEqual([1, 2, 3]);
    }
  }, 60_000);
});

// =================================================================================================
describe("deshacer · 409 fila_cambiada (D-14, CA-11)", () => {
  it("si otra persona cambio una de las filas, fila_cambiada con sus ids y no se escribe nada (ni en las demas)", async () => {
    const c = await ec.cliente(X);
    const filas = await sembrar(c, 3, "FD10");
    const m = await masiva(
      c,
      filas.map((x) => x.id),
      { tipo: "dng" },
      ux,
    );
    await accion(filas[1].id, 2, { tipo: "bi", valor: "77.00" }, ux2, "editar");
    const err = await errorDe(deshacerComo(c, ux));
    expect(err).toMatchObject({ codigo: "fila_cambiada", ids: [filas[1].id] });
    for (const f of filas)
      expect((await versionesDe(f.id)).length, f.clave).toBe(
        f.id === filas[1].id ? 3 : 2,
      );
    expect(
      (await estadoOp(m.operacionId!)).estado,
      "la operacion queda vigente",
    ).toBe("vigente");
  });

  // El cambio de filas[0] lo hace otro usuario (ux2): una edicion del propio ux seria su operacion MAS RECIENTE y deshacer
  // revertiria esa edicion (la pila es una pila), no la masiva. Asi la masiva sigue siendo la ultima de ux.
  it("lista todas las filas cambiadas por otras personas despues de la masiva (fila_cambiada con ids)", async () => {
    const c = await ec.cliente(X);
    const filas = await sembrar(c, 4, "FD11");
    await masiva(
      c,
      filas.map((x) => x.id),
      { tipo: "dng" },
      ux,
    );
    await accion(filas[0].id, 2, { tipo: "bi", valor: "10.00" }, ux2, "editar");
    await accion(filas[3].id, 2, { tipo: "bi", valor: "11.00" }, ux2, "editar");
    const err = await errorDe(deshacerComo(c, ux));
    expect(err?.codigo).toBe("fila_cambiada");
    expect([...(err?.ids ?? [])].sort()).toEqual(
      [filas[0].id, filas[3].id].sort(),
    );
  });

  // AMBIGUEDAD (informada en T6): D-14 dice «si todas sus filas siguen en la version que esa operacion creo». Tras deshacer la
  // operacion 2 la fila queda en la version 4 (la escribio `deshacer`, no la operacion 1). Leido al pie de la letra, deshacer la
  // operacion 1 daria fila_cambiada y una pila de dos niveles sobre la misma fila no serviria. Esta prueba fija la lectura util:
  // las versiones que escribe deshacer/rehacer sobre una fila no cuentan como un cambio ajeno.
  it("dos deshacer seguidos sobre la misma fila recorren la pila (el segundo no es fila_cambiada)", async () => {
    const c = await ec.cliente(X);
    const [a] = await sembrar(c, 1, "FD12");
    const op1 = await accion(a.id, 1, { tipo: "dng" });
    const op2 = await accion(
      a.id,
      2,
      { tipo: "bi", valor: "500.00" },
      ux,
      "editar",
    );
    await deshacerComo(c);
    expect((await estadoOp(op2.operacionId)).estado).toBe("deshecha");
    await deshacerComo(c);
    expect((await estadoOp(op1.operacionId)).estado).toBe("deshecha");
    const v = await versionesDe(a.id);
    expect(v.at(-1)).toMatchObject({
      accion: "deshacer",
      bi_dg: "1000.00",
      bi_dng: "0.00",
    });
    expect(v.map((x) => x.n)).toEqual([1, 2, 3, 4, 5]);
  });
});

// =================================================================================================
describe("rehacer · repone la ultima operacion deshecha hasta la siguiente accion (D-14, CA-11)", () => {
  it("rehacer repone los valores que tenia la operacion (version accion = rehacer) y se puede volver a deshacer", async () => {
    const c = await ec.cliente(X);
    const [f] = await sembrar(c, 1, "FR01");
    await accion(f.id, 1, { tipo: "dng" });
    await deshacerComo(c);
    const e = evaluadorFalso();
    const r = await rehacerComo(c, ux, e);
    expect(r).toEqual({ operacionId: expect.any(String), filas: 1 });
    const v = await versionesDe(f.id);
    expect(v.map((x) => x.n)).toEqual([1, 2, 3, 4]);
    expect(v[3]).toMatchObject({
      accion: "rehacer",
      operacion_id: r.operacionId,
      bi_dg: "0.00",
      bi_dng: "1000.00",
      igv_dng: "180.00",
      clasificada: true,
    });
    expect(e.llamadas).toHaveLength(1);
    expect(await codigoDe(rehacerComo(c)), "ya no queda nada deshecho").toBe(
      "nada_que_rehacer",
    );
    await deshacerComo(c);
    expect((await versionesDe(f.id)).at(-1)).toMatchObject({
      accion: "deshacer",
      bi_dg: "1000.00",
      bi_dng: "0.00",
    });
  });

  it("rehacer una masiva repone las 8 filas de una vez", async () => {
    const c = await ec.cliente(X);
    const filas = await sembrar(c, 8, "FR02");
    await masiva(
      c,
      filas.map((x) => x.id),
      { tipo: "dng" },
    );
    await deshacerComo(c);
    expect((await rehacerComo(c)).filas).toBe(8);
    for (const f of filas)
      expect((await versionesDe(f.id)).at(-1)).toMatchObject({
        accion: "rehacer",
        bi_dng: "1000.00",
      });
  });

  it("sin nada deshecho: nada_que_rehacer", async () => {
    const c = await ec.cliente(X);
    const [f] = await sembrar(c, 1, "FR03");
    await accion(f.id, 1, { tipo: "dng" });
    expect(await codigoDe(rehacerComo(c))).toBe("nada_que_rehacer");
    expect(await versionesDe(f.id)).toHaveLength(2);
  });

  it("una accion nueva del usuario caduca lo deshecho: despues ya no se puede rehacer", async () => {
    const c = await ec.cliente(X);
    const [a, b] = await sembrar(c, 2, "FR04");
    const op = await accion(a.id, 1, { tipo: "dng" });
    await deshacerComo(c);
    expect((await estadoOp(op.operacionId)).estado).toBe("deshecha");
    await accion(b.id, 1, { tipo: "dng" });
    expect((await estadoOp(op.operacionId)).estado).toBe("caducada");
    expect(await codigoDe(rehacerComo(c))).toBe("nada_que_rehacer");
  });

  it("la accion nueva de OTRO usuario no caduca lo que yo deshice", async () => {
    const c = await ec.cliente(X);
    const [a, b] = await sembrar(c, 2, "FR05");
    await accion(a.id, 1, { tipo: "dng" }, ux);
    await deshacerComo(c, ux);
    await accion(b.id, 1, { tipo: "dng" }, ux2);
    expect((await rehacerComo(c, ux)).filas).toBe(1);
  });

  it("si otra persona cambio la fila despues de deshacer, rehacer da fila_cambiada y no escribe", async () => {
    const c = await ec.cliente(X);
    const [f] = await sembrar(c, 1, "FR06");
    await accion(f.id, 1, { tipo: "dng" });
    await deshacerComo(c);
    await accion(f.id, 3, { tipo: "bi", valor: "42.00" }, ux2, "editar");
    const err = await errorDe(rehacerComo(c));
    expect(err).toMatchObject({ codigo: "fila_cambiada", ids: [f.id] });
    expect(await versionesDe(f.id)).toHaveLength(4);
  });

  it("rehacer cumple lo mismo que deshacer con la pila por usuario: ux2 no rehace lo que deshizo ux", async () => {
    const c = await ec.cliente(X);
    const [f] = await sembrar(c, 1, "FR07");
    await accion(f.id, 1, { tipo: "dng" }, ux);
    await deshacerComo(c, ux);
    expect(await codigoDe(rehacerComo(c, ux2))).toBe("nada_que_rehacer");
    expect((await rehacerComo(c, ux)).filas).toBe(1);
  });
});
