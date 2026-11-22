// Spec 027 (T4, rojo): repositorio de «aprender estas palabras» al excluir una compra con XML (R-7, CA-9, CA-14, CA-16). Contra la BD real
// con el backend (con y sin usuario), más una `tx` falsa para la traducción de errores. Necesita DATABASE_URL y MIGRATIONS_DATABASE_URL:
// si faltan, FALLA (no se salta).
//
// CONTRATO que fijan estas pruebas (lo implementa T10 en `packages/db/src/gastos/aprender.ts`; llama a `gnd_aprender`):
//   aprender(tx, {clienteId, compraId, terminos: {termino, categoria}[]}) -> {guardadas: string[], omitidas: string[]}
//       Guarda cada término nuevo como propia activa con origen `aprendida`, versión 1, el usuario de la sesión y la compra de origen.
//       Un término que ya es una propia del estudio (activa o desactivada) se omite y se informa. Ambas listas con las palabras en el
//       orden recibido. Todo o nada: si algo falla no queda ninguna palabra.
//   Errores (GastosRepoError.codigo): P0002 cliente o compra ajenos, inexistentes o mal formados (la compra debe ser del cliente),
//       55000 cliente archivado, CA422 la versión vigente de la compra no está excluida, CA423 la compra no tiene XML vigente,
//       CA421 si las nuevas pasan de 2.000 activas, 22023 (ningún término o más de 10, término fuera de ^[a-z0-9]{3,40}$, categoría fuera
//       de las 6), 42501 sin usuario.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aprender, leerGastosEstudio } from "./index";
import {
  PROVEEDOR,
  abrirArnes,
  falla,
  pruebasTraduccion,
  sembrarCompra,
  sembrarPropia,
  sembrarPropiasEnBloque,
  sembrarXml,
  type Arnes,
  type ClienteSembrado,
  type Estudio,
} from "./soporte-prueba";

let h: Arnes;

beforeAll(async () => {
  h = await abrirArnes();
}, 60_000);

afterAll(async () => {
  await h?.cerrar();
});

const PERIODO = "202610";
const GLOSA = "AUDIFONOS BLUETOOTH JBL X2 UND 2.00";

/** Compra excluida (versión vigente) con XML vigente: el caso de CA-9. */
async function compraExcluidaConXml(e: Estudio = h.A, c?: ClienteSembrado) {
  const cliente = c ?? (await e.nuevoCliente());
  const compra = await sembrarCompra(h.admin, e, cliente, {
    periodo: PERIODO,
    versiones: [false, true],
  });
  await sembrarXml(h.admin, e, cliente, compra, [GLOSA]);
  return { cliente, compra };
}

const termino = (t: string, categoria = "entretenimiento") => ({
  termino: t,
  categoria,
});

const guardar = (
  clienteId: string,
  compraId: string,
  terminos: { termino: string; categoria: string }[],
  e = h.A,
) => h.comoDueno((tx) => aprender(tx, { clienteId, compraId, terminos }), e);

const propias = async (e = h.A) =>
  (await h.comoDueno((tx) => leerGastosEstudio(tx), e)).propias;

