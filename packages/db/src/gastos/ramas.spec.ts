// Spec 027 (T14a): ramas de validación y de respaldo del repositorio de gastos que la BD real no alcanza (argumentos de forma
// equivocada que la barrera de errores.ts rechaza antes de ir a la BD, y respuestas incompletas de la BD). Con una `tx` falsa:
// no necesita BD. Contrato: un argumento mal formado es P0002 (id) o 22023 (tipo) SIN consultar; una respuesta incompleta cae a
// los valores por omisión del contrato (umbral 3, versión 0, listas vacías).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { txFalso } from "../trabajos/soporte-prueba";
import {
  aprender,
  ciiuPendientes,
  guardarCiiu,
  leerContextoGastos,
  leerGastosEstudio,
  leerGlosasCompra,
} from "./index";
import {
  exigirBooleano,
  exigirTexto,
  exigirTextos,
  exigirVersion,
  GastosRepoError,
} from "./errores";

/** El código de error de la promesa o de la llamada síncrona; falla si no lanza o lanza otra cosa. */
async function codigo(f: () => unknown): Promise<string> {
  try {
    await f();
  } catch (e) {
    if (!(e instanceof GastosRepoError)) throw e;
    return e.codigo;
  }
  throw new Error("se esperaba un GastosRepoError y no falló");
}

const cliente = randomUUID();
const compra = randomUUID();

describe("errores.ts: validadores de forma", () => {
  it.each([
    ["no es número", "1"],
    ["no es entero", 1.5],
    ["es negativo", -1],
    ["pasa de 2.147.483.646", 2_147_483_647],
    ["es NaN", Number.NaN],
    ["no es entero seguro", Number.MAX_SAFE_INTEGER + 2],
  ])("exigirVersion: %s -> 22023", async (_n, v) => {
    expect(await codigo(() => exigirVersion(v))).toBe("22023");
  });

  it("exigirVersion acepta 0 y el máximo", () => {
    expect(exigirVersion(0)).toBe(0);
    expect(exigirVersion(2_147_483_646)).toBe(2_147_483_646);
  });

  it("exigirBooleano y exigirTexto rechazan otros tipos y aceptan los suyos", async () => {
    expect(await codigo(() => exigirBooleano("true"))).toBe("22023");
    expect(await codigo(() => exigirTexto(5))).toBe("22023");
    expect(exigirBooleano(false)).toBe(false);
    expect(exigirTexto("")).toBe("");
  });

  it.each([
    ["no es arreglo", "abc"],
    ["tiene un elemento que no es texto", ["a", 1]],
    ["tiene un null", [null]],
  ])("exigirTextos: %s -> 22023", async (_n, v) => {
    expect(await codigo(() => exigirTextos(v))).toBe("22023");
  });

  it("exigirTextos acepta un arreglo de textos, también vacío", () => {
    expect(exigirTextos(["a", "b"])).toEqual(["a", "b"]);
    expect(exigirTextos([])).toEqual([]);
  });
});

describe("aprender: argumentos de forma equivocada (sin ir a la BD)", () => {
  it.each([
    ["terminos no es arreglo", "audifonos"],
    ["terminos es null", null],
    ["un término no es texto", [{ termino: 7, categoria: "juguetes" }]],
    ["una categoría no es texto", [{ termino: "audifonos", categoria: 7 }]],
    ["un elemento es null", [null]],
    ["falta la categoría", [{ termino: "audifonos" }]],
  ])("%s -> 22023", async (_n, terminos) => {
    const { tx, llamadas } = txFalso({ rows: [] });
    expect(
      await codigo(() =>
        aprender(tx, {
          clienteId: cliente,
          compraId: compra,
          terminos: terminos as never,
        }),
      ),
    ).toBe("22023");
    expect(llamadas).toEqual([]);
  });

  it("un id mal formado es P0002 y no consulta", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    expect(
      await codigo(() =>
        aprender(tx, { clienteId: "x", compraId: compra, terminos: [] }),
      ),
    ).toBe("P0002");
    expect(
      await codigo(() =>
        aprender(tx, { clienteId: cliente, compraId: "x", terminos: [] }),
      ),
    ).toBe("P0002");
    expect(llamadas).toEqual([]);
  });

  it("si la BD no devuelve fila o las listas no son arreglos, devuelve listas vacías", async () => {
    for (const rows of [
      [],
      [{ r: null }],
      [{ r: { guardadas: "a", omitidas: 3 } }],
    ]) {
      const { tx } = txFalso({ rows });
      expect(
        await aprender(tx, {
          clienteId: cliente,
          compraId: compra,
          terminos: [{ termino: "audifonos", categoria: "entretenimiento" }],
        }),
      ).toEqual({ guardadas: [], omitidas: [] });
    }
  });

  it("convierte a texto las palabras guardadas y omitidas", async () => {
    const { tx } = txFalso({
      rows: [{ r: { guardadas: ["a", 2], omitidas: [3n, "b"] } }],
    });
    expect(
      await aprender(tx, {
        clienteId: cliente,
        compraId: compra,
        terminos: [],
      }),
    ).toEqual({ guardadas: ["a", "2"], omitidas: ["3", "b"] });
  });
});

