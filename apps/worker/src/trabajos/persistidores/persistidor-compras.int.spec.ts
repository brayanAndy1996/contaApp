import type { ContappDb } from "@contapp/db";
import {
  MockSireApiClient,
  generarFilasComprasVolumen,
  type FilaPropuestaSire,
} from "@contapp/sunat";
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
import {
  arrancar007b,
  esperarTerminal,
} from "../../../test/procesadores-007b.js";
import {
  MONTOS,
  PERIODO,
  RUC_FIXTURE,
  SireApiControlado,
  cambiosEntre,
  claveDe,
  comprasDe,
  contarCompras,
  contarDe,
  descartarCompra,
  encolarDescarga,
  estadoDelPeriodo,
  filaCompra,
  fijarEstadoPeriodo,
  fotoDe,
  hallazgosDe,
  limpiarCompras,
  mundoVentas,
  nuevaVersion,
  nuevasEntre,
  reglasDe,
  sembrarCompra,
  sembrarCompras,
  versionesDe,
  volcarTablasCompras,
  type MundoVentas,
} from "../../../test/compras.js";
import {
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  Escenario,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  restaurarConfig,
  type ProcesoWorker,
} from "../../../test/trabajos.js";
import {
  TIPO_DESCARGA,
  contarDiferencias,
  contarPropuestas,
  diferenciasDe,
  liberarDedupe,
  propuestasDe,
} from "../../../test/ventas.js";
import { descargarPropuesta } from "../procesadores/descargar-propuesta.js";

// Spec 014, T8 (rojo; integración con PostgreSQL y Redis reales, BullMQ real y el mock de SireApiClient): el persistidor de
// compras con el procesador real `sire.propuesta.descargar` de 013 y `PERSISTIDORES` (D-3, D-4, D-18; CA-1, CA-6 parte
// hallazgos, CA-10, CA-15 parte persistir, CA-17; DU-17, DU-19 a DU-21). Se encola como lo hace el backend (rol backend,
// prioridad `interactivo`) y lo ejecuta el worker con la KEK `mock`.
//
// CONTRATO que fija (T11 tablas, T13 persistidor), además del de test/compras.ts:
// - Éxito: el trabajo queda `completado` y deja UNA `propuesta` (libro `compras`, fuente `api`, `usuario_id` = quien encoló,
//   `trabajo_id` = el trabajo) y, por cada comprobante nuevo, una `compra` (origen `sire`, `propuesta_id` = esa propuesta,
//   clave `tipo|SERIE|numero|tipoDoc|DOC`, `version_vigente` 1), su `compra_version` 1 con los montos exactos de la fila,
//   y sus `compra_hallazgo` de la versión 1. La primera descarga crea `compra_periodo` en `abierto`.
// - `resultado` = { propuestaId, recibidas, nuevas, iguales, distintas, claves, truncado } (≤ 4 KB, sin montos ni razones
//   sociales), el de 013.
// - Una fila ilegible (`fila_invalida`), más de 20.000 recibidas (`propuesta_demasiado_grande`) y un periodo `generado` son
//   `ErrorDatos`: el trabajo queda `error/datos_invalidos` sin reintentos y NO se guarda nada (ni el encabezado).
// - Una descarga repetida complementa (D-18): agrega solo las claves nuevas, compara contra la versión 1 de las compras vivas
//   (excluidas incluidas; las descartadas no cuentan) y no toca ninguna fila existente. Una agregada a mano se informa con
//   `origen_existente = manual`.
// - Sin tope de compras vivas por periodo (DU-20); solo el de 20.000 recibidas por descarga.
// - `propuesta_diferencia.campos` usa los nombres de `FilaPropuestaSire` (`biDg`, `igvDg`, ..., `total`) y `fecha`, `moneda`,
//   `tipoCambio` (plan 014, «campos comparables»).
// - Un `revisado` posterior al encolado se acepta (DU-21): la descarga solo agrega comprobantes nuevos.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const REINTENTOS = 3;
let admin: ContappDb;
let backend: ContappDb;
let redis: Redis;
let e: Escenario;
// Un prefijo de Redis por prueba: así no sobreviven arriendos del líder ni jobs de BullMQ de la prueba anterior.
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
    reintentos: REINTENTOS,
    base: 100,
  });
});

afterAll(async () => {
  await restaurarConfig(admin).catch(() => undefined);
  await limpiarCompras(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos)
    await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), admin?.close()]);
});

/** Arranca el worker con el puerto SIRE de la prueba, corre `fn` y lo detiene. */
async function conWorker<T>(
  api: SireApiControlado,
  fn: (p: ProcesoWorker) => Promise<T>,
): Promise<T> {
  const p = await arrancar007b({
    prefijo,
    sireApi: api,
  } as Parameters<typeof arrancar007b>[0]);
  api.contarTx = () => p.dbEstado.abiertas;
  try {
    return await fn(p);
  } finally {
    await p.detener({ esperaMs: 2000 });
  }
}

interface Resultado {
  propuestaId: string;
  recibidas: number;
  nuevas: number;
  iguales: number;
  distintas: number;
  claves: string[];
  truncado: boolean;
}

/** Encola una descarga de compras y espera su fin (el worker ya debe estar en marcha). */
async function descargar(
  m: MundoVentas,
  o: { periodo?: string } = {},
  timeoutMs = 90_000,
) {
  const id = await encolarDescarga(backend, redis, prefijo, m, {
    ...o,
    libro: "compras",
  });
  const f = await esperarTerminal(e, id, timeoutMs);
  return {
    id,
    estado: f.estado,
    motivo: f.motivo,
    intentos: f.intentos,
    resultado: (f as { resultado?: unknown }).resultado as Resultado | null,
  };
}

/** El puerto devuelve estas filas de compras (el soporte de ventas las tipa como de ventas). */
const responder = (api: SireApiControlado, filas: FilaPropuestaSire[]) =>
  api.responder(filas as never);

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

/**
 * Control positivo de las pruebas de «no se guardó nada»: sin persistidor registrado, el trabajo también falla con
 * `datos_invalidos` y no guarda nada, así que ese resultado solo prueba algo si una descarga válida del mismo cliente
 * SÍ se guarda. Se hace al final de la prueba.
 */
async function controlPositivo(api: SireApiControlado, m: MundoVentas) {
  responder(api, [filaCompra("1", { serie: "C001" })]);
  const r = await descargar(m);
  expect(
    [r.estado, r.motivo],
    "control positivo: una fila válida se guarda",
  ).toEqual(["completado", null]);
  expect(r.resultado).toMatchObject({ nuevas: 1 });
}

