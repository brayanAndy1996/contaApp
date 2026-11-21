import { readFileSync } from "node:fs";
import type { ContappDb } from "@contapp/db";
import type { FilaPropuestaSire } from "@contapp/sunat";
import type { Redis } from "ioredis";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { esperarTerminal } from "../../../test/procesadores-007b.js";
import {
  RUC_FIXTURE,
  SireApiControlado,
  cambiosEntre,
  comprasDe,
  encolarDescarga,
  filaCompra,
  fotoDe,
  limpiarCompras,
  mundoVentas,
  nuevaVersion,
  reglasDe,
  versionesDe,
  type MundoVentas,
} from "../../../test/compras.js";
import {
  fijarPerfil,
  hallazgosStdDe,
  rucProveedor,
  type PerfilCliente,
} from "../../../test/importar-historial.js";
import {
  esperadoMd5,
  fijarInterruptor,
  limpiarReglas,
  md5Version,
  sembrarRegla,
} from "../../../test/reglas.js";
import {
  Escenario,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  esperarHasta,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  restaurarConfig,
  type ProcesoWorker,
} from "../../../test/trabajos.js";
import {
  NUMEROS_FIXTURE,
  arrancarXml,
  esperarLotesXml,
  evaluacionesDe,
  hallazgosEvaluadosDe,
  limpiarXml,
  puertosXml,
  type PuertosXml,
} from "../../../test/xml.js";

// Spec 025, T5 (rojo; integración con PostgreSQL y Redis reales, BullMQ real, el mock de SireApiClient y `MockXmlProvider`): R-STD,
// el modo estándar por perfil del cliente (RF-113, D-8, D-9; CA-9, CA-10, CA-11). La descarga de compras (014) y la re-evaluación de
// `xml.obtener` (016) leen el perfil del cliente (columnas de 0026) y los proveedores con regla activa y los pasan al dominio.
//
// CONTRATO que fija (T11 worker, T8 dominio), además del de `test/importar-historial.ts`:
// - Un cliente que cumple U-4 (`zona = 'amazonia'`, `ventas_exoneradas`, no `ventas_mixtas`) recibe en la descarga un hallazgo
//   `R-STD` (sugerencia `{tipo: "clasificar"}`, sin confirmación, lecturas `biDg`, `igvDg`, `biDgng`, `igvDgng` como cadenas) en cada
//   compra con base DG o DGNG distinta de cero y de un proveedor SIN regla aprendida activa. No lo recibe: fuera del criterio (cada
//   una de las tres condiciones), proveedor con regla activa (también si es DG), fila solo con DNG, fila sin base gravada, ni con
//   R-STD apagada en el estudio. Convive con R-NEW, R-ISC y R-MIX.
// - Cambiar el perfil después NO toca versiones ni hallazgos guardados (D-9, solo inserción): la re-evaluación de `xml.obtener`
//   (evaluación `n + 1`) y la descarga siguiente sí sugieren. La versión 1 es idéntica a la fila del SIRE (RNF-052).
// - La compra ya clasificada por el contador no vuelve a recibir R-STD (D-8, CA-10); apagar R-STD no borra lo guardado.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

let admin: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
let prefijo = nuevoPrefijo();
const prefijos = [prefijo];
beforeEach(() => {
  prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
});

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  redis = conectarRedis();
  e = new Escenario(admin);
  await fijarConfig(admin, "sire", {
    global: 4,
    tenant: 2,
    espera: 0,
    reintentos: 1,
    base: 100,
  });
  await fijarConfig(admin, "xml", {
    global: 4,
    tenant: 2,
    espera: 0,
    reintentos: 2,
    base: 100,
  });
});

