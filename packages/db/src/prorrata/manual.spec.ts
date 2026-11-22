// Spec 026 (T4, rojo): repositorio de meses manuales versionados y su historial (R-5, CA-3, CA-4, CA-8, CA-10, D-4). Contra la BD
// real, con el backend (guardar, eliminar y leer) y el worker (solo para sembrar declaraciones), más una `tx` falsa para la
// traducción de errores. Necesita DATABASE_URL y MIGRATIONS_DATABASE_URL: si faltan, FALLA (no se salta).
//
// CONTRATO que fijan estas pruebas (lo implementa T10 en `packages/db/src/prorrata/manual.ts`; llama a las funciones acotadas de 0066):
//   guardarMesManual(tx, {clienteId, periodo, gravadas, exportaciones, noGravadas, motivo, version}) -> versión nueva (= version + 1)
//       `prorrata_mes_manual_guardar`; `version` = última versión del mes (0 si nunca tuvo manual; una «eliminado» también cuenta).
//   eliminarMesManual(tx, {clienteId, periodo, motivo, version}) -> versión nueva    `prorrata_mes_manual_eliminar`
//   leerManuales(tx, clienteId, periodos) -> ManualFila[]   una fila por periodo con historial: la de MAYOR versión, sea `guardado` o
//       `eliminado` (el CAS necesita su versión; el que la usa trata `eliminado` como «sin manual»), ordenadas por periodo.
//       `gravadas`, `exportaciones` y `noGravadas` null si `eliminado`; `autor` {id, nombre}.
//   leerHistorialMes(tx, clienteId, periodo) -> {declaraciones, manual}   todas las presentaciones del periodo (por número de orden) y
//       TODAS las versiones del manual (por versión ascendente, cronológico).
//   Errores (ProrrataRepoError.codigo): P0002 cliente ajeno o inexistente, 55000 archivado, CA409 versión distinta, CA412 mes con
//       declaración, 22023 argumento inválido, 42501 sin usuario.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  eliminarMesManual,
  guardarMesManual,
  leerHistorialMes,
  leerManuales,
} from "./index";
import {
  UUID,
  abrirArnes,
  declaracion,
  falla,
  pruebasTraduccion,
  registrarComoWorker,
  type Arnes,
  type ClienteSembrado,
} from "./soporte-prueba";

let h: Arnes;

beforeAll(async () => {
  h = await abrirArnes();
}, 60_000);

afterAll(async () => {
  await h?.cerrar();
});

const HASTA = "202610";
const montos = (
  gravadas = "1000.00",
  exportaciones = "0.00",
  noGravadas = "250.50",
) => ({
  gravadas,
  exportaciones,
  noGravadas,
});

const guardar = (
  c: ClienteSembrado,
  periodo: string,
  version: number,
  o: Partial<{
    gravadas: string;
    exportaciones: string;
    noGravadas: string;
    motivo: string;
  }> = {},
  e = h.A,
) =>
  h.comoDueno(
    (tx) =>
      guardarMesManual(tx, {
        clienteId: c.id,
        periodo,
        ...montos(o.gravadas, o.exportaciones, o.noGravadas),
        motivo: o.motivo ?? "Sin PDT: ingresado de los libros del cliente",
        version,
      }),
    e,
  );

const eliminar = (
  c: ClienteSembrado,
  periodo: string,
  version: number,
  motivo = "Se declaró en otro mes",
) =>
  h.comoDueno((tx) =>
    eliminarMesManual(tx, { clienteId: c.id, periodo, motivo, version }),
  );

const manuales = (c: ClienteSembrado, periodos: string[], e = h.A) =>
  h.comoDueno((tx) => leerManuales(tx, c.id, periodos), e);

const sinCambios = async (
  c: ClienteSembrado,
  periodo: string,
  versionEsperada: number | null,
): Promise<void> => {
  const m = await manuales(c, [periodo]);
  if (versionEsperada === null) expect(m).toEqual([]);
  else expect(m.map((x) => x.version)).toEqual([versionEsperada]);
};