describe("ciiu: argumentos de forma equivocada (sin ir a la BD)", () => {
  it("ciiuPendientes: rucs que no es arreglo o trae no-textos -> 22023", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    expect(await codigo(() => ciiuPendientes(tx, "20100070970" as never))).toBe(
      "22023",
    );
    expect(await codigo(() => ciiuPendientes(tx, [1] as never))).toBe("22023");
    expect(llamadas).toEqual([]);
  });

  it("ciiuPendientes: lista vacía -> [] sin consultar", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    expect(await ciiuPendientes(tx, [])).toEqual([]);
    expect(llamadas).toEqual([]);
  });

  it.each([
    ["entradas no es arreglo", "x"],
    ["entradas es null", null],
    ["el RUC no es texto", [{ ruc: 20100070970, ciiu: "4711" }]],
    ["el CIIU es un número", [{ ruc: "20100070970", ciiu: 4711 }]],
    ["el CIIU falta (undefined)", [{ ruc: "20100070970" }]],
    ["un elemento es null", [null]],
  ])("guardarCiiu: %s -> 22023", async (_n, entradas) => {
    const { tx, llamadas } = txFalso({ rows: [{ n: 1 }] });
    expect(await codigo(() => guardarCiiu(tx, entradas as never))).toBe(
      "22023",
    );
    expect(llamadas).toEqual([]);
  });

  it("guardarCiiu: con CIIU texto o null llama a la función y devuelve el conteo como número", async () => {
    const { tx, llamadas } = txFalso({ rows: [{ n: "2" }] });
    expect(
      await guardarCiiu(tx, [
        { ruc: "20100070970", ciiu: "4711" },
        { ruc: "20100070971", ciiu: null },
      ]),
    ).toBe(2);
    expect(llamadas).toHaveLength(1);
    expect(JSON.parse(llamadas[0]!.valores[0] as string)).toEqual([
      { ruc: "20100070970", ciiu: "4711" },
      { ruc: "20100070971", ciiu: null },
    ]);
  });
});

describe("contexto: argumentos de forma equivocada (sin ir a la BD)", () => {
  const base = { clienteId: cliente, periodo: "202610", proveedores: [] };

  it.each([
    ["periodo no es texto", { ...base, periodo: 202610 }],
    ["periodo con formato inválido", { ...base, periodo: "2026-10" }],
    ["periodo de mes 13", { ...base, periodo: "202613" }],
    ["proveedores no es arreglo", { ...base, proveedores: "x" }],
    [
      "proveedor con tipo no texto",
      { ...base, proveedores: [{ tipo: 6, numero: "1" }] },
    ],
    [
      "proveedor con número no texto",
      { ...base, proveedores: [{ tipo: "6", numero: 1 }] },
    ],
    ["proveedor null", { ...base, proveedores: [null] }],
  ])("%s -> 22023", async (_n, e) => {
    const { tx, llamadas } = txFalso({ rows: [] });
    expect(await codigo(() => leerContextoGastos(tx, e as never))).toBe(
      "22023",
    );
    expect(llamadas).toEqual([]);
  });

  it("clienteId mal formado -> P0002 sin consultar", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    expect(
      await codigo(() => leerContextoGastos(tx, { ...base, clienteId: "x" })),
    ).toBe("P0002");
    expect(llamadas).toEqual([]);
  });
});

describe("leerGastosEstudio: respuestas incompletas de la BD", () => {
  it("sin fila de configuración: umbral 3, versión 0, 0 propias activas y listas vacías", async () => {
    const { tx } = txFalso({ rows: [] });
    expect(await leerGastosEstudio(tx)).toEqual({
      umbral: 3,
      versionUmbral: 0,
      activasPropias: 0,
      globales: [],
      propias: [],
    });
  });

  it("configuración con campos nulos usa los valores por omisión", async () => {
    const { tx } = txFalso({
      rows: [{ umbral: null, version: null, activas: null }],
    });
    const r = await leerGastosEstudio(tx);
    expect([r.umbral, r.versionUmbral, r.activasPropias]).toEqual([3, 0, 0]);
  });

  it("excepciones nulas salen como lista vacía y compra_origen_id ausente como null", async () => {
    const { tx } = txFalso(
      { rows: [{ umbral: 5, version: 2, activas: 1 }] },
      {
        rows: [
          {
            id: "g1",
            palabra: "zapatilla",
            categoria: "calzado-ropa",
            excepciones: null,
            desactivada: false,
          },
          {
            id: "g2",
            palabra: "juguete",
            categoria: "juguetes",
            excepciones: ["caja"],
            desactivada: true,
          },
        ],
      },
      {
        rows: [
          {
            id: "p1",
            palabra: "audifonos",
            categoria: "entretenimiento",
            excepciones: null,
            origen: "aprendida",
            activa: true,
            version: "1",
            creado_por: "u1",
            nombre: "Ana",
            compra_origen_id: undefined,
            creada_en: new Date(0),
          },
        ],
      },
    );
    const r = await leerGastosEstudio(tx);
    expect([r.umbral, r.versionUmbral, r.activasPropias]).toEqual([5, 2, 1]);
    expect(
      r.globales.map((g) => [g.excepciones, g.desactivadaPorEstudio]),
    ).toEqual([
      [[], false],
      [["caja"], true],
    ]);
    expect(r.propias[0]).toMatchObject({
      excepciones: [],
      compraOrigenId: null,
      version: 1,
      autor: { id: "u1", nombre: "Ana" },
    });
  });
});

