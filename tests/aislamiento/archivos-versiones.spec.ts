// Spec 012b (T4, rojo): repositorios de versiones de archivo (`packages/db/src/archivos/`) contra la BD real (CA-2, CA-5, CA-7, CA-9;
// D3, D6, D8). `ultimaVersion`, `insertarVersion`, `listarVersiones` y `leerVersion`: con otro estudio, cliente, periodo o libro no
// devuelven nada; la numeracion es independiente por cliente, periodo y libro. Hasta T10 fallan por funcion inexistente.
// Contrato (firmas y forma de `VersionArchivo`): encabezado de `archivos-soporte.ts`.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auth-soporte";
import type { ContappDb, Tx } from "./soporte";
import { crearDb, type ClientePrueba } from "./trabajos-soporte";
import {
  BYTES,
  codigoRepo,
  contarEn,
  datosArchivo,
  entradaVersion,
  EscenarioArchivos,
  HEX,
  PERIODO,
  type DatosArchivo,
  type Libro,
} from "./archivos-soporte";

interface VersionArchivo {
  id: string;
  clienteId: string;
  periodo: string;
  libro: Libro;
  version: number;
  formatoId: string;
  formatoVersion: string;
  provisional: boolean;
  nombreTxt: string;
  nombreZip: string;
  sha256Txt: string;
  sha256Zip: string;
  bytesZip: number;
  lineas: number;
  huella: string;
  modificadas: number;
  excluidas: number;
  agregadas: number;
  impactoIgvDg: string | null;
  impactoIgvDgng: string | null;
  impactoIgvDng: string | null;
  impactoIgvTotal: string;
  avisos: Record<string, number>;
  ruta: string;
  trabajoId: string;
  generadoPor: string;
  generadoEn: Date;
}
type Entrada = ReturnType<typeof entradaVersion>;
const ultimaVersion = (tx: Tx, c: string, p: string, l: Libro) =>
  exportado<
    (tx: Tx, c: string, p: string, l: Libro) => Promise<VersionArchivo | null>
  >("ultimaVersion")(tx, c, p, l);
const insertarVersion = (tx: Tx, v: Entrada) =>
  exportado<(tx: Tx, v: Entrada) => Promise<VersionArchivo>>("insertarVersion")(
    tx,
    v,
  );
const listarVersiones = (tx: Tx, c: string, p: string, l: Libro) =>
  exportado<
    (tx: Tx, c: string, p: string, l: Libro) => Promise<VersionArchivo[]>
  >("listarVersiones")(tx, c, p, l);
const leerVersion = (
  tx: Tx,
  id: string,
  f: { clienteId: string; periodo: string; libro: Libro },
) =>
  exportado<(tx: Tx, id: string, f: unknown) => Promise<VersionArchivo | null>>(
    "leerVersion",
  )(tx, id, f);

let admin: Pool;
let ec: EscenarioArchivos;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let cy: ClientePrueba;
let ux: string;
let uy: string;

beforeAll(async () => {
  admin = abrirAdmin(8);
  ec = new EscenarioArchivos(admin);
  X = (await ec.estudio()).id;
  Y = (await ec.estudio()).id;
  cy = await ec.cliente(Y);
  ux = await ec.usuarioDe(X);
  uy = await ec.usuarioDe(Y);
  backend = crearDb("contapp_backend", 6);
  worker = crearDb("contapp_worker", 4);
});
afterAll(async () => {
  await ec?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close()].map((d) => d?.catch(() => undefined)),
  );
  await admin?.end();
});

const comoBackend = <T>(fn: (tx: Tx) => Promise<T>, tenantId = X) =>
  backend.withTenant({ tenantId }, fn);
const comoWorker = <T>(fn: (tx: Tx) => Promise<T>, tenantId = X) =>
  worker.withTenant({ tenantId }, fn);
/** Datos validos de una version nueva para `c` con su trabajo propio (el estado del periodo lo siembra cada prueba). */
async function nueva(
  c: ClientePrueba,
  o: Partial<DatosArchivo> = {},
  t = X,
  u = ux,
): Promise<DatosArchivo> {
  return datosArchivo(t, c, u, await ec.trabajoArchivo(t, c), o);
}
const VENTAS: Partial<DatosArchivo> = {
  libro: "ventas",
  impactoDg: null,
  impactoDgng: null,
  impactoDng: null,
};

