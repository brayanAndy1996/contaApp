// Spec 021 · T20: correcciones de la ronda adversarial 2 (rojo; integración con PostgreSQL y Redis reales, BullMQ real y el mock de
// SireApiClient). H-021-2-4: una fila de la descarga cuya suma de BI o de IGV al consolidar en el destino de la regla no cabe en
// NUMERIC(14,2) no se mueve (queda en la versión 1, sin `regla_aplicacion`) y no tumba la descarga: las demás filas del mismo
// proveedor y de otro proveedor con regla se aplican igual y la descarga termina `completado`. Hoy `planificarHistorial` lanza
// MontoFueraDeRangoError dentro de `persistidorCompras.insertar` y el trabajo falla entero. Falla hasta T21.
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
import {
  arrancar007b,
  esperarTerminal,
} from "../../../test/procesadores-007b.js";
import {
  PERIODO,
  RUC_FIXTURE,
  SireApiControlado,
  comprasDe,
  encolarDescarga,
  filaCompra,
  limpiarCompras,
  mundoVentas,
  versionesDe,
  type MundoVentas,
} from "../../../test/compras.js";
import {
  aplicacionesDe,
  limpiarReglas,
  sembrarRegla,
} from "../../../test/reglas.js";
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

// Spec 021, T4 (rojo; integración con PostgreSQL y Redis reales, BullMQ real y el mock de SireApiClient): R-HIS en la descarga
// de compras (D-1, D-7, D-10; CA-2, CA-4, CA-9, CA-13). Se encola como lo hace el backend y lo ejecuta el worker real.
//
// CONTRATO que fija (T10 worker, T9 `packages/db`), además del de `test/reglas.ts` (tablas y columnas de plan.md, 0047-0049):
// - Una regla viva, activa, del mismo cliente y del mismo proveedor (documento normalizado), con `periodo_aprendido` menor que
//   el de la descarga, y con R-HIS encendido, mueve la compra NUEVA al destino de la regla: la versión 1 queda tal cual llegó
//   del SIRE (`original`) y se inserta la versión 2 (`accion = historial`, `clasificada = true`, sin operación ni usuario) con
//   los tres BI y los tres IGV consolidados en el par del destino y el resto igual; `version_vigente` = 2 y una fila de
//   `regla_aplicacion` (regla, compra, `version_n` 2, periodo). La moneda y el tipo de cambio de la compra no cambian.
// - Se queda en la versión 1 la compra de otro proveedor o de otro cliente, la de regla inactiva, eliminada o aprendida en el
//   mismo periodo o uno posterior, la de BI total 0, la que ya está en el destino, la que no es nueva (descarga repetida) y
//   cualquiera con R-HIS apagado.
// - La versión 2 se evalúa sin R-NEW (el proveedor con regla deja de ser nuevo).
// - `resultado.segunHistorial` es el conteo de compras movidas y solo se informa cuando hay alguna (sin ellas el `resultado`
//   conserva la forma de 014: así no se rompen las pruebas de 014). Nada de montos, razones sociales ni RUC en el `resultado`,
//   los logs, Redis ni `auditoria.datos`; la auditoría `compra.historial` es de actor `trabajo` (la descarga) y solo lleva ids y periodo.

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
  await limpiarReglas(admin, e?.estudios ?? []).catch(() => undefined);
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
  extra: Record<string, unknown> = {},
): Promise<T> {
  const p = await arrancar007b({
    prefijo,
    sireApi: api,
    ...extra,
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
  segunHistorial?: number;
}

/** Encola una descarga de compras y espera su fin (el worker ya debe estar en marcha). */
async function descargar(m: MundoVentas, timeoutMs = 90_000) {
  const id = await encolarDescarga(backend, redis, prefijo, m, {
    libro: "compras",
  });
  const f = await esperarTerminal(e, id, timeoutMs);
  return {
    id,
    estado: f.estado,
    motivo: f.motivo,
    resultado: (f as { resultado?: unknown }).resultado as Resultado | null,
  };
}

/** El puerto devuelve estas filas de compras (el soporte de ventas las tipa como de ventas). */
const responder = (api: SireApiControlado, filas: FilaPropuestaSire[]) =>
  api.responder(filas as never);

const PX = "20100070970"; // proveedor con regla
const PY = "20600000011"; // segundo proveedor con regla válida (control positivo dentro de cada prueba)

const f = (
  numero: string,
  ruc: string,
  extra: Partial<FilaPropuestaSire> = {},
): FilaPropuestaSire => filaCompra(numero, { rucContraparte: ruc, ...extra });

/** Mixta: 600.00 en DG y 400.00 en DGNG (el IGV de cada par), total 1180.00. */
const MIXTA: Partial<FilaPropuestaSire> = {
  biDg: "600.00",
  igvDg: "108.00",
  biDgng: "400.00",
  igvDgng: "72.00",
  total: "1180.00",
};

const CEROS = {
  biDg: "0.00",
  igvDg: "0.00",
  biDgng: "0.00",
  igvDgng: "0.00",
  biDng: "0.00",
  igvDng: "0.00",
};

async function compraDe(m: MundoVentas, numero: string) {
  const c = (await comprasDe(admin, m.c.id)).find((x) => x.numero === numero);
  expect(c, `compra ${numero}`).toBeDefined();
  return c!;
}

/** La compra se quedó como llegó: una sola versión `original`, sin aplicación de regla. */
async function sinHistorial(m: MundoVentas, numero: string, motivo: string) {
  const c = await compraDe(m, numero);
  expect(c.version_vigente, `${motivo}: versión vigente`).toBe(1);
  const vs = await versionesDe(admin, c.id);
  expect(
    vs.map((v) => [v.n, v.accion]),
    `${motivo}: versiones`,
  ).toEqual([[1, "original"]]);
  const aplicadas = (await aplicacionesDe(admin, m.c.id)).filter(
    (a) => a.compra_id === c.id,
  );
  expect(aplicadas, `${motivo}: regla_aplicacion`).toEqual([]);
}

/** La compra pasó a la versión 2 `historial` con los montos dados (sobre los de la fila original). */
async function conHistorial(
  m: MundoVentas,
  numero: string,
  montos: Record<string, string>,
) {
  const c = await compraDe(m, numero);
  expect(c.version_vigente, `${numero}: versión vigente`).toBe(2);
  const vs = await versionesDe(admin, c.id);
  expect(
    vs.map((v) => [v.n, v.accion]),
    `${numero}: versiones`,
  ).toEqual([
    [1, "original"],
    [2, "historial"],
  ]);
  const v2 = vs[1]!;
  expect(v2).toMatchObject({
    clasificada: true,
    excluida: false,
    motivo: null,
    operacion_id: null,
    usuario_id: null,
  });
  expect(v2.montos).toMatchObject(montos);
  return { compra: c, versiones: vs };
}

// ---------------------------------------------------------------------------------------------------------------
const MAXIMO = "999999999999.99";
/** Cada columna cabe sola; BI de DG + BI de DGNG suman 1 000 000 000 000.00 al consolidar. */
const DESBORDA_BI: Partial<FilaPropuestaSire> = {
  biDg: MAXIMO,
  igvDg: "0.00",
  biDgng: "0.01",
  total: MAXIMO,
};
/** Igual con los IGV de DG y de DGNG (el BI cabe). */
const DESBORDA_IGV: Partial<FilaPropuestaSire> = {
  igvDg: MAXIMO,
  igvDgng: "0.01",
  total: MAXIMO,
};

describe("H-021-2-4: una fila cuya consolidación desborda NUMERIC(14,2) no tumba la descarga ni se mueve", () => {
  it("la descarga termina completada; la fila que desborda queda en la versión 1 y las demás se mueven a DNG", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const reglaX = await sembrarRegla(admin, m, {
      docNumero: PX,
      destino: "DNG",
    });
    const reglaY = await sembrarRegla(admin, m, {
      docNumero: PY,
      destino: "DNG",
    });
    const api = new SireApiControlado();
    responder(api, [
      f("1", PX),
      f("2", PX, DESBORDA_BI),
      f("3", PX, DESBORDA_IGV),
      f("4", PX, MIXTA),
      f("5", PY),
    ]);
    const r = await conWorker(api, () => descargar(m));
    expect([r.estado, r.motivo]).toEqual(["completado", null]);

    // Las filas que caben se mueven a DNG, como siempre.
    await conHistorial(m, "1", {
      ...CEROS,
      biDng: "100.00",
      igvDng: "18.00",
      total: "118.00",
    });
    await conHistorial(m, "4", {
      ...CEROS,
      biDng: "1000.00",
      igvDng: "180.00",
      total: "1180.00",
    });
    await conHistorial(m, "5", {
      ...CEROS,
      biDng: "100.00",
      igvDng: "18.00",
      total: "118.00",
    });

    // Las dos que desbordan se guardan tal cual llegaron: versión 1 `original`, sin aplicación de regla.
    await sinHistorial(m, "2", "BI que desborda");
    await sinHistorial(m, "3", "IGV que desborda");
    const c2 = await compraDe(m, "2");
    const [v1] = await versionesDe(admin, c2.id);
    expect(v1!.montos).toMatchObject({
      biDg: MAXIMO,
      biDgng: "0.01",
      total: MAXIMO,
    });

    // Una aplicación por fila movida, con la regla de su proveedor.
    const c1 = await compraDe(m, "1");
    const c4 = await compraDe(m, "4");
    const c5 = await compraDe(m, "5");
    const esperadas = [
      { regla_id: reglaX, compra_id: c1.id },
      { regla_id: reglaX, compra_id: c4.id },
      { regla_id: reglaY, compra_id: c5.id },
    ]
      .map((a) => ({ ...a, version_n: 2, periodo: PERIODO }))
      .sort((a, b) => a.compra_id.localeCompare(b.compra_id));
    expect(await aplicacionesDe(admin, m.c.id)).toEqual(esperadas);

    expect(r.resultado).toMatchObject({
      recibidas: 5,
      nuevas: 5,
      segunHistorial: 3,
    });
  });
});
