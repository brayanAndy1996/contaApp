// Spec 028 (T4, rojo): lector del resumen diario (R-13, D-6; CA-4, CA-12) contra la BD real con el rol worker (sin usuario en el
// contexto: el usuario del resumen va como argumento) y un oráculo en memoria con datos aleatorios y reproducibles (semillas fijas).
// Necesita DATABASE_URL y MIGRATIONS_DATABASE_URL: si faltan, FALLA (no se salta). La medida de rendimiento (R-16) está en
// `resumen.rendimiento.spec.ts`.
//
// CONTRATO que fijan estas pruebas (lo implementa T10 en `packages/db/src/correo/resumen.ts`):
//   leerResumen(tx, {usuarioId, desde, periodo, todos}) -> ClienteResumen[], en <= 3 consultas (clientes, mensajes por cliente,
//     periodos y descargas). Sin orden fijo (el dominio ordena y recorta a 50). Un elemento por cliente del alcance del usuario que
//     tenga algo que contar; el resto no aparece. Los conteos son `number` enteros.
//   Alcance (R-13, U-3): los clientes con cualquier asignación del usuario (responsable o colaborador), no archivados. Si `todos` es
//     true Y el rol del usuario en el estudio es dueno o admin Y no tiene ninguna asignación, todos los clientes no archivados del
//     estudio; con asignaciones o con otro rol, `todos` se ignora. Un usuario sin membresía en el estudio no tiene alcance: [].
//   Por cliente: nuevos = mensajes NO históricos con `primera_captura_en` ESTRICTAMENTE posterior a `desde` (atendidos o no);
//     criticosNuevos = de esos, los críticos; pendientesAtender = mensajes no históricos sin `atendido_en` del cliente (nuevos o
//     anteriores). Históricos y capturados en `desde` o antes nunca cuentan como nuevos.
//   Periodo (D-6): por libro (compras: `compra_periodo`; ventas: `venta_periodo`; sin fila = abierto) y SOLO el `periodo` pedido:
//     generado -> null; revisado -> "revisado"; si no, "abierto" cuando hay un `sire.propuesta.descargar` en estado `completado` de
//     ese cliente, libro y periodo (parámetros), y "sin_descargar" cuando no (un trabajo en cola, ejecutando, con error o cancelado
//     no cuenta; tampoco el de otro periodo, otro libro u otro cliente). `revisado` sin descarga no se define y no se prueba.
//   Entradas inválidas (22023, sin ir a la BD): `periodo` fuera de AAAAMM, `desde` no es una fecha válida, `todos` no booleano;
//     `usuarioId` que no es uuid: P0002.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leerResumen } from "./index";
import {
  DESDE,
  PERIODO,
  abrirArnes,
  archivar,
  asignarCliente,
  descarga,
  espiar,
  falla,
  oraculoResumen,
  periodoEstado,
  porCliente,
  pruebasTraduccion,
  sembrarEscenarioResumen,
  sembrarMensajes,
  type Arnes,
} from "./soporte-prueba";
import { txFalso } from "../trabajos/soporte-prueba";

let h: Arnes;

beforeAll(async () => {
  h = await abrirArnes();
}, 60_000);

afterAll(async () => {
  await h?.cerrar();
});

const MS = (t: string): Date => new Date(t);

