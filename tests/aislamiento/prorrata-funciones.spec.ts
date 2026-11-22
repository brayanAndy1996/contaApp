// Spec 026 (T3, rojo): las cuatro funciones acotadas de la migracion 0066 en BD real (D-3 a D-7; CA-3, CA-4, CA-6 a CA-10).
// Catalogo (SECURITY DEFINER de contapp_migrator, search_path fijo, EXECUTE solo al rol del plan), quien llama (42501), cliente ajeno
// (P0002) y archivado (55000), registrar (valida todo o nada con 22023, idempotente, no toca ventas, compras ni manuales, audita con
// actor trabajo), manual (CAS por version CA409, mes declarado CA412, eliminar y volver a guardar, historial completo), prorrata
// usada (CA413, CAS), auditoria sin montos, motivos ni RUC y el SAVEPOINT del worker. Contrato en `prorrata-soporte.ts`.
// Hasta T10 fallan por funcion o tabla inexistente (42883, 42P01).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { abrirAdmin } from "./auth-soporte";
import { type ContappDb } from "./soporte";
import { crearDb } from "./trabajos-soporte";
import {
  ACCIONES_PRORRATA,
  argsRegistrar,
  CANARIO,
  codigoDe,
  comoRolSql,
  conExecute,
  decl,
  EJECUTA,
  EscenarioProrrata,
  FIRMAS,
  idNuevo,
  infoFuncion,
  llamar,
  ROLES_FUNCION,
  SQL,
  ventana,
  type ArgsRegistrar,
  type ClientePrueba,
  type Llamada,
} from "./prorrata-soporte";

let admin: Pool;
let ep: EscenarioProrrata;
let backend: ContappDb;
let worker: ContappDb;
let X: string;
let Y: string;
let ux: string; // contador activo de X
let uD: string; // miembro desactivado de X
let uy: string; // contador activo de Y
let cy: ClientePrueba; // cliente de Y

const comoX = () => ({ tenantId: X, userId: ux });

beforeAll(async () => {
  admin = abrirAdmin(8);
  ep = new EscenarioProrrata(admin);
  X = (await ep.estudio()).id;
  Y = (await ep.estudio()).id;
  ux = await ep.usuarioDe(X);
  uD = (await ep.miembro(X, "contador", { desactivada: true })).id;
  uy = await ep.usuarioDe(Y);
  cy = await ep.cliente(Y);
  backend = crearDb("contapp_backend", 4);
  worker = crearDb("contapp_worker", 4);
});
afterAll(async () => {
  await ep?.limpiar();
  await Promise.all(
    [backend?.close(), worker?.close(), ep?.cerrar()].map((p) =>
      p?.catch(() => undefined),
    ),
  );
  await admin?.end();
});

// ---- Ayudas --------------------------------------------------------------------------------------------------------------------
function filas(r: Llamada): any[] {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.rows;
}
const cod = (r: Llamada) => codigoDe(r);
const conteo = (v: unknown): unknown => (Array.isArray(v) ? v.length : v);

interface Esc {
  c: ClientePrueba;
  job: string;
}
/** Cliente nuevo de X con un trabajo `sol.declaraciones.descargar` en ejecucion para `periodo` (por omision 202610). */
async function escenario(periodo = "202610"): Promise<Esc> {
  const c = await ep.cliente(X);
  return { c, job: await ep.jobDescarga(X, c, { periodo }) };
}
const registrar = (e: Esc, a: ArgsRegistrar = {}, revertir = false) =>
  llamar(
    worker,
    { tenantId: X, trabajoId: e.job },
    SQL.registrar,
    argsRegistrar(e.c, e.job, a),
    { revertir },
  );
const guardar = (
  c: ClientePrueba,
  periodo: string,
  version: number,
  o: {
    g?: string;
    e?: string;
    n?: string;
    motivo?: string;
    ctx?: { tenantId: string; userId?: string };
  } = {},
) =>
  llamar(backend, o.ctx ?? comoX(), SQL.guardarManual, [
    c.id,
    periodo,
    o.g ?? "1000.00",
    o.e ?? "0.00",
    o.n ?? "200.00",
    o.motivo ?? "Motivo de prueba",
    version,
  ]);
const eliminar = (
  c: ClientePrueba,
  periodo: string,
  version: number,
  motivo = "Se retira el mes",
) =>
  llamar(backend, comoX(), SQL.eliminarManual, [
    c.id,
    periodo,
    motivo,
    version,
  ]);
const usar = (
  c: ClientePrueba,
  periodo: string,
  version: number,
  porcentaje: string | null,
) =>
  llamar(backend, comoX(), SQL.guardarUsada, [
    c.id,
    periodo,
    porcentaje,
    version,
  ]);

// =================================================================================================
describe("0066 · las cuatro funciones en el catalogo (CA-8)", () => {
  for (const k of Object.keys(FIRMAS) as (keyof typeof FIRMAS)[]) {
    it(`${FIRMAS[k]}: SECURITY DEFINER de contapp_migrator, search_path fijo, sin PUBLIC; solo ${EJECUTA[k]} la ejecuta`, async () => {
      const i = await infoFuncion(admin, FIRMAS[k]).catch(() => {
        throw new Error(`falta la funcion ${FIRMAS[k]} (migracion 0066)`);
      });
      expect(i).toEqual({
        secdef: true,
        config: ["search_path=pg_catalog, pg_temp"],
        dueno: "contapp_migrator",
        duenoSuper: false,
        duenoBypass: false,
      });
      expect(await conExecute(admin, FIRMAS[k], ROLES_FUNCION)).toEqual([
        EJECUTA[k],
      ]);
    });
  }
});

