// Spec 027 (T4, rojo): repositorio del diccionario del estudio, el umbral y las globales desactivadas (R-6, R-11, R-12, R-13; CA-7, CA-10,
// CA-16). Contra la BD real con el backend (con y sin usuario), más una `tx` falsa para la traducción de errores. Necesita DATABASE_URL y
// MIGRATIONS_DATABASE_URL: si faltan, FALLA (no se salta).
// T16 (H-027-1-1, decisión 2026-11-23): agregar una palabra cuya otra forma (+s / +es) ya existe en el estudio es CA420, como la exacta.
//
// CONTRATO que fijan estas pruebas (lo implementa T10 en `packages/db/src/gastos/diccionario.ts`; llama a las funciones de 0070):
//   leerGastosEstudio(tx) -> {umbral (3 sin fila), versionUmbral (0 sin fila), activasPropias, globales, propias}
//       globales: las ACTIVAS de la plataforma por palabra, con `desactivadaPorEstudio`; propias: activas e inactivas por palabra, con
//       `autor {id, nombre}`, `origen`, `compraOrigenId` (null si manual) y `creadaEn` (Date); solo las del estudio de la sesión.
//   agregarPalabra(tx, {palabra, categoria, excepciones?}) -> id (uuid)                       `gnd_palabra_agregar`; nace activa, versión 1
//   cambiarEstadoPalabra(tx, {id, activa, version}) -> versión nueva (= version + 1)         `gnd_palabra_estado`
//   cambiarEstadoGlobal(tx, {palabraGlobalId, activa}) -> void                                `gnd_global_estado`
//   fijarUmbral(tx, {umbral, version}) -> versión nueva                                       `gnd_umbral_fijar`; `version` 0 si nunca se fijó
//   Errores (GastosRepoError.codigo): P0002 id ajeno, inexistente o mal formado (sin ir a la BD), 55000 cliente archivado, CA409 versión
//       distinta, CA420 palabra existente, CA421 límite de 2.000 activas, 22023 argumento inválido, 42501 sin estudio o sin usuario.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agregarPalabra,
  cambiarEstadoGlobal,
  cambiarEstadoPalabra,
  fijarUmbral,
  leerGastosEstudio,
} from "./index";
import {
  UUID,
  abrirArnes,
  desactivarGlobalDelEstudio,
  falla,
  fijarConfig,
  idGlobal,
  palabraUnica,
  pruebasTraduccion,
  sembrarPropia,
  sembrarPropiasEnBloque,
  type Arnes,
} from "./soporte-prueba";

let h: Arnes;

beforeAll(async () => {
  h = await abrirArnes();
}, 60_000);

afterAll(async () => {
  await h?.cerrar();
});

const vista = (e = h.A) => h.comoDueno((tx) => leerGastosEstudio(tx), e);

const agregar = (
  palabra: string,
  categoria = "juguetes",
  excepciones?: string[],
  e = h.A,
) =>
  h.comoDueno(
    (tx) =>
      agregarPalabra(tx, {
        palabra,
        categoria,
        ...(excepciones === undefined ? {} : { excepciones }),
      }),
    e,
  );

const estado = (id: string, activa: boolean, version: number, e = h.A) =>
  h.comoDueno((tx) => cambiarEstadoPalabra(tx, { id, activa, version }), e);