describe("guardar y leer el manual vigente (CA-4)", () => {
  it("guardar con versión 0 devuelve 1 y deja el mes manual con autor, motivo y fecha", async () => {
    const c = await h.A.nuevoCliente();
    const v = await guardar(c, "202601", 0, {
      gravadas: "12345.67",
      exportaciones: "100.00",
      noGravadas: "0.00",
      motivo: "Ñandú: ventas del libro físico",
    });
    expect(v).toBe(1);
    const [m] = await manuales(c, ["202601"]);
    expect(m).toMatchObject({
      periodo: "202601",
      version: 1,
      accion: "guardado",
      gravadas: "12345.67",
      exportaciones: "100.00",
      noGravadas: "0.00",
      motivo: "Ñandú: ventas del libro físico",
      autor: { id: h.A.dueno.id, nombre: h.A.dueno.nombre },
    });
    expect(m!.creadoEn).toBeInstanceOf(Date);
  });

  it("montos en cero («sin operaciones»), negativos y de 12 dígitos se guardan exactos y con 2 decimales", async () => {
    const c = await h.A.nuevoCliente();
    expect(
      await guardar(c, "202601", 0, {
        gravadas: "0",
        exportaciones: "0.00",
        noGravadas: "0.0",
      }),
    ).toBe(1);
    expect(
      await guardar(c, "202602", 0, {
        gravadas: "-5000.25",
        exportaciones: "0.00",
        noGravadas: "999999999999.99",
      }),
    ).toBe(1);
    const [a, b] = await manuales(c, ["202601", "202602"]);
    expect([a!.gravadas, a!.exportaciones, a!.noGravadas]).toEqual([
      "0.00",
      "0.00",
      "0.00",
    ]);
    expect([b!.gravadas, b!.exportaciones, b!.noGravadas]).toEqual([
      "-5000.25",
      "0.00",
      "999999999999.99",
    ]);
  });

  it("guardar de nuevo con la versión vigente da la siguiente y la vigente es la mayor", async () => {
    const c = await h.A.nuevoCliente();
    expect(await guardar(c, "202601", 0, { gravadas: "1.00" })).toBe(1);
    expect(
      await guardar(c, "202601", 1, { gravadas: "2.00", motivo: "Corregido" }),
    ).toBe(2);
    expect(await guardar(c, "202601", 2, { gravadas: "3.00" })).toBe(3);
    const m = await manuales(c, ["202601"]);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ version: 3, gravadas: "3.00" });
  });

  it("leerManuales trae un manual por periodo con historial, ordenado por periodo, y omite los demás", async () => {
    const c = await h.A.nuevoCliente();
    await guardar(c, "202603", 0, { gravadas: "30.00" });
    await guardar(c, "202601", 0, { gravadas: "10.00" });
    await guardar(c, "202601", 1, { gravadas: "11.00" });
    const m = await manuales(c, ["202601", "202602", "202603", "202604"]);
    expect(m.map((x) => [x.periodo, x.version, x.gravadas])).toEqual([
      ["202601", 2, "11.00"],
      ["202603", 1, "30.00"],
    ]);
    expect(await manuales(c, [])).toEqual([]);
  });

  it("no mezcla clientes ni estudios", async () => {
    const c1 = await h.A.nuevoCliente();
    const c2 = await h.A.nuevoCliente();
    const cb = await h.B.nuevoCliente();
    await guardar(c1, "202601", 0);
    await guardar(cb, "202601", 0, {}, h.B);
    expect(await manuales(c2, ["202601"])).toEqual([]);
    expect(await manuales(cb, ["202601"])).toEqual([]); // el cliente de B visto desde A
    expect(
      await h.comoDueno((tx) => leerManuales(tx, randomUUID(), ["202601"])),
    ).toEqual([]);
    expect(await manuales(cb, ["202601"], h.B)).toHaveLength(1);
  });

  it("un mes con manual no necesita que otro mes lo tenga: las versiones son por periodo", async () => {
    const c = await h.A.nuevoCliente();
    await guardar(c, "202601", 0);
    expect(await guardar(c, "202602", 0)).toBe(1);
  });
});