// =================================================================================================
describe("0066 · quien llama: estudio, usuario y membresia activa (42501)", () => {
  let cS: ClientePrueba;
  let jobS: string;
  beforeAll(async () => {
    ({ c: cS, job: jobS } = await escenario());
  });

  /** Llamada valida de cada funcion, con la que se prueban los rechazos de quien llama. */
  const llamadaDe = (k: keyof typeof FIRMAS): [string, unknown[]] => {
    switch (k) {
      case "registrar":
        return [SQL.registrar, argsRegistrar(cS, jobS)];
      case "guardarManual":
        return [
          SQL.guardarManual,
          [cS.id, "202609", "1.00", "0.00", "0.00", "m", 0],
        ];
      case "eliminarManual":
        return [SQL.eliminarManual, [cS.id, "202609", "m", 1]];
      case "guardarUsada":
        return [SQL.guardarUsada, [cS.id, "202609", "50.00", 0]];
    }
  };

  for (const k of Object.keys(FIRMAS) as (keyof typeof FIRMAS)[]) {
    const rol = EJECUTA[k];
    const otroRol =
      rol === "contapp_backend" ? "contapp_worker" : "contapp_backend";
    it(`${k}: sin estudio en la sesion, el rol equivocado y contapp_app dan 42501`, async () => {
      const [sql, valores] = llamadaDe(k);
      const sinEstudio = await comoRolSql(
        admin,
        rol,
        { tenantId: null, userId: ux },
        sql,
        valores,
      );
      expect(sinEstudio.ok ? "ok" : sinEstudio.code, "sin estudio").toBe(
        "42501",
      );
      for (const r of [otroRol, "contapp_app"]) {
        const x = await comoRolSql(
          admin,
          r,
          { tenantId: X, userId: ux },
          sql,
          valores,
        );
        expect(x.ok ? "ok" : x.code, `rol ${r}`).toBe("42501");
      }
    });

    if (rol === "contapp_backend") {
      it(`${k}: sin usuario, miembro desactivado y usuario de otro estudio dan 42501`, async () => {
        const [sql, valores] = llamadaDe(k);
        expect(
          cod(await llamar(backend, { tenantId: X }, sql, valores)),
          "sin usuario",
        ).toBe("42501");
        expect(
          cod(await llamar(backend, { tenantId: X, userId: uD }, sql, valores)),
          "miembro desactivado",
        ).toBe("42501");
        expect(
          cod(await llamar(backend, { tenantId: X, userId: uy }, sql, valores)),
          "usuario de otro estudio",
        ).toBe("42501");
      });
    }
  }
});

// =================================================================================================
describe("0066 · cliente ajeno o inexistente (P0002) y archivado (55000)", () => {
  /** La llamada valida de cada funcion sobre `clienteId` (y `job` solo para registrar). */
  const sobre = (
    k: keyof typeof FIRMAS,
    clienteId: string,
    job: string,
  ): Promise<Llamada> => {
    switch (k) {
      case "registrar":
        return llamar(
          worker,
          { tenantId: X },
          SQL.registrar,
          argsRegistrar(clienteId, job),
        );
      case "guardarManual":
        return llamar(backend, comoX(), SQL.guardarManual, [
          clienteId,
          "202609",
          "1.00",
          "0.00",
          "0.00",
          "m",
          0,
        ]);
      case "eliminarManual":
        return llamar(backend, comoX(), SQL.eliminarManual, [
          clienteId,
          "202609",
          "m",
          1,
        ]);
      case "guardarUsada":
        return llamar(backend, comoX(), SQL.guardarUsada, [
          clienteId,
          "202609",
          "50.00",
          0,
        ]);
    }
  };

  for (const k of Object.keys(FIRMAS) as (keyof typeof FIRMAS)[]) {
    it(`${k}: un cliente de otro estudio y uno inexistente dan P0002; uno archivado da 55000 y no escribe nada`, async () => {
      const jobAjeno = await ep.jobDescarga(Y, cy);
      expect(
        cod(await sobre(k, cy.id, jobAjeno)),
        "cliente de otro estudio",
      ).toBe("P0002");
      expect(
        cod(await sobre(k, idNuevo(), idNuevo())),
        "cliente inexistente",
      ).toBe("P0002");
      const arch = await ep.cliente(X);
      const jobArch = await ep.jobDescarga(X, arch);
      await ep.archivar(arch.id);
      expect(cod(await sobre(k, arch.id, jobArch)), "archivado").toBe("55000");
      expect(await ep.totales(arch.id)).toEqual({
        prorrata_obtencion: 0,
        declaracion_mensual: 0,
        prorrata_mes_manual: 0,
        prorrata_usada_manual: 0,
      });
    });
  }
});