describe("leerGastosEstudio (R-6, R-12)", () => {
  it("estudio sin nada: umbral 3 versión 0, ninguna propia y las globales de la semilla activas para él", async () => {
    const e = await h.nuevoEstudio();
    const v = await vista(e);
    expect(v).toMatchObject({
      umbral: 3,
      versionUmbral: 0,
      activasPropias: 0,
      propias: [],
    });
    expect(v.globales.length).toBeGreaterThanOrEqual(72);
    expect(v.globales.every((g) => g.desactivadaPorEstudio === false)).toBe(
      true,
    );
    const zapatilla = v.globales.find((g) => g.palabra === "zapatilla");
    expect(zapatilla).toMatchObject({ categoria: "calzado-ropa" });
    expect(zapatilla!.id).toMatch(UUID);
    expect(zapatilla!.excepciones).toEqual(
      expect.arrayContaining(["seguridad", "punta de acero"]),
    );
    const palabras = v.globales.map((g) => g.palabra);
    expect([...palabras].sort()).toEqual(palabras);
  });

  it("propias: activas e inactivas por palabra, con origen, autor, versión y fecha; cuenta solo las activas", async () => {
    const e = await h.nuevoEstudio();
    await sembrarPropia(h.admin, e, {
      palabra: "bbb",
      categoria: "juguetes",
      excepciones: ["x y"],
      version: 3,
    });
    await sembrarPropia(h.admin, e, {
      palabra: "aaa",
      categoria: "entretenimiento",
      activa: false,
    });
    await sembrarPropia(h.admin, e, {
      palabra: "ccc",
      categoria: "cuidado-personal",
    });
    const v = await vista(e);
    expect(v.activasPropias).toBe(2);
    expect(v.propias.map((p) => p.palabra)).toEqual(["aaa", "bbb", "ccc"]);
    expect(v.propias[1]).toMatchObject({
      palabra: "bbb",
      categoria: "juguetes",
      excepciones: ["x y"],
      origen: "manual",
      activa: true,
      version: 3,
      compraOrigenId: null,
      autor: { id: e.dueno.id, nombre: e.dueno.nombre },
    });
    expect(v.propias[1]!.id).toMatch(UUID);
    expect(v.propias[1]!.creadaEn).toBeInstanceOf(Date);
    expect(v.propias[0]).toMatchObject({ activa: false });
  });

  it("umbral y su versión", async () => {
    const e = await h.nuevoEstudio();
    await fijarConfig(h.admin, e, 9, 4);
    expect(await vista(e)).toMatchObject({ umbral: 9, versionUmbral: 4 });
  });

  it("globales desactivadas por el estudio se marcan; las del otro estudio no", async () => {
    const e = await h.nuevoEstudio();
    const idCerveza = await idGlobal(h.admin, "cerveza");
    await desactivarGlobalDelEstudio(h.admin, e, idCerveza);
    const v = await vista(e);
    expect(
      v.globales.find((g) => g.palabra === "cerveza")?.desactivadaPorEstudio,
    ).toBe(true);
    expect(
      v.globales.find((g) => g.palabra === "vino")?.desactivadaPorEstudio,
    ).toBe(false);
    const otro = await vista(h.B);
    expect(
      otro.globales.find((g) => g.palabra === "cerveza")?.desactivadaPorEstudio,
    ).toBe(false);
  });

  it("A no ve las propias de B ni B las de A (RLS)", async () => {
    const pa = palabraUnica();
    const pb = palabraUnica();
    await sembrarPropia(h.admin, h.A, { palabra: pa });
    await sembrarPropia(h.admin, h.B, { palabra: pb });
    const a = (await vista(h.A)).propias.map((p) => p.palabra);
    const b = (await vista(h.B)).propias.map((p) => p.palabra);
    expect(a).toContain(pa);
    expect(a).not.toContain(pb);
    expect(b).toContain(pb);
    expect(b).not.toContain(pa);
  });
});

