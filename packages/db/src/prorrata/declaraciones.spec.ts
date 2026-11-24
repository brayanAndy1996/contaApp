// Spec 026 (T4, rojo): repositorio de declaraciones del PDT 621 y de obtenciones (R-2, R-5; CA-1, CA-3, CA-7, CA-8, CA-10, D-3, D-4).
// Contra la BD real: el worker registra (función acotada de 0066) y el backend lee con la RLS del estudio; más una `tx` falsa para
// la traducción de errores. Necesita DATABASE_URL y MIGRATIONS_DATABASE_URL: si faltan, FALLA (no se salta).
//
// CONTRATO que fijan estas pruebas (lo implementa T10 en `packages/db/src/prorrata/declaraciones.ts`; todo con la `tx` de withTenant):
//   registrarDeclaraciones(tx, {clienteId, trabajoId, periodoHasta, leidos, sinDeclaracion, declaraciones}) -> nuevas   (worker)
//       llama a `prorrata_declaraciones_registrar`; devuelve cuántas presentaciones eran nuevas; repetir la misma obtención devuelve 0.
//   leerDeclaraciones(tx, clienteId, periodos) -> DeclaracionFila[]   TODAS las presentaciones de esos periodos (original y
//       rectificatorias; el dominio elige la vigente por número de orden), ordenadas por periodo y número de orden NUMÉRICO.
//       Montos como cadenas con 2 decimales, `numeroOrden` como cadena, `prorrataUsada` «NN.NN» o null, `obtencionId` uuid.
//   leerUltimaObtencion(tx, clienteId, periodoHasta) -> ObtencionFila | null   la más reciente de ese cliente y ese `periodoHasta`.
//   ProrrataRepoError { codigo }: de todo error de `pg` solo se conserva el SQLSTATE o "desconocido".
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "../with-tenant";
import {
  ProrrataRepoError,
  leerDeclaraciones,
  leerUltimaObtencion,
  registrarDeclaraciones,
} from "./index";
import {
  UUID,
  abrirArnes,
  declaracion,
  falla,
  pruebasTraduccion,
  registrarComoWorker,
  sembrarTrabajo,
  ventana,
  type Arnes,
} from "./soporte-prueba";

let h: Arnes;

beforeAll(async () => {
  h = await abrirArnes();
}, 60_000);

afterAll(async () => {
  await h?.cerrar();
});

const HASTA = "202610";
const VENTANA = ventana(HASTA);

describe("ventana de prueba (sanidad del soporte)", () => {
  it("2026-10 → 2025-11 a 2026-10", () => {
    expect(VENTANA[0]).toBe("202511");
    expect(VENTANA[11]).toBe("202610");
    expect(VENTANA).toHaveLength(12);
  });
});