// =================================================================================================
describe("prorrata_declaraciones_registrar (D-3, D-4, CA-1, CA-3, CA-7)", () => {
  it("inserta la obtencion y las presentaciones, devuelve las nuevas y deja los montos exactos, el trabajo y los periodos", async () => {
    const e = await escenario();
    const r = await registrar(e, {
      declaraciones: [
        decl({
          periodo: "202610",
          numeroOrden: "1001",
          prorrataUsada: "87.34",
        }),
        decl({
          periodo: "202609",
          numeroOrden: "2001",
          gravadas: "50000.50",
          exportaciones: "1200.25",
          noGravadas: "0.00",
        }),
      ],
    });
    expect(filas(r)[0].n).toBe(2);
    const ob = await ep.obtenciones(e.c.id);
    expect(ob).toHaveLength(1);
    expect(ob[0]).toMatchObject({
      periodo_hasta: "202610",
      trabajo_id: e.job,
      nuevas: 2,
    });
    expect([...ob[0]!.periodos_leidos].sort()).toEqual(ventana("202610"));
    expect([...ob[0]!.periodos_sin_declaracion].sort()).toEqual(
      ventana("202610").filter((p) => p !== "202610" && p !== "202609"),
    );
    const ds = await ep.declaraciones(e.c.id);
    expect(ds.map((d) => `${d.periodo}:${d.numero_orden}`)).toEqual([
      "202609:2001",
      "202610:1001",
    ]);
    expect(ds[1]).toMatchObject({
      tenant_id: X,
      tipo: "original",
      ventas_gravadas_base: "100000.00",
      ventas_gravadas_igv: "18000.00",
      exportaciones: "0.00",
      no_gravadas: "5000.00",
      igv_adq_dg: "9000.00",
      igv_adq_dgng: "1800.00",
      prorrata_usada: "87.34",
      obtencion_id: ob[0]!.id,
    });
    expect(ds[0]).toMatchObject({
      ventas_gravadas_base: "50000.50",
      exportaciones: "1200.25",
      no_gravadas: "0.00",
      prorrata_usada: null,
    });
  });

  it("repetir la misma obtencion no duplica: devuelve 0 nuevas, deja las filas como estaban y suma otra obtencion con nuevas 0", async () => {
    const e = await escenario();
    expect(filas(await registrar(e))[0].n).toBe(1);
    expect(filas(await registrar(e))[0].n).toBe(0);
    expect(await ep.declaraciones(e.c.id)).toHaveLength(1);
    const ob = await ep.obtenciones(e.c.id);
    expect(ob.map((o) => o.nuevas)).toEqual([1, 0]);
  });

  it("la misma presentacion con otros montos no sobrescribe la guardada (solo inserta presentaciones nuevas)", async () => {
    const e = await escenario();
    await registrar(e);
    const r = await registrar(e, {
      declaraciones: [
        decl({
          periodo: "202610",
          numeroOrden: "1001",
          gravadas: "1.00",
          prorrataUsada: "10.00",
        }),
      ],
    });
    expect(filas(r)[0].n).toBe(0);
    const [d] = await ep.declaraciones(e.c.id, "202610");
    expect(d).toMatchObject({
      ventas_gravadas_base: "100000.00",
      prorrata_usada: null,
    });
  });

  it("una rectificatoria posterior suma su fila y la original queda (el vigente se decide al leer)", async () => {
    const e = await escenario();
    await registrar(e);
    const r = await registrar(e, {
      declaraciones: [
        decl({ periodo: "202610", numeroOrden: "1001" }),
        decl({
          periodo: "202610",
          numeroOrden: "1002",
          tipo: "rectificatoria",
          gravadas: "120000.00",
        }),
      ],
    });
    expect(filas(r)[0].n).toBe(1);
    const ds = await ep.declaraciones(e.c.id, "202610");
    expect(
      ds.map((d) => [d.numero_orden, d.tipo, d.ventas_gravadas_base]),
    ).toEqual([
      ["1001", "original", "100000.00"],
      ["1002", "rectificatoria", "120000.00"],
    ]);
  });

  it("original y rectificatoria en la misma obtencion entran juntas", async () => {
    const e = await escenario();
    const r = await registrar(e, {
      declaraciones: [
        decl({ periodo: "202610", numeroOrden: "1001" }),
        decl({
          periodo: "202610",
          numeroOrden: "1002",
          tipo: "rectificatoria",
        }),
      ],
    });
    expect(filas(r)[0].n).toBe(2);
  });

  it("sin declaraciones (todos los periodos leidos «sin declaracion») es valido: 0 nuevas y queda la obtencion", async () => {
    const e = await escenario();
    expect(filas(await registrar(e, { declaraciones: [] }))[0].n).toBe(0);
    const ob = await ep.obtenciones(e.c.id);
    expect(ob).toHaveLength(1);
    expect(ob[0]!.periodos_sin_declaracion).toHaveLength(12);
    expect(await ep.declaraciones(e.c.id)).toEqual([]);
  });

  it("una lectura parcial (periodos leidos que son un subconjunto de la ventana) es valida", async () => {
    const e = await escenario();
    const r = await registrar(e, {
      leidos: ["202610", "202609", "202608"],
      declaraciones: [decl({ periodo: "202609", numeroOrden: "55" })],
    });
    expect(filas(r)[0].n).toBe(1);
    const [o] = await ep.obtenciones(e.c.id);
    expect([...o!.periodos_leidos].sort()).toEqual([
      "202608",
      "202609",
      "202610",
    ]);
    expect([...o!.periodos_sin_declaracion].sort()).toEqual([
      "202608",
      "202610",
    ]);
  });

  it("la ventana cruza el cambio de ano (R-1): 202602 admite desde 202503 y rechaza 202502", async () => {
    const e = await escenario("202602");
    const ok = await registrar(e, {
      hasta: "202602",
      declaraciones: [decl({ periodo: "202503", numeroOrden: "31" })],
    });
    expect(filas(ok)[0].n).toBe(1);
    const fuera = await registrar(e, {
      hasta: "202602",
      leidos: ["202502"],
      declaraciones: [],
    });
    expect(cod(fuera)).toBe("22023");
  });

  // ---- Entradas invalidas: 22023 a todo y sin cambios --------------------------------------------------------------------------
  describe("entradas invalidas: 22023 y ninguna fila nueva", () => {
    let cV: ClientePrueba;
    let jobV: string;
    let jobTipo: string;
    let jobOtroCliente: string;
    let jobOtroPeriodo: string;
    beforeAll(async () => {
      ({ c: cV, job: jobV } = await escenario());
      jobTipo = await ep.jobDescarga(X, cV, {
        tipo: "sol.buzon.revisar",
        parametros: {},
      });
      jobOtroCliente = await ep.jobDescarga(X, await ep.cliente(X));
      jobOtroPeriodo = await ep.jobDescarga(X, cV, { periodo: "202609" });
    });

    const dcl = (campo: string, valor: unknown) => [
      { ...decl({ periodo: "202610" }), [campo]: valor },
    ];
    const sinCampo = (campo: string) => {
      const d = { ...decl({ periodo: "202610" }) };
      delete (d as Record<string, unknown>)[campo];
      return [d];
    };
    const CASOS: [string, () => unknown[]][] = [
      ["trabajo de otro tipo", () => argsRegistrar(cV, jobTipo)],
      ["trabajo de otro cliente", () => argsRegistrar(cV, jobOtroCliente)],
      ["trabajo de otro periodo", () => argsRegistrar(cV, jobOtroPeriodo)],
      ["trabajo inexistente", () => argsRegistrar(cV, idNuevo())],
      [
        "periodo_hasta con mes 13",
        () =>
          argsRegistrar(cV, jobV, {
            hasta: "202613",
            leidos: ["202610"],
            declaraciones: [],
          }),
      ],
      [
        "periodo_hasta con formato invalido",
        () =>
          argsRegistrar(cV, jobV, {
            hasta: "2026-10",
            leidos: ["202610"],
            declaraciones: [],
          }),
      ],
      [
        "periodo leido fuera de la ventana (M-12)",
        () =>
          argsRegistrar(cV, jobV, {
            leidos: ["202610", "202510"],
            declaraciones: [],
          }),
      ],
      [
        "periodo leido posterior a M",
        () =>
          argsRegistrar(cV, jobV, {
            leidos: ["202610", "202611"],
            declaraciones: [],
          }),
      ],
      [
        "periodos leidos repetidos",
        () =>
          argsRegistrar(cV, jobV, {
            leidos: ["202610", "202610"],
            sinDeclaracion: [],
            declaraciones: [],
          }),
      ],
      [
        "mas de 12 periodos leidos",
        () =>
          argsRegistrar(cV, jobV, {
            leidos: [...ventana("202610"), "202510"],
            declaraciones: [],
          }),
      ],
      [
        "sin declaracion que no esta en los leidos",
        () =>
          argsRegistrar(cV, jobV, {
            leidos: ["202610"],
            sinDeclaracion: ["202609"],
            declaraciones: [],
          }),
      ],
      [
        "declaracion de un periodo no leido",
        () =>
          argsRegistrar(cV, jobV, {
            leidos: ["202610"],
            sinDeclaracion: [],
            declaraciones: [decl({ periodo: "202609" })],
          }),
      ],
      [
        "declaracion en un periodo «sin declaracion»",
        () =>
          argsRegistrar(cV, jobV, {
            leidos: ["202610"],
            sinDeclaracion: ["202610"],
            declaraciones: [decl({ periodo: "202610" })],
          }),
      ],
      [
        "declaraciones que no es un arreglo",
        () => argsRegistrar(cV, jobV, { declaraciones: {} }),
      ],
      [
        "declaracion sin periodo",
        () =>
          argsRegistrar(cV, jobV, {
            leidos: ["202610"],
            sinDeclaracion: [],
            declaraciones: sinCampo("periodo"),
          }),
      ],
      ...[
        "ventas_gravadas_base",
        "ventas_gravadas_igv",
        "exportaciones",
        "no_gravadas",
        "igv_adq_dg",
        "igv_adq_dgng",
      ].flatMap((k): [string, () => unknown[]][] => [
        [
          `${k} fuera de NUMERIC(14,2)`,
          () =>
            argsRegistrar(cV, jobV, {
              declaraciones: dcl(k, "1000000000000.00"),
            }),
        ],
        [
          `${k} con 3 decimales`,
          () => argsRegistrar(cV, jobV, { declaraciones: dcl(k, "10.123") }),
        ],
        [
          `${k} no numerico`,
          () => argsRegistrar(cV, jobV, { declaraciones: dcl(k, "abc") }),
        ],
        [
          `${k} vacio`,
          () => argsRegistrar(cV, jobV, { declaraciones: dcl(k, "") }),
        ],
        [
          `${k} ausente`,
          () => argsRegistrar(cV, jobV, { declaraciones: sinCampo(k) }),
        ],
      ]),
      [
        "prorrata usada 100.01",
        () =>
          argsRegistrar(cV, jobV, {
            declaraciones: dcl("prorrata_usada", "100.01"),
          }),
      ],
      [
        "prorrata usada negativa",
        () =>
          argsRegistrar(cV, jobV, {
            declaraciones: dcl("prorrata_usada", "-1"),
          }),
      ],
      [
        "prorrata usada no numerica",
        () =>
          argsRegistrar(cV, jobV, {
            declaraciones: dcl("prorrata_usada", "abc"),
          }),
      ],
      [
        "prorrata usada con 3 decimales",
        () =>
          argsRegistrar(cV, jobV, {
            declaraciones: dcl("prorrata_usada", "50.123"),
          }),
      ],
      [
        "numero de orden 0",
        () =>
          argsRegistrar(cV, jobV, { declaraciones: dcl("numero_orden", "0") }),
      ],
      [
        "numero de orden vacio",
        () =>
          argsRegistrar(cV, jobV, { declaraciones: dcl("numero_orden", "") }),
      ],
      [
        "numero de orden de 16 digitos",
        () =>
          argsRegistrar(cV, jobV, {
            declaraciones: dcl("numero_orden", "1234567890123456"),
          }),
      ],
      [
        "numero de orden con letras",
        () =>
          argsRegistrar(cV, jobV, {
            declaraciones: dcl("numero_orden", "12a"),
          }),
      ],
      [
        "numero de orden negativo",
        () =>
          argsRegistrar(cV, jobV, { declaraciones: dcl("numero_orden", "-1") }),
      ],
      [
        "fecha con mes 13",
        () =>
          argsRegistrar(cV, jobV, {
            declaraciones: dcl("fecha_presentacion", "2026-13-01"),
          }),
      ],
      [
        "fecha con otro formato",
        () =>
          argsRegistrar(cV, jobV, {
            declaraciones: dcl("fecha_presentacion", "05/11/2026"),
          }),
      ],
      [
        "tipo desconocido",
        () =>
          argsRegistrar(cV, jobV, {
            declaraciones: dcl("tipo", "sustitutoria"),
          }),
      ],
      [
        "tipo nulo",
        () => argsRegistrar(cV, jobV, { declaraciones: dcl("tipo", null) }),
      ],
    ];

    for (const [nombre, args] of CASOS) {
      it(`${nombre} da 22023 y no cambia nada`, async () => {
        const antes = await ep.totales(cV.id);
        const r = await llamar(
          worker,
          { tenantId: X, trabajoId: jobV },
          SQL.registrar,
          args(),
        );
        expect(cod(r)).toBe("22023");
        expect(await ep.totales(cV.id)).toEqual(antes);
      });
    }

    it("una lista con una declaracion mala entre buenas no inserta ninguna (todo o nada)", async () => {
      const antes = await ep.totales(cV.id);
      const r = await registrar(
        { c: cV, job: jobV },
        {
          declaraciones: [
            decl({ periodo: "202610", numeroOrden: "7001" }),
            decl({
              periodo: "202609",
              numeroOrden: "7002",
              prorrataUsada: "100.01",
            }),
          ],
        },
      );
      expect(cod(r)).toBe("22023");
      expect(await ep.totales(cV.id)).toEqual(antes);
    });
  });

  it("no toca ventas, compras ni los manuales: ni crea ni cambia filas, y un manual del mismo mes sigue ahi (R-5: queda en el historial)", async () => {
    const e = await escenario();
    await ep.venta(X, e.c, { periodo: "202610", numero: "501" });
    await ep.manual(X, e.c, { periodo: "202610" });
    await ep.usada(X, e.c, { periodo: "202610" });
    const antes = await ep.contadoresAjenos(X);
    const manualAntes = await ep.manuales(e.c.id);
    expect(filas(await registrar(e))[0].n).toBe(1);
    expect(await ep.contadoresAjenos(X)).toEqual(antes);
    expect(await ep.manuales(e.c.id)).toEqual(manualAntes);
    expect(await ep.usadas(e.c.id)).toHaveLength(1);
  });

  it("audita prorrata.declaraciones_obtenidas por obtencion (tambien la repetida) con actor trabajo, el cliente y datos sin RUC ni montos", async () => {
    const e = await escenario();
    const args: ArgsRegistrar = {
      declaraciones: [
        decl({
          periodo: "202610",
          numeroOrden: "1001",
          gravadas: CANARIO.gravadas,
          exportaciones: CANARIO.exportaciones,
        }),
      ],
    };
    const { filas: aud } = await ep.capturar(
      X,
      "prorrata.declaraciones_obtenidas",
      async () => {
        filas(await registrar(e, args));
        filas(await registrar(e, args));
      },
    );
    expect(aud).toHaveLength(2);
    for (const f of aud) {
      expect(f.actor_tipo).toBe("trabajo");
      expect(f.trabajo_id).toBe(e.job);
      expect(f.cliente_id).toBe(e.c.id);
      expect(Object.keys(f.datos).sort()).toEqual([
        "leidos",
        "nuevas",
        "periodo",
        "sinDeclaracion",
      ]);
      expect(f.datos.periodo).toBe("202610");
      expect(conteo(f.datos.leidos)).toBe(12);
      expect(conteo(f.datos.sinDeclaracion)).toBe(11);
      const t = JSON.stringify(f.datos);
      for (const p of [
        e.c.ruc,
        CANARIO.gravadas,
        CANARIO.exportaciones,
        "100000",
        "18000",
      ])
        expect(t, p).not.toContain(p);
      expect(t, "montos").not.toMatch(/\d+\.\d{2}/);
    }
    expect(aud.map((f) => f.datos.nuevas)).toEqual([1, 0]);
  });
});