describe("compare-and-set por versión (CA-4: mes_cambiado)", () => {
  it("una versión vieja, adelantada o 0 con manual vigente: CA409 y nada cambia", async () => {
    const c = await h.A.nuevoCliente();
    await guardar(c, "202601", 0, { gravadas: "1.00" });
    await guardar(c, "202601", 1, { gravadas: "2.00" });
    for (const version of [0, 1, 3, 99]) {
      const e = await falla(
        guardar(c, "202601", version, { gravadas: "999.00" }),
      );
      expect(e.codigo).toBe("CA409");
    }
    const m = await manuales(c, ["202601"]);
    expect(m[0]).toMatchObject({ version: 2, gravadas: "2.00" });
    expect(
      (await h.comoDueno((tx) => leerHistorialMes(tx, c.id, "202601"))).manual,
    ).toHaveLength(2);
  });

  it("guardar con versión 1 cuando nunca hubo manual: CA409", async () => {
    const c = await h.A.nuevoCliente();
    expect((await falla(guardar(c, "202601", 1))).codigo).toBe("CA409");
    await sinCambios(c, "202601", null);
  });

  it("eliminar sin manual vivo o con versión distinta: CA409", async () => {
    const c = await h.A.nuevoCliente();
    expect((await falla(eliminar(c, "202601", 1))).codigo).toBe("CA409"); // nunca hubo
    await guardar(c, "202601", 0);
    expect((await falla(eliminar(c, "202601", 2))).codigo).toBe("CA409"); // versión adelantada
    await sinCambios(c, "202601", 1);
    await eliminar(c, "202601", 1);
    expect((await falla(eliminar(c, "202601", 2))).codigo).toBe("CA409"); // ya eliminado: no hay manual vivo
    await sinCambios(c, "202601", 2);
  });
});

describe("eliminar y volver a guardar (CA-4)", () => {
  it("eliminar devuelve la versión siguiente; la lectura la muestra «eliminado» y sin montos", async () => {
    const c = await h.A.nuevoCliente();
    await guardar(c, "202601", 0);
    const v = await eliminar(c, "202601", 1, "Ya no aplica: llegó el PDT");
    expect(v).toBe(2);
    const [m] = await manuales(c, ["202601"]);
    expect(m).toMatchObject({
      version: 2,
      accion: "eliminado",
      gravadas: null,
      exportaciones: null,
      noGravadas: null,
      motivo: "Ya no aplica: llegó el PDT",
      autor: { id: h.A.dueno.id, nombre: h.A.dueno.nombre },
    });
  });

  it("después de eliminar se vuelve a guardar con la versión de la eliminación, y el historial conserva todo en orden", async () => {
    const c = await h.A.nuevoCliente();
    await guardar(c, "202601", 0, { gravadas: "1.00", motivo: "uno" });
    await guardar(c, "202601", 1, { gravadas: "2.00", motivo: "dos" });
    await eliminar(c, "202601", 2, "tres");
    expect((await falla(guardar(c, "202601", 2))).codigo).toBe("CA409"); // la eliminada también cuenta
    expect(
      await guardar(c, "202601", 3, { gravadas: "4.00", motivo: "cuatro" }),
    ).toBe(4);
    const hist = await h.comoDueno((tx) =>
      leerHistorialMes(tx, c.id, "202601"),
    );
    expect(hist.declaraciones).toEqual([]);
    expect(
      hist.manual.map((x) => [x.version, x.accion, x.gravadas, x.motivo]),
    ).toEqual([
      [1, "guardado", "1.00", "uno"],
      [2, "guardado", "2.00", "dos"],
      [3, "eliminado", null, "tres"],
      [4, "guardado", "4.00", "cuatro"],
    ]);
    for (const x of hist.manual) {
      expect(x.autor).toEqual({ id: h.A.dueno.id, nombre: h.A.dueno.nombre });
      expect(x.creadoEn).toBeInstanceOf(Date);
    }
  });
});