describe("agregarPalabra (R-6, CA-7)", () => {
  it("devuelve el id de la palabra nueva: activa, versión 1, origen manual, con su autor y excepciones", async () => {
    const e = await h.nuevoEstudio();
    const palabra = palabraUnica();
    const id = await agregar(
      palabra,
      "entretenimiento",
      ["ejemplo uno", "dos"],
      e,
    );
    expect(id).toMatch(UUID);
    const v = await vista(e);
    expect(v.propias).toEqual([
      expect.objectContaining({
        id,
        palabra,
        categoria: "entretenimiento",
        excepciones: ["ejemplo uno", "dos"],
        origen: "manual",
        activa: true,
        version: 1,
        compraOrigenId: null,
        autor: { id: e.dueno.id, nombre: e.dueno.nombre },
      }),
    ]);
    expect(v.activasPropias).toBe(1);
  });

  it("sin excepciones queda un arreglo vacío", async () => {
    const e = await h.nuevoEstudio();
    await agregar("sinexcep", "juguetes", undefined, e);
    expect((await vista(e)).propias[0]!.excepciones).toEqual([]);
  });

  it("la misma palabra en otro estudio es otra fila (no choca)", async () => {
    const palabra = palabraUnica();
    await agregar(palabra, "juguetes", undefined, h.A);
    await expect(agregar(palabra, "juguetes", undefined, h.B)).resolves.toMatch(
      UUID,
    );
  });

  it("palabra existente en el estudio (activa o desactivada) -> CA420", async () => {
    const e = await h.nuevoEstudio();
    await sembrarPropia(h.admin, e, { palabra: "repetida" });
    await sembrarPropia(h.admin, e, { palabra: "apagada", activa: false });
    expect(
      (await falla(agregar("repetida", "juguetes", undefined, e))).codigo,
    ).toBe("CA420");
    expect(
      (await falla(agregar("apagada", "entretenimiento", undefined, e))).codigo,
    ).toBe("CA420");
    expect((await vista(e)).propias).toHaveLength(2);
  });

  it.each([
    ["palabra con espacio", "dos palabras", "juguetes", []],
    ["palabra de 2 letras", "ab", "juguetes", []],
    ["palabra de 41 letras", "a".repeat(41), "juguetes", []],
    ["palabra con mayúsculas", "Zapatilla", "juguetes", []],
    ["palabra con tilde", "camión", "juguetes", []],
    ["palabra vacía", "", "juguetes", []],
    ["categoría fuera de las 6", "valida1", "armas", []],
    ["categoría vacía", "valida2", "", []],
    [
      "más de 5 excepciones",
      "valida3",
      "juguetes",
      ["a", "b", "c", "d", "e", "f"],
    ],
    ["excepción de 4 palabras", "valida4", "juguetes", ["uno dos tres cuatro"]],
    ["excepción vacía", "valida5", "juguetes", [""]],
  ])(
    "argumento inválido (%s) -> 22023 y no guarda nada",
    async (_n, palabra, categoria, excepciones) => {
      const e = await h.nuevoEstudio();
      expect(
        (await falla(agregar(palabra, categoria, excepciones, e))).codigo,
      ).toBe("22023");
      expect((await vista(e)).propias).toEqual([]);
    },
  );

  it("sin usuario en el contexto -> 42501", async () => {
    const e = await h.nuevoEstudio();
    const r = await falla(
      h.sinUsuario(
        (tx) =>
          agregarPalabra(tx, {
            palabra: palabraUnica(),
            categoria: "juguetes",
          }),
        e,
      ),
    );
    expect(r.codigo).toBe("42501");
  });

  it("el worker no puede agregar palabras -> 42501", async () => {
    const e = await h.nuevoEstudio();
    const r = await falla(
      h.comoWorker(
        (tx) =>
          agregarPalabra(tx, {
            palabra: palabraUnica(),
            categoria: "juguetes",
          }),
        e,
      ),
    );
    expect(r.codigo).toBe("42501");
  });

  it("límite de 2.000 activas: con 1.999 entra la 2.000 y la 2.001 da CA421; las desactivadas no cuentan", async () => {
    const e = await h.nuevoEstudio();
    await sembrarPropiasEnBloque(h.admin, e, 1999);
    await sembrarPropia(h.admin, e, { palabra: "apagadaa", activa: false });
    await expect(
      agregar("laultima", "juguetes", undefined, e),
    ).resolves.toMatch(UUID);
    expect((await vista(e)).activasPropias).toBe(2000);
    expect(
      (await falla(agregar("sobra", "juguetes", undefined, e))).codigo,
    ).toBe("CA421");
    expect((await vista(e)).activasPropias).toBe(2000);
  }, 60_000);
});