describe("registrar y leer (CA-1, CA-3)", () => {
  it("registra las presentaciones y devuelve cuántas son nuevas; leerDeclaraciones las trae exactas", async () => {
    const c = await h.A.nuevoCliente();
    const d1 = declaracion("202610", {
      ventasGravadasBase: "123456.78",
      ventasGravadasIgv: "22222.22",
      exportaciones: "1000.50",
      noGravadas: "0.00",
      igvAdquisicionesDg: "15000.10",
      igvAdquisicionesDgng: "999.99",
      prorrataUsada: "87.35",
    });
    const d2 = declaracion("202609");
    const nuevas = await registrarComoWorker(h.admin, h.worker, h.A, c, {
      hasta: HASTA,
      declaraciones: [d1, d2],
    });
    expect(nuevas).toBe(2);
    const filas = await h.comoDueno((tx) =>
      leerDeclaraciones(tx, c.id, ["202609", "202610"]),
    );
    expect(filas.map((f) => f.periodo)).toEqual(["202609", "202610"]);
    expect(filas[1]).toMatchObject(d1);
    expect(filas[0]).toMatchObject(d2);
    expect(filas[0]!.prorrataUsada).toBeNull();
    for (const f of filas) expect(f.obtencionId).toMatch(UUID);
  });

  it("guarda las presentaciones de un mes: la original y las rectificatorias, ordenadas por número de orden numérico", async () => {
    const c = await h.A.nuevoCliente();
    await registrarComoWorker(h.admin, h.worker, h.A, c, {
      hasta: HASTA,
      declaraciones: [
        declaracion("202608", {
          numeroOrden: "10",
          tipo: "rectificatoria",
          ventasGravadasBase: "30.00",
        }),
        declaracion("202608", {
          numeroOrden: "9",
          tipo: "rectificatoria",
          ventasGravadasBase: "20.00",
        }),
        declaracion("202608", {
          numeroOrden: "2",
          ventasGravadasBase: "10.00",
        }),
      ],
    });
    const filas = await h.comoDueno((tx) =>
      leerDeclaraciones(tx, c.id, ["202608"]),
    );
    // «2», «9», «10»: con orden de texto saldría «10», «2», «9».
    expect(filas.map((f) => f.numeroOrden)).toEqual(["2", "9", "10"]);
    expect(filas.map((f) => f.tipo)).toEqual([
      "original",
      "rectificatoria",
      "rectificatoria",
    ]);
    expect(filas.map((f) => f.ventasGravadasBase)).toEqual([
      "10.00",
      "20.00",
      "30.00",
    ]);
  });

  it("montos con signo, ceros y de 12 dígitos se devuelven exactos y con 2 decimales (sin pasar por number)", async () => {
    const c = await h.A.nuevoCliente();
    await registrarComoWorker(h.admin, h.worker, h.A, c, {
      hasta: HASTA,
      declaraciones: [
        declaracion("202610", {
          ventasGravadasBase: "999999999999.99",
          ventasGravadasIgv: "-250.50",
          exportaciones: "0.10",
          noGravadas: "0",
          igvAdquisicionesDg: "-0.01",
          igvAdquisicionesDgng: "123456789012.34",
          numeroOrden: "999999999999999",
          prorrataUsada: "0.00",
        }),
      ],
    });
    const [f] = await h.comoDueno((tx) =>
      leerDeclaraciones(tx, c.id, ["202610"]),
    );
    expect(f).toMatchObject({
      ventasGravadasBase: "999999999999.99",
      ventasGravadasIgv: "-250.50",
      exportaciones: "0.10",
      noGravadas: "0.00",
      igvAdquisicionesDg: "-0.01",
      igvAdquisicionesDgng: "123456789012.34",
      numeroOrden: "999999999999999",
      prorrataUsada: "0.00",
    });
    for (const v of Object.values(f!)) expect(typeof v).not.toBe("number");
  });

  it("solo trae los periodos pedidos; sin periodos o sin declaraciones: vacío", async () => {
    const c = await h.A.nuevoCliente();
    await registrarComoWorker(h.admin, h.worker, h.A, c, {
      hasta: HASTA,
      declaraciones: [
        declaracion("202610"),
        declaracion("202609"),
        declaracion("202601"),
      ],
    });
    const una = await h.comoDueno((tx) =>
      leerDeclaraciones(tx, c.id, ["202609"]),
    );
    expect(una.map((f) => f.periodo)).toEqual(["202609"]);
    expect(await h.comoDueno((tx) => leerDeclaraciones(tx, c.id, []))).toEqual(
      [],
    );
    expect(
      await h.comoDueno((tx) => leerDeclaraciones(tx, c.id, ["202512"])),
    ).toEqual([]);
  });

  it("no mezcla clientes ni estudios", async () => {
    const c1 = await h.A.nuevoCliente();
    const c2 = await h.A.nuevoCliente();
    const cb = await h.B.nuevoCliente();
    await registrarComoWorker(h.admin, h.worker, h.A, c1, {
      hasta: HASTA,
      declaraciones: [declaracion("202610")],
    });
    await registrarComoWorker(h.admin, h.worker, h.B, cb, {
      hasta: HASTA,
      declaraciones: [declaracion("202610", { ventasGravadasBase: "777.00" })],
    });
    expect(
      await h.comoDueno((tx) => leerDeclaraciones(tx, c2.id, ["202610"])),
    ).toEqual([]);
    // el cliente de B visto desde A (RLS) y un cliente inexistente
    expect(
      await h.comoDueno((tx) => leerDeclaraciones(tx, cb.id, ["202610"])),
    ).toEqual([]);
    expect(
      await h.comoDueno((tx) =>
        leerDeclaraciones(tx, randomUUID(), ["202610"]),
      ),
    ).toEqual([]);
    const deB = await h.comoDueno(
      (tx) => leerDeclaraciones(tx, cb.id, ["202610"]),
      h.B,
    );
    expect(deB).toHaveLength(1);
    expect(deB[0]!.ventasGravadasBase).toBe("777.00");
  });
});

