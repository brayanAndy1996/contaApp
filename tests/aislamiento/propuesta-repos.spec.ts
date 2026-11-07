// Spec 013 (T2, rojo): repositorios comunes de `packages/db/src/propuestas/**` contra la BD real (D1, D3, D16, CA-3, CA-11).
// Se importan de `@contapp/db` por nombre (si faltan, la prueba dice cual).
//
// FIRMAS que fija (T8). Todas reciben la `tx` de withTenant como primer argumento y leen o escriben dentro del estudio del
// contexto. Las filas salen en camelCase, con Date para las marcas de tiempo y numeros JS para los contadores:
//   type NuevaPropuesta = { clienteId, periodo: 'AAAAMM', libro: 'compras'|'ventas', fuente: 'api'|'importacion',
//     hash: string (64), filasRecibidas, filasNuevas, filasIguales, filasDistintas, usuarioId, trabajoId: string | null }
//   type PropuestaFila = NuevaPropuesta & { id: string, creadaEn: Date }
//   type NuevaDiferencia = { clave, tipo, serie, numero, origenExistente: 'sire'|'manual', campos: string[],
//     valoresSire: Record<string, string> }
//   type DiferenciaFila = NuevaDiferencia & { id: string }
//   bloquearPeriodoLibro(tx, clienteId, periodo, libro): Promise<void>
//       pg_advisory_xact_lock sobre la clave (cliente, periodo, libro); dura hasta el commit o rollback. Clientes, periodos
//       o libros distintos NO se bloquean entre si. (Orden: advisory del periodo -> cliente -> filas; 013 plan, Decisiones.)
//   crearPropuesta(tx, nueva: NuevaPropuesta): Promise<PropuestaFila>         (rol worker o backend; inmutable despues)
//   insertarDiferencias(tx, propuestaId, diferencias: NuevaDiferencia[]): Promise<void>   (lista vacia = no hace nada)
//   listarPropuestas(tx, clienteId, periodo, libro): Promise<PropuestaFila[]>  (mas reciente primero: creadaEn DESC, id DESC)
//   listarDiferencias(tx, propuestaId): Promise<DiferenciaFila[]>               (por clave; propuesta ajena o inexistente = [])
// Los errores de pg se reducen a un error con `codigo` = SQLSTATE y nada mas (como TrabajosRepoError).
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auth-soporte";
import type { ContappDb, Tx } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import { EscenarioVentas, HASH, PERIODO } from "./ventas-soporte";

type Libro = "compras" | "ventas";
interface NuevaPropuesta {
  clienteId: string;
  periodo: string;
  libro: Libro;
  fuente: "api" | "importacion";
  hash: string;
  filasRecibidas: number;
  filasNuevas: number;
  filasIguales: number;
  filasDistintas: number;
  usuarioId: string;
  trabajoId: string | null;
}
type PropuestaFila = NuevaPropuesta & { id: string; creadaEn: Date };
interface NuevaDiferencia {
  clave: string;
  tipo: string;
  serie: string;
  numero: string;
  origenExistente: "sire" | "manual";
  campos: string[];
  valoresSire: Record<string, string>;
}
type DiferenciaFila = NuevaDiferencia & { id: string };

const bloquearPeriodoLibro = (tx: Tx, c: string, p: string, l: Libro) =>
  exportado<(tx: Tx, c: string, p: string, l: Libro) => Promise<void>>("bloquearPeriodoLibro")(tx, c, p, l);
const crearPropuesta = (tx: Tx, n: NuevaPropuesta) =>
  exportado<(tx: Tx, n: NuevaPropuesta) => Promise<PropuestaFila>>("crearPropuesta")(tx, n);
const insertarDiferencias = (tx: Tx, id: string, d: NuevaDiferencia[]) =>
  exportado<(tx: Tx, id: string, d: NuevaDiferencia[]) => Promise<void>>("insertarDiferencias")(tx, id, d);
const listarPropuestas = (tx: Tx, c: string, p: string, l: Libro) =>
  exportado<(tx: Tx, c: string, p: string, l: Libro) => Promise<PropuestaFila[]>>("listarPropuestas")(tx, c, p, l);
const listarDiferencias = (tx: Tx, id: string) =>
  exportado<(tx: Tx, id: string) => Promise<DiferenciaFila[]>>("listarDiferencias")(tx, id);

let admin: Pool;
let ev: EscenarioVentas;
const dbs: ContappDb[] = [];
let X: string;
let Y: string;
let cx: ClientePrueba;
let cx2: ClientePrueba;
let cy: ClientePrueba;
let ux: string;
let uy: string;