// =================================================================================================
describe("prorrata_mes_manual_guardar y prorrata_mes_manual_eliminar (R-5, CA-3, CA-4)", () => {
  it("guardar con version 0 crea la version 1 (devuelve 1) con los montos, el motivo, el autor y el periodo", async () => {
    const c = await ep.cliente(X);
    const r = await guardar(c, "202609", 0, {
      g: "12345.67",
      e: "100.00",
      n: "0.50",
      motivo: "Mes sin PDT: ver libro de ventas",
    });
    expect(filas(r)[0].version).toBe(1);
    const m = await ep.manuales(c.id);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({
      periodo: "202609",
      version: 1,
      accion: "guardado",
      gravadas: "12345.67",
      exportaciones: "100.00",
      no_gravadas: "0.50",
      motivo: "Mes sin PDT: ver libro de ventas",
      autor: ux,
    });
    expect(m[0]!.creado_en).toBeInstanceOf(Date);
  });

  it("un mes en cero («sin operaciones») se guarda igual (CA-4)", async () => {
    const c = await ep.cliente(X);
    expect(
      filas(
        await guardar(c, "202601", 0, { g: "0.00", e: "0.00", n: "0.00" }),
      )[0].version,
    ).toBe(1);
  });

  it("guardar con la version vigente crea la siguiente y las anteriores quedan intactas", async () => {
    const c = await ep.cliente(X);
    await guardar(c, "202609", 0, { g: "100.00", motivo: "primero" });
    expect(
      filas(
        await guardar(c, "202609", 1, { g: "250.00", motivo: "segundo" }),
      )[0].version,
    ).toBe(2);
    const m = await ep.manuales(c.id, "202609");
    expect(m.map((x) => [x.version, x.gravadas, x.motivo])).toEqual([
      [1, "100.00", "primero"],
      [2, "250.00", "segundo"],
    ]);
  });

  it("version vieja o inexistente da CA409 y no cambia nada", async () => {
    const c = await ep.cliente(X);
    expect(cod(await guardar(c, "202609", 3)), "nunca tuvo manual").toBe(
      "CA409",
    );
    await guardar(c, "202609", 0);
    await guardar(c, "202609", 1);
    expect(
      cod(await guardar(c, "202609", 0)),
      "version 0 con dos versiones",
    ).toBe("CA409");
    expect(cod(await guardar(c, "202609", 1)), "version vieja").toBe("CA409");
    expect(cod(await guardar(c, "202609", 5)), "version futura").toBe("CA409");
    expect(await ep.manuales(c.id)).toHaveLength(2);
  });

  it("un mes con declaracion da CA412 y no guarda; otro periodo, otro cliente o el mes siguiente no se bloquean", async () => {
    const c = await ep.cliente(X);
    await ep.declaracion(X, c, { periodo: "202609" });
    expect(cod(await guardar(c, "202609", 0))).toBe("CA412");
    expect(await ep.manuales(c.id)).toEqual([]);
    expect(cod(await guardar(c, "202608", 0)), "otro periodo").toBe("ok");
    const otro = await ep.cliente(X);
    expect(cod(await guardar(otro, "202609", 0)), "otro cliente").toBe("ok");
  });

  it("una declaracion que llega despues de un manual: el manual queda y guardar de nuevo da CA412 (R-5)", async () => {
    const e = await escenario();
    await guardar(e.c, "202610", 0);
    expect(filas(await registrar(e))[0].n).toBe(1);
    expect(await ep.manuales(e.c.id, "202610")).toHaveLength(1);
    expect(cod(await guardar(e.c, "202610", 1))).toBe("CA412");
  });

  it("eliminar crea la version «eliminado» (montos nulos, con su motivo), cuenta como version y se puede volver a guardar", async () => {
    const c = await ep.cliente(X);
    await guardar(c, "202609", 0, { g: "100.00", motivo: "alta" });
    expect(filas(await eliminar(c, "202609", 1, "baja"))[0].version).toBe(2);
    const baja = (await ep.manuales(c.id, "202609"))[1]!;
    expect(baja).toMatchObject({
      version: 2,
      accion: "eliminado",
      gravadas: null,
      exportaciones: null,
      no_gravadas: null,
      motivo: "baja",
      autor: ux,
    });
    expect(cod(await guardar(c, "202609", 0)), "la version 0 ya no vale").toBe(
      "CA409",
    );
    expect(cod(await guardar(c, "202609", 1)), "la version 1 ya no vale").toBe(
      "CA409",
    );
    expect(
      filas(
        await guardar(c, "202609", 2, { g: "300.00", motivo: "de nuevo" }),
      )[0].version,
    ).toBe(3);
    expect(filas(await eliminar(c, "202609", 3))[0].version).toBe(4);
  });

  it("el historial conserva todas las versiones, con sus montos originales (CA-4)", async () => {
    const c = await ep.cliente(X);
    await guardar(c, "202609", 0, { g: "100.00", motivo: "uno" });
    await guardar(c, "202609", 1, { g: "200.00", motivo: "dos" });
    await eliminar(c, "202609", 2, "tres");
    await guardar(c, "202609", 3, { g: "400.00", motivo: "cuatro" });
    const m = await ep.manuales(c.id, "202609");
    expect(m.map((x) => [x.version, x.accion, x.gravadas, x.motivo])).toEqual([
      [1, "guardado", "100.00", "uno"],
      [2, "guardado", "200.00", "dos"],
      [3, "eliminado", null, "tres"],
      [4, "guardado", "400.00", "cuatro"],
    ]);
  });

  it("eliminar sin manual vivo, con la version equivocada o ya eliminado da CA409 y no escribe", async () => {
    const c = await ep.cliente(X);
    expect(cod(await eliminar(c, "202609", 1)), "nunca tuvo manual").toBe(
      "CA409",
    );
    await guardar(c, "202609", 0);
    expect(cod(await eliminar(c, "202609", 0)), "version 0").toBe("CA409");
    expect(cod(await eliminar(c, "202609", 2)), "version futura").toBe("CA409");
    await eliminar(c, "202609", 1);
    expect(cod(await eliminar(c, "202609", 2)), "ya eliminado").toBe("CA409");
    expect(await ep.manuales(c.id)).toHaveLength(2);
  });

  it("las versiones son por cliente y por periodo: dos clientes o dos periodos empiezan los dos en 0", async () => {
    const a = await ep.cliente(X);
    const b = await ep.cliente(X);
    for (const [c, p] of [
      [a, "202609"],
      [b, "202609"],
      [a, "202608"],
    ] as const)
      expect(filas(await guardar(c, p, 0))[0].version, `${c.id} ${p}`).toBe(1);
  });

  it("audita prorrata.mes_manual_guardado y prorrata.mes_manual_eliminado: actor usuario, cliente y datos {clienteId, periodo, version}, sin montos, motivo ni RUC", async () => {
    const c = await ep.cliente(X);
    const g = await ep.capturar(X, "prorrata.mes_manual_guardado", async () => {
      filas(
        await guardar(c, "202609", 0, {
          g: CANARIO.gravadas,
          e: CANARIO.exportaciones,
          n: CANARIO.noGravadas,
          motivo: CANARIO.motivo,
        }),
      );
    });
    expect(g.filas).toHaveLength(1);
    expect(g.filas[0]).toMatchObject({
      actor_tipo: "usuario",
      usuario_id: ux,
      cliente_id: c.id,
    });
    expect(g.filas[0]!.datos).toEqual({
      clienteId: c.id,
      periodo: "202609",
      version: 1,
    });
    const el = await ep.capturar(
      X,
      "prorrata.mes_manual_eliminado",
      async () => {
        filas(await eliminar(c, "202609", 1, CANARIO.motivo));
      },
    );
    expect(el.filas).toHaveLength(1);
    expect(el.filas[0]).toMatchObject({
      actor_tipo: "usuario",
      usuario_id: ux,
      cliente_id: c.id,
    });
    expect(el.filas[0]!.datos).toEqual({
      clienteId: c.id,
      periodo: "202609",
      version: 2,
    });
    for (const f of [...g.filas, ...el.filas]) {
      const t = JSON.stringify(f.datos);
      for (const p of [
        CANARIO.motivo,
        CANARIO.gravadas,
        CANARIO.exportaciones,
        CANARIO.noGravadas,
        c.ruc,
      ])
        expect(t, p).not.toContain(p);
    }
  });

  it("un rechazo (CA409 o CA412) no deja auditoria", async () => {
    const c = await ep.cliente(X);
    const antes = await ep.cuantas(X);
    expect(cod(await guardar(c, "202609", 4))).toBe("CA409");
    expect(cod(await eliminar(c, "202609", 1))).toBe("CA409");
    await ep.declaracion(X, c, { periodo: "202608" });
    expect(cod(await guardar(c, "202608", 0))).toBe("CA412");
    expect(await ep.cuantas(X)).toBe(antes);
  });
});