async function fixtureCompras(): Promise<FilaPropuestaSire[]> {
  const p = await new MockSireApiClient().descargarPropuesta(
    { token: "t", expiraEn: new Date(0) },
    { ruc: RUC_FIXTURE, periodo: PERIODO, libro: "compras" },
  );
  if (p.libro !== "compras") throw new Error("se esperaba compras");
  return p.filas;
}

const porNumero = (filas: FilaPropuestaSire[], numero: string) =>
  filas.find((f) => f.numero === numero)!;

/** No quedó nada del cliente: ni encabezado, ni compras, ni versiones, ni hallazgos, ni estado, ni diferencias. */
async function nada(m: MundoVentas): Promise<void> {
  expect(await contarPropuestas(admin, m.c.id), "propuestas").toBe(0);
  expect(await contarDe(admin, "compra", m.c.id), "compras").toBe(0);
  expect(await contarDe(admin, "compra_version", m.c.id), "versiones").toBe(0);
  expect(await contarDe(admin, "compra_hallazgo", m.c.id), "hallazgos").toBe(0);
  expect(await contarDe(admin, "compra_periodo", m.c.id), "estado").toBe(0);
  expect(await contarDiferencias(admin, m.c.id), "diferencias").toBe(0);
}

// ---------------------------------------------------------------------------------------------------------------
describe("CA-1: la primera descarga con el mock", () => {
  it("contribuyente de prueba: 1 propuesta con contadores, 5 compras origen sire y el resultado de 013", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const api = new SireApiControlado();
    const r = await conWorker(api, () => descargar(m));

    expect([r.estado, r.motivo, r.intentos]).toEqual(["completado", null, 0]);
    const props = await propuestasDe(admin, m.c.id);
    expect(props).toHaveLength(1);
    const p = props[0]!;
    expect(p).toMatchObject({
      libro: "compras",
      fuente: "api",
      filas_recibidas: 5,
      filas_nuevas: 5,
      filas_iguales: 0,
      filas_distintas: 0,
      usuario_id: m.u,
      trabajo_id: r.id,
    });
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/);

    const compras = await comprasDe(admin, m.c.id);
    expect(compras.map((c) => c.clave)).toEqual([
      "01|F001|1040|6|20700000011",
      "01|F001|2056|6|20700000045",
      "01|F001|3064|6|20700000053",
      "01|F001|4062|6|20700000061",
      "01|F001|5070|6|20700000070",
    ]);
    expect(compras.every((c) => c.origen === "sire")).toBe(true);
    expect(compras.every((c) => c.propuesta_id === p.id)).toBe(true);
    expect(compras.every((c) => c.version_vigente === 1)).toBe(true);
    expect(compras.every((c) => c.descartada_en === null)).toBe(true);
    expect(await diferenciasDe(admin, p.id)).toEqual([]);

    // El periodo nace `abierto` en la primera descarga (D-9).
    expect(await estadoDelPeriodo(admin, m.c.id)).toBe("abierto");

    // El puerto recibió el RUC, el periodo y el libro del trabajo.
    expect(api.llamadas).toHaveLength(1);
    expect(api.llamadas[0]!.solicitud).toEqual({
      ruc: RUC_FIXTURE,
      periodo: PERIODO,
      libro: "compras",
    });

    expect(r.resultado).toEqual({
      propuestaId: p.id,
      recibidas: 5,
      nuevas: 5,
      iguales: 0,
      distintas: 0,
      claves: [],
      truncado: false,
    });
    expect(bytes(r.resultado)).toBeLessThanOrEqual(4096);
  });

  it("la versión 1 de cada compra es idéntica a la fila del SIRE: identidad y los 10 montos con el total, como cadenas exactas", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await conWorker(new SireApiControlado(), () => descargar(m));
    const filas = await fixtureCompras();
    const compras = await comprasDe(admin, m.c.id);
    expect(compras).toHaveLength(5);

    for (const f of filas) {
      const c = compras.find((x) => x.clave === claveDe(f));
      expect(c, `compra ${f.numero}`).toBeDefined();
      expect(c).toMatchObject({
        tipo_doc: f.tipo,
        serie: f.serie,
        numero: f.numero,
        doc_tipo: "6",
        doc_numero: f.rucContraparte,
        razon_social: f.razonSocialContraparte,
        fecha: f.fechaEmision,
        moneda: f.moneda,
        tipo_cambio: f.moneda === "USD" ? f.tipoCambio : null,
      });
      const versiones = await versionesDe(admin, c!.id);
      expect(versiones, `versiones de ${f.numero}`).toHaveLength(1);
      expect(versiones[0]).toMatchObject({
        n: 1,
        excluida: false,
        motivo: null,
        clasificada: false,
      });
      for (const [col] of MONTOS)
        expect(versiones[0]!.montos[col], `${f.numero}.${col}`).toBe(
          f[col] as string,
        );
    }
  });

  it("casos reales: San Juan trae R-ISC y la mixta 21.48 / 1.61 trae R-MIX en la versión 1; las demás no", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await conWorker(new SireApiControlado(), () => descargar(m));
    const por = new Map(
      (await comprasDe(admin, m.c.id)).map((c) => [c.numero, c]),
    );

    const sanJuan = await reglasDe(admin, por.get("1040")!.id);
    expect(sanJuan).toContain("R-ISC");
    expect(sanJuan).not.toContain("R-MIX");
    const mixta = await reglasDe(admin, por.get("2056")!.id);
    expect(mixta).toContain("R-MIX");
    expect(mixta).not.toContain("R-ISC");
    for (const n of ["3064", "4062", "5070"]) {
      const reglas = await reglasDe(admin, por.get(n)!.id);
      expect(reglas, n).not.toContain("R-ISC");
      expect(reglas, n).not.toContain("R-MIX");
    }

    // R-ISC pide confirmación y propone mover; R-MIX propone separar. Todos los hallazgos son de la versión 1.
    const isc = (await hallazgosDe(admin, por.get("1040")!.id)).find(
      (h) => h.regla === "R-ISC",
    )!;
    expect(isc).toMatchObject({ version_n: 1, requiere_confirmacion: true });
    expect(isc.sugerencia).toMatchObject({ tipo: "mover" });
    const mix = (await hallazgosDe(admin, por.get("2056")!.id)).find(
      (h) => h.regla === "R-MIX",
    )!;
    expect(mix.version_n).toBe(1);
    expect(mix.sugerencia).toMatchObject({ tipo: "separar" });
    expect(
      (await hallazgosDe(admin, por.get("1040")!.id)).every(
        (h) => h.version_n === 1,
      ),
    ).toBe(true);
  });

  it("una fila descuadrada pero legible se guarda tal cual llegó (la mixta 21.48 con IGV 1.61 y total 23.09)", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await conWorker(new SireApiControlado(), () => descargar(m));
    const mixta = (await comprasDe(admin, m.c.id)).find(
      (c) => c.numero === "2056",
    )!;
    const [v1] = await versionesDe(admin, mixta.id);
    expect(v1!.montos).toMatchObject({
      biDg: "21.48",
      igvDg: "1.61",
      total: "23.09",
    });
  });

  it("la razón social es texto no confiable: HTML y fórmulas se guardan tal cual; ausente queda null", async () => {
    const m = await mundoVentas(e, backend);
    const html = `<img src=x onerror=alert(1)> =HYPERLINK("http://x")`;
    const api = new SireApiControlado();
    responder(api, [
      filaCompra("1", { razonSocialContraparte: html }),
      filaCompra("2", {
        rucContraparte: "20100070971",
        razonSocialContraparte: undefined,
      }),
    ]);
    const r = await conWorker(api, () => descargar(m));
    expect(r.estado).toBe("completado");
    const compras = await comprasDe(admin, m.c.id);
    expect(compras.find((c) => c.numero === "1")!.razon_social).toBe(html);
    expect(compras.find((c) => c.numero === "2")!.razon_social).toBeNull();
    // La razón social no sale en el resultado del trabajo.
    expect(JSON.stringify(r.resultado)).not.toContain("onerror");
  });

  it("una regla que falla con una fila no tumba la descarga: esa fila queda sin hallazgos y las demás conservan los suyos (D-4)", async () => {
    // Una DUA (tipo 50, número de 12 dígitos) es un comprobante legible del SIRE que `evaluarReglas` de 011 no acepta
    // (número de comprobante de a lo más 8 dígitos): la evaluación de esa fila falla y el resto sigue.
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const api = new SireApiControlado();
    const dua = filaCompra("123456789012", {
      tipo: "50",
      serie: "2026",
      rucContraparte: "20700000079",
    });
    responder(api, [...(await fixtureCompras()), dua]);
    const r = await conWorker(api, () => descargar(m));
    expect([r.estado, r.motivo]).toEqual(["completado", null]);
    expect(r.resultado).toMatchObject({
      recibidas: 6,
      nuevas: 6,
      iguales: 0,
      distintas: 0,
    });
    const por = new Map(
      (await comprasDe(admin, m.c.id)).map((c) => [c.numero, c]),
    );
    expect(por.size).toBe(6);
    expect(await hallazgosDe(admin, por.get("123456789012")!.id)).toEqual([]);
    expect(await reglasDe(admin, por.get("1040")!.id)).toContain("R-ISC");
    expect(await reglasDe(admin, por.get("2056")!.id)).toContain("R-MIX");
  });

  it("el hash es del contenido: los mismos datos dan el mismo y otros montos dan otro", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado();
    await conWorker(api, async () => {
      responder(api, [filaCompra("1")]);
      await descargar(m);
      await descargar(m);
      responder(api, [filaCompra("1", { total: "119.00" })]);
      await descargar(m);
    });
    const [a, b, c] = await propuestasDe(admin, m.c.id);
    expect(a!.hash).toBe(b!.hash);
    expect(c!.hash).not.toBe(a!.hash);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-1 y D-3: todo o nada", () => {
  const ILEGIBLES: Array<[string, Partial<FilaPropuestaSire>]> = [
    ["monto no numérico", { total: "abc" }],
    ["monto con tres decimales", { igvDg: "18.001" }],
    ["monto fuera de NUMERIC(14,2)", { total: "1000000000000.00" }],
    ["moneda desconocida", { moneda: "EUR" as never }],
    ["tipo de cambio inválido", { moneda: "USD", tipoCambio: "abc" }],
    ["fecha inexistente", { fechaEmision: "2026-02-30" }],
    ["número vacío", { numero: "" }],
    ["barra vertical en una parte de la clave", { numero: "12|3" }],
    // H-014-4 / DU-24: el NUL no cabe en un `text` de PostgreSQL (22021); se rechaza con fila_invalida, no se limpia.
    ["razón social con NUL (DU-24)", { razonSocialContraparte: "ACME\u0000 SAC" }],
  ];

  it.each(ILEGIBLES)(
    "una fila ilegible (%s) entre filas válidas: error/datos_invalidos sin reintentos y no queda nada",
    async (_motivo, mala) => {
      const m = await mundoVentas(e, backend);
      const api = new SireApiControlado();
      responder(api, [filaCompra("1"), filaCompra("2", mala), filaCompra("3")]);
      await conWorker(api, async () => {
        const r = await descargar(m);
        expect([r.estado, r.motivo, r.intentos]).toEqual([
          "error",
          "datos_invalidos",
          0,
        ]);
        expect(api.llamadas).toHaveLength(1);
        await nada(m);
        // Control: la misma descarga sin la fila mala se guarda, así que lo anterior fue por la fila y no por otra cosa.
        await controlPositivo(api, m);
      });
    },
  );

  it("una fila ilegible en una descarga repetida no cambia nada de lo ya guardado", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const api = new SireApiControlado();
    await conWorker(api, async () => {
      expect((await descargar(m)).estado).toBe("completado");
      const antes = await fotoDe(admin, m.c.id);
      const propuestasAntes = await contarPropuestas(admin, m.c.id);
      responder(api, [
        ...(await fixtureCompras()),
        filaCompra("6080"),
        filaCompra("6081", { total: "no-es-un-monto" }),
      ]);
      const r = await descargar(m);
      expect([r.estado, r.motivo, r.intentos]).toEqual([
        "error",
        "datos_invalidos",
        0,
      ]);
      const despues = await fotoDe(admin, m.c.id);
      expect(cambiosEntre(antes, despues)).toEqual([]);
      expect(nuevasEntre(antes, despues, "compra")).toEqual([]);
      expect(await contarPropuestas(admin, m.c.id)).toBe(propuestasAntes);
    });
  });

  it("más de 20.000 filas recibidas: error/datos_invalidos (propuesta_demasiado_grande) y no se guarda nada, ni con el periodo ya trabajado", async () => {
    const vacio = await mundoVentas(e, backend);
    const api = new SireApiControlado();
    responder(api, generarFilasComprasVolumen(20_001));
    const r = await conWorker(api, () => descargar(vacio));
    expect([r.estado, r.motivo, r.intentos]).toEqual([
      "error",
      "datos_invalidos",
      0,
    ]);
    await nada(vacio);

    // Con el periodo ya descargado, la propuesta demasiado grande tampoco toca lo guardado.
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const api2 = new SireApiControlado();
    await conWorker(api2, async () => {
      expect((await descargar(m)).estado).toBe("completado");
      const antes = await fotoDe(admin, m.c.id);
      responder(api2, generarFilasComprasVolumen(20_001));
      const g = await descargar(m);
      expect([g.estado, g.motivo, g.intentos]).toEqual([
        "error",
        "datos_invalidos",
        0,
      ]);
      expect(cambiosEntre(antes, await fotoDe(admin, m.c.id))).toEqual([]);
      expect(await contarPropuestas(admin, m.c.id)).toBe(1);
    });
    // Control: una descarga válida del cliente vacío sí se guarda (si no, el rechazo anterior no probaría nada).
    await conWorker(api, () => controlPositivo(api, vacio));
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-10 (D-4, DU-7): proveedor nuevo", () => {
  const nuevos = async (m: MundoVentas): Promise<string[]> => {
    const salida: string[] = [];
    for (const c of await comprasDe(admin, m.c.id))
      if ((await reglasDe(admin, c.id)).includes("R-NEW"))
        salida.push(c.numero);
    return salida.sort();
  };
  const TODAS = ["1040", "2056", "3064", "4062", "5070"];

  async function descargaFixture(m: MundoVentas) {
    const api = new SireApiControlado();
    const r = await conWorker(api, () => descargar(m));
    expect(r.estado).toBe("completado");
  }

  it("primer periodo del cliente: todos los proveedores son nuevos (R-NEW en las 5 filas, pendientes de clasificar)", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await descargaFixture(m);
    expect(await nuevos(m)).toEqual(TODAS);
    const nueva = (
      await hallazgosDe(admin, (await comprasDe(admin, m.c.id))[0]!.id)
    ).find((h) => h.regla === "R-NEW")!;
    expect(nueva.requiere_confirmacion).toBe(true);
    for (const c of await comprasDe(admin, m.c.id))
      expect((await versionesDe(admin, c.id))[0]!.clasificada).toBe(false);
  });

  it("con una compra del mismo proveedor en otro periodo del mismo cliente ya no es nuevo; los demás sí", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await sembrarCompra(
      admin,
      m,
      filaCompra("77", { rucContraparte: "20700000011" }),
      { periodo: "202609" },
    );
    await descargaFixture(m);
    expect(await nuevos(m)).toEqual(["2056", "3064", "4062", "5070"]);
  });

  it("una compra excluida de otro periodo sigue contando como historial del proveedor (D-6)", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const id = await sembrarCompra(
      admin,
      m,
      filaCompra("78", { rucContraparte: "20700000061" }),
      { periodo: "202609" },
    );
    await nuevaVersion(admin, m, id, { excluida: true, motivo: "zapatillas" });
    await descargaFixture(m);
    expect(await nuevos(m)).toEqual(["1040", "2056", "3064", "5070"]);
  });

  it("el historial de otro cliente del mismo estudio o de otro estudio no cuenta", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    // Otro cliente del mismo estudio y un cliente de otro estudio, con compras de los proveedores de la fixture.
    const otroCliente = await e.cliente(m.T);
    const T2 = await e.estudio();
    const u2 = await e.usuario(T2, "contador");
    const c2 = await e.cliente(T2);
    for (const ruc of ["20700000011", "20700000045"]) {
      await sembrarCompra(admin, m, filaCompra("90", { rucContraparte: ruc }), {
        periodo: "202609",
        clienteId: otroCliente.id,
      });
      await sembrarCompra(
        admin,
        { T: T2, u: u2, c: c2 },
        filaCompra("91", { rucContraparte: ruc }),
        { periodo: "202609" },
      );
    }
    await descargaFixture(m);
    expect(await nuevos(m)).toEqual(TODAS);
  });

  it("una compra del mismo proveedor en el mismo periodo no lo vuelve conocido (el historial es de otros periodos)", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await sembrarCompra(
      admin,
      m,
      filaCompra("9999", { rucContraparte: "20700000053" }),
      { origen: "agregada" },
    );
    await descargaFixture(m);
    expect(await nuevos(m)).toContain("3064");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-17 (D-18, DU-2, DU-17): descarga repetida = complementar", () => {
  /**
   * Primera descarga (las 5 de la fixture), y el trabajo del contador: corrige San Juan (versión 2), excluye la mixta
   * (versión 2) y agrega a mano F001-9001 y F001-9002. Devuelve el estado antes de la segunda descarga.
   */
  async function periodoTrabajado(api: SireApiControlado) {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const primera = await descargar(m);
    expect(primera.estado).toBe("completado");
    const por = new Map(
      (await comprasDe(admin, m.c.id)).map((c) => [c.numero, c]),
    );
    await nuevaVersion(admin, m, por.get("1040")!.id, {
      montos: { biDg: "0.00", isc: "770.00" },
      clasificada: true,
    });
    await nuevaVersion(admin, m, por.get("2056")!.id, {
      excluida: true,
      motivo: "zapatillas",
    });
    const a1 = filaCompra("9001", {
      rucContraparte: "20700000053",
      total: "118.00",
    });
    const a2 = filaCompra("9002", { rucContraparte: "20700000053" });
    const idA1 = await sembrarCompra(admin, m, a1, { origen: "agregada" });
    const idA2 = await sembrarCompra(admin, m, a2, { origen: "agregada" });
    const antes = await fotoDe(admin, m.c.id);
    void api;
    return { m, primera, a1, a2, idA1, idA2, antes };
  }

  /** La fixture con F001-5070 distinta, el nuevo F001-6080 y las dos agregadas (9001 distinta y 9002 igual). */
  async function segundaRespuesta(
    a1: FilaPropuestaSire,
    a2: FilaPropuestaSire,
  ) {
    const base = await fixtureCompras();
    const f5070 = porNumero(base, "5070");
    return {
      filas: [
        ...base.filter((f) => f.numero !== "5070"),
        {
          ...f5070,
          biDg: "160.00",
          igvDg: "28.80",
          total: "188.80",
        },
        filaCompra("6080", { rucContraparte: "20700000070" }),
        { ...a1, biDg: "200.00", igvDg: "36.00", total: "236.00" },
        a2,
      ],
    };
  }

  it("el SIRE trae un comprobante nuevo y otro distinto de su versión 1: se agrega solo el nuevo y ninguna fila existente cambia (ni la corregida, ni la excluida, ni la agregada)", async () => {
    const api = new SireApiControlado();
    await conWorker(api, async () => {
      const { m, primera, a1, a2, idA1, idA2, antes } =
        await periodoTrabajado(api);
      const { filas } = await segundaRespuesta(a1, a2);
      responder(api, filas);
      const segunda = await descargar(m);
      expect(segunda.estado).toBe("completado");

      // Foto: todo lo que había sigue idéntico, campo por campo.
      const despues = await fotoDe(admin, m.c.id);
      expect(cambiosEntre(antes, despues)).toEqual([]);

      // Y solo nació una compra con su versión 1 (y sus hallazgos): la 6080 como original de la segunda propuesta.
      const props = await propuestasDe(admin, m.c.id);
      expect(props).toHaveLength(2);
      const p2 = props.find((p) => p.trabajo_id === segunda.id)!;
      const nueva = nuevasEntre(antes, despues, "compra");
      expect(nueva).toHaveLength(1);
      expect(nuevasEntre(antes, despues, "compra_version")).toHaveLength(1);
      const compras = await comprasDe(admin, m.c.id);
      const c6080 = compras.find((c) => c.numero === "6080")!;
      expect(c6080).toMatchObject({
        id: nueva[0],
        origen: "sire",
        propuesta_id: p2.id,
        clave: "01|F001|6080|6|20700000070",
        version_vigente: 1,
      });
      const hallazgosNuevos = nuevasEntre(antes, despues, "compra_hallazgo");
      expect(hallazgosNuevos.length).toBe(
        (await hallazgosDe(admin, c6080.id)).length,
      );
      expect(compras).toHaveLength(8); // 5 + 2 agregadas + 1 nueva

      // La corregida, la excluida y las agregadas siguen como las dejó el contador.
      const por = new Map(compras.map((c) => [c.numero, c]));
      expect(por.get("1040")!.version_vigente).toBe(2);
      expect(por.get("2056")!.version_vigente).toBe(2);
      expect(por.get("9001")).toMatchObject({
        id: idA1,
        origen: "agregada",
        propuesta_id: null,
      });
      expect(por.get("9002")).toMatchObject({
        id: idA2,
        origen: "agregada",
        propuesta_id: null,
      });
      expect(await versionesDe(admin, por.get("5070")!.id)).toHaveLength(1);

      // Contadores: 8 recibidas = 1 nueva + 5 iguales (1040 y 2056 se comparan con su versión 1) + 2 distintas.
      expect(segunda.resultado).toMatchObject({
        propuestaId: p2.id,
        recibidas: 8,
        nuevas: 1,
        iguales: 5,
        distintas: 2,
        truncado: false,
      });
      expect([...segunda.resultado!.claves].sort()).toEqual([
        "01|F001|5070|6|20700000070",
        "01|F001|9001|6|20700000053",
      ]);
      expect(p2).toMatchObject({
        filas_recibidas: 8,
        filas_nuevas: 1,
        filas_iguales: 5,
        filas_distintas: 2,
        usuario_id: m.u,
      });
      expect(bytes(segunda.resultado)).toBeLessThanOrEqual(4096);
      expect(JSON.stringify(segunda.resultado)).not.toContain("PRUEBA");

      // Las diferencias: la del SIRE con los valores del SIRE y la de la agregada con origen manual.
      const difs = await diferenciasDe(admin, p2.id);
      expect(difs).toHaveLength(2);
      const d5070 = difs.find((d) => d.clave === "01|F001|5070|6|20700000070")!;
      expect(d5070).toMatchObject({
        tipo: "01",
        serie: "F001",
        numero: "5070",
        origen_existente: "sire",
        valores_sire: { biDg: "160.00", igvDg: "28.80", total: "188.80" },
      });
      expect([...d5070.campos].sort()).toEqual(["biDg", "igvDg", "total"]);
      const d9001 = difs.find((d) => d.clave === "01|F001|9001|6|20700000053")!;
      expect(d9001.origen_existente).toBe("manual");
      expect([...d9001.campos].sort()).toEqual(["biDg", "igvDg", "total"]);
      expect(
        await diferenciasDe(admin, primera.resultado!.propuestaId),
      ).toEqual([]);
    });
  });

  it("repetir la descarga agrega 0, informa las mismas distintas y no deja otra compra ni otra versión", async () => {
    const api = new SireApiControlado();
    await conWorker(api, async () => {
      const { m, a1, a2 } = await periodoTrabajado(api);
      const { filas } = await segundaRespuesta(a1, a2);
      responder(api, filas);
      await descargar(m);
      const antes = await fotoDe(admin, m.c.id);

      const tercera = await descargar(m);
      expect(tercera.estado).toBe("completado");
      expect(tercera.resultado).toMatchObject({
        recibidas: 8,
        nuevas: 0,
        iguales: 6,
        distintas: 2,
        truncado: false,
      });
      expect([...tercera.resultado!.claves].sort()).toEqual([
        "01|F001|5070|6|20700000070",
        "01|F001|9001|6|20700000053",
      ]);
      const despues = await fotoDe(admin, m.c.id);
      expect(cambiosEntre(antes, despues)).toEqual([]);
      expect(nuevasEntre(antes, despues, "compra")).toEqual([]);
      expect(nuevasEntre(antes, despues, "compra_version")).toEqual([]);
      expect(nuevasEntre(antes, despues, "compra_hallazgo")).toEqual([]);
      expect(await contarCompras(admin, m.c.id)).toBe(8);
      expect(await propuestasDe(admin, m.c.id)).toHaveLength(3);
    });
  });

  it("repetir sin cambios (la misma fixture): 0 nuevas, 5 iguales, 0 distintas y otra propuesta cada vez", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const api = new SireApiControlado();
    await conWorker(api, async () => {
      const primera = await descargar(m);
      const segunda = await descargar(m);
      const tercera = await descargar(m);
      expect(primera.resultado).toMatchObject({ nuevas: 5, iguales: 0 });
      for (const r of [segunda, tercera])
        expect(r.resultado).toMatchObject({
          recibidas: 5,
          nuevas: 0,
          iguales: 5,
          distintas: 0,
          claves: [],
          truncado: false,
        });
    });
    expect(await contarCompras(admin, m.c.id)).toBe(5);
    expect(await contarDe(admin, "compra_version", m.c.id)).toBe(5);
    expect(await propuestasDe(admin, m.c.id)).toHaveLength(3);
    expect(await contarDiferencias(admin, m.c.id)).toBe(0);
  });

  it("la razón social no cuenta para comparar: la misma fila con otra razón social es igual y no se actualiza", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado();
    await conWorker(api, async () => {
      responder(api, [
        filaCompra("1", { razonSocialContraparte: "UNO S.A.C." }),
      ]);
      await descargar(m);
      responder(api, [
        filaCompra("1", { razonSocialContraparte: "OTRA RAZON S.A.C." }),
      ]);
      const r = await descargar(m);
      expect(r.resultado).toMatchObject({
        nuevas: 0,
        iguales: 1,
        distintas: 0,
      });
    });
    expect((await comprasDe(admin, m.c.id))[0]!.razon_social).toBe(
      "UNO S.A.C.",
    );
  });

  it("lo que el SIRE dejó de traer no se borra: una descarga con solo la 3064 deja las 5", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const api = new SireApiControlado();
    await conWorker(api, async () => {
      await descargar(m);
      responder(api, [porNumero(await fixtureCompras(), "3064")]);
      const r = await descargar(m);
      expect(r.resultado).toMatchObject({
        recibidas: 1,
        nuevas: 0,
        iguales: 1,
        distintas: 0,
      });
    });
    expect(await contarCompras(admin, m.c.id)).toBe(5);
  });

  it("cada periodo se complementa por separado: la misma clave en otro periodo es nueva", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado();
    responder(api, [filaCompra("1")]);
    await conWorker(api, async () => {
      await descargar(m, { periodo: "202609" });
      const r = await descargar(m, { periodo: "202610" });
      expect(r.resultado).toMatchObject({
        nuevas: 1,
        iguales: 0,
        distintas: 0,
      });
    });
    expect(await contarCompras(admin, m.c.id, "202609")).toBe(1);
    expect(await contarCompras(admin, m.c.id, "202610")).toBe(1);
  });

  it("una compra descartada libera su clave: el SIRE la trae como original nueva y la descartada no se toca", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado();
    await conWorker(api, async () => {
      const f = filaCompra("7007");
      const id = await sembrarCompra(admin, m, f, { origen: "agregada" });
      await descartarCompra(admin, id);
      const antes = await fotoDe(admin, m.c.id);
      responder(api, [f]);
      const r = await descargar(m);
      expect(r.estado).toBe("completado");
      expect(r.resultado).toMatchObject({
        recibidas: 1,
        nuevas: 1,
        iguales: 0,
        distintas: 0,
      });
      expect(cambiosEntre(antes, await fotoDe(admin, m.c.id))).toEqual([]);
      const compras = await comprasDe(admin, m.c.id);
      expect(compras).toHaveLength(2);
      expect(compras.filter((c) => c.descartada_en === null)).toHaveLength(1);
      expect(compras.find((c) => c.descartada_en === null)).toMatchObject({
        origen: "sire",
        clave: claveDe(f),
      });
      expect(compras.find((c) => c.id === id)!.descartada_en).not.toBeNull();
    });
  });

  it("si se trunca: 100 distintas dejan 40 claves únicas en el resultado (≤ 4 KB), `truncado` y las 100 en propuesta_diferencia", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado();
    await conWorker(api, async () => {
      const base = generarFilasComprasVolumen(100);
      responder(api, base);
      await descargar(m);
      responder(
        api,
        base.map((f) => ({ ...f, fechaEmision: "2026-10-29" })),
      );
      const r = await descargar(m);
      expect(r.resultado).toMatchObject({
        recibidas: 100,
        nuevas: 0,
        iguales: 0,
        distintas: 100,
        truncado: true,
      });
      expect(r.resultado!.claves).toHaveLength(40);
      expect(new Set(r.resultado!.claves).size).toBe(40);
      expect(bytes(r.resultado)).toBeLessThanOrEqual(4096);
      const difs = await diferenciasDe(admin, r.resultado!.propuestaId);
      expect(difs).toHaveLength(100);
      expect(
        difs.every((d) => d.campos.length === 1 && d.campos[0] === "fecha"),
      ).toBe(true);
    });
  });

  it("un comprobante repetido dentro de la misma descarga NO es error: se guarda la primera aparición y las demás cuentan como iguales o distintas (DU-17)", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado();
    responder(api, [
      filaCompra("100"),
      filaCompra("00100"), // misma clave que la anterior, idéntica
      filaCompra("200"),
      filaCompra("200", { total: "119.00" }), // misma clave, distinta de la primera
      filaCompra("300"),
    ]);
    const r = await conWorker(api, () => descargar(m));
    expect([r.estado, r.motivo]).toEqual(["completado", null]);
    expect(r.resultado).toMatchObject({
      recibidas: 5,
      nuevas: 3,
      iguales: 1,
      distintas: 1,
    });
    expect(r.resultado!.claves).toEqual([claveDe(filaCompra("200"))]);
    const compras = await comprasDe(admin, m.c.id);
    expect(compras).toHaveLength(3);
    const dos = compras.find((c) => c.numero === "200")!;
    expect((await versionesDe(admin, dos.id))[0]!.montos.total).toBe("118.00");
  });

  it("estado `generado`: la descarga falla con datos_invalidos sin reintentos y no toca nada", async () => {
    const api = new SireApiControlado();
    await conWorker(api, async () => {
      const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
      expect((await descargar(m)).estado).toBe("completado");
      await fijarEstadoPeriodo(admin, m, "generado");
      const antes = await fotoDe(admin, m.c.id);
      responder(api, [...(await fixtureCompras()), filaCompra("6080")]);
      const r = await descargar(m);
      expect([r.estado, r.motivo, r.intentos]).toEqual([
        "error",
        "datos_invalidos",
        0,
      ]);
      const despues = await fotoDe(admin, m.c.id);
      expect(cambiosEntre(antes, despues)).toEqual([]);
      expect(nuevasEntre(antes, despues, "compra")).toEqual([]);
      expect(await propuestasDe(admin, m.c.id)).toHaveLength(1);
      expect(await estadoDelPeriodo(admin, m.c.id)).toBe("generado");
    });
  });

  it("estado `revisado` que apareció después de encolar (DU-21): se acepta, agrega solo las nuevas y el periodo sigue revisado", async () => {
    const api = new SireApiControlado();
    await conWorker(api, async () => {
      const { m, a1, a2, antes } = await periodoTrabajado(api);
      await fijarEstadoPeriodo(admin, m, "revisado");
      const conEstado = await fotoDe(admin, m.c.id);
      const { filas } = await segundaRespuesta(a1, a2);
      responder(api, filas);
      const r = await descargar(m);
      expect(r.estado).toBe("completado");
      expect(r.resultado).toMatchObject({
        nuevas: 1,
        iguales: 5,
        distintas: 2,
      });
      const despues = await fotoDe(admin, m.c.id);
      expect(cambiosEntre(conEstado, despues)).toEqual([]);
      expect(
        cambiosEntre(antes, despues).filter(
          (c) => !c.startsWith("compra_periodo"),
        ),
      ).toEqual([]);
      expect(nuevasEntre(conEstado, despues, "compra")).toHaveLength(1);
      expect(await estadoDelPeriodo(admin, m.c.id)).toBe("revisado");
    });
  });

  it("un periodo `generado` de otro periodo o de otro cliente no impide descargar", async () => {
    const api = new SireApiControlado();
    await conWorker(api, async () => {
      const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
      const otro = await mundoVentas(e, backend);
      await fijarEstadoPeriodo(admin, m, "generado", "202609");
      await fijarEstadoPeriodo(admin, otro, "generado");
      const r = await descargar(m);
      expect(r.estado).toBe("completado");
      expect(r.resultado).toMatchObject({ nuevas: 5 });
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("reintentos y simultaneidad", () => {
  /** Contexto de un trabajo real para invocar el procesador directo (sin worker). */
  const contexto = (m: MundoVentas, id: string, periodo: string) => ({
    trabajo: {
      id,
      tenantId: m.T,
      clienteId: m.c.id,
      ruc: m.c.ruc,
      tipo: TIPO_DESCARGA,
      parametros: { periodo, libro: "compras" },
      intentos: 0,
      creadoPor: m.u,
    },
    conToken: <T>(usar: (t: string) => Promise<T>) => usar("token-de-prueba"),
  });

  /** Cancela los trabajos que quedaron `en_cola` sin worker para que ningún worker posterior los recoja. */
  const cancelarEnCola = (clienteId: string) =>
    admin.pool
      .query(
        "update job_registro set estado = 'cancelado', motivo = 'cancelado_usuario', terminado_en = now(), actualizado_en = now() where cliente_id = $1 and estado = 'en_cola'",
        [clienteId],
      )
      .catch(() => undefined);

  it("un reintento tras una caída antes de confirmar no deja nada a medias ni duplica: el segundo intento guarda las 5 y un tercero (entrega repetida) encuentra todo igual", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const dbWorker = crearDbRol("contapp_worker");
    const api = new SireApiControlado();
    responder(api, await fixtureCompras());
    try {
      const id = await encolarDescarga(backend, redis, prefijo, m, {
        libro: "compras",
      });
      // Primer intento: todo el trabajo se hace dentro de la transacción y el proceso cae antes de confirmarla.
      const conCaida = {
        withTenant: (c: unknown, f: (tx: never) => Promise<unknown>) =>
          (
            dbWorker as unknown as {
              withTenant: (c: unknown, f: unknown) => Promise<unknown>;
            }
          ).withTenant(c, async (tx: never) => {
            await f(tx);
            throw new Error("caída simulada antes del commit");
          }),
      };
      const caido = descargarPropuesta({ db: conCaida as never, sireApi: api });
      await expect(caido(contexto(m, id, PERIODO) as never)).rejects.toThrow(
        "caída simulada",
      );
      await nada(m);

      const bueno = descargarPropuesta({ db: dbWorker, sireApi: api });
      const segundo = (await bueno(
        contexto(m, id, PERIODO) as never,
      )) as Resultado;
      expect(segundo).toMatchObject({
        recibidas: 5,
        nuevas: 5,
        iguales: 0,
        distintas: 0,
      });
      expect(await contarCompras(admin, m.c.id)).toBe(5);
      expect(await propuestasDe(admin, m.c.id)).toHaveLength(1);

      const tercero = (await bueno(
        contexto(m, id, PERIODO) as never,
      )) as Resultado;
      expect(tercero).toMatchObject({
        recibidas: 5,
        nuevas: 0,
        iguales: 5,
        distintas: 0,
      });
      expect(await contarCompras(admin, m.c.id)).toBe(5);
      expect(await contarDe(admin, "compra_version", m.c.id)).toBe(5);
    } finally {
      await cancelarEnCola(m.c.id);
      await dbWorker.close();
    }
  });

  it("dos descargas simultáneas del mismo cliente y periodo (12 rondas): sin 40P01 ni compras duplicadas; una agrega y la otra encuentra todo igual", async () => {
    // Por la cola no pueden correr dos a la vez (deduplicación de 008 D8 y lock del RUC), así que se invoca el procesador
    // directo con dos trabajos reales, sin worker en marcha: es la carrera de dos procesos worker (o de una importación).
    const m = await mundoVentas(e, backend);
    const dbWorker = crearDbRol("contapp_worker");
    const api = new SireApiControlado().responder(
      (s) => generarFilasComprasVolumen(5, s.periodo) as never,
    );
    const proc = descargarPropuesta({ db: dbWorker, sireApi: api });
    try {
      for (let i = 0; i < 12; i++) {
        const periodo = `2025${String(i + 1).padStart(2, "0")}`;
        const a = await encolarDescarga(backend, redis, prefijo, m, {
          periodo,
          libro: "compras",
        });
        await liberarDedupe(admin, a);
        const b = await encolarDescarga(backend, redis, prefijo, m, {
          periodo,
          libro: "compras",
        });
        api.barrera(2); // reinicia la barrera de la ronda
        const resultados = (await Promise.all([
          proc(contexto(m, a, periodo) as never),
          proc(contexto(m, b, periodo) as never),
        ])) as Resultado[];

        expect(resultados.map((r) => r.nuevas).sort(), `ronda ${i}`).toEqual([
          0, 5,
        ]);
        expect(resultados.map((r) => r.iguales).sort(), `ronda ${i}`).toEqual([
          0, 5,
        ]);
        expect(
          resultados.map((r) => r.distintas),
          `ronda ${i}`,
        ).toEqual([0, 0]);
        expect(await contarCompras(admin, m.c.id, periodo), `ronda ${i}`).toBe(
          5,
        );
        expect(
          await propuestasDe(admin, m.c.id, periodo),
          `ronda ${i}`,
        ).toHaveLength(2);
      }
      // Cada compra tiene una sola versión: la carrera no escribió ninguna de más.
      expect(await contarDe(admin, "compra_version", m.c.id)).toBe(
        await contarDe(admin, "compra", m.c.id),
      );
    } finally {
      await cancelarEnCola(m.c.id);
      await dbWorker.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-15 (persistir) y DU-20: volumen y sin tope por periodo", () => {
  it("5.000 filas sintéticas se persisten y se evalúan sin error: 5.000 compras con su versión 1, un R-NEW por proveedor nuevo y un resultado de ≤ 4 KB", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado();
    const filas = generarFilasComprasVolumen(5_000);
    responder(api, filas);
    const t0 = Date.now();
    const r = await conWorker(api, () => descargar(m, {}, 150_000));
    const ms = Date.now() - t0;
    expect([r.estado, r.motivo, r.intentos]).toEqual(["completado", null, 0]);
    expect(r.resultado).toMatchObject({
      recibidas: 5_000,
      nuevas: 5_000,
      iguales: 0,
      distintas: 0,
      claves: [],
      truncado: false,
    });
    expect(bytes(r.resultado)).toBeLessThanOrEqual(4096);
    expect(await contarCompras(admin, m.c.id)).toBe(5_000);
    expect(await contarDe(admin, "compra_version", m.c.id)).toBe(5_000);
    // Primer periodo del cliente: todos los proveedores son nuevos, así que cada fila trae su R-NEW (la evaluó).
    const nuevos = await admin.pool.query(
      `select count(*)::int as n from compra_hallazgo h join compra c on c.id = h.compra_id
        where c.cliente_id = $1 and h.regla = 'R-NEW' and h.version_n = 1`,
      [m.c.id],
    );
    expect(nuevos.rows[0].n).toBe(5_000);
    // Sin cuadrar el tiempo a una máquina, pero una evaluación cuadrática (relee el periodo por fila) no cabe aquí.
    expect(ms, "persistir 5.000 filas").toBeLessThan(90_000);
    // Los montos de una fila cualquiera quedaron exactos.
    const alguna = filas[2_345]!;
    const c = (await comprasDe(admin, m.c.id)).find(
      (x) => x.clave === claveDe(alguna),
    )!;
    const [v1] = await versionesDe(admin, c.id);
    for (const [col] of MONTOS)
      expect(v1!.montos[col], col).toBe(alguna[col] as string);
  });

  it("DU-20: un periodo con 5.000 compras vivas más una descarga de 1 nueva se persiste (5.001 vivas)", async () => {
    const m = await mundoVentas(e, backend);
    await sembrarCompras(admin, m, 5_000);
    const api = new SireApiControlado();
    responder(api, [filaCompra("1", { serie: "N001" })]);
    const r = await conWorker(api, () => descargar(m));
    expect([r.estado, r.motivo]).toEqual(["completado", null]);
    expect(r.resultado).toMatchObject({
      recibidas: 1,
      nuevas: 1,
      iguales: 0,
      distintas: 0,
    });
    expect(await contarCompras(admin, m.c.id, PERIODO, true)).toBe(5_001);
    // 2 propuestas: la sembrada por `sembrarCompras` (5.000 filas, también `fuente = 'api'`) y la de esta descarga (1 fila).
    const props = await propuestasDe(admin, m.c.id);
    expect(props).toHaveLength(2);
    expect(props.filter((p) => p.filas_recibidas === 1)).toHaveLength(1);
  });

  it("DU-20: 5.000 vivas y una segunda descarga de 1.000 nuevas dejan 6.000 vivas (lo ya guardado cuenta como iguales)", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado();
    await conWorker(api, async () => {
      responder(api, generarFilasComprasVolumen(5_000));
      expect((await descargar(m, {}, 150_000)).estado).toBe("completado");
      const antes = await fotoDe(admin, m.c.id);
      responder(api, generarFilasComprasVolumen(6_000));
      const r = await descargar(m, {}, 150_000);
      expect([r.estado, r.motivo]).toEqual(["completado", null]);
      expect(r.resultado).toMatchObject({
        recibidas: 6_000,
        nuevas: 1_000,
        iguales: 5_000,
        distintas: 0,
      });
      expect(await contarCompras(admin, m.c.id, PERIODO, true)).toBe(6_000);
      const despues = await fotoDe(admin, m.c.id);
      expect(cambiosEntre(antes, despues)).toEqual([]);
      expect(nuevasEntre(antes, despues, "compra")).toHaveLength(1_000);
    });
  });

  it("solo las 20.000 recibidas por descarga tienen tope: 5.000 vivas y 20.001 recibidas falla sin guardar nada", async () => {
    const m = await mundoVentas(e, backend);
    await sembrarCompras(admin, m, 5_000);
    const antes = await fotoDe(admin, m.c.id);
    const api = new SireApiControlado();
    responder(api, generarFilasComprasVolumen(20_001));
    const r = await conWorker(api, () => descargar(m));
    expect([r.estado, r.motivo, r.intentos]).toEqual([
      "error",
      "datos_invalidos",
      0,
    ]);
    expect(cambiosEntre(antes, await fotoDe(admin, m.c.id))).toEqual([]);
    expect(await contarCompras(admin, m.c.id)).toBe(5_000);
    expect(await contarPropuestas(admin, m.c.id)).toBe(1); // la sembrada; la descarga no dejó encabezado
    // Control: una descarga válida del mismo cliente sí se guarda.
    await conWorker(api, () => controlPositivo(api, m));
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("secretos y contenido crudo (RNF-004)", () => {
  it("el contenido crudo de una fila ilegible no aparece en las tablas ni en job_registro", async () => {
    const m = await mundoVentas(e, backend);
    const api = new SireApiControlado();
    responder(api, [
      filaCompra("1"),
      filaCompra("2", {
        total: "CANARIO-MONTO-777",
        razonSocialContraparte: "CANARIO-RAZON-888",
      }),
    ]);
    const r = await conWorker(api, () => descargar(m));
    expect(r.estado).toBe("error");
    const trabajo = JSON.stringify(await e.fila(r.id));
    expect(trabajo).not.toContain("CANARIO-MONTO-777");
    expect(trabajo).not.toContain("CANARIO-RAZON-888");
    expect(await volcarTablasCompras(admin, [m.T])).not.toContain("CANARIO");
    await nada(m);
    await conWorker(api, () => controlPositivo(api, m));
  });
});