describe("leerContextoGastos: respuestas incompletas de la BD", () => {
  const e = { clienteId: cliente, periodo: "202610", proveedores: [] };

  it("sin fila del estudio: umbral 3, listas vacías, sin CIIU ni categorías, y no consulta el historial sin proveedores", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    expect(await leerContextoGastos(tx, e)).toEqual({
      umbral: 3,
      globales: [],
      desactivadas: [],
      propias: [],
      ciiuCliente: null,
      ciiuProveedores: [],
      categoriasCliente: { permitidas: [], quitadas: [] },
      historial: [],
    });
    expect(llamadas).toHaveLength(1);
  });

  it("campos nulos o de tipo inesperado caen a sus valores por omisión; excepciones ausentes salen vacías", async () => {
    const { tx } = txFalso({
      rows: [
        {
          umbral: null,
          globales: "no es arreglo",
          desactivadas: null,
          propias: [
            {
              palabra: "audifonos",
              categoria: "entretenimiento",
              excepciones: "x",
            },
            {
              palabra: "zapatilla",
              categoria: "calzado-ropa",
              excepciones: ["suela"],
            },
          ],
          ciiu_cliente: undefined,
          ciiu_proveedores: null,
          categorias: { permitidas: null, quitadas: ["juguetes", 1] },
        },
      ],
    });
    const r = await leerContextoGastos(tx, e);
    expect(r.umbral).toBe(3);
    expect(r.globales).toEqual([]);
    expect(r.desactivadas).toEqual([]);
    expect(r.ciiuCliente).toBeNull();
    expect(r.propias).toEqual([
      { palabra: "audifonos", categoria: "entretenimiento", excepciones: [] },
      {
        palabra: "zapatilla",
        categoria: "calzado-ropa",
        excepciones: ["suela"],
      },
    ]);
    expect(r.categoriasCliente).toEqual({
      permitidas: [],
      quitadas: ["juguetes", "1"],
    });
  });

  it("proveedor sin CIIU en la caché, sin historial y que no es RUC: ciiu null y conteos en 0", async () => {
    const { tx, llamadas } = txFalso(
      { rows: [{ umbral: 4, ciiu_proveedores: { "20100070970": "4711" } }] },
      { rows: [] },
    );
    const r = await leerContextoGastos(tx, {
      ...e,
      proveedores: [
        { tipo: "6", numero: "20100070970" },
        { tipo: "6", numero: "20100070971" },
        { tipo: "1", numero: "12345678" },
        { tipo: "6", numero: "20100070970" },
      ],
    });
    expect(r.umbral).toBe(4);
    expect(r.ciiuProveedores.map((c) => c.ciiu)).toEqual(["4711", null, null]);
    expect(
      r.historial.map((h) => [h.aceptadas6, h.excluidas6, h.excluidas12]),
    ).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
    expect(llamadas).toHaveLength(2);
    expect(llamadas[0]!.valores[1]).toEqual(["20100070970", "20100070971"]);
  });
});

describe("leerGlosasCompra: respuestas de la BD sin ítems", () => {
  it("id que no es uuid -> null sin consultar", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    expect(await leerGlosasCompra(tx, "x")).toBeNull();
    expect(llamadas).toEqual([]);
  });

  it("sin XML (sin fila) -> null", async () => {
    const { tx } = txFalso({ rows: [] });
    expect(await leerGlosasCompra(tx, compra)).toBeNull();
  });

  it.each([
    ["detalle null", null],
    ["detalle sin items", {}],
    ["items que no es arreglo", { items: "x" }],
  ])("%s -> lista vacía", async (_n, detalle) => {
    const { tx } = txFalso({ rows: [{ detalle }] });
    expect(await leerGlosasCompra(tx, compra)).toEqual([]);
  });

  it("descarta los ítems sin descripción de texto y conserva el orden", async () => {
    const { tx } = txFalso({
      rows: [
        {
          detalle: {
            items: [
              { descripcion: "A" },
              null,
              { descripcion: 5 },
              { descripcion: "B" },
            ],
          },
        },
      ],
    });
    expect(await leerGlosasCompra(tx, compra)).toEqual(["A", "B"]);
  });
});