describe("historial del mes", () => {
  it("trae las presentaciones del periodo (por número de orden) y el manual, sin otros periodos ni clientes", async () => {
    const c = await h.A.nuevoCliente();
    const otro = await h.A.nuevoCliente();
    await guardar(c, "202608", 0, { gravadas: "8.00" });
    await guardar(c, "202609", 0, { gravadas: "9.00" });
    await guardar(otro, "202608", 0, { gravadas: "77.00" });
    await registrarComoWorker(h.admin, h.worker, h.A, c, {
      hasta: HASTA,
      declaraciones: [
        declaracion("202609", { numeroOrden: "10", tipo: "rectificatoria" }),
        declaracion("202609", { numeroOrden: "2" }),
        declaracion("202610"),
      ],
    });
    const hist = await h.comoDueno((tx) =>
      leerHistorialMes(tx, c.id, "202609"),
    );
    expect(
      hist.declaraciones.map((d) => [d.periodo, d.numeroOrden, d.tipo]),
    ).toEqual([
      ["202609", "2", "original"],
      ["202609", "10", "rectificatoria"],
    ]);
    for (const d of hist.declaraciones) expect(d.obtencionId).toMatch(UUID);
    expect(hist.manual.map((x) => [x.periodo, x.version, x.gravadas])).toEqual([
      ["202609", 1, "9.00"],
    ]);
  });

  it("un mes sin nada: listas vacías; cliente de otro estudio o inexistente: listas vacías (RLS)", async () => {
    const c = await h.A.nuevoCliente();
    const cb = await h.B.nuevoCliente();
    await guardar(cb, "202601", 0, {}, h.B);
    expect(
      await h.comoDueno((tx) => leerHistorialMes(tx, c.id, "202601")),
    ).toEqual({ declaraciones: [], manual: [] });
    expect(
      await h.comoDueno((tx) => leerHistorialMes(tx, cb.id, "202601")),
    ).toEqual({ declaraciones: [], manual: [] });
    expect(
      await h.comoDueno((tx) => leerHistorialMes(tx, randomUUID(), "202601")),
    ).toEqual({ declaraciones: [], manual: [] });
  });
});

describe("mes con declaración (CA-4: mes_declarado)", () => {
  it("guardar un mes que ya tiene declaración: CA412 y no escribe", async () => {
    const c = await h.A.nuevoCliente();
    await registrarComoWorker(h.admin, h.worker, h.A, c, {
      hasta: HASTA,
      declaraciones: [declaracion("202609")],
    });
    const e = await falla(guardar(c, "202609", 0));
    expect(e.codigo).toBe("CA412");
    await sinCambios(c, "202609", null);
  });

  it("también con una rectificatoria sola o con la versión correcta de un manual previo", async () => {
    const c = await h.A.nuevoCliente();
    await guardar(c, "202609", 0, { gravadas: "1.00" }); // manual primero
    await registrarComoWorker(h.admin, h.worker, h.A, c, {
      hasta: HASTA,
      declaraciones: [
        declaracion("202609", { numeroOrden: "5", tipo: "rectificatoria" }),
      ],
    });
    expect((await falla(guardar(c, "202609", 1))).codigo).toBe("CA412");
    // el manual previo sigue en el historial junto a la declaración (el mes lo muestra «Reemplazado por la declaración»)
    const hist = await h.comoDueno((tx) =>
      leerHistorialMes(tx, c.id, "202609"),
    );
    expect(hist.manual).toHaveLength(1);
    expect(hist.declaraciones).toHaveLength(1);
  });

  it("eliminar el manual de un mes que luego se declaró sigue permitido", async () => {
    const c = await h.A.nuevoCliente();
    await guardar(c, "202609", 0);
    await registrarComoWorker(h.admin, h.worker, h.A, c, {
      hasta: HASTA,
      declaraciones: [declaracion("202609")],
    });
    expect(await eliminar(c, "202609", 1)).toBe(2);
  });

  it("un mes sin declaración del mismo cliente no se ve afectado por la de otro mes", async () => {
    const c = await h.A.nuevoCliente();
    await registrarComoWorker(h.admin, h.worker, h.A, c, {
      hasta: HASTA,
      declaraciones: [declaracion("202609")],
    });
    expect(await guardar(c, "202608", 0)).toBe(1);
  });
});