describe("repetir la obtención no duplica (CA-1)", () => {
  it("la segunda obtención con lo mismo devuelve 0 nuevas, no duplica filas y deja su propio registro", async () => {
    const c = await h.A.nuevoCliente();
    const declaraciones = [
      declaracion("202610"),
      declaracion("202609"),
      declaracion("202609", { numeroOrden: "2", tipo: "rectificatoria" }),
    ];
    expect(
      await registrarComoWorker(h.admin, h.worker, h.A, c, {
        hasta: HASTA,
        declaraciones,
      }),
    ).toBe(3);
    expect(
      await registrarComoWorker(h.admin, h.worker, h.A, c, {
        hasta: HASTA,
        declaraciones,
      }),
    ).toBe(0);
    const filas = await h.comoDueno((tx) =>
      leerDeclaraciones(tx, c.id, ["202609", "202610"]),
    );
    expect(filas).toHaveLength(3);
    const u = await h.comoDueno((tx) => leerUltimaObtencion(tx, c.id, HASTA));
    expect(u!.nuevas).toBe(0);
  });

  it("una obtención posterior con una rectificatoria agrega solo esa y conserva la original", async () => {
    const c = await h.A.nuevoCliente();
    await registrarComoWorker(h.admin, h.worker, h.A, c, {
      hasta: HASTA,
      declaraciones: [declaracion("202609")],
    });
    const nuevas = await registrarComoWorker(h.admin, h.worker, h.A, c, {
      hasta: HASTA,
      declaraciones: [
        declaracion("202609"),
        declaracion("202609", {
          numeroOrden: "2",
          tipo: "rectificatoria",
          ventasGravadasBase: "55.00",
        }),
      ],
    });
    expect(nuevas).toBe(1);
    const filas = await h.comoDueno((tx) =>
      leerDeclaraciones(tx, c.id, ["202609"]),
    );
    expect(filas.map((f) => f.numeroOrden)).toEqual(["1", "2"]);
  });
});

describe("última obtención (CA-1)", () => {
  it("sin obtenciones: null", async () => {
    const c = await h.A.nuevoCliente();
    expect(
      await h.comoDueno((tx) => leerUltimaObtencion(tx, c.id, HASTA)),
    ).toBeNull();
  });

  it("trae los periodos leídos, los sin declaración, las nuevas, el trabajo y la fecha", async () => {
    const c = await h.A.nuevoCliente();
    const trabajoId = await sembrarTrabajo(h.admin, h.A, c, HASTA);
    const leidos = VENTANA.filter((p) => p !== "202603");
    const sinDeclaracion = ["202511", "202512"];
    const declaraciones = leidos
      .filter((p) => !sinDeclaracion.includes(p))
      .map((p) => declaracion(p));
    const nuevas = await h.comoWorker((tx: Tx) =>
      registrarDeclaraciones(tx, {
        clienteId: c.id,
        trabajoId,
        periodoHasta: HASTA,
        leidos,
        sinDeclaracion,
        declaraciones,
      }),
    );
    expect(nuevas).toBe(declaraciones.length);
    const u = await h.comoDueno((tx) => leerUltimaObtencion(tx, c.id, HASTA));
    expect(u).not.toBeNull();
    expect(u!.id).toMatch(UUID);
    expect(u!.periodoHasta).toBe(HASTA);
    expect([...u!.periodosLeidos].sort()).toEqual([...leidos].sort());
    expect([...u!.periodosSinDeclaracion].sort()).toEqual(sinDeclaracion);
    expect(u!.nuevas).toBe(declaraciones.length);
    expect(u!.trabajoId).toBe(trabajoId);
    expect(u!.obtenidaEn).toBeInstanceOf(Date);
  });

  it("devuelve la más reciente del mismo periodo hasta, sin mezclar otros periodos hasta ni otros clientes", async () => {
    const c = await h.A.nuevoCliente();
    const otro = await h.A.nuevoCliente();
    await registrarComoWorker(h.admin, h.worker, h.A, c, {
      hasta: HASTA,
      declaraciones: [declaracion("202610")],
    });
    await registrarComoWorker(h.admin, h.worker, h.A, c, {
      hasta: HASTA,
      declaraciones: [declaracion("202610"), declaracion("202609")],
    });
    await registrarComoWorker(h.admin, h.worker, h.A, c, {
      hasta: "202609",
      declaraciones: [declaracion("202608")],
    });
    await registrarComoWorker(h.admin, h.worker, h.A, otro, {
      hasta: HASTA,
      declaraciones: [],
    });
    const u = await h.comoDueno((tx) => leerUltimaObtencion(tx, c.id, HASTA));
    expect(u!.periodoHasta).toBe(HASTA);
    expect(u!.nuevas).toBe(1); // la segunda: solo 202609 era nueva
    const otraVentana = await h.comoDueno((tx) =>
      leerUltimaObtencion(tx, c.id, "202609"),
    );
    expect(otraVentana!.nuevas).toBe(1);
    expect(
      await h.comoDueno((tx) => leerUltimaObtencion(tx, c.id, "202601")),
    ).toBeNull();
    expect(
      await h.comoDueno((tx) => leerUltimaObtencion(tx, randomUUID(), HASTA)),
    ).toBeNull();
  });

  it("una obtención sin ninguna declaración también queda registrada (todo «sin declaración»)", async () => {
    const c = await h.A.nuevoCliente();
    expect(
      await registrarComoWorker(h.admin, h.worker, h.A, c, {
        hasta: HASTA,
        declaraciones: [],
      }),
    ).toBe(0);
    const u = await h.comoDueno((tx) => leerUltimaObtencion(tx, c.id, HASTA));
    expect(u!.nuevas).toBe(0);
    expect([...u!.periodosSinDeclaracion].sort()).toEqual([...VENTANA].sort());
  });

  it("de otro estudio: null (RLS)", async () => {
    const cb = await h.B.nuevoCliente();
    await registrarComoWorker(h.admin, h.worker, h.B, cb, {
      hasta: HASTA,
      declaraciones: [declaracion("202610")],
    });
    expect(
      await h.comoDueno((tx) => leerUltimaObtencion(tx, cb.id, HASTA)),
    ).toBeNull();
  });
});