describe("aprender: guardado (R-7, CA-9)", () => {
  it("guarda como propias «aprendidas» con el usuario, la compra de origen, versión 1 y activas", async () => {
    const e = await h.nuevoEstudio();
    const { cliente, compra } = await compraExcluidaConXml(e);
    const r = await guardar(
      cliente.id,
      compra.id,
      [termino("audifonos"), termino("bluetooth", "juguetes")],
      e,
    );
    expect(r).toEqual({ guardadas: ["audifonos", "bluetooth"], omitidas: [] });
    const lista = await propias(e);
    expect(lista).toHaveLength(2);
    expect(lista[0]).toMatchObject({
      palabra: "audifonos",
      categoria: "entretenimiento",
      origen: "aprendida",
      activa: true,
      version: 1,
      compraOrigenId: compra.id,
      excepciones: [],
      autor: { id: e.dueno.id, nombre: e.dueno.nombre },
    });
    expect(lista[1]).toMatchObject({
      palabra: "bluetooth",
      categoria: "juguetes",
      origen: "aprendida",
    });
  });

  it("un término ya propio (activo o desactivado) se omite y se informa; los nuevos se guardan", async () => {
    const e = await h.nuevoEstudio();
    const { cliente, compra } = await compraExcluidaConXml(e);
    await sembrarPropia(h.admin, e, {
      palabra: "audifonos",
      categoria: "juguetes",
    });
    await sembrarPropia(h.admin, e, {
      palabra: "jbl",
      categoria: "juguetes",
      activa: false,
    });
    const r = await guardar(
      cliente.id,
      compra.id,
      [termino("audifonos"), termino("bluetooth"), termino("jbl")],
      e,
    );
    expect(r).toEqual({
      guardadas: ["bluetooth"],
      omitidas: ["audifonos", "jbl"],
    });
    const lista = await propias(e);
    expect(lista.map((p) => p.palabra)).toEqual([
      "audifonos",
      "bluetooth",
      "jbl",
    ]);
    // la existente no cambia de categoría ni de origen
    expect(lista[0]).toMatchObject({
      categoria: "juguetes",
      origen: "manual",
      version: 1,
    });
    expect(lista[2]).toMatchObject({ activa: false, origen: "manual" });
  });

  it("todos omitidos: no es un error; guardadas queda vacía", async () => {
    const e = await h.nuevoEstudio();
    const { cliente, compra } = await compraExcluidaConXml(e);
    await sembrarPropia(h.admin, e, { palabra: "audifonos" });
    expect(
      await guardar(cliente.id, compra.id, [termino("audifonos")], e),
    ).toEqual({
      guardadas: [],
      omitidas: ["audifonos"],
    });
  });

  it("dos veces la misma llamada: la segunda omite todo (nada se duplica)", async () => {
    const e = await h.nuevoEstudio();
    const { cliente, compra } = await compraExcluidaConXml(e);
    await guardar(
      cliente.id,
      compra.id,
      [termino("audifonos"), termino("jbl")],
      e,
    );
    const r = await guardar(
      cliente.id,
      compra.id,
      [termino("audifonos"), termino("jbl")],
      e,
    );
    expect(r).toEqual({ guardadas: [], omitidas: ["audifonos", "jbl"] });
    expect(await propias(e)).toHaveLength(2);
  });

  it("acepta 1 y 10 términos", async () => {
    const e = await h.nuevoEstudio();
    const { cliente, compra } = await compraExcluidaConXml(e);
    const diez = Array.from({ length: 10 }, (_, i) => termino(`termino${i}`));
    expect(
      (await guardar(cliente.id, compra.id, diez, e)).guardadas,
    ).toHaveLength(10);
    const e2 = await h.nuevoEstudio();
    const x = await compraExcluidaConXml(e2);
    expect(
      (await guardar(x.cliente.id, x.compra.id, [termino("unico")], e2))
        .guardadas,
    ).toEqual(["unico"]);
  });

  it("mismo término en otro estudio no choca", async () => {
    const e1 = await h.nuevoEstudio();
    const e2 = await h.nuevoEstudio();
    const a = await compraExcluidaConXml(e1);
    const b = await compraExcluidaConXml(e2);
    await guardar(a.cliente.id, a.compra.id, [termino("audifonos")], e1);
    expect(
      (await guardar(b.cliente.id, b.compra.id, [termino("audifonos")], e2))
        .guardadas,
    ).toEqual(["audifonos"]);
  });
});

