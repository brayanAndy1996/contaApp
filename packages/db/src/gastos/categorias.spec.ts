// Spec 027 (T4, rojo): repositorio de las categorías permitidas y quitadas por cliente (R-13, CA-8, CA-16). Contra la BD real con el backend
// (con y sin usuario), más una `tx` falsa para la traducción de errores. Necesita DATABASE_URL y MIGRATIONS_DATABASE_URL: si faltan,
// FALLA (no se salta).
//
// CONTRATO que fijan estas pruebas (lo implementa T10 en `packages/db/src/gastos/categorias.ts`; llama a `gnd_cliente_categorias_fijar`):
//   leerCategoriasCliente(tx, clienteId) -> {ciiu, permitidas, quitadas, version} | null
//       `ciiu` = clase de la caché del estudio para el RUC del cliente (null sin fila o «sin dato»); sin fila de categorías: listas
//       vacías y versión 0; null si el cliente no existe, es de otro estudio o el id está mal formado (sin ir a la BD).
//   fijarCategoriasCliente(tx, {clienteId, permitidas, quitadas, version}) -> versión nueva (= version + 1); `version` 0 si nunca se
//       fijaron. Reemplaza ambas listas.
//   Errores (GastosRepoError.codigo): P0002 cliente ajeno, inexistente o mal formado, 55000 cliente archivado, CA409 versión distinta,
//       22023 (categoría fuera de las 6, categoría repetida en una lista, una categoría en ambas listas, versión inválida), 42501 sin usuario.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fijarCategoriasCliente, leerCategoriasCliente } from "./index";
import {
  CATEGORIAS,
  abrirArnes,
  falla,
  fijarCategoriasDelCliente,
  pruebasTraduccion,
  sembrarCiiu,
  type Arnes,
} from "./soporte-prueba";

let h: Arnes;

beforeAll(async () => {
  h = await abrirArnes();
}, 60_000);

afterAll(async () => {
  await h?.cerrar();
});

const leer = (clienteId: string, e = h.A) =>
  h.comoDueno((tx) => leerCategoriasCliente(tx, clienteId), e);

const fijar = (
  clienteId: string,
  permitidas: string[],
  quitadas: string[],
  version: number,
  e = h.A,
) =>
  h.comoDueno(
    (tx) =>
      fijarCategoriasCliente(tx, { clienteId, permitidas, quitadas, version }),
    e,
  );

const ordenado = (xs: string[]) => [...xs].sort();

describe("leerCategoriasCliente (R-13)", () => {
  it("cliente sin ajuste ni CIIU: listas vacías, versión 0 y ciiu null", async () => {
    const c = await h.A.nuevoCliente();
    expect(await leer(c.id)).toEqual({
      ciiu: null,
      permitidas: [],
      quitadas: [],
      version: 0,
    });
  });

  it("con el ajuste del estudio y la CIIU de la caché", async () => {
    const c = await h.A.nuevoCliente();
    await fijarCategoriasDelCliente(
      h.admin,
      h.A,
      c,
      ["calzado-ropa"],
      ["juguetes", "entretenimiento"],
      3,
    );
    await sembrarCiiu(h.admin, h.A, c.ruc, "4752");
    const v = await leer(c.id);
    expect(v).toMatchObject({
      ciiu: "4752",
      permitidas: ["calzado-ropa"],
      version: 3,
    });
    expect(ordenado(v!.quitadas)).toEqual(["entretenimiento", "juguetes"]);
  });

  it("CIIU «sin dato» sale null", async () => {
    const c = await h.A.nuevoCliente();
    await sembrarCiiu(h.admin, h.A, c.ruc, null);
    expect((await leer(c.id))!.ciiu).toBeNull();
  });

  it("cada cliente tiene su ajuste", async () => {
    const c1 = await h.A.nuevoCliente();
    const c2 = await h.A.nuevoCliente();
    await fijarCategoriasDelCliente(h.admin, h.A, c1, ["juguetes"], []);
    expect((await leer(c2.id))!.permitidas).toEqual([]);
  });

  it("null: cliente de otro estudio, inexistente o con id mal formado", async () => {
    const deB = await h.B.nuevoCliente();
    await fijarCategoriasDelCliente(h.admin, h.B, deB, ["juguetes"], []);
    expect(await leer(deB.id, h.A)).toBeNull();
    expect(await leer(randomUUID())).toBeNull();
    expect(await leer("no-es-un-uuid")).toBeNull();
    expect(await leer(deB.id, h.B)).not.toBeNull();
  });

  it("un cliente archivado se puede leer", async () => {
    expect(await leer(h.A.archivado.id)).toMatchObject({
      permitidas: [],
      quitadas: [],
      version: 0,
    });
  });
});