// =================================================================================================
describe("prorrata_usada_guardar (R-8, U-9, CA-6)", () => {
  it("sin PDT del periodo guarda la version 1 con el porcentaje y el autor; la siguiente version puede dejarlo nulo", async () => {
    const c = await ep.cliente(X);
    expect(filas(await usar(c, "202610", 0, "63.21"))[0].version).toBe(1);
    expect(filas(await usar(c, "202610", 1, null))[0].version).toBe(2);
    const u = await ep.usadas(c.id, "202610");
    expect(u.map((x) => [x.version, x.porcentaje, x.autor])).toEqual([
      [1, "63.21", ux],
      [2, null, ux],
    ]);
  });

  it("un PDT que no trae la prorrata (o un periodo con PDT de otro mes) no impide guardarla", async () => {
    const c = await ep.cliente(X);
    await ep.declaracion(X, c, { periodo: "202610", prorrataUsada: null });
    await ep.declaracion(X, c, { periodo: "202609", prorrataUsada: "40.00" });
    expect(cod(await usar(c, "202610", 0, "63.21")), "PDT sin prorrata").toBe(
      "ok",
    );
    const sinPdt = await ep.cliente(X);
    expect(cod(await usar(sinPdt, "202610", 0, "63.21")), "sin PDT").toBe("ok");
  });

  it("un PDT que trae la prorrata (tambien 0.00) da CA413 y no guarda", async () => {
    for (const p of ["63.21", "0.00"]) {
      const c = await ep.cliente(X);
      await ep.declaracion(X, c, { periodo: "202610", prorrataUsada: p });
      expect(cod(await usar(c, "202610", 0, "50.00")), p).toBe("CA413");
      expect(await ep.usadas(c.id)).toEqual([]);
    }
  });

  it("decide el PDT vigente (mayor numero de orden): una rectificatoria sin prorrata la libera; una con prorrata la bloquea", async () => {
    const libera = await ep.cliente(X);
    await ep.declaracion(X, libera, {
      periodo: "202610",
      numeroOrden: "1001",
      prorrataUsada: "70.00",
    });
    await ep.declaracion(X, libera, {
      periodo: "202610",
      numeroOrden: "1002",
      tipo: "rectificatoria",
      prorrataUsada: null,
    });
    expect(
      cod(await usar(libera, "202610", 0, "50.00")),
      "la vigente no la trae",
    ).toBe("ok");
    const bloquea = await ep.cliente(X);
    await ep.declaracion(X, bloquea, {
      periodo: "202610",
      numeroOrden: "1001",
      prorrataUsada: null,
    });
    await ep.declaracion(X, bloquea, {
      periodo: "202610",
      numeroOrden: "1002",
      tipo: "rectificatoria",
      prorrataUsada: "70.00",
    });
    expect(
      cod(await usar(bloquea, "202610", 0, "50.00")),
      "la vigente la trae",
    ).toBe("CA413");
  });

  it("compare-and-set por version: la version equivocada da CA409; repetir la version 0 da CA409; la siguiente sale bien", async () => {
    const c = await ep.cliente(X);
    expect(cod(await usar(c, "202610", 2, "10.00")), "nunca tuvo").toBe(
      "CA409",
    );
    await usar(c, "202610", 0, "10.00");
    expect(cod(await usar(c, "202610", 0, "20.00")), "repetida").toBe("CA409");
    expect(filas(await usar(c, "202610", 1, "20.00"))[0].version).toBe(2);
    expect((await ep.usadas(c.id)).map((x) => x.porcentaje)).toEqual([
      "10.00",
      "20.00",
    ]);
  });

  it("porcentaje fuera de 0..100 falla (22023 o el CHECK 23514) y no guarda", async () => {
    const c = await ep.cliente(X);
    for (const p of ["100.01", "-0.01"]) {
      expect(["22023", "23514"], p).toContain(
        cod(await usar(c, "202610", 0, p)),
      );
    }
    expect(await ep.usadas(c.id)).toEqual([]);
    expect(cod(await usar(c, "202610", 0, "100.00")), "el limite entra").toBe(
      "ok",
    );
  });

  it("audita prorrata.usada_guardada: actor usuario, cliente y datos {clienteId, periodo, version}, sin el porcentaje ni el RUC", async () => {
    const c = await ep.cliente(X);
    const { filas: aud } = await ep.capturar(
      X,
      "prorrata.usada_guardada",
      async () => {
        filas(await usar(c, "202610", 0, CANARIO.porcentaje));
      },
    );
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({
      actor_tipo: "usuario",
      usuario_id: ux,
      cliente_id: c.id,
    });
    expect(aud[0]!.datos).toEqual({
      clienteId: c.id,
      periodo: "202610",
      version: 1,
    });
    expect(JSON.stringify(aud[0]!.datos)).not.toContain(CANARIO.porcentaje);
    expect(JSON.stringify(aud[0]!.datos)).not.toContain(c.ruc);
  });
});