describe("el caso de CA-4: un Contador con cuatro clientes", () => {
  it("solo A (3 nuevos, 1 crítico, 5 pendientes) y B (compras abierto, ventas sin descargar); C no asignado y D archivado no salen", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    const [a, b, c, d] = [
      await e.nuevoCliente({ razonSocial: "A Responsable T4" }),
      await e.nuevoCliente({ razonSocial: "B Colaborador T4" }),
      await e.nuevoCliente({ razonSocial: "C Ajeno T4" }),
      await e.nuevoCliente({ razonSocial: "D Archivado T4" }),
    ] as const;
    await asignarCliente(h, e, a, u, "responsable");
    await asignarCliente(h, e, b, u, "colaborador");
    await asignarCliente(h, e, d, u, "responsable");
    await archivar(h, e, d);
    const antes = MS("2026-11-19T10:00:00.000Z");
    const nuevo = MS("2026-11-21T10:00:00.000Z");
    const m = (clienteId: string, capturadoEn: Date, extra = {}) => ({
      clienteId,
      critico: false,
      historico: false,
      atendido: false,
      capturadoEn,
      ...extra,
    });
    await sembrarMensajes(h.admin, e, e.dueno, [
      // A: 3 nuevos (1 crítico) y 2 pendientes de antes, más ruido que no cuenta.
      m(a.id, nuevo, { critico: true }),
      m(a.id, nuevo),
      m(a.id, nuevo),
      m(a.id, antes),
      m(a.id, antes),
      m(a.id, antes, { atendido: true }),
      m(a.id, nuevo, { historico: true }),
      // C y D: con mensajes nuevos, pero fuera del alcance.
      m(c.id, nuevo),
      m(c.id, nuevo, { critico: true }),
      m(d.id, nuevo),
    ]);
    // A: ambos periodos generados (nada pendiente de periodo). B: compras abierto con descarga (0 comprobantes), ventas sin descarga.
    for (const libro of ["compras", "ventas"] as const)
      await periodoEstado(h, e, a, libro, PERIODO, "generado");
    await descarga(h, e, b, "compras", PERIODO, "completado");
    const filas = await h.comoWorker(e, (tx) =>
      leerResumen(tx, {
        usuarioId: u.id,
        desde: DESDE,
        periodo: PERIODO,
        todos: false,
      }),
    );
    expect(porCliente(filas)).toEqual(
      porCliente([
        {
          clienteId: a.id,
          razonSocial: "A Responsable T4",
          nuevos: 3,
          criticosNuevos: 1,
          pendientesAtender: 5,
          compras: null,
          ventas: null,
        },
        {
          clienteId: b.id,
          razonSocial: "B Colaborador T4",
          nuevos: 0,
          criticosNuevos: 0,
          pendientesAtender: 0,
          compras: "abierto",
          ventas: "sin_descargar",
        },
      ]),
    );
  });

  it("con los periodos de B generados en ambos libros y sin mensajes nuevos, B no aparece (nada que contar)", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    const b = await e.nuevoCliente();
    await asignarCliente(h, e, b, u, "colaborador");
    for (const libro of ["compras", "ventas"] as const)
      await periodoEstado(h, e, b, libro, PERIODO, "generado");
    // Pendientes de atender de antes: solos no cuentan (R-13).
    await sembrarMensajes(h.admin, e, e.dueno, [
      {
        clienteId: b.id,
        critico: true,
        historico: false,
        atendido: false,
        capturadoEn: MS("2026-11-10T10:00:00.000Z"),
      },
    ]);
    const filas = await h.comoWorker(e, (tx) =>
      leerResumen(tx, {
        usuarioId: u.id,
        desde: DESDE,
        periodo: PERIODO,
        todos: false,
      }),
    );
    expect(filas).toEqual([]);
  });
});