const nueva = (c: ClientePrueba | string, usuarioId: string, o: Partial<NuevaPropuesta> = {}): NuevaPropuesta => ({
  clienteId: typeof c === "string" ? c : c.id,
  periodo: PERIODO,
  libro: "ventas",
  fuente: "api",
  hash: HASH,
  filasRecibidas: 3,
  filasNuevas: 1,
  filasIguales: 1,
  filasDistintas: 1,
  usuarioId,
  trabajoId: null,
  ...o,
});
const dif = (numero: string, o: Partial<NuevaDiferencia> = {}): NuevaDiferencia => ({
  clave: `03|B001|${numero}`,
  tipo: "03",
  serie: "B001",
  numero,
  origenExistente: "sire",
  campos: ["total"],
  valoresSire: { total: "120.00" },
  ...o,
});

const db = (rol: "contapp_backend" | "contapp_worker", max = 4): ContappDb => {
  const d = crearDb(rol, max);
  dbs.push(d);
  return d;
};
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  admin = abrirAdmin(6);
  ev = new EscenarioVentas(admin);
  X = (await ev.estudio()).id;
  Y = (await ev.estudio()).id;
  cx = await ev.cliente(X);
  cx2 = await ev.cliente(X);
  cy = await ev.cliente(Y);
  ux = await ev.usuarioDe(X);
  uy = await ev.usuarioDe(Y);
});
afterAll(async () => {
  await ev?.limpiar();
  await Promise.all(dbs.map((d) => d.close().catch(() => undefined)));
  await admin?.end();
});

// =================================================================================================
describe("crearPropuesta y listarPropuestas (D1, D16)", () => {
  it("el worker crea el encabezado: devuelve id, creadaEn y los contadores tal cual; queda en la tabla del estudio", async () => {
    const w = db("contapp_worker");
    const fila = await w.withTenant({ tenantId: X }, (tx) =>
      crearPropuesta(tx, nueva(cx, ux, { filasRecibidas: 5, filasNuevas: 2, filasIguales: 2, filasDistintas: 1 })),
    );
    expect(fila.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(fila.creadaEn).toBeInstanceOf(Date);
    expect(fila).toMatchObject({
      clienteId: cx.id,
      periodo: PERIODO,
      libro: "ventas",
      fuente: "api",
      hash: HASH,
      filasRecibidas: 5,
      filasNuevas: 2,
      filasIguales: 2,
      filasDistintas: 1,
      usuarioId: ux,
      trabajoId: null,
    });
    const enBd = (await admin.query("select tenant_id, filas_recibidas from propuesta where id = $1", [fila.id])).rows[0];
    expect(enBd).toEqual({ tenant_id: X, filas_recibidas: 5 });
  });

  it("el backend crea la de una importacion (fuente importacion, sin trabajo)", async () => {
    const b = db("contapp_backend");
    const fila = await b.withTenant({ tenantId: X }, (tx) =>
      crearPropuesta(tx, nueva(cx, ux, { fuente: "importacion", libro: "ventas", periodo: "202609" })),
    );
    expect(fila).toMatchObject({ fuente: "importacion", trabajoId: null, periodo: "202609" });
  });

  it("acepta el id de un trabajo real del estudio como trabajoId", async () => {
    const w = db("contapp_worker");
    const jobId = await ev.job(X, cx, { tipo: "sire.propuesta.descargar", estado: "ejecutando" });
    const fila = await w.withTenant({ tenantId: X }, (tx) => crearPropuesta(tx, nueva(cx, ux, { trabajoId: jobId })));
    expect(fila.trabajoId).toBe(jobId);
  });

  it("contadores que no cuadran, mas de 20.000 filas o un cliente ajeno fallan con un error de SQLSTATE (23514 / 23503)", async () => {
    const w = db("contapp_worker");
    await expect(
      w.withTenant({ tenantId: X }, (tx) => crearPropuesta(tx, nueva(cx, ux, { filasRecibidas: 9 }))),
    ).rejects.toMatchObject({ codigo: "23514" });
    await expect(
      w.withTenant({ tenantId: X }, (tx) =>
        crearPropuesta(tx, nueva(cx, ux, { filasRecibidas: 20001, filasNuevas: 20001, filasIguales: 0, filasDistintas: 0 })),
      ),
    ).rejects.toMatchObject({ codigo: "23514" });
    await expect(
      w.withTenant({ tenantId: X }, (tx) => crearPropuesta(tx, nueva(cy, ux))),
    ).rejects.toMatchObject({ codigo: "23503" });
  });

  it("el error de pg se reduce al SQLSTATE: sin detail, constraint, table ni valores en el mensaje", async () => {
    const w = db("contapp_worker");
    const e = await w
      .withTenant({ tenantId: X }, (tx) => crearPropuesta(tx, nueva(cx, ux, { filasRecibidas: 9 })))
      .then(
        () => null,
        (x: Record<string, unknown>) => x,
      );
    expect(e).not.toBeNull();
    expect(e!.codigo, "el error del repo lleva el SQLSTATE en `codigo`").toBe("23514");
    for (const k of ["detail", "where", "constraint", "table", "column", "schema", "cause"]) {
      expect(e as object, `el error no debe exponer ${k}`).not.toHaveProperty(k);
    }
    expect(String(e!.message)).not.toContain(cx.id);
  });

  it("listarPropuestas: solo las del cliente, periodo y libro pedidos, la mas reciente primero", async () => {
    const e = await (async () => {
      const t = (await ev.estudio()).id;
      return { t, c: await ev.cliente(t), c2: await ev.cliente(t), u: await ev.usuarioDe(t) };
    })();
    const w = db("contapp_worker");
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const f = await w.withTenant({ tenantId: e.t }, (tx) =>
        crearPropuesta(tx, nueva(e.c, e.u, { filasRecibidas: n, filasNuevas: n, filasIguales: 0, filasDistintas: 0 })),
      );
      ids.push(f.id);
      await dormir(15);
    }
    await w.withTenant({ tenantId: e.t }, async (tx) => {
      await crearPropuesta(tx, nueva(e.c, e.u, { libro: "compras" }));
      await crearPropuesta(tx, nueva(e.c, e.u, { periodo: "202609" }));
      await crearPropuesta(tx, nueva(e.c2, e.u));
    });
    const lista = await w.withTenant({ tenantId: e.t }, (tx) => listarPropuestas(tx, e.c.id, PERIODO, "ventas"));
    expect(lista.map((p) => p.id)).toEqual([...ids].reverse());
    expect(lista.map((p) => p.filasRecibidas)).toEqual([3, 2, 1]);
    const compras = await w.withTenant({ tenantId: e.t }, (tx) => listarPropuestas(tx, e.c.id, PERIODO, "compras"));
    expect(compras).toHaveLength(1);
  });

  it("aislamiento: el estudio Y no ve las propuestas de X aunque pida el cliente de X", async () => {
    const b = db("contapp_backend");
    const antes = await b.withTenant({ tenantId: X }, (tx) => listarPropuestas(tx, cx.id, PERIODO, "ventas"));
    expect(antes.length).toBeGreaterThan(0);
    const ajena = await b.withTenant({ tenantId: Y }, (tx) => listarPropuestas(tx, cx.id, PERIODO, "ventas"));
    expect(ajena).toEqual([]);
  });
});

