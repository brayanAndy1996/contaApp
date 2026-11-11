import type { ContappDb } from "@contapp/db";
import { ErrorDatos } from "@contapp/sunat";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AlmacenEspia,
  PERIODO,
  ctxDe,
  encolarGenerar,
  estadoDe,
  limpiarArchivos,
  ventaFactura,
  versionesDe,
  type ParametrosGenerar,
} from "../../../test/archivos.js";
import { limpiarCompras, RUC_FIXTURE } from "../../../test/compras.js";
import { arrancar007b, esperarTerminal } from "../../../test/procesadores-007b.js";
import {
  Escenario,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
} from "../../../test/trabajos.js";
import { mundoVentas, sembrarManual, type MundoVentas } from "../../../test/ventas.js";
import { ErrorArchivo, generarArchivo } from "./generar-archivo.js";

// Spec 012b, T18 (rojo): corrección de H-012b-2 (ronda adversarial 1). Con datos REALES cuyo impacto total en IGV no cabe en
// NUMERIC(14,2) (cada venta cabe y cuadra al 18 %, la suma no), el procesador `archivo.generar` termina con un error de DATOS
// (`ErrorDatos`/`ErrorArchivo`, motivo `datos_invalidos`, sin reintento) y no deja versión, ZIP ni cambio de estado. Es el mismo
// desborde por el que el previo y el `POST` del backend responden 422 `resumen_fuera_de_rango`
// (`apps/backend/src/modules/archivos/previo-fuera-de-rango.int.spec.ts`).
// Hoy (rojo): `prepararArchivo` (domain, `prevalidacion/resumen.ts`) lanza `EntradaPrevalidacionInvalidaError`, que no es
// `ErrorDatos`: el procesador lo deja pasar tal cual y el ejecutor de 008 lo trata como fallo transitorio (reintenta).
// La huella del trabajo es una cualquiera: el desborde se produce al armar el resumen, antes de compararla.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

let admin: ContappDb;
let backend: ContappDb;
let dbWorker: ContappDb;
let redis: Redis;
let e: Escenario;
let prefijo = nuevoPrefijo();
const prefijos = [prefijo];

interface FilaConfig {
  cola: string;
  concurrencia_global: number;
  concurrencia_tenant: number;
  espera_ruc_ms: number;
  reintentos: number;
  backoff_base_ms: number;
  max_pendientes_tenant: number;
}
let configOriginal: FilaConfig | undefined;

beforeAll(async () => {
  admin = crearDbAdmin();
  backend = crearDbRol("contapp_backend");
  dbWorker = crearDbRol("contapp_worker", 8);
  redis = conectarRedis();
  e = new Escenario(admin);
  configOriginal = (await admin.pool.query("select * from config_sistema where cola = 'archivos'")).rows[0] as
    | FilaConfig
    | undefined;
  // Un reintento permitido: si el error no fuera de datos, el ejecutor lo reintentaría (`intentos` = 1).
  await fijarConfig(admin, "archivos", { global: 4, tenant: 2, espera: 0, reintentos: 1, base: 100 });
});

afterAll(async () => {
  if (configOriginal !== undefined) {
    await admin.pool
      .query(
        `update config_sistema set concurrencia_global = $2, concurrencia_tenant = $3, espera_ruc_ms = $4, reintentos = $5,
           backoff_base_ms = $6, max_pendientes_tenant = $7, actualizado_en = now() where cola = $1`,
        [
          "archivos",
          configOriginal.concurrencia_global,
          configOriginal.concurrencia_tenant,
          configOriginal.espera_ruc_ms,
          configOriginal.reintentos,
          configOriginal.backoff_base_ms,
          configOriginal.max_pendientes_tenant,
        ],
      )
      .catch(() => undefined);
  }
  await limpiarArchivos(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarCompras(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos) await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), dbWorker?.close(), admin?.close()]);
});

const IGV_ENORME = "144000000000.00"; // 18 % de 800 000 000 000.00
const HUELLA = "0".repeat(64);
const PARAMETROS: ParametrosGenerar = { periodo: PERIODO, libro: "ventas", estadoVisto: "abierto", huella: HUELLA };

/** Ventas agregadas a mano reales (7 facturas válidas que cuadran; las agregadas son el impacto en IGV): Σ IGV = 1 008 000 000 000.00, no cabe en NUMERIC(14,2). */
async function mundoDesbordado(): Promise<MundoVentas> {
  const m = await mundoVentas(e, backend, { ruc: RUC_FIXTURE });
  for (let i = 1; i <= 7; i++) {
    await sembrarManual(
      admin,
      m,
      ventaFactura("F001", String(i), { baseGravada: "800000000000.00", igv: IGV_ENORME, total: "944000000000.00" }),
    );
  }
  return m;
}

/** Un rechazo no deja rastro: ni versión, ni ZIP (ni intento de guardarlo), y el periodo sigue sin fila. */
async function sinRastro(m: MundoVentas, almacen: AlmacenEspia): Promise<void> {
  expect(await versionesDe(admin, m.c.id)).toEqual([]);
  expect(almacen.intentosGuardar).toEqual([]);
  expect(almacen.rutas()).toEqual([]);
  expect(await estadoDe(admin, "ventas", m.c.id)).toBeNull();
}

describe("H-012b-2 · el desborde del impacto en IGV es un error de datos en el worker", () => {
  it("directo: ErrorDatos (ErrorArchivo, `datos_invalidos`), sin versión, sin ZIP y con el periodo intacto", async () => {
    const m = await mundoDesbordado();
    const almacen = new AlmacenEspia();
    const id = await encolarGenerar(admin, backend, redis, prefijo, m, PARAMETROS);
    const proceso = generarArchivo({ db: dbWorker, storage: almacen });

    const error = await proceso(ctxDe(m, id, PARAMETROS)).then(
      () => undefined,
      (x: unknown) => x as Error,
    );

    expect(error, "el procesador debía rechazar con un error de datos, no dejar pasar el de dominio").toBeInstanceOf(ErrorDatos);
    expect(error).toBeInstanceOf(ErrorArchivo);
    expect(error).toMatchObject({ codigo: "datos_invalidos" });
    // El error no lleva montos ni datos de las filas.
    expect(`${error?.message}\n${JSON.stringify(error)}`).not.toMatch(/144000000000|800000000000|944000000000/);
    await sinRastro(m, almacen);
  });

  it("por la cola: termina `error / datos_invalidos` sin reintentos (intentos = 0) y sin dejar nada", async () => {
    const m = await mundoDesbordado();
    const almacen = new AlmacenEspia();
    prefijo = nuevoPrefijo();
    prefijos.push(prefijo);
    const w = await arrancar007b({ prefijo, storage: almacen } as Parameters<typeof arrancar007b>[0]);
    try {
      const id = await encolarGenerar(admin, backend, redis, prefijo, m, PARAMETROS, { liberar: false });
      const fila = await esperarTerminal(e, id, 30_000);

      expect([fila.estado, fila.motivo, fila.intentos]).toEqual(["error", "datos_invalidos", 0]);
      await sinRastro(m, almacen);
    } finally {
      await w.detener({ esperaMs: 2000 });
    }
  });
});