describe("el corte de «nuevos» (R-13, U-4)", () => {
  it("cuenta estrictamente después de `desde`: igual o antes no; +1 ms sí; los históricos nunca", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    const c = await e.nuevoCliente();
    await asignarCliente(h, e, c, u, "responsable");
    for (const libro of ["compras", "ventas"] as const)
      await periodoEstado(h, e, c, libro, PERIODO, "generado");
    const t = DESDE.getTime();
    const m = (ms: number, extra = {}) => ({
      clienteId: c.id,
      critico: false,
      historico: false,
      atendido: false,
      capturadoEn: new Date(ms),
      ...extra,
    });
    await sembrarMensajes(h.admin, e, e.dueno, [
      m(t - 1),
      m(t),
      m(t + 1, { critico: true }),
      m(t + 86_400_000),
      m(t + 86_400_000, { historico: true, critico: true }),
    ]);
    const [fila] = await h.comoWorker(e, (tx) =>
      leerResumen(tx, {
        usuarioId: u.id,
        desde: DESDE,
        periodo: PERIODO,
        todos: false,
      }),
    );
    expect(fila).toMatchObject({
      nuevos: 2,
      criticosNuevos: 1,
      pendientesAtender: 4,
    });
  });

  it("un nuevo ya atendido cuenta como nuevo pero no como pendiente de atender", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    const c = await e.nuevoCliente();
    await asignarCliente(h, e, c, u, "responsable");
    for (const libro of ["compras", "ventas"] as const)
      await periodoEstado(h, e, c, libro, PERIODO, "generado");
    await sembrarMensajes(h.admin, e, e.dueno, [
      {
        clienteId: c.id,
        critico: true,
        historico: false,
        atendido: true,
        capturadoEn: MS("2026-11-22T10:00:00.000Z"),
      },
    ]);
    const [fila] = await h.comoWorker(e, (tx) =>
      leerResumen(tx, {
        usuarioId: u.id,
        desde: DESDE,
        periodo: PERIODO,
        todos: false,
      }),
    );
    expect(fila).toMatchObject({
      nuevos: 1,
      criticosNuevos: 1,
      pendientesAtender: 0,
    });
  });
});

describe("estado del periodo por libro (D-6)", () => {
  const leerUno = async (
    preparar: (
      e: Awaited<ReturnType<Arnes["nuevoEstudio"]>>,
      c: Awaited<
        ReturnType<Awaited<ReturnType<Arnes["nuevoEstudio"]>>["nuevoCliente"]>
      >,
    ) => Promise<void>,
  ) => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    const c = await e.nuevoCliente();
    await asignarCliente(h, e, c, u, "responsable");
    await preparar(e, c);
    const filas = await h.comoWorker(e, (tx) =>
      leerResumen(tx, {
        usuarioId: u.id,
        desde: DESDE,
        periodo: PERIODO,
        todos: false,
      }),
    );
    return filas[0];
  };

  it.each<
    [
      string,
      "completado" | "error" | "en_cola" | "ejecutando" | "cancelado" | null,
      string,
    ]
  >([
    ["sin trabajo", null, "sin_descargar"],
    ["trabajo completado", "completado", "abierto"],
    ["trabajo fallido", "error", "sin_descargar"],
    ["trabajo en cola", "en_cola", "sin_descargar"],
    ["trabajo ejecutando", "ejecutando", "sin_descargar"],
    ["trabajo cancelado", "cancelado", "sin_descargar"],
  ])("abierto (sin fila) con %s -> %s", async (_nombre, trabajo, esperado) => {
    for (const libro of ["compras", "ventas"] as const) {
      const fila = await leerUno(async (e, c) => {
        if (trabajo !== null) await descarga(h, e, c, libro, PERIODO, trabajo);
      });
      expect(fila?.[libro]).toBe(esperado);
      // El otro libro no se contagia.
      const otro = libro === "compras" ? "ventas" : "compras";
      expect(fila?.[otro]).toBe("sin_descargar");
    }
  });

  it("el periodo `abierto` guardado se comporta igual que sin fila", async () => {
    const fila = await leerUno(async (e, c) => {
      await periodoEstado(h, e, c, "compras", PERIODO, "abierto");
      await descarga(h, e, c, "compras", PERIODO, "completado");
    });
    expect(fila?.compras).toBe("abierto");
  });

  it("revisado (con su descarga) -> revisado; generado -> fuera (null), en cada libro por separado", async () => {
    const fila = await leerUno(async (e, c) => {
      await descarga(h, e, c, "compras", PERIODO, "completado");
      await periodoEstado(h, e, c, "compras", PERIODO, "revisado");
      await periodoEstado(h, e, c, "ventas", PERIODO, "generado");
    });
    expect(fila).toMatchObject({ compras: "revisado", ventas: null });
  });

  it("una descarga completada de otro periodo, de otro libro o de otro cliente no cuenta", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    const c = await e.nuevoCliente();
    const otro = await e.nuevoCliente();
    await asignarCliente(h, e, c, u, "responsable");
    await asignarCliente(h, e, otro, u, "colaborador");
    await descarga(h, e, c, "compras", "202609", "completado"); // otro periodo
    await descarga(h, e, c, "compras", "202611", "completado"); // otro periodo
    await descarga(h, e, c, "ventas", PERIODO, "completado"); // otro libro
    await descarga(h, e, otro, "compras", PERIODO, "completado"); // otro cliente
    const filas = await h.comoWorker(e, (tx) =>
      leerResumen(tx, {
        usuarioId: u.id,
        desde: DESDE,
        periodo: PERIODO,
        todos: false,
      }),
    );
    const por = new Map(filas.map((f) => [f.clienteId, f]));
    expect(por.get(c.id)).toMatchObject({
      compras: "sin_descargar",
      ventas: "abierto",
    });
    expect(por.get(otro.id)).toMatchObject({
      compras: "abierto",
      ventas: "sin_descargar",
    });
  });

  it("solo mira el periodo pedido: el estado de otro mes no cambia el resultado", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    const c = await e.nuevoCliente();
    await asignarCliente(h, e, c, u, "responsable");
    await periodoEstado(h, e, c, "compras", "202609", "generado");
    await periodoEstado(h, e, c, "ventas", "202611", "generado");
    const filas = await h.comoWorker(e, (tx) =>
      leerResumen(tx, {
        usuarioId: u.id,
        desde: DESDE,
        periodo: PERIODO,
        todos: false,
      }),
    );
    expect(filas[0]).toMatchObject({
      compras: "sin_descargar",
      ventas: "sin_descargar",
    });
  });
});