// =================================================================================================
describe("auditoria de las cuatro acciones sin montos, motivos ni RUC (D-6, D-7, CA-10)", () => {
  it("obtener, guardar, eliminar y prorrata usada no dejan canarios ni cifras con decimales en los datos de la auditoria", async () => {
    const e = await escenario();
    const previas = new Map<string, Set<string>>();
    for (const a of ACCIONES_PRORRATA)
      previas.set(a, new Set((await ep.filas(X, a)).map((f) => f.id)));
    filas(
      await registrar(e, {
        declaraciones: [
          decl({
            periodo: "202610",
            gravadas: CANARIO.gravadas,
            exportaciones: CANARIO.exportaciones,
            noGravadas: CANARIO.noGravadas,
          }),
        ],
      }),
    );
    filas(
      await guardar(e.c, "202609", 0, {
        g: CANARIO.gravadas,
        e: CANARIO.exportaciones,
        n: CANARIO.noGravadas,
        motivo: CANARIO.motivo,
      }),
    );
    filas(await eliminar(e.c, "202609", 1, CANARIO.motivo));
    filas(await usar(e.c, "202608", 0, CANARIO.porcentaje));
    const nuevas = [];
    for (const a of ACCIONES_PRORRATA)
      for (const f of await ep.filas(X, a))
        if (!previas.get(a)!.has(f.id)) nuevas.push(f);
    expect(new Set(nuevas.map((f) => f.accion))).toEqual(
      new Set(ACCIONES_PRORRATA),
    );
    for (const f of nuevas) {
      const t = JSON.stringify(f.datos);
      for (const p of [e.c.ruc, ...Object.values(CANARIO)])
        expect(t, `${f.accion}: ${p}`).not.toContain(p);
      expect(t, `${f.accion}: montos`).not.toMatch(/\d+\.\d{2}/);
    }
  });
});