// =================================================================================================
describe("insertarDiferencias y listarDiferencias (D16)", () => {
  it("guarda campos y valores del SIRE como cadenas y los devuelve por clave", async () => {
    const w = db("contapp_worker");
    const lista = await w.withTenant({ tenantId: X }, async (tx) => {
      const p = await crearPropuesta(tx, nueva(cx, ux));
      await insertarDiferencias(tx, p.id, [
        dif("292", { campos: ["total", "igv"], valoresSire: { total: "236.00", igv: "36.00" } }),
        dif("290"),
        dif("291", { origenExistente: "manual", campos: ["fecha"], valoresSire: { fecha: "2026-10-06" } }),
      ]);
      return listarDiferencias(tx, p.id);
    });
    expect(lista.map((d) => d.clave)).toEqual(["03|B001|290", "03|B001|291", "03|B001|292"]);
    expect(lista[0]).toMatchObject({ tipo: "03", serie: "B001", numero: "290", origenExistente: "sire", campos: ["total"], valoresSire: { total: "120.00" } });
    expect(lista[1]).toMatchObject({ origenExistente: "manual", campos: ["fecha"], valoresSire: { fecha: "2026-10-06" } });
    expect(lista[2]).toMatchObject({ campos: ["total", "igv"], valoresSire: { total: "236.00", igv: "36.00" } });
    for (const d of lista) {
      for (const v of Object.values(d.valoresSire)) expect(typeof v).toBe("string");
    }
  });

  it("una lista vacia no hace nada y listarDiferencias de una propuesta sin diferencias da []", async () => {
    const w = db("contapp_worker");
    const lista = await w.withTenant({ tenantId: X }, async (tx) => {
      const p = await crearPropuesta(tx, nueva(cx, ux, { filasRecibidas: 1, filasNuevas: 1, filasIguales: 0, filasDistintas: 0 }));
      await insertarDiferencias(tx, p.id, []);
      return listarDiferencias(tx, p.id);
    });
    expect(lista).toEqual([]);
  });

  it("campos vacios, origen invalido o propuesta ajena fallan con SQLSTATE (23514 / 23503) y no dejan nada", async () => {
    const w = db("contapp_worker");
    const propX = await ev.propuesta(X, cx, { nuevas: 1 });
    const propY = await ev.propuesta(Y, cy, { nuevas: 1 });
    await expect(
      w.withTenant({ tenantId: X }, (tx) => insertarDiferencias(tx, propX, [dif("1", { campos: [] })])),
    ).rejects.toMatchObject({ codigo: "23514" });
    await expect(
      w.withTenant({ tenantId: X }, (tx) => insertarDiferencias(tx, propX, [dif("1", { origenExistente: "otro" as never })])),
    ).rejects.toMatchObject({ codigo: "23514" });
    await expect(
      w.withTenant({ tenantId: X }, (tx) => insertarDiferencias(tx, propY, [dif("1")])),
    ).rejects.toMatchObject({ codigo: "23503" });
    // todo o nada: la segunda esta mal, la primera no debe quedar
    await expect(
      w.withTenant({ tenantId: X }, (tx) => insertarDiferencias(tx, propX, [dif("5"), dif("6", { campos: [] })])),
    ).rejects.toMatchObject({ codigo: "23514" });
    expect((await admin.query("select count(*)::int as n from propuesta_diferencia where propuesta_id = $1", [propX])).rows[0].n).toBe(0);
  });

  it("listarDiferencias de una propuesta de otro estudio o inexistente devuelve []", async () => {
    const b = db("contapp_backend");
    const propX = await ev.propuesta(X, cx, { nuevas: 1 });
    await admin.query(
      `insert into propuesta_diferencia (tenant_id, propuesta_id, clave, tipo, serie, numero, origen_existente, campos, valores_sire)
       values ($1, $2, '03|B001|290', '03', 'B001', '290', 'sire', array['total'], '{"total":"1.00"}'::jsonb)`,
      [X, propX],
    );
    expect(await b.withTenant({ tenantId: X }, (tx) => listarDiferencias(tx, propX))).toHaveLength(1);
    expect(await b.withTenant({ tenantId: Y }, (tx) => listarDiferencias(tx, propX))).toEqual([]);
    expect(await b.withTenant({ tenantId: X }, (tx) => listarDiferencias(tx, randomUUID()))).toEqual([]);
  });

  it("la propuesta y sus diferencias son de uno u otro libro sin mezclarse (ventas y compras comparten tabla)", async () => {
    const w = db("contapp_worker");
    const r = await w.withTenant({ tenantId: X }, async (tx) => {
      const pv = await crearPropuesta(tx, nueva(cx2, ux, { libro: "ventas" }));
      const pc = await crearPropuesta(tx, nueva(cx2, ux, { libro: "compras" }));
      await insertarDiferencias(tx, pv.id, [dif("1")]);
      await insertarDiferencias(tx, pc.id, [dif("2"), dif("3")]);
      return {
        v: await listarDiferencias(tx, pv.id),
        c: await listarDiferencias(tx, pc.id),
        lv: await listarPropuestas(tx, cx2.id, PERIODO, "ventas"),
        lc: await listarPropuestas(tx, cx2.id, PERIODO, "compras"),
      };
    });
    expect(r.v).toHaveLength(1);
    expect(r.c).toHaveLength(2);
    expect(r.lv.map((p) => p.libro)).toEqual(["ventas"]);
    expect(r.lc.map((p) => p.libro)).toEqual(["compras"]);
  });
});