describe("fijarCategoriasCliente (R-13, CA-8)", () => {
  it("primera vez con versión 0 devuelve 1 y la lectura trae lo fijado; luego 2 con la 1 (reemplaza ambas listas)", async () => {
    const c = await h.A.nuevoCliente();
    expect(
      await fijar(c.id, ["calzado-ropa", "juguetes"], ["entretenimiento"], 0),
    ).toBe(1);
    const v1 = await leer(c.id);
    expect(ordenado(v1!.permitidas)).toEqual(["calzado-ropa", "juguetes"]);
    expect(v1!.quitadas).toEqual(["entretenimiento"]);
    expect(v1!.version).toBe(1);
    expect(await fijar(c.id, [], ["juguetes"], 1)).toBe(2);
    expect(await leer(c.id)).toMatchObject({
      permitidas: [],
      quitadas: ["juguetes"],
      version: 2,
    });
  });

  it("acepta las seis categorías y las listas vacías", async () => {
    const c = await h.A.nuevoCliente();
    expect(await fijar(c.id, [...CATEGORIAS], [], 0)).toBe(1);
    expect(ordenado((await leer(c.id))!.permitidas)).toEqual(
      ordenado([...CATEGORIAS]),
    );
    expect(await fijar(c.id, [], [], 1)).toBe(2);
    expect(await leer(c.id)).toMatchObject({
      permitidas: [],
      quitadas: [],
      version: 2,
    });
  });

  it("versión distinta de la vigente -> CA409 y no cambia", async () => {
    const c = await h.A.nuevoCliente();
    await fijar(c.id, ["juguetes"], [], 0);
    expect((await falla(fijar(c.id, ["calzado-ropa"], [], 0))).codigo).toBe(
      "CA409",
    );
    expect((await falla(fijar(c.id, ["calzado-ropa"], [], 7))).codigo).toBe(
      "CA409",
    );
    expect(await leer(c.id)).toMatchObject({
      permitidas: ["juguetes"],
      version: 1,
    });
  });

  it("cliente archivado -> 55000 y no deja ninguna fila", async () => {
    const r = await falla(fijar(h.A.archivado.id, ["juguetes"], [], 0));
    expect(r.codigo).toBe("55000");
    expect(await leer(h.A.archivado.id)).toMatchObject({
      permitidas: [],
      version: 0,
    });
    const n = await h.admin.query(
      "select count(*)::int as n from gnd_cliente_categorias where cliente_id = $1",
      [h.A.archivado.id],
    );
    expect(n.rows[0].n).toBe(0);
  });

  it("cliente de otro estudio, inexistente o mal formado -> P0002", async () => {
    const deB = await h.B.nuevoCliente();
    expect((await falla(fijar(deB.id, ["juguetes"], [], 0))).codigo).toBe(
      "P0002",
    );
    expect((await falla(fijar(randomUUID(), ["juguetes"], [], 0))).codigo).toBe(
      "P0002",
    );
    expect(
      (await falla(fijar("no-es-un-uuid", ["juguetes"], [], 0))).codigo,
    ).toBe("P0002");
    const n = await h.admin.query(
      "select count(*)::int as n from gnd_cliente_categorias where cliente_id = $1",
      [deB.id],
    );
    expect(n.rows[0].n).toBe(0);
  });

  it.each([
    ["categoría fuera de las 6 en permitidas", ["armas"], []],
    ["categoría fuera de las 6 en quitadas", [], ["armas"]],
    ["categoría repetida en permitidas", ["juguetes", "juguetes"], []],
    ["categoría repetida en quitadas", [], ["juguetes", "juguetes"]],
    [
      "la misma categoría en ambas listas",
      ["juguetes", "calzado-ropa"],
      ["juguetes"],
    ],
    ["categoría vacía", [""], []],
    ["categoría en mayúsculas", ["Juguetes"], []],
  ])("%s -> 22023 y no guarda nada", async (_n, permitidas, quitadas) => {
    const c = await h.A.nuevoCliente();
    expect((await falla(fijar(c.id, permitidas, quitadas, 0))).codigo).toBe(
      "22023",
    );
    expect(await leer(c.id)).toMatchObject({
      permitidas: [],
      quitadas: [],
      version: 0,
    });
  });

  it.each([-1, 1.5, Number.NaN])("versión %s -> 22023", async (version) => {
    const c = await h.A.nuevoCliente();
    expect((await falla(fijar(c.id, ["juguetes"], [], version))).codigo).toBe(
      "22023",
    );
  });

  it("sin usuario -> 42501", async () => {
    const c = await h.A.nuevoCliente();
    const r = await falla(
      h.sinUsuario((tx) =>
        fijarCategoriasCliente(tx, {
          clienteId: c.id,
          permitidas: [],
          quitadas: [],
          version: 0,
        }),
      ),
    );
    expect(r.codigo).toBe("42501");
  });

  it("el worker no escribe -> 42501", async () => {
    const c = await h.A.nuevoCliente();
    const r = await falla(
      h.comoWorker((tx) =>
        fijarCategoriasCliente(tx, {
          clienteId: c.id,
          permitidas: [],
          quitadas: [],
          version: 0,
        }),
      ),
    );
    expect(r.codigo).toBe("42501");
  });
});

pruebasTraduccion([
  ["leerCategoriasCliente", (tx) => leerCategoriasCliente(tx, randomUUID())],
  [
    "fijarCategoriasCliente",
    (tx) =>
      fijarCategoriasCliente(tx, {
        clienteId: randomUUID(),
        permitidas: ["calzado-ropa"],
        quitadas: [],
        version: 0,
      }),
  ],
]);
