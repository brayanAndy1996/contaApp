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
  MONTOS,
  PERIODO,
  RUC_FIXTURE,
  SireApiControlado,
  cambiosEntre,
  comprasDe,
  encolarDescarga,
  filaCompra,
  fotoDe,
  limpiarCompras,
  mundoVentas,
  reglasDe,
  sembrarCompra,
  versionesDe,
  volcarTablasCompras,
  type MundoVentas,
} from "../../../test/compras.js";
import {
  aplicacionesDe,
  auditoriaHistorialDe,
  contarAplicaciones,
  esperadoMd5,
  fijarInterruptor,
  limpiarReglas,
  md5Version,
  sembrarRegla,
  volcarAuditoria,
  volcarTablasReglas,
} from "../../../test/reglas.js";
import { loggerEspia, volcado } from "../../../test/soporte.js";
import {
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  Escenario,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
  restaurarConfig,
  volcarPrefijo,
  type ProcesoWorker,
} from "../../../test/trabajos.js";
import { boletas290y292 } from "../../../test/ventas.js";

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
const PZ = "20600000029"; // proveedor sin regla

const f = (
  numero: string,
  ruc: string,
  extra: Partial<FilaPropuestaSire> = {},
): FilaPropuestaSire =>
  filaCompra(numero, { rucContraparte: ruc, ...extra });

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
  expect(vs.map((v) => [v.n, v.accion]), `${motivo}: versiones`).toEqual([
    [1, "original"],
  ]);
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
  expect(vs.map((v) => [v.n, v.accion]), `${numero}: versiones`).toEqual([
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
describe("CA-2: la descarga aplica la regla aprendida a las compras nuevas", () => {
  it("regla DNG de X aprendida en 202609: sus compras de 202610 quedan con versión 2 historial en DNG; las de otro proveedor no", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const reglaId = await sembrarRegla(admin, m, {
      docNumero: PX,
      destino: "DNG",
    });
    const api = new SireApiControlado();
    responder(api, [
      f("1", PX),
      f("2", PX, MIXTA),
      f("3", PZ),
    ]);
    const r = await conWorker(api, () => descargar(m));
    expect([r.estado, r.motivo]).toEqual(["completado", null]);

    // La gravada: todo a DNG, el total no cambia.
    await conHistorial(m, "1", {
      ...CEROS,
      biDng: "100.00",
      igvDng: "18.00",
      total: "118.00",
    });
    // La mixta: DG + DGNG consolidados en DNG.
    await conHistorial(m, "2", {
      ...CEROS,
      biDng: "1000.00",
      igvDng: "180.00",
      total: "1180.00",
    });

    // Una aplicación por compra movida, con la regla, la versión 2 y el periodo de la descarga.
    const c1 = await compraDe(m, "1");
    const c2 = await compraDe(m, "2");
    expect(await aplicacionesDe(admin, m.c.id)).toEqual(
      [c1, c2]
        .map((c) => ({
          regla_id: reglaId,
          compra_id: c.id,
          version_n: 2,
          periodo: PERIODO,
        }))
        .sort((a, b) => a.compra_id.localeCompare(b.compra_id)),
    );

    // El otro proveedor no se toca (y es nuevo para el cliente: R-NEW en su versión 1).
    await sinHistorial(m, "3", "proveedor sin regla");
    expect(await reglasDe(admin, (await compraDe(m, "3")).id)).toContain(
      "R-NEW",
    );

    expect(r.resultado).toMatchObject({ recibidas: 3, nuevas: 3 });
    expect(r.resultado!.segunHistorial).toBe(2);
  });

  it("la versión 1 sigue idéntica a la fila del SIRE: columnas exactas y md5 de la fila", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await sembrarRegla(admin, m, { docNumero: PX, destino: "DNG" });
    const api = new SireApiControlado();
    const filas = [f("1", PX), f("2", PX, MIXTA)];
    responder(api, filas);
    await conWorker(api, () => descargar(m));

    for (const fila of filas) {
      const c = await compraDe(m, fila.numero);
      expect(c.version_vigente, `${fila.numero}: se movió a la versión 2`).toBe(
        2,
      );
      const [v1] = await versionesDe(admin, c.id);
      expect(v1).toMatchObject({
        n: 1,
        accion: "original",
        clasificada: false,
        excluida: false,
        motivo: null,
        operacion_id: null,
        usuario_id: null,
      });
      for (const [col] of MONTOS)
        expect(v1!.montos[col], `${fila.numero}.${col}`).toBe(
          fila[col] as string,
        );
      expect(await md5Version(admin, c.id, 1), `md5 ${fila.numero}`).toBe(
        esperadoMd5(fila as never),
      );
      // La identidad de la compra tampoco cambia.
      expect(c).toMatchObject({
        origen: "sire",
        doc_tipo: "6",
        doc_numero: PX,
        razon_social: fila.razonSocialContraparte,
        fecha: fila.fechaEmision,
        moneda: "PEN",
      });
    }
  });

  it.each(["DG", "DGNG"] as const)(
    "regla %s: los tres BI y los tres IGV se consolidan en el par del destino",
    async (destino) => {
      const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
      await sembrarRegla(admin, m, { docNumero: PX, destino });
      const api = new SireApiControlado();
      // DGNG: la fila de entrada está en DG. DG: la fila de entrada es la mixta DG + DGNG.
      responder(api, [destino === "DG" ? f("1", PX, MIXTA) : f("1", PX)]);
      await conWorker(api, () => descargar(m));
      const esperado =
        destino === "DG"
          ? { ...CEROS, biDg: "1000.00", igvDg: "180.00", total: "1180.00" }
          : { ...CEROS, biDgng: "100.00", igvDgng: "18.00", total: "118.00" };
      await conHistorial(m, "1", esperado);
    },
  );

  it("las otras columnas de monto (no gravado, ISC, ICBPER, otros) pasan intactas a la versión 2", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await sembrarRegla(admin, m, { docNumero: PX, destino: "DNG" });
    const api = new SireApiControlado();
    responder(api, [
      f("1", PX, {
        biDg: "230.00",
        igvDg: "41.40",
        noGravado: "8.97",
        isc: "770.00",
        icbper: "0.50",
        otros: "1.10",
        total: "1051.97",
      }),
    ]);
    await conWorker(api, () => descargar(m));
    await conHistorial(m, "1", {
      ...CEROS,
      biDng: "230.00",
      igvDng: "41.40",
      noGravado: "8.97",
      isc: "770.00",
      icbper: "0.50",
      otros: "1.10",
      total: "1051.97",
    });
  });

  it("USD con tipo de cambio: la versión 2 consolida los montos y la compra conserva su moneda y su tipo de cambio", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await sembrarRegla(admin, m, { docNumero: PX, destino: "DNG" });
    const api = new SireApiControlado();
    responder(api, [
      f("1", PX, {
        moneda: "USD",
        tipoCambio: "3.756",
        biDg: "100.00",
        igvDg: "18.00",
        total: "118.00",
      }),
    ]);
    await conWorker(api, () => descargar(m));
    const { compra } = await conHistorial(m, "1", {
      ...CEROS,
      biDng: "100.00",
      igvDng: "18.00",
      total: "118.00",
    });
    expect(compra).toMatchObject({ moneda: "USD", tipo_cambio: "3.756" });
  });

  it("nota de crédito (montos negativos): se consolida con el signo", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await sembrarRegla(admin, m, { docNumero: PX, destino: "DNG" });
    const api = new SireApiControlado();
    responder(api, [
      f("1", PX, {
        tipo: "07",
        biDg: "-100.00",
        igvDg: "-18.00",
        total: "-118.00",
      }),
    ]);
    await conWorker(api, () => descargar(m));
    await conHistorial(m, "1", {
      ...CEROS,
      biDng: "-100.00",
      igvDng: "-18.00",
      total: "-118.00",
    });
  });

  it("D-7: la versión 2 se evalúa sin R-NEW; sin regla, el mismo proveedor nuevo sí trae R-NEW", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await sembrarRegla(admin, m, { docNumero: PX, destino: "DNG" });
    const api = new SireApiControlado();
    responder(api, [f("1", PX), f("2", PZ)]);
    await conWorker(api, () => descargar(m));
    const conRegla = await compraDe(m, "1");
    const sinRegla = await compraDe(m, "2");
    expect(conRegla.version_vigente, "la compra de X pasó a la versión 2").toBe(
      2,
    );
    expect(
      await reglasDe(admin, conRegla.id, 2),
      "versión 2 con regla",
    ).not.toContain("R-NEW");
    expect(
      await reglasDe(admin, sinRegla.id, 1),
      "control: sin regla el proveedor nuevo pide destino",
    ).toContain("R-NEW");
  });

  it("CA-9: una regla editada antes de la descarga (versión 2, DGNG) aplica el destino vigente", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await sembrarRegla(admin, m, {
      docNumero: PX,
      destino: "DGNG",
      version: 2,
    });
    const api = new SireApiControlado();
    responder(api, [f("1", PX)]);
    await conWorker(api, () => descargar(m));
    await conHistorial(m, "1", {
      ...CEROS,
      biDgng: "100.00",
      igvDgng: "18.00",
      total: "118.00",
    });
  });

  it("un documento de otro tipo con el mismo número no coincide con la regla del RUC", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await sembrarRegla(admin, m, { docTipo: "6", docNumero: PX });
    await sembrarRegla(admin, m, { docNumero: PY, destino: "DNG" }); // control
    const api = new SireApiControlado();
    responder(api, [f("1", PX, { tipoDocContraparte: "1" }), f("2", PY)]);
    const r = await conWorker(api, () => descargar(m));
    await sinHistorial(m, "1", "mismo número, otro tipo de documento");
    await conHistorial(m, "2", { ...CEROS, biDng: "100.00", igvDng: "18.00" });
    expect(r.resultado!.segunHistorial).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-4: lo que R-HIS no toca", () => {
  type Caso = [string, Parameters<typeof sembrarRegla>[2]];
  const EXCLUIDOS: Caso[] = [
    ["regla inactiva", { activa: false }],
    ["regla eliminada", { eliminada: true }],
    ["aprendida en el mismo periodo de la descarga", { periodoAprendido: PERIODO }],
    ["aprendida en un periodo posterior", { periodoAprendido: "202611" }],
  ];

  it.each(EXCLUIDOS)(
    "%s: la compra de X se queda en la versión 1; la de Y (regla válida) sí se mueve",
    async (_nombre, opcionesX) => {
      const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
      await sembrarRegla(admin, m, { docNumero: PX, ...opcionesX });
      await sembrarRegla(admin, m, { docNumero: PY, destino: "DNG" });
      const api = new SireApiControlado();
      responder(api, [f("1", PX), f("2", PY)]);
      const r = await conWorker(api, () => descargar(m));
      expect(r.estado).toBe("completado");
      await sinHistorial(m, "1", _nombre);
      await conHistorial(m, "2", {
        ...CEROS,
        biDng: "100.00",
        igvDng: "18.00",
      });
      expect(r.resultado!.segunHistorial, "solo se cuenta la de Y").toBe(1);
    },
  );

  it("BI total 0: la compra de X (solo no gravado) se queda en la versión 1", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await sembrarRegla(admin, m, { docNumero: PX, destino: "DNG" });
    await sembrarRegla(admin, m, { docNumero: PY, destino: "DNG" });
    const api = new SireApiControlado();
    responder(api, [
      f("1", PX, {
        biDg: "0.00",
        igvDg: "0.00",
        noGravado: "50.00",
        total: "50.00",
      }),
      f("2", PY),
    ]);
    const r = await conWorker(api, () => descargar(m));
    await sinHistorial(m, "1", "BI total 0");
    await conHistorial(m, "2", { ...CEROS, biDng: "100.00", igvDng: "18.00" });
    expect(r.resultado!.segunHistorial).toBe(1);
  });

  it("destino igual al actual: la compra ya en DNG se queda en la versión 1", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await sembrarRegla(admin, m, { docNumero: PX, destino: "DNG" });
    await sembrarRegla(admin, m, { docNumero: PY, destino: "DNG" });
    const api = new SireApiControlado();
    responder(api, [
      f("1", PX, { ...CEROS, biDng: "100.00", igvDng: "18.00" }),
      f("2", PY),
    ]);
    const r = await conWorker(api, () => descargar(m));
    await sinHistorial(m, "1", "ya está en el destino");
    await conHistorial(m, "2", { ...CEROS, biDng: "100.00", igvDng: "18.00" });
    expect(r.resultado!.segunHistorial).toBe(1);
  });

  it("R-HIS apagado: ninguna compra se mueve; al encenderlo, las compras ya guardadas no se tocan y las nuevas sí", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await sembrarRegla(admin, m, { docNumero: PX, destino: "DNG" });
    await fijarInterruptor(admin, m, "R-HIS", false);
    const api = new SireApiControlado();
    responder(api, [f("1", PX)]);
    // Las dos descargas con el mismo worker en marcha (como las pruebas de 014): reiniciarlo espera el arriendo del líder.
    const { r1, r2 } = await conWorker(api, async () => {
      const r1 = await descargar(m);
      expect(r1.estado).toBe("completado");
      await sinHistorial(m, "1", "R-HIS apagado");
      expect(await contarAplicaciones(admin, m.T)).toBe(0);

      // Se enciende y llega una descarga con la misma fila y una nueva: la guardada no cambia (D-1: solo al cargar).
      await fijarInterruptor(admin, m, "R-HIS", true);
      responder(api, [f("1", PX), f("2", PX)]);
      return { r1, r2: await descargar(m) };
    });
    expect(r1.resultado!.segunHistorial ?? 0).toBe(0);
    expect(r2.resultado).toMatchObject({ nuevas: 1, iguales: 1 });
    await sinHistorial(m, "1", "ya estaba guardada");
    await conHistorial(m, "2", { ...CEROS, biDng: "100.00", igvDng: "18.00" });
    expect(r2.resultado!.segunHistorial).toBe(1);
  });

  it("descarga repetida sin filas nuevas: una regla aprendida después no toca lo ya guardado; una fila nueva posterior sí se mueve", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const api = new SireApiControlado();
    responder(api, [f("1", PX), f("2", PX)]);
    const { r, r3 } = await conWorker(api, async () => {
      expect((await descargar(m)).estado).toBe("completado");
      await sembrarRegla(admin, m, { docNumero: PX, destino: "DNG" });
      const antes = await fotoDe(admin, m.c.id);

      const r = await descargar(m);
      expect(r.estado).toBe("completado");
      expect(cambiosEntre(antes, await fotoDe(admin, m.c.id))).toEqual([]);
      expect(await contarAplicaciones(admin, m.T)).toBe(0);

      // Control: la misma regla sí mueve la fila que llega por primera vez en la descarga siguiente.
      responder(api, [f("1", PX), f("2", PX), f("3", PX)]);
      return { r, r3: await descargar(m) };
    });
    expect(r.resultado).toMatchObject({ nuevas: 0, iguales: 2 });
    expect(r.resultado!.segunHistorial ?? 0).toBe(0);
    expect(r3.resultado).toMatchObject({ nuevas: 1, iguales: 2 });
    expect(r3.resultado!.segunHistorial).toBe(1);
    await sinHistorial(m, "1", "sigue sin moverse");
    await sinHistorial(m, "2", "sigue sin moverse");
    await conHistorial(m, "3", { ...CEROS, biDng: "100.00", igvDng: "18.00" });
  });

  it("una compra sembrada antes en el periodo (misma clave) no se mueve aunque exista la regla", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await sembrarCompra(admin, m, f("1", PX));
    await sembrarRegla(admin, m, { docNumero: PX, destino: "DNG" });
    const api = new SireApiControlado();
    responder(api, [f("1", PX), f("2", PX)]);
    const r = await conWorker(api, () => descargar(m));
    expect(r.resultado).toMatchObject({ nuevas: 1, iguales: 1 });
    await sinHistorial(m, "1", "ya existía");
    await conHistorial(m, "2", { ...CEROS, biDng: "100.00", igvDng: "18.00" });
  });

  it("la regla de otro cliente del mismo estudio y la de otro estudio, con el mismo RUC de proveedor, no se aplican", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const otroCliente = await e.cliente(m.T);
    const otro = await mundoVentas(e, backend);
    await sembrarRegla(admin, m, {
      docNumero: PX,
      clienteId: otroCliente.id,
    });
    await sembrarRegla(admin, otro, { docNumero: PX });
    await sembrarRegla(admin, m, { docNumero: PY, destino: "DNG" }); // control
    const api = new SireApiControlado();
    responder(api, [f("1", PX), f("2", PY)]);
    const r = await conWorker(api, () => descargar(m));
    await sinHistorial(m, "1", "regla ajena");
    await conHistorial(m, "2", { ...CEROS, biDng: "100.00", igvDng: "18.00" });
    expect(r.resultado!.segunHistorial).toBe(1);
    expect(await aplicacionesDe(admin, otroCliente.id)).toEqual([]);
    expect(await contarAplicaciones(admin, otro.T)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CA-13 / D-10: el resultado, los logs y la auditoría no llevan montos, razón social ni RUC", () => {
  it("canarios en razón social, RUC y montos: el conteo es lo único que sale; la auditoría compra.historial es del trabajo de descarga y solo lleva ids", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    const ruc = "20731641779";
    const razon = "CANARIO-razon-7f3a91c2e5b84d06";
    const monto = "7316.41";
    await sembrarRegla(admin, m, { docNumero: ruc, destino: "DNG" });
    const api = new SireApiControlado();
    responder(api, [
      f("1", ruc, {
        razonSocialContraparte: razon,
        biDg: monto,
        igvDg: "1316.95",
        total: "8633.36",
      }),
    ]);
    const espia = loggerEspia();
    const r = await conWorker(api, () => descargar(m), {
      logger: espia.logger,
    });
    expect(r.estado).toBe("completado");
    await conHistorial(m, "1", { biDng: monto, igvDng: "1316.95" });
    expect(r.resultado!.segunHistorial).toBe(1);

    const resultado = JSON.stringify(r.resultado);
    const observable = [
      resultado,
      await e.volcarJobs(),
      await volcarPrefijo(redis, prefijo),
      await volcarAuditoria(admin, m.T),
      volcado(espia.llamadas),
    ].join("\n");
    for (const canario of [ruc, razon, monto, "1316.95", "8633.36"])
      expect(observable, `«${canario}» no debe salir`).not.toContain(canario);
    expect(Buffer.byteLength(resultado)).toBeLessThanOrEqual(4096);

    // La auditoría de la aplicación: una fila, del sistema, con ids y periodo.
    const aud = await auditoriaHistorialDe(admin, m.T);
    expect(aud).toHaveLength(1);
    // Actor `trabajo` con el id de la descarga (auditoria_registrar lo decide por `app.trabajo_id` y toma como usuario a quien
    // la pidió: `creado_por` del trabajo).
    expect(aud[0]).toMatchObject({
      actor_tipo: "trabajo",
      usuario_id: m.u,
      trabajo_id: r.id,
    });
    expect(Object.keys(aud[0]!.datos).sort()).toEqual([
      "compraId",
      "periodo",
      "reglaId",
    ]);
    expect(aud[0]!.datos).toMatchObject({ periodo: PERIODO });

    // En las tablas de negocio sí está (control: el canario existe donde debe).
    const tablas = [
      await volcarTablasCompras(admin, [m.T]),
      await volcarTablasReglas(admin, [m.T]),
    ].join("\n");
    expect(tablas).toContain(razon);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("ventas no informa segunHistorial", () => {
  it("una descarga de ventas con reglas en el estudio deja el resultado de 013, sin segunHistorial", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await sembrarRegla(admin, m, { docNumero: PX, destino: "DNG" });
    const api = new SireApiControlado();
    api.responder(boletas290y292());
    const id = await encolarDescarga(backend, redis, prefijo, m);
    const t = await conWorker(api, () => esperarTerminal(e, id, 90_000));
    expect([t.estado, t.motivo]).toEqual(["completado", null]);
    const res = (t as { resultado?: Record<string, unknown> }).resultado!;
    expect(res).toMatchObject({ recibidas: 2, nuevas: 2 });
    expect(Object.keys(res)).not.toContain("segunHistorial");
  });
});