describe("registrar: errores traducidos con el SQLSTATE", () => {
  const sinEscrituras = async (clienteId: string): Promise<void> => {
    expect(
      await h.comoDueno((tx) => leerDeclaraciones(tx, clienteId, VENTANA)),
    ).toEqual([]);
    expect(
      await h.comoDueno((tx) => leerUltimaObtencion(tx, clienteId, HASTA)),
    ).toBeNull();
  };

  it("cliente de otro estudio o inexistente: P0002, sin escribir", async () => {
    const cb = await h.B.nuevoCliente();
    const trabajoId = await sembrarTrabajo(h.admin, h.B, cb, HASTA);
    const e = await falla(
      h.comoWorker((tx) =>
        registrarDeclaraciones(tx, {
          clienteId: cb.id,
          trabajoId,
          periodoHasta: HASTA,
          leidos: VENTANA,
          sinDeclaracion: [],
          declaraciones: [declaracion("202610")],
        }),
      ),
    );
    expect(e.codigo).toBe("P0002");
    const e2 = await falla(
      h.comoWorker((tx) =>
        registrarDeclaraciones(tx, {
          clienteId: randomUUID(),
          trabajoId,
          periodoHasta: HASTA,
          leidos: VENTANA,
          sinDeclaracion: [],
          declaraciones: [],
        }),
      ),
    );
    expect(e2.codigo).toBe("P0002");
    expect(
      await h.comoDueno((tx) => leerDeclaraciones(tx, cb.id, VENTANA), h.B),
    ).toEqual([]);
  });

  it("cliente archivado: 55000", async () => {
    const trabajoId = await sembrarTrabajo(h.admin, h.A, h.A.archivado, HASTA);
    const e = await falla(
      h.comoWorker((tx) =>
        registrarDeclaraciones(tx, {
          clienteId: h.A.archivado.id,
          trabajoId,
          periodoHasta: HASTA,
          leidos: VENTANA,
          sinDeclaracion: [],
          declaraciones: [declaracion("202610")],
        }),
      ),
    );
    expect(e.codigo).toBe("55000");
    await sinEscrituras(h.A.archivado.id);
  });

  it("un trabajo de otro tipo, de otro cliente o de otro periodo: 22023, sin escribir", async () => {
    const c = await h.A.nuevoCliente();
    const otro = await h.A.nuevoCliente();
    const casos = [
      await sembrarTrabajo(h.admin, h.A, c, HASTA, "sol.buzon.revisar"),
      await sembrarTrabajo(h.admin, h.A, otro, HASTA),
      await sembrarTrabajo(h.admin, h.A, c, "202609"),
      randomUUID(),
    ];
    for (const trabajoId of casos) {
      const e = await falla(
        h.comoWorker((tx) =>
          registrarDeclaraciones(tx, {
            clienteId: c.id,
            trabajoId,
            periodoHasta: HASTA,
            leidos: VENTANA,
            sinDeclaracion: [],
            declaraciones: [declaracion("202610")],
          }),
        ),
      );
      expect(e.codigo).toBe("22023");
    }
    await sinEscrituras(c.id);
  });

  it.each([
    ["leídos fuera de la ventana", { leidos: ["202510"] }],
    ["leídos repetidos", { leidos: ["202610", "202610"] }],
    ["más de 12 periodos leídos", { leidos: [...VENTANA, "202611"] }],
    [
      "sin declaración que no se leyó",
      { leidos: ["202610"], sinDeclaracion: ["202609"] },
    ],
    [
      "una declaración en un periodo que no se leyó",
      { leidos: ["202609"], declaraciones: [declaracion("202610")] },
    ],
    [
      "una declaración en un periodo «sin declaración»",
      {
        leidos: ["202610"],
        sinDeclaracion: ["202610"],
        declaraciones: [declaracion("202610")],
      },
    ],
    [
      "monto con 3 decimales",
      { declaraciones: [declaracion("202610", { exportaciones: "1.234" })] },
    ],
    [
      "monto fuera de NUMERIC(14,2)",
      {
        declaraciones: [
          declaracion("202610", { noGravadas: "1000000000000.00" }),
        ],
      },
    ],
    [
      "prorrata usada 100.01",
      { declaraciones: [declaracion("202610", { prorrataUsada: "100.01" })] },
    ],
    [
      "número de orden 0",
      { declaraciones: [declaracion("202610", { numeroOrden: "0" })] },
    ],
    [
      "tipo inválido",
      { declaraciones: [declaracion("202610", { tipo: "otra" as never })] },
    ],
  ] as Array<
    [
      string,
      Partial<{
        leidos: string[];
        sinDeclaracion: string[];
        declaraciones: ReturnType<typeof declaracion>[];
      }>,
    ]
  >)("%s: 22023 y no escribe nada (ni la obtención)", async (_nombre, o) => {
    const c = await h.A.nuevoCliente();
    const trabajoId = await sembrarTrabajo(h.admin, h.A, c, HASTA);
    const e = await falla(
      h.comoWorker((tx) =>
        registrarDeclaraciones(tx, {
          clienteId: c.id,
          trabajoId,
          periodoHasta: HASTA,
          leidos: o.leidos ?? VENTANA,
          sinDeclaracion: o.sinDeclaracion ?? [],
          declaraciones: o.declaraciones ?? [declaracion("202610")],
        }),
      ),
    );
    expect(e.codigo).toBe("22023");
    await sinEscrituras(c.id);
  });

  it("el backend no puede registrar (la función es del worker): 42501", async () => {
    const c = await h.A.nuevoCliente();
    const trabajoId = await sembrarTrabajo(h.admin, h.A, c, HASTA);
    const e = await falla(
      h.comoDueno((tx) =>
        registrarDeclaraciones(tx, {
          clienteId: c.id,
          trabajoId,
          periodoHasta: HASTA,
          leidos: VENTANA,
          sinDeclaracion: [],
          declaraciones: [declaracion("202610")],
        }),
      ),
    );
    expect(e.codigo).toBe("42501");
    await sinEscrituras(c.id);
  });

  it("sin estudio en el contexto no se ve nada y no se escribe", async () => {
    const c = await h.A.nuevoCliente();
    const trabajoId = await sembrarTrabajo(h.admin, h.A, c, HASTA);
    const e = await falla(
      h.worker.withTenant({ tenantId: randomUUID() }, (tx) =>
        registrarDeclaraciones(tx, {
          clienteId: c.id,
          trabajoId,
          periodoHasta: HASTA,
          leidos: VENTANA,
          sinDeclaracion: [],
          declaraciones: [],
        }),
      ),
    );
    expect(["P0002", "22023", "42501"]).toContain(e.codigo);
    await sinEscrituras(c.id);
  });
});

describe("el error del repositorio", () => {
  it("es un ProrrataRepoError con mensaje fijo", () => {
    const e = new ProrrataRepoError("CA409");
    expect(e).toBeInstanceOf(Error);
    expect(e.codigo).toBe("CA409");
    expect(e.message).toBe(
      "Error de base de datos en prorrata (SQLSTATE CA409)",
    );
  });
});

const CLIENTE = "01990000-0000-7000-8000-000000000001";
const TRABAJO = "01990000-0000-7000-8000-000000000002";
pruebasTraduccion([
  [
    "registrarDeclaraciones",
    (tx) =>
      registrarDeclaraciones(tx, {
        clienteId: CLIENTE,
        trabajoId: TRABAJO,
        periodoHasta: HASTA,
        leidos: VENTANA,
        sinDeclaracion: [],
        declaraciones: [declaracion("202610")],
      }),
  ],
  ["leerDeclaraciones", (tx) => leerDeclaraciones(tx, CLIENTE, ["202610"])],
  ["leerUltimaObtencion", (tx) => leerUltimaObtencion(tx, CLIENTE, HASTA)],
]);