describe("aprender: precondiciones (R-7)", () => {
  it("compra no excluida (versión vigente sin excluir) -> CA422 y no guarda nada", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    const compra = await sembrarCompra(h.admin, e, c, { periodo: PERIODO });
    await sembrarXml(h.admin, e, c, compra, [GLOSA]);
    expect(
      (await falla(guardar(c.id, compra.id, [termino("audifonos")], e))).codigo,
    ).toBe("CA422");
    expect(await propias(e)).toEqual([]);
  });

  it("excluida y luego restaurada (vigente sin excluir) -> CA422", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    const compra = await sembrarCompra(h.admin, e, c, {
      periodo: PERIODO,
      versiones: [false, true, false],
    });
    await sembrarXml(h.admin, e, c, compra, [GLOSA]);
    expect(
      (await falla(guardar(c.id, compra.id, [termino("audifonos")], e))).codigo,
    ).toBe("CA422");
  });

  it("excluida solo en una versión anterior al puntero (deshacer) -> CA422; excluida con puntero atrás en la excluida sí", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    const noExcluida = await sembrarCompra(h.admin, e, c, {
      periodo: PERIODO,
      versiones: [false, true],
      vigente: 1,
    });
    await sembrarXml(h.admin, e, c, noExcluida, [GLOSA]);
    expect(
      (await falla(guardar(c.id, noExcluida.id, [termino("audifonos")], e)))
        .codigo,
    ).toBe("CA422");
    const excluida = await sembrarCompra(h.admin, e, c, {
      periodo: PERIODO,
      versiones: [true, false],
      vigente: 1,
    });
    await sembrarXml(h.admin, e, c, excluida, [GLOSA]);
    expect(
      (await guardar(c.id, excluida.id, [termino("audifonos")], e)).guardadas,
    ).toEqual(["audifonos"]);
  });

  it("compra excluida sin XML -> CA423 y no guarda nada", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    const compra = await sembrarCompra(h.admin, e, c, {
      periodo: PERIODO,
      versiones: [false, true],
    });
    expect(
      (await falla(guardar(c.id, compra.id, [termino("audifonos")], e))).codigo,
    ).toBe("CA423");
    expect(await propias(e)).toEqual([]);
  });

  it("compra de otro cliente del mismo estudio, de otro estudio, inexistente o mal formada -> P0002", async () => {
    const e = await h.nuevoEstudio();
    const { cliente, compra } = await compraExcluidaConXml(e);
    const otroCliente = await e.nuevoCliente();
    expect(
      (
        await falla(
          guardar(otroCliente.id, compra.id, [termino("audifonos")], e),
        )
      ).codigo,
    ).toBe("P0002");
    const deB = await compraExcluidaConXml(h.B);
    expect(
      (
        await falla(
          guardar(cliente.id, deB.compra.id, [termino("audifonos")], e),
        )
      ).codigo,
    ).toBe("P0002");
    expect(
      (
        await falla(
          guardar(deB.cliente.id, deB.compra.id, [termino("audifonos")], e),
        )
      ).codigo,
    ).toBe("P0002");
    expect(
      (
        await falla(
          guardar(cliente.id, randomUUID(), [termino("audifonos")], e),
        )
      ).codigo,
    ).toBe("P0002");
    expect(
      (
        await falla(
          guardar(cliente.id, "no-es-un-uuid", [termino("audifonos")], e),
        )
      ).codigo,
    ).toBe("P0002");
    expect(
      (await falla(guardar(randomUUID(), compra.id, [termino("audifonos")], e)))
        .codigo,
    ).toBe("P0002");
    expect(await propias(e)).toEqual([]);
    expect(await propias(h.B)).not.toContainEqual(
      expect.objectContaining({ palabra: "audifonos", origen: "aprendida" }),
    );
  });

  it("compra descartada -> P0002", async () => {
    const e = await h.nuevoEstudio();
    const c = await e.nuevoCliente();
    const compra = await sembrarCompra(h.admin, e, c, {
      periodo: PERIODO,
      versiones: [false, true],
      descartada: true,
    });
    await sembrarXml(h.admin, e, c, compra, [GLOSA]);
    expect(
      (await falla(guardar(c.id, compra.id, [termino("audifonos")], e))).codigo,
    ).toBe("P0002");
  });

  it("cliente archivado -> 55000 y no guarda nada", async () => {
    const e = await h.nuevoEstudio();
    const compra = await sembrarCompra(h.admin, e, e.archivado, {
      periodo: PERIODO,
      versiones: [false, true],
    });
    await sembrarXml(h.admin, e, e.archivado, compra, [GLOSA]);
    expect(
      (
        await falla(
          guardar(e.archivado.id, compra.id, [termino("audifonos")], e),
        )
      ).codigo,
    ).toBe("55000");
    expect(await propias(e)).toEqual([]);
  });

  it("sin usuario -> 42501; el worker tampoco puede", async () => {
    const e = await h.nuevoEstudio();
    const { cliente, compra } = await compraExcluidaConXml(e);
    const args = {
      clienteId: cliente.id,
      compraId: compra.id,
      terminos: [termino("audifonos")],
    };
    expect(
      (await falla(h.sinUsuario((tx) => aprender(tx, args), e))).codigo,
    ).toBe("42501");
    expect(
      (await falla(h.comoWorker((tx) => aprender(tx, args), e))).codigo,
    ).toBe("42501");
    expect(await propias(e)).toEqual([]);
  });
});