describe("alcance del usuario (R-13, U-3; CA-12)", () => {
  it("«todos»: un Dueño sin asignaciones ve todos los clientes no archivados; con todos=false no ve ninguno", async () => {
    const e = await h.nuevoEstudio();
    const [x, y, z] = [
      await e.nuevoCliente(),
      await e.nuevoCliente(),
      await e.nuevoCliente(),
    ] as const;
    await archivar(h, e, z);
    const con = await h.comoWorker(e, (tx) =>
      leerResumen(tx, {
        usuarioId: e.dueno.id,
        desde: DESDE,
        periodo: PERIODO,
        todos: true,
      }),
    );
    expect(con.map((f) => f.clienteId).sort()).toEqual([x.id, y.id].sort());
    const sin = await h.comoWorker(e, (tx) =>
      leerResumen(tx, {
        usuarioId: e.dueno.id,
        desde: DESDE,
        periodo: PERIODO,
        todos: false,
      }),
    );
    expect(sin).toEqual([]);
  });

  it("un Dueño con una asignación: «todos» se ignora y solo salen sus asignados", async () => {
    const e = await h.nuevoEstudio();
    const x = await e.nuevoCliente();
    await e.nuevoCliente();
    await asignarCliente(h, e, x, e.dueno, "colaborador");
    const filas = await h.comoWorker(e, (tx) =>
      leerResumen(tx, {
        usuarioId: e.dueno.id,
        desde: DESDE,
        periodo: PERIODO,
        todos: true,
      }),
    );
    expect(filas.map((f) => f.clienteId)).toEqual([x.id]);
  });

  it.each(["contador", "asistente", "lectura"] as const)(
    "un %s sin asignaciones con todos=true: se ignora y no sale ningún cliente",
    async (rol) => {
      const e = await h.nuevoEstudio();
      const u = await e.nuevoUsuario(rol);
      await e.nuevoCliente();
      const filas = await h.comoWorker(e, (tx) =>
        leerResumen(tx, {
          usuarioId: u.id,
          desde: DESDE,
          periodo: PERIODO,
          todos: true,
        }),
      );
      expect(filas).toEqual([]);
    },
  );

  it("un Administrador sin asignaciones sí puede con todos=true", async () => {
    const e = await h.nuevoEstudio();
    const adm = await e.nuevoUsuario("admin");
    const x = await e.nuevoCliente();
    const filas = await h.comoWorker(e, (tx) =>
      leerResumen(tx, {
        usuarioId: adm.id,
        desde: DESDE,
        periodo: PERIODO,
        todos: true,
      }),
    );
    expect(filas.map((f) => f.clienteId)).toEqual([x.id]);
  });

  it("un usuario sin membresía en el estudio (otro estudio) no tiene alcance, ni siquiera con todos=true", async () => {
    const e = await h.nuevoEstudio();
    await e.nuevoCliente();
    const filas = await h.comoWorker(e, (tx) =>
      leerResumen(tx, {
        usuarioId: h.B.dueno.id,
        desde: DESDE,
        periodo: PERIODO,
        todos: true,
      }),
    );
    expect(filas).toEqual([]);
  });

  it("un usuario en dos estudios: cada resumen trae solo los clientes y mensajes de su estudio (R-4)", async () => {
    const e1 = await h.nuevoEstudio();
    const e2 = await h.nuevoEstudio();
    const u = await e1.nuevoUsuario("contador");
    await e2.unir(u, "contador");
    const c1 = await e1.nuevoCliente();
    const c2 = await e2.nuevoCliente();
    await asignarCliente(h, e1, c1, u, "responsable");
    await asignarCliente(h, e2, c2, u, "responsable");
    await sembrarMensajes(h.admin, e1, e1.dueno, [
      {
        clienteId: c1.id,
        critico: true,
        historico: false,
        atendido: false,
        capturadoEn: MS("2026-11-22T10:00:00.000Z"),
      },
    ]);
    const leer = (e: typeof e1) =>
      h.comoWorker(e, (tx) =>
        leerResumen(tx, {
          usuarioId: u.id,
          desde: DESDE,
          periodo: PERIODO,
          todos: false,
        }),
      );
    const r1 = await leer(e1);
    const r2 = await leer(e2);
    expect(r1.map((f) => f.clienteId)).toEqual([c1.id]);
    expect(r1[0]).toMatchObject({ nuevos: 1, criticosNuevos: 1 });
    expect(r2.map((f) => f.clienteId)).toEqual([c2.id]);
    expect(r2[0]).toMatchObject({ nuevos: 0, criticosNuevos: 0 });
    expect(JSON.stringify(r1)).not.toContain(c2.id);
    expect(JSON.stringify(r2)).not.toContain(c1.id);
  });
});