// =================================================================================================
describe("bloquearPeriodoLibro: serializa por (cliente, periodo, libro) (D16, CA-11)", () => {
  /** Toma el bloqueo y lo retiene hasta `liberar()`; devuelve cuando lo tiene y una promesa de fin. */
  async function retener(d: ContappDb, tenant: string, c: string, p: string, l: Libro) {
    let liberar!: () => void;
    const espera = new Promise<void>((r) => (liberar = r));
    let tomado!: () => void;
    const listo = new Promise<void>((r) => (tomado = r));
    const fin = d.withTenant({ tenantId: tenant }, async (tx) => {
      await bloquearPeriodoLibro(tx, c, p, l);
      tomado();
      await espera;
    });
    fin.catch(() => undefined); // si falla antes de tomar el bloqueo, el error sale en el race de abajo
    await Promise.race([listo, fin]);
    return { liberar, fin };
  }

  /** Intenta tomar el mismo bloqueo en otra transaccion; informa si lo logro antes de `ms`. */
  async function intentarTomar(d: ContappDb, tenant: string, c: string, p: string, l: Libro, ms = 400) {
    let adquirido = false;
    const fin = d.withTenant({ tenantId: tenant }, async (tx) => {
      await bloquearPeriodoLibro(tx, c, p, l);
      adquirido = true;
    });
    fin.catch(() => undefined); // el llamador la espera y ve el error; esto evita un rechazo sin manejar mientras duerme
    await dormir(ms);
    return { adquirido: () => adquirido, fin };
  }

  it("la misma terna espera a la primera transaccion y sigue al confirmarse", async () => {
    const a = db("contapp_worker");
    const b = db("contapp_worker");
    const t1 = await retener(a, X, cx.id, PERIODO, "ventas");
    const t2 = await intentarTomar(b, X, cx.id, PERIODO, "ventas");
    expect(t2.adquirido(), "la segunda no debe pasar mientras la primera retiene el bloqueo").toBe(false);
    t1.liberar();
    await t1.fin;
    await t2.fin;
    expect(t2.adquirido()).toBe(true);
  });

  it("lo toma tambien el backend (importacion) y espera al worker (descarga) sobre la misma terna", async () => {
    const w = db("contapp_worker");
    const b = db("contapp_backend");
    const t1 = await retener(w, X, cx.id, PERIODO, "ventas");
    const t2 = await intentarTomar(b, X, cx.id, PERIODO, "ventas");
    expect(t2.adquirido()).toBe(false);
    t1.liberar();
    await Promise.all([t1.fin, t2.fin]);
    expect(t2.adquirido()).toBe(true);
  });

  it("otro libro, otro periodo u otro cliente NO se bloquean entre si", async () => {
    const a = db("contapp_worker");
    const t1 = await retener(a, X, cx.id, PERIODO, "ventas");
    try {
      for (const [c, p, l] of [
        [cx.id, PERIODO, "compras"],
        [cx.id, "202609", "ventas"],
        [cx2.id, PERIODO, "ventas"],
      ] as const) {
        const otra = await intentarTomar(db("contapp_worker"), X, c, p, l, 250);
        expect(otra.adquirido(), `${c} ${p} ${l}`).toBe(true);
        await otra.fin;
      }
    } finally {
      t1.liberar();
      await t1.fin;
    }
  });

  it("un cliente de otro estudio con el mismo periodo y libro tampoco espera", async () => {
    const a = db("contapp_worker");
    const t1 = await retener(a, X, cx.id, PERIODO, "ventas");
    try {
      const otra = await intentarTomar(db("contapp_worker"), Y, cy.id, PERIODO, "ventas", 250);
      expect(otra.adquirido()).toBe(true);
      await otra.fin;
    } finally {
      t1.liberar();
      await t1.fin;
    }
  });

  it("se libera al terminar la transaccion, tambien si falla (rollback)", async () => {
    const a = db("contapp_worker");
    const b = db("contapp_worker");
    await expect(
      a.withTenant({ tenantId: X }, async (tx) => {
        await bloquearPeriodoLibro(tx, cx.id, PERIODO, "ventas");
        throw new Error("falla a proposito");
      }),
    ).rejects.toThrow("falla a proposito");
    const t2 = await intentarTomar(b, X, cx.id, PERIODO, "ventas", 150);
    expect(t2.adquirido()).toBe(true);
    await t2.fin;
  });

  it("30 rondas de dos transacciones sobre la misma terna: ninguna da 40P01 y las secciones criticas no se solapan", async () => {
    const a = db("contapp_worker", 3);
    const b = db("contapp_backend", 3);
    for (let ronda = 0; ronda < 30; ronda++) {
      const orden: string[] = [];
      const seccion = (nombre: string) => async (tx: Tx) => {
        await bloquearPeriodoLibro(tx, cx.id, PERIODO, "ventas");
        orden.push(`${nombre}:entra`);
        await tx.query("select pg_sleep(0.005)");
        orden.push(`${nombre}:sale`);
      };
      const r = await Promise.allSettled([
        a.withTenant({ tenantId: X }, seccion("a")),
        b.withTenant({ tenantId: X }, seccion("b")),
      ]);
      expect(r.map((x) => x.status), `ronda ${ronda}: ${JSON.stringify(r)}`).toEqual(["fulfilled", "fulfilled"]);
      // sin solape: cada "entra" va seguido de su propio "sale"
      expect(orden[0].split(":")[0]).toBe(orden[1].split(":")[0]);
      expect(orden[2].split(":")[0]).toBe(orden[3].split(":")[0]);
    }
  });
});