describe("cambiarEstadoPalabra (R-6)", () => {
  it("desactivar y reactivar devuelven la versión nueva y la dejan escrita", async () => {
    const e = await h.nuevoEstudio();
    const id = await agregar("cambia", "juguetes", undefined, e);
    expect(await estado(id, false, 1, e)).toBe(2);
    expect((await vista(e)).propias[0]).toMatchObject({
      id,
      activa: false,
      version: 2,
    });
    expect((await vista(e)).activasPropias).toBe(0);
    expect(await estado(id, true, 2, e)).toBe(3);
    expect((await vista(e)).propias[0]).toMatchObject({
      id,
      activa: true,
      version: 3,
    });
  });

  it("versión vieja -> CA409 y no cambia nada", async () => {
    const e = await h.nuevoEstudio();
    const id = await agregar("viejaver", "juguetes", undefined, e);
    await estado(id, false, 1, e);
    expect((await falla(estado(id, true, 1, e))).codigo).toBe("CA409");
    expect((await vista(e)).propias[0]).toMatchObject({
      activa: false,
      version: 2,
    });
  });

  it("id de otro estudio, inexistente o mal formado -> P0002", async () => {
    const e = await h.nuevoEstudio();
    const deB = await sembrarPropia(h.admin, h.B, {});
    expect((await falla(estado(deB.id, false, 1, e))).codigo).toBe("P0002");
    expect((await falla(estado(randomUUID(), false, 1, e))).codigo).toBe(
      "P0002",
    );
    expect((await falla(estado("no-es-un-uuid", false, 1, e))).codigo).toBe(
      "P0002",
    );
    // la fila de B sigue intacta
    expect(
      (await vista(h.B)).propias.find((p) => p.id === deB.id),
    ).toMatchObject({ activa: true, version: 1 });
  });

  it("reactivar con 2.000 activas -> CA421; con 1.999 sí", async () => {
    const e = await h.nuevoEstudio();
    await sembrarPropiasEnBloque(h.admin, e, 1999);
    const apagada = await sembrarPropia(h.admin, e, {
      palabra: "apagadab",
      activa: false,
      version: 4,
    });
    const otra = await sembrarPropia(h.admin, e, {
      palabra: "apagadac",
      activa: false,
      version: 1,
    });
    await expect(estado(apagada.id, true, 4, e)).resolves.toBe(5); // 2.000 activas
    expect((await falla(estado(otra.id, true, 1, e))).codigo).toBe("CA421");
    expect(
      (await vista(e)).propias.find((p) => p.id === otra.id),
    ).toMatchObject({ activa: false, version: 1 });
  }, 60_000);

  it("versión inválida (negativa o no entera) -> 22023", async () => {
    const e = await h.nuevoEstudio();
    const id = await agregar("versionmala", "juguetes", undefined, e);
    expect((await falla(estado(id, false, -1, e))).codigo).toBe("22023");
    expect((await falla(estado(id, false, 1.5, e))).codigo).toBe("22023");
  });

  it("sin usuario -> 42501", async () => {
    const e = await h.nuevoEstudio();
    const id = await agregar("sinusuario", "juguetes", undefined, e);
    const r = await falla(
      h.sinUsuario(
        (tx) => cambiarEstadoPalabra(tx, { id, activa: false, version: 1 }),
        e,
      ),
    );
    expect(r.codigo).toBe("42501");
  });
});

describe("cambiarEstadoGlobal (R-12)", () => {
  const global = (palabraGlobalId: string, activa: boolean, e = h.A) =>
    h.comoDueno(
      (tx) => cambiarEstadoGlobal(tx, { palabraGlobalId, activa }),
      e,
    );

  it("desactivar y reactivar una global para el estudio; no toca la de otro estudio ni la fila global", async () => {
    const e = await h.nuevoEstudio();
    const id = await idGlobal(h.admin, "perfume");
    await expect(global(id, false, e)).resolves.toBeUndefined();
    expect(
      (await vista(e)).globales.find((g) => g.id === id)?.desactivadaPorEstudio,
    ).toBe(true);
    expect(
      (await vista(h.B)).globales.find((g) => g.id === id)
        ?.desactivadaPorEstudio,
    ).toBe(false);
    const fila = await h.admin.query(
      "select activa, version from gnd_palabra_global where id = $1",
      [id],
    );
    expect(fila.rows[0]).toEqual({
      activa: true,
      version: expect.any(Number) as number,
    });
    await expect(global(id, true, e)).resolves.toBeUndefined();
    expect(
      (await vista(e)).globales.find((g) => g.id === id)?.desactivadaPorEstudio,
    ).toBe(false);
  });

  it("global inexistente o mal formada -> P0002", async () => {
    const e = await h.nuevoEstudio();
    expect((await falla(global(randomUUID(), false, e))).codigo).toBe("P0002");
    expect((await falla(global("no-es-un-uuid", false, e))).codigo).toBe(
      "P0002",
    );
  });

  it("sin usuario -> 42501", async () => {
    const e = await h.nuevoEstudio();
    const id = await idGlobal(h.admin, "perfume");
    const r = await falla(
      h.sinUsuario(
        (tx) => cambiarEstadoGlobal(tx, { palabraGlobalId: id, activa: false }),
        e,
      ),
    );
    expect(r.codigo).toBe("42501");
  });
});

