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
  comprasDe,
  encolarDescarga,
  filaCompra,
  limpiarCompras,
  mundoVentas,
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
  fijarInterruptor,
  limpiarReglas,
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
} from "../../../test/trabajos.js";
import {
  NUMEROS_FIXTURE,
  arrancarXml,
  esperarLotesXml,
  limpiarXml,
  puertosXml,
  type PuertosXml,
} from "../../../test/xml.js";

// Spec 025, T11a (integración con PostgreSQL y Redis reales, BullMQ real, el mock de SireApiClient y `MockXmlProvider`): R-STD nunca
// se sugiere a un proveedor con regla aprendida activa, sea cual sea el interruptor de R-HIS (D-8). Antes de 0063 el worker leía esos
// proveedores con `reglas_historial_vigentes`, que con R-HIS apagado devuelve vacío: R-STD sugería DNG a proveedores con regla.
// Ahora los lee con `reglas_proveedores_con_regla` (0063). Una regla desactivada sigue sin contar.

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

async function conWorker<T>(
  p: PuertosXml,
  fn: () => Promise<T>,
  api?: SireApiControlado,
  simulado = false,
): Promise<T> {
  const w = await arrancarXml(prefijo, p, {
    simuladoEnReglas: simulado,
    ...(api === undefined ? {} : { sireApi: api }),
  });
  if (api !== undefined) api.contarTx = () => w.dbEstado.abiertas;
  try {
    return await fn();
  } finally {
    await w.detener({ esperaMs: 2000 });
  }
}

async function descargar(m: MundoVentas) {
  const id = await encolarDescarga(backend, redis, prefijo, m, {
    libro: "compras",
  });
  const f = await esperarTerminal(e, id, 60_000);
  return { estado: f.estado, motivo: f.motivo };
}

async function compraDe(m: MundoVentas, numero: string) {
  const c = (await comprasDe(admin, m.c.id)).find((x) => x.numero === numero);
  expect(c, `compra ${numero}`).toBeDefined();
  return c!;
}

const P = {
  X: rucProveedor(201), // sin regla
  Y: rucProveedor(202), // regla activa en DNG
  Z: rucProveedor(203), // regla activa en DG
  W: rucProveedor(204), // regla desactivada
};

const fila = (numero: string, ruc: string): FilaPropuestaSire =>
  filaCompra(numero, { rucContraparte: ruc });

describe("T11a · R-HIS apagado: R-STD sigue sin sugerirse a proveedores con regla activa (D-8)", () => {
  it("descarga: sin R-STD en los proveedores con regla activa (DNG y DG); sí en el sin regla y en el de regla desactivada", async () => {
    const m = await mundoVentas(e, backend);
    await fijarPerfil(admin, m.c.id, CUMPLE);
    await fijarInterruptor(admin, m, "R-HIS", false);
    await sembrarRegla(admin, m, { docNumero: P.Y, destino: "DNG" });
    await sembrarRegla(admin, m, { docNumero: P.Z, destino: "DG" });
    await sembrarRegla(admin, m, {
      docNumero: P.W,
      destino: "DNG",
      activa: false,
    });
    const api = new SireApiControlado();
    api.responder([
      fila("1", P.X),
      fila("2", P.Y),
      fila("3", P.Z),
      fila("4", P.W),
    ] as never);
    const r = await conWorker(puertosXml(), () => descargar(m), api);
    expect(r).toEqual({ estado: "completado", motivo: null });

    for (const [numero, motivo] of [
      ["2", "regla activa en DNG"],
      ["3", "regla activa en DG"],
    ] as const)
      expect(
        await hallazgosStdDe(admin, (await compraDe(m, numero)).id),
        `${numero} (${motivo})`,
      ).toEqual([]);
    for (const [numero, motivo] of [
      ["1", "sin regla"],
      ["4", "regla desactivada"],
    ] as const)
      expect(
        await hallazgosStdDe(admin, (await compraDe(m, numero)).id),
        `${numero} (${motivo})`,
      ).toHaveLength(1);
    // Control: con R-HIS apagado la regla no mueve la compra (solo la versión 1 del SIRE).
    expect(
      (await versionesDe(admin, (await compraDe(m, "2")).id)).length,
    ).toBe(1);
  });

  it("re-evaluación de xml.obtener: el proveedor con regla activa no recibe R-STD ni en la evaluación 1 ni en la 2", async () => {
    const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
    await fijarPerfil(admin, m.c.id, CUMPLE);
    await fijarInterruptor(admin, m, "R-HIS", false);
    // La regla es del proveedor de la compra 2056 (como en persistidor-std.int.spec.ts, pero con R-HIS apagado).
    await sembrarRegla(admin, m, { docNumero: "20700000045", destino: "DG" });
    const p = puertosXml();
    p.xml.pausar();
    const compras = await conWorker(
      p,
      async () => {
        expect((await descargar(m)).estado).toBe("completado");
        await esperarHasta(
          () => p.xml.llamadas.length > 0,
          "el proveedor recibe el pedido",
        );
        p.xml.abrir();
        const l = await esperarLotesXml(admin, m.c.id, 1, esperarHasta, 25_000);
        expect(l[0]).toMatchObject({ estado: "completado" });
        return new Map(
          (await comprasDe(admin, m.c.id)).map((c) => [c.numero, c]),
        );
      },
      undefined,
      true,
    );
    expect(
      await hallazgosStdDe(admin, compras.get("2056")!.id),
      "2056 (proveedor con regla activa)",
    ).toEqual([]);
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
});