afterAll(async () => {
  await restaurarConfig(admin).catch(() => undefined);
  await limpiarReglas(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarXml(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarCompras(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos)
    await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

const CUMPLE: PerfilCliente = {
  zona: "amazonia",
  ventasExoneradas: true,
  ventasMixtas: false,
};

/**
 * Worker con el XmlProvider y el storage de la prueba y, si se da, el puerto SIRE de la prueba. `simulado` enciende la
 * re-evaluación simulada de `xml.obtener` (evaluación 2): solo para las pruebas que esperan el XML; las demás leen
 * la BD mientras corre y no deben competir con una evaluación 2 que agrega hallazgos R-STD.
 */
async function conWorker<T>(
  p: PuertosXml,
  fn: (w: ProcesoWorker) => Promise<T>,
  api?: SireApiControlado,
  simulado = false,
): Promise<T> {
  const w = await arrancarXml(prefijo, p, {
    simuladoEnReglas: simulado,
    ...(api === undefined ? {} : { sireApi: api }),
  });
  if (api !== undefined) api.contarTx = () => w.dbEstado.abiertas;
  try {
    return await fn(w);
  } finally {
    await w.detener({ esperaMs: 2000 });
  }
}

async function descargar(m: MundoVentas, periodo?: string, timeoutMs = 60_000) {
  const id = await encolarDescarga(backend, redis, prefijo, m, {
    libro: "compras",
    ...(periodo === undefined ? {} : { periodo }),
  });
  const f = await esperarTerminal(e, id, timeoutMs);
  return { estado: f.estado, motivo: f.motivo };
}

/** Lo ya guardado (compras, versiones y hallazgos) sigue idéntico; el estado del periodo no es parte de esta comparación. */
const cambiosGuardados = (
  antes: Awaited<ReturnType<typeof fotoDe>>,
  despues: Awaited<ReturnType<typeof fotoDe>>,
) =>
  cambiosEntre(antes, despues).filter((c) => !c.startsWith("compra_periodo"));

const lotes = (m: MundoVentas, minimo: number, timeoutMs = 25_000) =>
  esperarLotesXml(admin, m.c.id, minimo, esperarHasta, timeoutMs);

const responder = (api: SireApiControlado, filas: FilaPropuestaSire[]) =>
  api.responder(filas as never);

async function compraDe(m: MundoVentas, numero: string, periodo?: string) {
  const c = (await comprasDe(admin, m.c.id, periodo)).find(
    (x) => x.numero === numero,
  );
  expect(c, `compra ${numero}`).toBeDefined();
  return c!;
}

const stdDe = async (m: MundoVentas, numero: string, periodo?: string) =>
  hallazgosStdDe(admin, (await compraDe(m, numero, periodo)).id);

const CEROS = {
  biDg: "0.00",
  igvDg: "0.00",
  biDgng: "0.00",
  igvDgng: "0.00",
  biDng: "0.00",
  igvDng: "0.00",
};

const P = {
  X: rucProveedor(101), // sin regla
  Y: rucProveedor(102), // regla activa en DNG
  Z: rucProveedor(103), // regla activa en DG
  W: rucProveedor(104), // regla desactivada
  V: rucProveedor(105), // solo DNG
  U: rucProveedor(106), // sin base gravada
  T: rucProveedor(107), // mixta DG + DGNG
  S: rucProveedor(108), // solo DGNG
};

const fila = (
  numero: string,
  ruc: string,
  extra: Partial<FilaPropuestaSire> = {},
): FilaPropuestaSire => filaCompra(numero, { rucContraparte: ruc, ...extra });

/** Las ocho compras de la matriz de CA-9 (periodo 202610). */
const MATRIZ = (): FilaPropuestaSire[] => [
  fila("1", P.X),
  fila("2", P.Y),
  fila("3", P.Z),
  fila("4", P.W),
  fila("5", P.V, { ...CEROS, biDng: "100.00", igvDng: "18.00" }),
  fila("6", P.U, { ...CEROS, noGravado: "50.00", total: "50.00" }),
  fila("7", P.T, {
    biDg: "60.00",
    igvDg: "10.80",
    biDgng: "40.00",
    igvDgng: "7.20",
    total: "118.00",
  }),
  fila("8", P.S, { ...CEROS, biDgng: "100.00", igvDgng: "18.00" }),
];

/** Con regla de 021: Y en DNG y Z en DG (activas, aprendidas antes); W con la regla desactivada. */
async function sembrarReglasMatriz(m: MundoVentas): Promise<void> {
  await sembrarRegla(admin, m, { docNumero: P.Y, destino: "DNG" });
  await sembrarRegla(admin, m, { docNumero: P.Z, destino: "DG" });
  await sembrarRegla(admin, m, {
    docNumero: P.W,
    destino: "DNG",
    activa: false,
  });
}

// ---------------------------------------------------------------------------------------------------------------
describe("CA-9: R-STD en la descarga de un cliente que cumple U-4", () => {
  it("sugiere DNG en las compras sin regla activa con base DG o DGNG; en las demás, nada", async () => {
    const m = await mundoVentas(e, backend);
    await fijarPerfil(admin, m.c.id, CUMPLE);
    await sembrarReglasMatriz(m);
    const api = new SireApiControlado();
    responder(api, MATRIZ());
    const r = await conWorker(puertosXml(), () => descargar(m), api);
    expect(r).toEqual({ estado: "completado", motivo: null });

    const con: Array<[string, string]> = [
      ["1", "sin regla"],
      ["4", "regla desactivada (no es activa)"],
      ["7", "mixta DG + DGNG"],
      ["8", "solo DGNG"],
    ];
    for (const [numero, motivo] of con) {
      const hs = await stdDe(m, numero);
      expect(hs, `${numero} (${motivo})`).toHaveLength(1);
      expect(hs[0], `${numero} (${motivo})`).toMatchObject({
        version_n: 1,
        evaluacion_n: 1,
        requiere_confirmacion: false,
        sugerencia: { tipo: "clasificar" },
      });
    }
    // Lo que guarda: las lecturas con los montos de la fila como cadenas.
    expect((await stdDe(m, "1"))[0]!.lecturas).toEqual({
      biDg: "100.00",
      igvDg: "18.00",
      biDgng: "0.00",
      igvDgng: "0.00",
    });
    expect((await stdDe(m, "7"))[0]!.lecturas).toEqual({
      biDg: "60.00",
      igvDg: "10.80",
      biDgng: "40.00",
      igvDgng: "7.20",
    });
    expect((await stdDe(m, "8"))[0]!.lecturas).toEqual({
      biDg: "0.00",
      igvDg: "0.00",
      biDgng: "100.00",
      igvDgng: "18.00",
    });

    const sin: Array<[string, string]> = [
      ["2", "proveedor con regla activa en DNG"],
      ["3", "proveedor con regla activa en DG"],
      ["5", "fila solo con DNG"],
      ["6", "fila sin base gravada"],
    ];
    for (const [numero, motivo] of sin)
      expect(await stdDe(m, numero), `${numero} (${motivo})`).toEqual([]);
  });

  it("convive con R-NEW, R-ISC y R-MIX en la misma compra y no cambia la versión 1 (RNF-052)", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await fijarPerfil(admin, m.c.id, CUMPLE);
    const r = await conWorker(
      puertosXml(),
      () => descargar(m),
      undefined,
      true,
    );
    expect(r).toEqual({ estado: "completado", motivo: null });

    const compras = new Map(
      (await comprasDe(admin, m.c.id)).map((c) => [c.numero, c]),
    );
    expect([...compras.keys()].sort()).toEqual([...NUMEROS_FIXTURE].sort());
    for (const n of NUMEROS_FIXTURE) {
      expect(await reglasDe(admin, compras.get(n)!.id), n).toEqual(
        expect.arrayContaining(["R-NEW", "R-STD"]),
      );
    }
    // La de San Juan trae R-ISC y la mixta de 21.48 / 1.61 trae R-MIX, además de R-STD.
    expect(await reglasDe(admin, compras.get("1040")!.id)).toEqual(
      expect.arrayContaining(["R-ISC", "R-STD"]),
    );
    expect(await reglasDe(admin, compras.get("2056")!.id)).toEqual(
      expect.arrayContaining(["R-MIX", "R-STD"]),
    );

    // RNF-052: R-STD es solo un hallazgo; la versión 1 de cada compra es la fila que trajo el SIRE.
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../../../../fixtures/sire/20700000002-compras-202610.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { filas: FilaPropuestaSire[] };
    for (const fx of fixture.filas) {
      const c = compras.get(fx.numero)!;
      expect(c.version_vigente, fx.numero).toBe(1);
      expect(
        (await versionesDe(admin, c.id)).map((v) => [v.n, v.accion]),
        fx.numero,
      ).toEqual([[1, "original"]]);
      expect(await md5Version(admin, c.id, 1), `md5 ${fx.numero}`).toBe(
        esperadoMd5(fx as never),
      );
    }
  });

  it.each<[string, Partial<PerfilCliente>]>([
    ["zona general", { zona: "general" }],
    ["sin ventas exoneradas", { ventasExoneradas: false }],
    ["con ventas mixtas", { ventasMixtas: true }],
  ])(
    "fuera del criterio (%s): ninguna compra recibe R-STD",
    async (_nombre, cambio) => {
      const m = await mundoVentas(e, backend);
      await fijarPerfil(admin, m.c.id, { ...CUMPLE, ...cambio });
      const api = new SireApiControlado();
      responder(api, MATRIZ());
      const r = await conWorker(puertosXml(), () => descargar(m), api);
      expect(r).toEqual({ estado: "completado", motivo: null });
      for (const n of ["1", "2", "3", "4", "5", "6", "7", "8"])
        expect(await stdDe(m, n), n).toEqual([]);
      // Control: el resto de las reglas sí se evaluó (un proveedor sin historial es R-NEW).
      expect(await reglasDe(admin, (await compraDe(m, "1")).id)).toContain(
        "R-NEW",
      );
    },
  );

  it("perfil por omisión (zona general, sin ventas exoneradas): igual que antes de 025, sin R-STD", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado();
    responder(api, MATRIZ());
    await conWorker(puertosXml(), () => descargar(m), api);
    for (const n of ["1", "7", "8"]) expect(await stdDe(m, n), n).toEqual([]);
  });

  it("R-STD apagada en el estudio (RF-089): ninguna compra la recibe y las demás reglas siguen", async () => {
    const m = await mundoVentas(e, backend);
    await fijarPerfil(admin, m.c.id, CUMPLE);
    await fijarInterruptor(admin, m, "R-STD", false);
    const api = new SireApiControlado();
    responder(api, MATRIZ());
    const r = await conWorker(puertosXml(), () => descargar(m), api);
    expect(r).toEqual({ estado: "completado", motivo: null });
    for (const n of ["1", "4", "7", "8"])
      expect(await stdDe(m, n), n).toEqual([]);
    expect(await reglasDe(admin, (await compraDe(m, "1")).id)).toContain(
      "R-NEW",
    );
  });

  it("el interruptor es del estudio: otro estudio con R-STD encendida y el mismo perfil sigue recibiéndola", async () => {
    const apagado = await mundoVentas(e, backend);
    const encendido = await mundoVentas(e, backend);
    for (const m of [apagado, encendido])
      await fijarPerfil(admin, m.c.id, CUMPLE);
    await fijarInterruptor(admin, apagado, "R-STD", false);
    const api = new SireApiControlado();
    responder(api, [fila("1", P.X)]);
    await conWorker(
      puertosXml(),
      async () => {
        expect((await descargar(apagado)).estado).toBe("completado");
        expect((await descargar(encendido)).estado).toBe("completado");
      },
      api,
    );
    expect(await stdDe(apagado, "1")).toEqual([]);
    expect(await stdDe(encendido, "1")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-11: el perfil se lee al evaluar; lo guardado no cambia (D-9)", () => {
  it("perfil marcado entre la descarga y la llegada del XML: versiones y hallazgos guardados intactos; la evaluación 2 sí sugiere R-STD", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const p = puertosXml();
    // El XML llega después de la descarga (queda detenido en el proveedor): entre una cosa y otra se marca el perfil.
    p.xml.pausar();
    const lote = await conWorker(
      p,
      async () => {
        expect((await descargar(m)).estado).toBe("completado");
        await esperarHasta(
          () => p.xml.llamadas.length > 0,
          "el proveedor recibe el pedido",
        );
        const compras0 = await comprasDe(admin, m.c.id);
        for (const c of compras0)
          expect(await hallazgosStdDe(admin, c.id), c.numero).toEqual([]);

        const antes = await fotoDe(admin, m.c.id);
        await fijarPerfil(admin, m.c.id, CUMPLE);
        // Cambiar el perfil no toca nada de lo guardado.
        expect(cambiosGuardados(antes, await fotoDe(admin, m.c.id))).toEqual(
          [],
        );
        p.xml.abrir();
        const l = await lotes(m, 1);
        return { l, antes };
      },
      undefined,
      true,
    );
    expect(lote.l[0]).toMatchObject({
      estado: "completado",
      resultado: { guardados: 5 },
    });

    const despues = await fotoDe(admin, m.c.id);
    // Solo inserción: lo de antes (compras, versiones y hallazgos de la evaluación 1) sigue idéntico.
    expect(cambiosGuardados(lote.antes, despues)).toEqual([]);

    const compras = new Map(
      (await comprasDe(admin, m.c.id)).map((c) => [c.numero, c]),
    );
    for (const n of NUMEROS_FIXTURE) {
      const c = compras.get(n)!;
      expect(c.version_vigente, n).toBe(1);
      expect(
        (await evaluacionesDe(admin, c.id)).map((x) => [x.version_n, x.n]),
        n,
      ).toEqual([
        [1, 1],
        [1, 2],
      ]);
      const std = await hallazgosStdDe(admin, c.id);
      expect(
        std.map((h) => [h.version_n, h.evaluacion_n]),
        `${n}: R-STD solo en la evaluación 2`,
      ).toEqual([[1, 2]]);
      expect(std[0]).toMatchObject({
        requiere_confirmacion: false,
        sugerencia: { tipo: "clasificar" },
      });
    }
  });

  it("la descarga siguiente, con el perfil ya marcado, sí sugiere; el periodo anterior queda como estaba", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado().responder(((s: { periodo: string }) =>
      s.periodo === "202610" ? [fila("1", P.X)] : [fila("11", P.X)]) as never);
    await conWorker(
      puertosXml(),
      async () => {
        expect((await descargar(m, "202610")).estado).toBe("completado");
        await fijarPerfil(admin, m.c.id, CUMPLE);
        const antes = await fotoDe(admin, m.c.id);
        expect((await descargar(m, "202611")).estado).toBe("completado");
        expect(cambiosGuardados(antes, await fotoDe(admin, m.c.id))).toEqual(
          [],
        );
      },
      api,
    );
    expect(await stdDe(m, "1", "202610")).toEqual([]);
    expect(await stdDe(m, "11", "202611")).toHaveLength(1);
  });

  it("la versión 1 de las compras del SIRE queda idéntica a la fila aunque R-STD sugiera (md5 de la versión 1)", async () => {
    const m = await mundoVentas(e, backend);
    await fijarPerfil(admin, m.c.id, CUMPLE);
    const filas = [
      fila("1", P.X),
      fila("2", P.T, {
        biDg: "60.00",
        igvDg: "10.80",
        biDgng: "40.00",
        igvDgng: "7.20",
      }),
    ];
    const api = new SireApiControlado();
    responder(api, filas);
    await conWorker(puertosXml(), () => descargar(m), api);
    for (const f of filas) {
      const c = await compraDe(m, f.numero);
      expect(await hallazgosStdDe(admin, c.id), f.numero).toHaveLength(1);
      expect(c.version_vigente, f.numero).toBe(1);
      expect(await md5Version(admin, c.id, 1), f.numero).toBe(
        esperadoMd5(f as never),
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-9, CA-10: R-STD en la re-evaluación de xml.obtener", () => {
  /** Descarga con el XML detenido, deja que `antes` toque la BD y suelta el XML; devuelve las compras por número. */
  async function conXmlTardio(
    m: MundoVentas,
    antesDelXml: () => Promise<void> = async () => undefined,
  ) {
    const p = puertosXml();
    p.xml.pausar();
    return conWorker(
      p,
      async () => {
        expect((await descargar(m)).estado).toBe("completado");
        await esperarHasta(
          () => p.xml.llamadas.length > 0,
          "el proveedor recibe el pedido",
        );
        await antesDelXml();
        p.xml.abrir();
        const l = await lotes(m, 1);
        expect(l[0]).toMatchObject({
          estado: "completado",
          resultado: { guardados: 5 },
        });
        return new Map(
          (await comprasDe(admin, m.c.id)).map((c) => [c.numero, c]),
        );
      },
      undefined,
      true,
    );
  }

  it("R-STD apagada entre la descarga y el XML: la evaluación 2 no la trae y la 1 guardada no se borra", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await fijarPerfil(admin, m.c.id, CUMPLE);
    const compras = await conXmlTardio(m, () =>
      fijarInterruptor(admin, m, "R-STD", false),
    );
    for (const n of NUMEROS_FIXTURE) {
      const hs = await hallazgosStdDe(admin, compras.get(n)!.id);
      expect(
        hs.map((h) => [h.version_n, h.evaluacion_n]),
        n,
      ).toEqual([[1, 1]]);
      // Control: las demás reglas siguen evaluándose con el XML.
      const todos = await hallazgosEvaluadosDe(admin, compras.get(n)!.id);
      expect(
        todos.filter((h) => h.evaluacion_n === 2).length,
        `${n}: evaluación 2 con otras reglas`,
      ).toBeGreaterThan(0);
    }
  });

  it("proveedor con regla activa (también DG): ni en la descarga ni en la re-evaluación; los demás sí en las dos", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await fijarPerfil(admin, m.c.id, CUMPLE);
    // La regla es del proveedor de la compra 2056, en DG: la descarga no la mueve y R-STD tampoco debe sugerirla.
    await sembrarRegla(admin, m, { docNumero: "20700000045", destino: "DG" });
    const compras = await conXmlTardio(m);
    const dosCincuentaYSeis = await hallazgosStdDe(
      admin,
      compras.get("2056")!.id,
    );
    expect(dosCincuentaYSeis, "2056 (proveedor con regla activa)").toEqual([]);
    for (const n of NUMEROS_FIXTURE.filter((x) => x !== "2056")) {
      const hs = await hallazgosStdDe(admin, compras.get(n)!.id);
      expect(
        hs.map((h) => [h.version_n, h.evaluacion_n]),
        n,
      ).toEqual([
        [1, 1],
        [1, 2],
      ]);
    }
  });

  it("clasificada a mano antes de que llegue el XML: la re-evaluación no vuelve a sugerir R-STD en esa compra; en las demás sí", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await fijarPerfil(admin, m.c.id, CUMPLE);
    let clasificada = "";
    const compras = await conXmlTardio(m, async () => {
      const c = await compraDe(m, "1040");
      clasificada = c.id;
      // El contador la clasifica (nueva versión `clasificada`, montos iguales).
      await nuevaVersion(admin, m, c.id, { clasificada: true });
    });
    const std = await hallazgosStdDe(admin, clasificada);
    // De la descarga queda lo guardado (versión 1); la versión clasificada no recibe R-STD en ninguna evaluación.
    expect(
      std.map((h) => [h.version_n, h.evaluacion_n]),
      "1040",
    ).toEqual([[1, 1]]);
    expect(compras.get("1040")!.version_vigente).toBe(2);
    for (const n of NUMEROS_FIXTURE.filter((x) => x !== "1040")) {
      const hs = await hallazgosStdDe(admin, compras.get(n)!.id);
      expect(
        hs.map((h) => [h.version_n, h.evaluacion_n]),
        n,
      ).toEqual([
        [1, 1],
        [1, 2],
      ]);
    }
  });
});