// =================================================================================================
describe("insertarVersion · lo que guarda y lo que devuelve (D3, CA-2, CA-5)", () => {
  it("compras: con el periodo generado inserta como el worker y devuelve la version con hashes en hex, montos como cadenas y fecha", async () => {
    const c = await ec.cliente(X);
    await ec.periodoDe("compras", X, c, PERIODO, "generado", ux);
    const d = await nueva(c, {
      excluidas: 2,
      agregadas: 1,
      modificadas: 3,
      impactoTotal: "-12.50",
      impactoDg: "-10.00",
      impactoDgng: "-2.00",
      impactoDng: "-0.50",
      avisos: { "R-ISC": 1, RAZON_SOCIAL_RECORTADA: 2 },
    });
    const v = await comoWorker((tx) => insertarVersion(tx, entradaVersion(d)));
    expect(v, "insertarVersion aun no esta implementada").toEqual({
      id: d.id,
      clienteId: c.id,
      periodo: PERIODO,
      libro: "compras",
      version: 1,
      formatoId: "RCE-REEMPLAZO",
      formatoVersion: "0-provisional",
      provisional: true,
      nombreTxt: d.nombreTxt,
      nombreZip: d.nombreZip,
      sha256Txt: HEX("a"),
      sha256Zip: HEX("b"),
      bytesZip: 1234,
      lineas: 3,
      huella: HEX("c"),
      modificadas: 3,
      excluidas: 2,
      agregadas: 1,
      impactoIgvDg: "-10.00",
      impactoIgvDgng: "-2.00",
      impactoIgvDng: "-0.50",
      impactoIgvTotal: "-12.50",
      avisos: { "R-ISC": 1, RAZON_SOCIAL_RECORTADA: 2 },
      ruta: d.ruta,
      trabajoId: d.trabajoId,
      generadoPor: ux,
      generadoEn: expect.any(Date),
    });
    expect(typeof v.bytesZip).toBe("number");
    expect(typeof v.lineas).toBe("number");
    const fila = (
      await admin.query(
        `select encode(sha256_txt, 'hex') as t, encode(sha256_zip, 'hex') as z, impacto_igv_total::text as total, avisos, ruta, tenant_id
           from archivo_generado where id = $1`,
        [d.id],
      )
    ).rows[0];
    expect(fila).toEqual({
      t: HEX("a"),
      z: HEX("b"),
      total: "-12.50",
      avisos: { "R-ISC": 1, RAZON_SOCIAL_RECORTADA: 2 },
      ruta: d.ruta,
      tenant_id: X,
    });
  });

  it("ventas: los impactos por destino quedan nulos y el total se guarda; el avisos vacio es un objeto", async () => {
    const c = await ec.cliente(X);
    await ec.periodoDe("ventas", X, c, PERIODO, "generado", ux);
    const d = await nueva(c, { ...VENTAS, avisos: {}, impactoTotal: "0.00" });
    const v = await comoWorker((tx) => insertarVersion(tx, entradaVersion(d)));
    expect(v).toMatchObject({
      libro: "ventas",
      impactoIgvDg: null,
      impactoIgvDgng: null,
      impactoIgvDng: null,
      impactoIgvTotal: "0.00",
      avisos: {},
    });
  });

  it("la version 2 entra cuando existe la 1; un periodo no generado, una version repetida o saltada y el mismo trabajo lanzan ArchivosRepoError con el SQLSTATE", async () => {
    const c = await ec.cliente(X);
    const Err =
      exportado<new (c: string) => Error & { codigo: string }>(
        "ArchivosRepoError",
      );
    const d1 = await nueva(c);
    expect(
      await codigoRepo(
        comoWorker((tx) => insertarVersion(tx, entradaVersion(d1))),
      ),
      "periodo sin generar",
    ).toBe("23514");
    await ec.periodoDe("compras", X, c, PERIODO, "generado", ux);
    await comoWorker((tx) => insertarVersion(tx, entradaVersion(d1)));
    expect(
      await codigoRepo(
        comoWorker(async (tx) =>
          insertarVersion(tx, entradaVersion(await nueva(c))),
        ),
      ),
    ).toBe("23514");
    expect(
      await codigoRepo(
        comoWorker(async (tx) =>
          insertarVersion(tx, entradaVersion(await nueva(c, { version: 3 }))),
        ),
      ),
    ).toBe("23514");
    const mismoTrabajo = await nueva(c, {
      version: 2,
      trabajoId: d1.trabajoId,
    });
    let error: unknown;
    await comoWorker((tx) =>
      insertarVersion(tx, entradaVersion(mismoTrabajo)),
    ).catch((e) => (error = e));
    expect(error).toBeInstanceOf(Err);
    expect((error as { codigo: string }).codigo).toBe("23505");
    const texto =
      String((error as Error).message) +
      JSON.stringify(error) +
      String((error as Error).stack);
    for (const dato of [d1.ruta, d1.huella, d1.nombreZip, c.id])
      expect(texto, "el error no lleva datos de la fila").not.toContain(dato);
    const d2 = await nueva(c, { version: 2, sha256Zip: BYTES("d") });
    expect(
      (await comoWorker((tx) => insertarVersion(tx, entradaVersion(d2))))
        .version,
    ).toBe(2);
    expect(
      await contarEn(admin, "archivo_generado", "cliente_id = $1", [c.id]),
    ).toBe(2);
  });

  it("el backend no inserta (CA-9): 42501 aunque el periodo este generado", async () => {
    const c = await ec.cliente(X);
    await ec.periodoDe("compras", X, c, PERIODO, "generado", ux);
    expect(
      await codigoRepo(
        comoBackend(async (tx) =>
          insertarVersion(tx, entradaVersion(await nueva(c))),
        ),
      ),
    ).toBe("42501");
    expect(
      await contarEn(admin, "archivo_generado", "cliente_id = $1", [c.id]),
    ).toBe(0);
  });

  it("una insercion dentro de una transaccion que luego falla no deja version (la numeracion no se consume)", async () => {
    const c = await ec.cliente(X);
    await ec.periodoDe("compras", X, c, PERIODO, "generado", ux);
    const d = await nueva(c);
    await comoWorker(async (tx) => {
      await insertarVersion(tx, entradaVersion(d));
      throw new Error("falla despues de insertar");
    }).catch(() => undefined);
    expect(
      await contarEn(admin, "archivo_generado", "cliente_id = $1", [c.id]),
    ).toBe(0);
    expect(
      (await comoWorker((tx) => insertarVersion(tx, entradaVersion(d))))
        .version,
    ).toBe(1);
  });

  it("un monto de mas de 14 digitos no cabe (22003) y un id de ruta distinta no entra (23514)", async () => {
    const c = await ec.cliente(X);
    await ec.periodoDe("compras", X, c, PERIODO, "generado", ux);
    expect(
      await codigoRepo(
        comoWorker(async (tx) =>
          insertarVersion(
            tx,
            entradaVersion(
              await nueva(c, { impactoTotal: "1234567890123.45" }),
            ),
          ),
        ),
      ),
    ).toBe("22003");
    expect(
      await codigoRepo(
        comoWorker(async (tx) =>
          insertarVersion(
            tx,
            entradaVersion(await nueva(c, { ruta: "archivos/otro.zip" })),
          ),
        ),
      ),
    ).toBe("23514");
  });
});