describe("aprender: términos inválidos no guardan nada (R-7, CA-9)", () => {
  const diez = Array.from({ length: 10 }, (_, i) => termino(`valido${i}`));
  it.each([
    ["ningún término", []],
    ["11 términos", [...diez, termino("undecimo")]],
    ["término con espacio", [termino("audifonos"), termino("dos palabras")]],
    ["término de 2 letras", [termino("audifonos"), termino("ab")]],
    ["término de 41 letras", [termino("audifonos"), termino("a".repeat(41))]],
    ["término con mayúsculas", [termino("audifonos"), termino("Bluetooth")]],
    ["término con símbolos", [termino("audifonos"), termino("jbl-x2")]],
    ["término vacío", [termino("")]],
    [
      "categoría fuera de las 6",
      [termino("audifonos"), termino("bluetooth", "armas")],
    ],
    ["categoría vacía", [termino("audifonos", "")]],
  ])("%s -> 22023", async (_n, terminos) => {
    const e = await h.nuevoEstudio();
    const { cliente, compra } = await compraExcluidaConXml(e);
    expect(
      (await falla(guardar(cliente.id, compra.id, terminos, e))).codigo,
    ).toBe("22023");
    expect(await propias(e)).toEqual([]);
  });
});

describe("aprender: límite de 2.000 (R-6)", () => {
  it("si las nuevas pasan de 2.000 activas -> CA421 y no se guarda NINGUNA (todo o nada)", async () => {
    const e = await h.nuevoEstudio();
    const { cliente, compra } = await compraExcluidaConXml(e);
    await sembrarPropiasEnBloque(h.admin, e, 1999);
    expect(
      (
        await falla(
          guardar(
            cliente.id,
            compra.id,
            [termino("primera"), termino("segunda")],
            e,
          ),
        )
      ).codigo,
    ).toBe("CA421");
    const lista = await propias(e);
    expect(lista).toHaveLength(1999);
    expect(
      lista.some((p) => p.palabra === "primera" || p.palabra === "segunda"),
    ).toBe(false);
  }, 60_000);

  it("con 1.999 activas entra una; las omitidas no cuentan para el límite", async () => {
    const e = await h.nuevoEstudio();
    const { cliente, compra } = await compraExcluidaConXml(e);
    await sembrarPropiasEnBloque(h.admin, e, 1999);
    const r = await guardar(
      cliente.id,
      compra.id,
      [termino("lim1"), termino("laentra")],
      e,
    ); // «lim1» ya existe
    expect(r).toEqual({ guardadas: ["laentra"], omitidas: ["lim1"] });
    expect(await propias(e)).toHaveLength(2000);
  }, 60_000);
});

describe("aprender: sin efectos en otras tablas", () => {
  it("no cambia la compra, su XML ni el umbral: solo agrega propias (y la auditoría)", async () => {
    const e = await h.nuevoEstudio();
    const { cliente, compra } = await compraExcluidaConXml(e);
    const antes = await h.admin.query(
      `select (select count(*) from compra_version where compra_id = $1)::int as versiones,
              (select version_vigente from compra where id = $1) as vigente,
              (select count(*) from documento_xml where tenant_id = $2)::int as xml,
              (select count(*) from gnd_config where tenant_id = $2)::int as config`,
      [compra.id, e.tenantId],
    );
    await guardar(cliente.id, compra.id, [termino("audifonos")], e);
    const despues = await h.admin.query(
      `select (select count(*) from compra_version where compra_id = $1)::int as versiones,
              (select version_vigente from compra where id = $1) as vigente,
              (select count(*) from documento_xml where tenant_id = $2)::int as xml,
              (select count(*) from gnd_config where tenant_id = $2)::int as config`,
      [compra.id, e.tenantId],
    );
    expect(despues.rows[0]).toEqual(antes.rows[0]);
  });

  it("PROVEEDOR de prueba conocido: la glosa original no se copia en ninguna fila de propias", async () => {
    const e = await h.nuevoEstudio();
    const { cliente, compra } = await compraExcluidaConXml(e);
    await guardar(cliente.id, compra.id, [termino("audifonos")], e);
    const filas = await h.admin.query(
      "select to_jsonb(p)::text as t from gnd_palabra_estudio p where tenant_id = $1",
      [e.tenantId],
    );
    for (const f of filas.rows as Array<{ t: string }>) {
      expect(f.t).not.toContain(GLOSA);
      expect(f.t).not.toContain(PROVEEDOR.numero);
    }
  });
});

pruebasTraduccion([
  [
    "aprender",
    (tx) =>
      aprender(tx, {
        clienteId: randomUUID(),
        compraId: randomUUID(),
        terminos: [termino("audifonos")],
      }),
  ],
]);