describe("contra el oráculo en memoria con datos aleatorios (R-13)", () => {
  it.each([1, 2, 3, 4, 5])(
    "semilla %i: responsable, colaborador, no asignado, archivado y «todos» coinciden con el oráculo para cada usuario",
    async (semilla) => {
      const esc = await sembrarEscenarioResumen(h, semilla);
      const { e, usuarios, datos } = esc;
      let conDatos = 0;
      for (const [nombre, u] of Object.entries(usuarios)) {
        for (const todos of [false, true]) {
          const p = { usuarioId: u.id, desde: DESDE, periodo: PERIODO, todos };
          const obtenido = await h.comoWorker(e, (tx) => leerResumen(tx, p));
          const esperado = oraculoResumen(datos, p);
          expect(porCliente(obtenido), `${nombre} todos=${todos}`).toEqual(
            esperado,
          );
          if (esperado.length > 0) conDatos++;
        }
      }
      // La prueba no es vacua: hay resultados con y sin «todos», y la escena trae de todo.
      expect(conDatos).toBeGreaterThanOrEqual(6);
      expect(datos.clientes.some((c) => c.archivado)).toBe(true);
      expect(datos.mensajes.some((m) => m.historico)).toBe(true);
      expect(datos.mensajes.some((m) => m.atendido)).toBe(true);
      expect(datos.mensajes.some((m) => m.critico)).toBe(true);
      expect(datos.descargas.size).toBeGreaterThan(0);
    },
    120_000,
  );

  it("los conteos son enteros de JavaScript (no texto de bigint) y no hay claves de más", async () => {
    const esc = await sembrarEscenarioResumen(h, 7);
    const filas = await h.comoWorker(esc.e, (tx) =>
      leerResumen(tx, {
        usuarioId: esc.usuarios.dueno.id,
        desde: DESDE,
        periodo: PERIODO,
        todos: true,
      }),
    );
    expect(filas.length).toBeGreaterThan(0);
    for (const f of filas) {
      expect(typeof f.nuevos).toBe("number");
      expect(typeof f.criticosNuevos).toBe("number");
      expect(typeof f.pendientesAtender).toBe("number");
      expect(Object.keys(f).sort()).toEqual([
        "clienteId",
        "compras",
        "criticosNuevos",
        "nuevos",
        "pendientesAtender",
        "razonSocial",
        "ventas",
      ]);
    }
  }, 60_000);

  it("a lo sumo 3 consultas por lectura (clientes, mensajes por cliente, periodos y descargas), con datos de todo tipo", async () => {
    const esc = await sembrarEscenarioResumen(h, 3);
    for (const [quien, todos] of [
      [esc.usuarios.dueno, true],
      [esc.usuarios.admin1, false],
      [esc.usuarios.contador1, true],
    ] as const) {
      const consultas = await h.comoWorker(esc.e, async (tx) => {
        const espia = espiar(tx);
        const filas = await leerResumen(espia.tx, {
          usuarioId: quien.id,
          desde: DESDE,
          periodo: PERIODO,
          todos,
        });
        expect(filas.length).toBeGreaterThan(0);
        return espia.consultas();
      });
      expect(consultas).toBeGreaterThanOrEqual(1);
      expect(consultas).toBeLessThanOrEqual(3);
    }
  }, 60_000);

  it("lee con el rol backend (con el usuario en el contexto) lo mismo que con el worker", async () => {
    const e = await h.nuevoEstudio();
    const u = await e.nuevoUsuario("contador");
    const c = await e.nuevoCliente();
    await asignarCliente(h, e, c, u, "responsable");
    await sembrarMensajes(h.admin, e, e.dueno, [
      {
        clienteId: c.id,
        critico: false,
        historico: false,
        atendido: false,
        capturadoEn: MS("2026-11-22T10:00:00.000Z"),
      },
    ]);
    const p = { usuarioId: u.id, desde: DESDE, periodo: PERIODO, todos: false };
    const w = await h.comoWorker(e, (tx) => leerResumen(tx, p));
    const b = await h.comoUsuario(e, u, (tx) => leerResumen(tx, p));
    expect(w.length).toBe(1);
    expect(porCliente(b)).toEqual(porCliente(w));
  });
});