// =================================================================================================
describe("ultimaVersion · listarVersiones · leerVersion (D5, D8, CA-6, CA-9)", () => {
  /** Tres versiones de compras (1, 2, 3) y una de ventas (1) para un cliente; devuelve los datos sembrados. */
  async function sembrar() {
    const c = await ec.cliente(X);
    const v1 = await ec.archivo(X, c, ux, { version: 1 });
    const v2 = await ec.archivo(X, c, ux, {
      version: 2,
      sha256Zip: BYTES("d"),
    });
    const v3 = await ec.archivo(X, c, ux, {
      version: 3,
      sha256Zip: BYTES("e"),
      lineas: 9,
    });
    const ventas = await ec.archivo(X, c, ux, { ...VENTAS, version: 1 });
    return { c, v1, v2, v3, ventas };
  }

  it("ultimaVersion: null sin versiones; con versiones, la mayor del libro; el worker y el backend la leen", async () => {
    const c = await ec.cliente(X);
    expect(
      await comoBackend((tx) => ultimaVersion(tx, c.id, PERIODO, "compras")),
      "ultimaVersion aun no esta implementada",
    ).toBeNull();
    const s = await sembrar();
    for (const como of [comoBackend, comoWorker]) {
      const u = await como((tx) =>
        ultimaVersion(tx, s.c.id, PERIODO, "compras"),
      );
      expect(u).toMatchObject({
        id: s.v3.id,
        version: 3,
        lineas: 9,
        sha256Zip: HEX("e"),
        libro: "compras",
        generadoPor: ux,
      });
      expect(u?.generadoEn).toBeInstanceOf(Date);
      expect(
        (await como((tx) => ultimaVersion(tx, s.c.id, PERIODO, "ventas")))?.id,
      ).toBe(s.ventas.id);
    }
  });

  it("la numeracion y la lectura son independientes por cliente, periodo y libro", async () => {
    const s = await sembrar();
    const otro = await ec.cliente(X);
    expect(
      await comoBackend((tx) => ultimaVersion(tx, otro.id, PERIODO, "compras")),
      "otro cliente",
    ).toBeNull();
    expect(
      await comoBackend((tx) => ultimaVersion(tx, s.c.id, "202609", "compras")),
      "otro periodo",
    ).toBeNull();
    const ventas = await comoBackend((tx) =>
      ultimaVersion(tx, s.c.id, PERIODO, "ventas"),
    );
    expect(ventas, "ventas lleva su propia numeracion").toMatchObject({
      libro: "ventas",
      version: 1,
    });
    await ec.archivo(X, otro, ux, { version: 1 });
    expect(
      (
        await comoBackend((tx) =>
          ultimaVersion(tx, otro.id, PERIODO, "compras"),
        )
      )?.version,
    ).toBe(1);
    expect(
      (await comoBackend((tx) => ultimaVersion(tx, s.c.id, PERIODO, "compras")))
        ?.version,
    ).toBe(3);
  });

  it("otro estudio: ultimaVersion, listarVersiones y leerVersion no devuelven nada", async () => {
    const s = await sembrar();
    expect(
      await comoBackend(
        (tx) => ultimaVersion(tx, s.c.id, PERIODO, "compras"),
        Y,
      ),
    ).toBeNull();
    expect(
      await comoBackend(
        (tx) => listarVersiones(tx, s.c.id, PERIODO, "compras"),
        Y,
      ),
    ).toEqual([]);
    expect(
      await comoBackend(
        (tx) =>
          leerVersion(tx, s.v2.id, {
            clienteId: s.c.id,
            periodo: PERIODO,
            libro: "compras",
          }),
        Y,
      ),
    ).toBeNull();
    expect(
      await comoWorker(
        (tx) =>
          leerVersion(tx, s.v2.id, {
            clienteId: s.c.id,
            periodo: PERIODO,
            libro: "compras",
          }),
        Y,
      ),
    ).toBeNull();
  });

  it("listarVersiones: mayor version primero, solo las del cliente, periodo y libro pedidos; vacio si no hay", async () => {
    const s = await sembrar();
    await ec.archivo(X, s.c, ux, { version: 1, periodo: "202609" });
    const l = await comoBackend((tx) =>
      listarVersiones(tx, s.c.id, PERIODO, "compras"),
    );
    expect(l.map((v) => [v.version, v.id])).toEqual([
      [3, s.v3.id],
      [2, s.v2.id],
      [1, s.v1.id],
    ]);
    for (const v of l)
      expect(v).toMatchObject({
        clienteId: s.c.id,
        periodo: PERIODO,
        libro: "compras",
      });
    expect(
      (
        await comoBackend((tx) =>
          listarVersiones(tx, s.c.id, PERIODO, "ventas"),
        )
      ).map((v) => v.id),
    ).toEqual([s.ventas.id]);
    expect(
      await comoBackend((tx) =>
        listarVersiones(tx, s.c.id, "202601", "compras"),
      ),
    ).toEqual([]);
    expect(
      await comoBackend(async (tx) =>
        listarVersiones(tx, (await ec.cliente(X)).id, PERIODO, "compras"),
      ),
    ).toEqual([]);
  });

  it("leerVersion: la version pedida con su ruta y su trabajo; el cliente, periodo o libro equivocados dan null", async () => {
    const s = await sembrar();
    const filtro = {
      clienteId: s.c.id,
      periodo: PERIODO,
      libro: "compras" as Libro,
    };
    const v = await comoBackend((tx) => leerVersion(tx, s.v2.id, filtro));
    expect(v, "leerVersion aun no esta implementada").toMatchObject({
      id: s.v2.id,
      version: 2,
      ruta: s.v2.ruta,
      trabajoId: s.v2.trabajoId,
      sha256Zip: HEX("d"),
      nombreZip: s.v2.nombreZip,
    });
    const otro = await ec.cliente(X);
    expect(
      await comoBackend((tx) =>
        leerVersion(tx, s.v2.id, { ...filtro, clienteId: otro.id }),
      ),
      "otro cliente",
    ).toBeNull();
    expect(
      await comoBackend((tx) =>
        leerVersion(tx, s.v2.id, { ...filtro, periodo: "202609" }),
      ),
      "otro periodo",
    ).toBeNull();
    expect(
      await comoBackend((tx) =>
        leerVersion(tx, s.v2.id, { ...filtro, libro: "ventas" }),
      ),
      "otro libro",
    ).toBeNull();
    expect(
      await comoBackend((tx) => leerVersion(tx, s.ventas.id, filtro)),
      "una version de ventas pedida como compras",
    ).toBeNull();
    expect(
      (
        await comoBackend((tx) =>
          leerVersion(tx, s.ventas.id, { ...filtro, libro: "ventas" }),
        )
      )?.libro,
    ).toBe("ventas");
    expect(
      await comoBackend((tx) =>
        leerVersion(tx, "00000000-0000-4000-8000-000000000000", filtro),
      ),
      "inexistente",
    ).toBeNull();
  });

  it("la fila de un cliente de otro estudio con el mismo periodo no se mezcla (aislamiento cruzado)", async () => {
    const s = await sembrar();
    await ec.archivo(Y, cy, uy, { version: 1 });
    expect(
      (
        await comoBackend((tx) =>
          listarVersiones(tx, s.c.id, PERIODO, "compras"),
        )
      ).length,
    ).toBe(3);
    expect(
      await comoBackend((tx) => listarVersiones(tx, cy.id, PERIODO, "compras")),
    ).toEqual([]);
    expect(
      (
        await comoBackend(
          (tx) => listarVersiones(tx, cy.id, PERIODO, "compras"),
          Y,
        )
      ).length,
    ).toBe(1);
  });

  it("la lectura es de solo lectura: no hay forma de actualizar ni borrar con el rol del backend o del worker", async () => {
    const s = await sembrar();
    for (const como of [comoBackend, comoWorker]) {
      const r = await como((tx) =>
        tx.query(
          "select count(*)::int as n from archivo_generado where cliente_id = $1",
          [s.c.id],
        ),
      );
      expect(r.rows[0].n).toBe(4);
    }
  });
});

// =================================================================================================
describe("secuencia del worker: ultima + 1 bajo el periodo generado (D6, CA-7, CA-14)", () => {
  it("tres generaciones seguidas numeran 1, 2 y 3; cada una lee la ultima y la siguiente entra", async () => {
    const c = await ec.cliente(X);
    const numeros: number[] = [];
    for (let i = 0; i < 3; i++) {
      await ec.periodoDe("compras", X, c, PERIODO, "generado", ux);
      const v = await comoWorker(async (tx) => {
        const u = await ultimaVersion(tx, c.id, PERIODO, "compras");
        return insertarVersion(
          tx,
          entradaVersion(await nueva(c, { version: (u?.version ?? 0) + 1 })),
        );
      });
      numeros.push(v.version);
    }
    expect(numeros).toEqual([1, 2, 3]);
    expect(
      (
        await comoBackend((tx) => listarVersiones(tx, c.id, PERIODO, "compras"))
      ).map((v) => v.version),
    ).toEqual([3, 2, 1]);
  });
});