describe("fijarUmbral (R-11, CA-10)", () => {
  const fijar = (umbral: number, version: number, e = h.A) =>
    h.comoDueno((tx) => fijarUmbral(tx, { umbral, version }), e);

  it("primera vez con versión 0 devuelve 1; luego 2 con la 1; se lee con su versión", async () => {
    const e = await h.nuevoEstudio();
    expect(await fijar(6, 0, e)).toBe(1);
    expect(await vista(e)).toMatchObject({ umbral: 6, versionUmbral: 1 });
    expect(await fijar(1, 1, e)).toBe(2);
    expect(await vista(e)).toMatchObject({ umbral: 1, versionUmbral: 2 });
    expect(await fijar(20, 2, e)).toBe(3);
    expect(await vista(e)).toMatchObject({ umbral: 20, versionUmbral: 3 });
  });

  it("versión distinta de la vigente -> CA409 y no cambia", async () => {
    const e = await h.nuevoEstudio();
    await fijar(6, 0, e);
    expect((await falla(fijar(7, 0, e))).codigo).toBe("CA409");
    expect((await falla(fijar(7, 5, e))).codigo).toBe("CA409");
    expect(await vista(e)).toMatchObject({ umbral: 6, versionUmbral: 1 });
  });

  it.each([0, 21, -1, 3.5, Number.NaN])(
    "umbral %s -> 22023",
    async (umbral) => {
      const e = await h.nuevoEstudio();
      expect((await falla(fijar(umbral, 0, e))).codigo).toBe("22023");
      expect(await vista(e)).toMatchObject({ umbral: 3, versionUmbral: 0 });
    },
  );

  it("el umbral de un estudio no cambia el del otro", async () => {
    const e = await h.nuevoEstudio();
    await fijar(12, 0, e);
    expect((await vista(h.B)).umbral).toBe(3);
  });

  it("sin usuario -> 42501", async () => {
    const e = await h.nuevoEstudio();
    const r = await falla(
      h.sinUsuario((tx) => fijarUmbral(tx, { umbral: 5, version: 0 }), e),
    );
    expect(r.codigo).toBe("42501");
  });
});

pruebasTraduccion([
  ["leerGastosEstudio", (tx) => leerGastosEstudio(tx)],
  [
    "agregarPalabra",
    (tx) =>
      agregarPalabra(tx, {
        palabra: "zapatilla",
        categoria: "calzado-ropa",
        excepciones: ["seguridad"],
      }),
  ],
  [
    "cambiarEstadoPalabra",
    (tx) =>
      cambiarEstadoPalabra(tx, { id: randomUUID(), activa: false, version: 1 }),
  ],
  [
    "cambiarEstadoGlobal",
    (tx) =>
      cambiarEstadoGlobal(tx, { palabraGlobalId: randomUUID(), activa: false }),
  ],
  ["fijarUmbral", (tx) => fijarUmbral(tx, { umbral: 5, version: 0 })],
]);

// Spec 027 · T16 (rojo; H-027-1-1): `gnd_palabra_agregar` trata la otra forma de una palabra propia (activa o desactivada) como existente.
describe("agregarPalabra: plural en ambos sentidos (T16, H-027-1-1)", () => {
  it.each([
    ["audifonos", "audifono"],
    ["audifono", "audifonos"],
    ["pantalones", "pantalon"],
    ["pantalon", "pantalones"],
  ])("propia «%s» activa: agregar «%s» -> CA420 y no guarda nada", async (existente, otra) => {
    const e = await h.nuevoEstudio();
    await sembrarPropia(h.admin, e, { palabra: existente });
    expect((await falla(agregar(otra, "entretenimiento", undefined, e))).codigo).toBe("CA420");
    expect((await vista(e)).propias.map((p) => p.palabra)).toEqual([existente]);
  });

  it("propia desactivada en la otra forma: también CA420 (desactivada cuenta como existente)", async () => {
    const e = await h.nuevoEstudio();
    await sembrarPropia(h.admin, e, { palabra: "parlantes", activa: false });
    expect((await falla(agregar("parlante", "juguetes", undefined, e))).codigo).toBe("CA420");
    expect((await vista(e)).propias).toHaveLength(1);
  });

  it("no se amplía a raíces ni prefijos: «lapiz» con «lapices», «audifonera» con «audifonos» y «polonia» con «polos» no chocan", async () => {
    const e = await h.nuevoEstudio();
    await sembrarPropia(h.admin, e, { palabra: "lapiz" });
    await sembrarPropia(h.admin, e, { palabra: "audifonos" });
    await sembrarPropia(h.admin, e, { palabra: "polos" });
    for (const palabra of ["lapices", "audifonera", "polonia"]) {
      await expect(agregar(palabra, "juguetes", undefined, e)).resolves.toMatch(UUID);
    }
  });

  it("la otra forma en otro estudio no choca", async () => {
    const e1 = await h.nuevoEstudio();
    const e2 = await h.nuevoEstudio();
    await sembrarPropia(h.admin, e1, { palabra: "audifonos" });
    await expect(agregar("audifono", "juguetes", undefined, e2)).resolves.toMatch(UUID);
  });
});