describe("errores traducidos con el SQLSTATE", () => {
  it("cliente de otro estudio o inexistente: P0002, sin escribir", async () => {
    const cb = await h.B.nuevoCliente();
    expect((await falla(guardar(cb, "202601", 0))).codigo).toBe("P0002");
    expect(
      (
        await falla(
          guardar({ id: randomUUID(), ruc: "30000000000" }, "202601", 0),
        )
      ).codigo,
    ).toBe("P0002");
    expect((await falla(eliminar(cb, "202601", 1))).codigo).toBe("P0002");
    expect(await manuales(cb, ["202601"], h.B)).toEqual([]);
  });

  it("cliente archivado: 55000 al guardar y al eliminar", async () => {
    expect((await falla(guardar(h.A.archivado, "202601", 0))).codigo).toBe(
      "55000",
    );
    expect((await falla(eliminar(h.A.archivado, "202601", 1))).codigo).toBe(
      "55000",
    );
    await sinCambios(h.A.archivado, "202601", null);
  });

  it("sin usuario en el contexto: 42501 y no escribe", async () => {
    const c = await h.A.nuevoCliente();
    const e = await falla(
      h.sinUsuario((tx) =>
        guardarMesManual(tx, {
          clienteId: c.id,
          periodo: "202601",
          ...montos(),
          motivo: "x",
          version: 0,
        }),
      ),
    );
    expect(e.codigo).toBe("42501");
    const e2 = await falla(
      h.sinUsuario((tx) =>
        eliminarMesManual(tx, {
          clienteId: c.id,
          periodo: "202601",
          motivo: "x",
          version: 1,
        }),
      ),
    );
    expect(e2.codigo).toBe("42501");
    await sinCambios(c, "202601", null);
  });

  it("el worker no puede guardar ni eliminar (son funciones del backend): 42501", async () => {
    const c = await h.A.nuevoCliente();
    const e = await falla(
      h.comoWorker((tx) =>
        guardarMesManual(tx, {
          clienteId: c.id,
          periodo: "202601",
          ...montos(),
          motivo: "x",
          version: 0,
        }),
      ),
    );
    expect(e.codigo).toBe("42501");
    await sinCambios(c, "202601", null);
  });

  it.each([
    ["periodo con formato inválido", { periodo: "2026-01" }],
    ["mes 13", { periodo: "202613" }],
    ["monto fuera de NUMERIC(14,2)", { noGravadas: "1000000000000.00" }],
    ["monto no numérico", { exportaciones: "abc" }],
    ["motivo vacío", { motivo: "" }],
    ["motivo de 501 caracteres", { motivo: "a".repeat(501) }],
  ] as Array<
    [
      string,
      Partial<{
        periodo: string;
        gravadas: string;
        exportaciones: string;
        noGravadas: string;
        motivo: string;
      }>,
    ]
  >)("%s: se rechaza sin escribir", async (_nombre, o) => {
    const c = await h.A.nuevoCliente();
    const e = await falla(guardar(c, o.periodo ?? "202601", 0, o));
    // 22023 de la función; 22003/23514/22P02 si la validación la hace el tipo o el CHECK de la tabla.
    expect(["22023", "22003", "23514", "22P02"]).toContain(e.codigo);
    await sinCambios(c, "202601", null);
  });

  it("un motivo de 500 caracteres exactos se guarda", async () => {
    const c = await h.A.nuevoCliente();
    expect(await guardar(c, "202601", 0, { motivo: "ñ".repeat(500) })).toBe(1);
    expect((await manuales(c, ["202601"]))[0]!.motivo).toHaveLength(500);
  });
});

const CLIENTE = "01990000-0000-7000-8000-000000000001";
pruebasTraduccion([
  [
    "guardarMesManual",
    (tx) =>
      guardarMesManual(tx, {
        clienteId: CLIENTE,
        periodo: "202601",
        ...montos(),
        motivo: "CANARIO",
        version: 0,
      }),
  ],
  [
    "eliminarMesManual",
    (tx) =>
      eliminarMesManual(tx, {
        clienteId: CLIENTE,
        periodo: "202601",
        motivo: "CANARIO",
        version: 1,
      }),
  ],
  ["leerManuales", (tx) => leerManuales(tx, CLIENTE, ["202601"])],
  ["leerHistorialMes", (tx) => leerHistorialMes(tx, CLIENTE, "202601")],
]);