// =================================================================================================
describe("sin SAVEPOINT en el worker (D-3, CA-7; nota de 0038)", () => {
  it("la funcion del worker funciona sin SAVEPOINT; insertar en declaracion_mensual desde el rol del worker dentro de un SAVEPOINT sigue dando 42501", async () => {
    const e = await escenario();
    const control = await registrar(e);
    expect(filas(control)[0].n, "control sin SAVEPOINT").toBe(1);
    const obtencionId = (await ep.obtenciones(e.c.id))[0]!.id;
    const dentro = await worker.withTenant(
      { tenantId: X, trabajoId: e.job },
      async (tx) => {
        await tx.query("SAVEPOINT sp_026");
        try {
          await tx.query(
            `insert into declaracion_mensual (cliente_id, periodo, numero_orden, fecha_presentacion, tipo, ventas_gravadas_base,
             ventas_gravadas_igv, exportaciones, no_gravadas, igv_adq_dg, igv_adq_dgng, obtencion_id)
           values ($1, '202609', 99, '2026-11-05', 'original', 1, 1, 0, 0, 0, 0, $2)`,
            [e.c.id, obtencionId],
          );
          return "ok";
        } catch (err) {
          await tx.query("ROLLBACK TO SAVEPOINT sp_026");
          return String((err as { code?: string }).code);
        }
      },
    );
    expect(dentro).toBe("42501");
    expect(await ep.declaraciones(e.c.id, "202609")).toEqual([]);
  });
});