describe("entradas inválidas: la última barrera, sin ir a la BD", () => {
  const U = randomUUID();
  const base = { usuarioId: U, desde: DESDE, periodo: PERIODO, todos: false };

  it.each([
    ["periodo con guion", { ...base, periodo: "2026-10" }],
    ["periodo corto", { ...base, periodo: "20261" }],
    ["periodo con mes 13", { ...base, periodo: "202613" }],
    ["periodo con mes 00", { ...base, periodo: "202600" }],
    ["periodo numérico", { ...base, periodo: 202610 }],
    ["desde inválido", { ...base, desde: new Date("no es fecha") }],
    ["desde como texto", { ...base, desde: "2026-11-20" }],
    ["todos como texto", { ...base, todos: "true" }],
    ["todos nulo", { ...base, todos: null }],
  ])("%s: 22023", async (_n, p) => {
    const { tx, llamadas } = txFalso({ rows: [] });
    expect((await falla(leerResumen(tx, p as never))).codigo).toBe("22023");
    expect(llamadas).toHaveLength(0);
  });

  it("un usuarioId que no es uuid: P0002", async () => {
    const { tx, llamadas } = txFalso({ rows: [] });
    expect(
      (await falla(leerResumen(tx, { ...base, usuarioId: "no-es-uuid" })))
        .codigo,
    ).toBe("P0002");
    expect(llamadas).toHaveLength(0);
  });
});

pruebasTraduccion([
  [
    "leerResumen",
    (tx) =>
      leerResumen(tx, {
        usuarioId: "0190a000-0000-7000-8000-0000000000a1",
        desde: DESDE,
        periodo: PERIODO,
        todos: false,
      }),
  ],
]);
