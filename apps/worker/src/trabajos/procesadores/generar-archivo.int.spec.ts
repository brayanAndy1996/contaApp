import type { ContappDb } from "@contapp/db";
import { ErrorDatos } from "@contapp/sunat";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PERIODO,
  RAZON_CANARIO,
  RUC_OTRO_CLIENTE,
  SERIE_CANARIO,
  TOTAL_CANARIO,
  BASE_CANARIO,
  IGV_CANARIO,
  AlmacenEspia,
  archivarCliente,
  ctxDe,
  descifradosDe,
  encolarGenerar,
  estadoDe,
  fijarEstado,
  huellaDe,
  lineasDeTxt,
  leerZipUnico,
  limpiarArchivos,
  motivoCanario,
  previoDe,
  restaurarExclusion,
  sembrarComprasBase,
  sembrarExclusion,
  sembrarVentaSire,
  sembrarVentasConRuc,
  sembrarVersion,
  sha256Hex,
  ventaBoleta,
  ventaFactura,
  versionesDe,
  volcarTablasArchivos,
  type Libro,
  type ParametrosGenerar,
} from "../../../test/archivos.js";
import {
  limpiarCompras,
  nuevaVersion,
  sembrarCompra,
  sembrarCompras,
  filaCompra,
  RUC_FIXTURE,
} from "../../../test/compras.js";
import { arrancar007b, esperarTerminal } from "../../../test/procesadores-007b.js";
import { loggerEspia, volcado } from "../../../test/soporte.js";
import {
  Escenario,
  conectarRedis,
  crearDbAdmin,
  crearDbRol,
  fijarConfig,
  limpiarPrefijo,
  nuevoPrefijo,
} from "../../../test/trabajos.js";
import { mundoVentas, sembrarManual, sembrarPropuesta, sembrarSalto, type MundoVentas } from "../../../test/ventas.js";
import { ErrorArchivo, generarArchivo, type DepsGenerarArchivo, type ResultadoGenerarArchivo } from "./generar-archivo.js";

// Spec 012b, T5 (rojo; integración con PostgreSQL y Redis reales, BullMQ real y un storage en memoria): el procesador
// `archivo.generar` (D2, D4, D6, D10, D11, D12; CA-2 a CA-4, CA-6 a CA-8, CA-13 a CA-15). Se encola como lo hace el backend
// (rol backend) y lo ejecuta el procesador con el rol del worker, directo (la mayoría) o por la cola (los de «cola»).
//
// CONTRATO que fija (T11), además del de `src/trabajos/procesadores/generar-archivo.ts` y `test/archivos.ts`:
// - Una `withTenant`: cliente activo -> advisory del periodo y libro -> `fijarEstadoPeriodo{,Ventas}(estadoVisto -> generado)`
//   -> filas -> `prepararArchivo` -> huella -> `generarTxt` -> `empaquetar` -> `storage.guardar` -> `insertarVersion`.
// - Rechazo = `ErrorArchivo` (sin reintento): `parametros_invalidos`, `cliente_archivado`, `estado_invalido`,
//   `resumen_cambiado` (huella distinta; va antes que la prevalidación, como el 409 antes del 422), `prevalidacion_fallida`,
//   `formato_no_oficial` (NODE_ENV=production). Un rechazo no cambia el estado, no crea versión ni guarda nada en storage.
// - La versión guarda el resumen del previo (modificadas, excluidas, agregadas, impacto por destino y total; en ventas los
//   tres destinos son NULL y el total es el de `ResumenCambiosVentas`), `avisos` como conteos por código, los dos SHA-256,
//   `bytes_zip`, `lineas`, `huella`, `generado_por` = el usuario del trabajo y `trabajo_id` = el trabajo.
// - El ZIP está en `archivos/{tenant}/{cliente}/{id}.zip` (la ruta de la fila); contiene un solo TXT en latin1 con CRLF,
//   una línea por fila no excluida.
// - Idempotencia (D6, P-5): mismo trabajo o misma huella con el periodo ya `generado`, o TXT idéntico al de la última
//   versión tras reabrir: devuelve esa versión con `nueva: false`, sin guardar nada y con el periodo `generado`.
// - Un fallo de BD tras `storage.guardar` revierte todo y borra el ZIP (se propaga el error de BD, no `ErrorArchivo`).
// - Ni el resultado, ni los errores, ni los logs llevan filas, montos, razones sociales, motivos de exclusión, bytes ni rutas.
// - La cola `archivos` tiene su fila en `config_sistema` (el plan no nombra la migración: la fija T10/T11).

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

let admin: ContappDb;
let backend: ContappDb;
let dbWorker: ContappDb;
let redis: Redis;
let e: Escenario;
// Un prefijo de Redis por prueba: así no sobreviven arriendos del líder ni jobs de BullMQ de la prueba anterior.
let prefijo = nuevoPrefijo();
const prefijos = [prefijo];
beforeEach(() => {
  prefijo = nuevoPrefijo();
  prefijos.push(prefijo);
});
// Las pruebas «directas» encolan el trabajo pero lo ejecutan con el procesador sin pasar por la cola, así que su fila de
// `job_registro` queda `en_cola`. El reconciliador del worker de una prueba «por la cola» enumera TODOS los estudios (y no
// mira el prefijo de Redis): al pasar 30 s adopta esos trabajos ajenos y los corre con el almacén de esa prueba (flaky bajo
// cobertura, que es más lenta). Al terminar cada prueba se cancelan los pendientes de los estudios de este archivo.
afterEach(async () => {
  await admin.pool.query(
    `update job_registro set estado = 'cancelado', terminado_en = now(), actualizado_en = now()
      where tenant_id = any($1::uuid[]) and estado = 'en_cola'`,
    [e?.estudios ?? []],
  );
});

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
  configOriginal = (
    await admin.pool.query("select * from config_sistema where cola = 'archivos'")
  ).rows[0] as FilaConfig | undefined;
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

// ---------------------------------------------------------------------------------------------------------------
// Soporte local
// ---------------------------------------------------------------------------------------------------------------

const mundo = (): Promise<MundoVentas> => mundoVentas(e, backend, { ruc: RUC_FIXTURE });

interface Intento {
  id: string;
  resultado?: ResultadoGenerarArchivo;
  error?: Error;
}

type OpcionesIntento = Partial<Pick<DepsGenerarArchivo, "nodeEnv" | "logger">> & { trabajoId?: string };

/** Encola un trabajo nuevo (o usa `trabajoId`) y corre el procesador con el rol del worker; devuelve resultado o error. */
async function intentar(
  m: MundoVentas,
  almacen: AlmacenEspia,
  p: ParametrosGenerar,
  o: OpcionesIntento = {},
): Promise<Intento> {
  const id = o.trabajoId ?? (await encolarGenerar(admin, backend, redis, prefijo, m, p));
  const deps = { ...o };
  delete deps.trabajoId;
  const proc = generarArchivo({ db: dbWorker, storage: almacen, ...deps });
  try {
    return { id, resultado: (await proc(ctxDe(m, id, p))) as ResultadoGenerarArchivo };
  } catch (error) {
    return { id, error: error as Error };
  }
}

/** Como `intentar`, pero falla la prueba (con el error) si el procesador rechazó. */
async function generar(
  m: MundoVentas,
  almacen: AlmacenEspia,
  p: ParametrosGenerar,
  o: OpcionesIntento = {},
): Promise<{ id: string; resultado: ResultadoGenerarArchivo }> {
  const r = await intentar(m, almacen, p, o);
  if (r.error !== undefined) throw r.error;
  return { id: r.id, resultado: r.resultado as ResultadoGenerarArchivo };
}

async function parametros(
  m: MundoVentas,
  libro: Libro,
  estadoVisto: "abierto" | "revisado" = "abierto",
  periodo = PERIODO,
): Promise<ParametrosGenerar> {
  return { periodo, libro, estadoVisto, huella: await huellaDe(admin, m, libro, periodo) };
}

/** El rechazo es de negocio (sin reintento) con el código fino dado. */
function esRechazo(r: Intento, detalle: string | string[]): void {
  expect(r.error, "el procesador debía rechazar").toBeInstanceOf(ErrorArchivo);
  expect(r.error).toBeInstanceOf(ErrorDatos);
  expect(r.error).toMatchObject({ codigo: "datos_invalidos" });
  const esperados = Array.isArray(detalle) ? detalle : [detalle];
  expect(esperados).toContain((r.error as ErrorArchivo).detalle);
}

/** Un rechazo no deja rastro: ni versión, ni ZIP (ni intento de guardarlo), y el estado queda como estaba. */
async function sinRastro(
  m: MundoVentas,
  libro: Libro,
  almacen: AlmacenEspia,
  estadoAntes: Awaited<ReturnType<typeof estadoDe>>,
): Promise<void> {
  expect(await versionesDe(admin, m.c.id)).toEqual([]);
  expect(almacen.intentosGuardar).toEqual([]);
  expect(almacen.rutas()).toEqual([]);
  expect(await estadoDe(admin, libro, m.c.id)).toEqual(estadoAntes);
}

/** Texto de todo lo que puede quedar a la vista fuera del ZIP: resultado, error, tablas, jobs y logs. */
async function visible(m: MundoVentas, r: Intento, logs: unknown): Promise<string> {
  return [
    volcado(r.resultado ?? null),
    r.error === undefined ? "" : `${r.error.message}\n${r.error.stack ?? ""}\n${JSON.stringify(r.error)}`,
    await volcarTablasArchivos(admin, [m.T]),
    await e.volcarJobs(),
    volcado(logs),
  ].join("\n");
}

const RUTA = (m: MundoVentas, id: string): string => `archivos/${m.T}/${m.c.id}/${id}.zip`;

// ---------------------------------------------------------------------------------------------------------------
// CA-2 · compras
// ---------------------------------------------------------------------------------------------------------------

describe("CA-2: compras genera la versión 1", () => {
  it("fila, hashes, ZIP en archivos/{tenant}/{cliente}/{id}.zip y TXT con una línea por fila no excluida", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await sembrarComprasBase(admin, m);
    const previo = await previoDe(admin, m, "compras");
    expect(previo.resultado.apto, "el periodo sembrado debe ser apto").toBe(true);
    const p: ParametrosGenerar = { periodo: PERIODO, libro: "compras", estadoVisto: "abierto", huella: previo.huella };
    const { logger, llamadas } = loggerEspia();

    const r = await generar(m, almacen, p, { logger: logger as never });

    const [v, ...otras] = await versionesDe(admin, m.c.id);
    expect(otras).toEqual([]);
    expect(v).toBeDefined();
    expect(r.resultado).toEqual({ archivoId: v!.id, version: 1, nueva: true, lineas: 5, provisional: true });
    expect(v).toMatchObject({
      libro: "compras",
      periodo: PERIODO,
      version: 1,
      provisional: true,
      lineas: 5,
      huella: p.huella,
      trabajo_id: r.id,
      generado_por: m.u,
      ruta: RUTA(m, v!.id),
    });
    expect(v!.nombre_zip).toMatch(/^CONTAPP-PROVISIONAL-.*\.zip$/);
    expect(v!.nombre_zip).toContain(m.c.ruc);
    expect(v!.nombre_zip).toContain(PERIODO);

    // El ZIP guardado es el de la fila y sus dos hashes coinciden con los bytes reales.
    expect(almacen.rutas()).toEqual([v!.ruta]);
    expect(almacen.intentosGuardar).toEqual([v!.ruta]);
    const zip = await almacen.leer(v!.ruta);
    expect(sha256Hex(zip)).toBe(v!.sha_zip);
    expect(zip.length).toBe(v!.bytes_zip);
    const { nombre, contenido } = leerZipUnico(zip);
    expect(nombre).toBe(v!.nombre_txt);
    expect(sha256Hex(contenido)).toBe(v!.sha_txt);

    // Una línea por fila no excluida: 3 originales + la mixta corregida + la agregada; la zapatilla (F001-4062) no está.
    const lineas = lineasDeTxt(contenido);
    expect(lineas).toHaveLength(5);
    expect(contenido.toString("latin1").endsWith("\r\n")).toBe(true);
    expect(lineas.map((l) => l.split("|")[3]).sort()).toEqual(["1", "2", "2056", "3", "9001"]);
    expect(contenido.toString("latin1")).toContain(RAZON_CANARIO); // en el TXT sí, es su contenido

    // Estado: el periodo quedó `generado` por quien generó.
    expect(await estadoDe(admin, "compras", m.c.id)).toMatchObject({ estado: "generado", marcado_por: m.u });

    // CA-5: la versión guarda el resumen del previo (1 modificada, 1 excluida, 1 agregada; IGV +18.00 en destino DG).
    expect([v!.modificadas, v!.excluidas, v!.agregadas]).toEqual([1, 1, 1]);
    expect([v!.impacto_dg, v!.impacto_dgng, v!.impacto_dng, v!.impacto_total]).toEqual([
      "18.00",
      "0.00",
      "0.00",
      "18.00",
    ]);
    const resumen = previo.resumen as { impactoIgv: Record<"DG" | "DGNG" | "DNG" | "total", { toString(): string }> };
    expect(v!.impacto_dg).toBe(resumen.impactoIgv.DG.toString());
    expect(v!.impacto_total).toBe(resumen.impactoIgv.total.toString());

    // D10: nada de la fila ni de las rutas fuera del ZIP; el trabajo no lee credenciales.
    const afuera = await visible(m, r, llamadas);
    for (const prohibido of [RAZON_CANARIO, v!.ruta, "archivos/", "4062"]) expect(afuera).not.toContain(prohibido);
    expect(await descifradosDe(admin, [m.T])).toBe(0);
  });

  it("estadoVisto `revisado` (P-3): genera y el periodo queda `generado`", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await sembrarComprasBase(admin, m);
    await fijarEstado(admin, "compras", m, "revisado");
    const r = await generar(m, almacen, await parametros(m, "compras", "revisado"));
    expect(r.resultado).toMatchObject({ version: 1, nueva: true, lineas: 5 });
    expect(await estadoDe(admin, "compras", m.c.id)).toMatchObject({ estado: "generado", marcado_por: m.u });
  });

  it("con la fila del periodo ausente (equivale a `abierto`) la crea como `generado`", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await sembrarComprasBase(admin, m);
    expect(await estadoDe(admin, "compras", m.c.id)).toBeNull();
    await generar(m, almacen, await parametros(m, "compras"));
    expect(await estadoDe(admin, "compras", m.c.id)).toMatchObject({ estado: "generado", marcado_por: m.u });
  });

  it("NODE_ENV distinto de production: sale `provisional = true` (D2)", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await sembrarComprasBase(admin, m);
    const r = await generar(m, almacen, await parametros(m, "compras"), { nodeEnv: "development" });
    expect(r.resultado.provisional).toBe(true);
    expect((await versionesDe(admin, m.c.id))[0]).toMatchObject({ provisional: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-2 / CA-10 · ventas
// ---------------------------------------------------------------------------------------------------------------

describe("CA-2 / CA-10: ventas genera el RVIE provisional", () => {
  async function ventasBase(m: MundoVentas) {
    const prop = await sembrarPropuesta(admin, m, { filas: 2 });
    const b290 = await sembrarVentaSire(admin, m, prop, ventaBoleta("290"));
    const b292 = await sembrarVentaSire(
      admin,
      m,
      prop,
      ventaBoleta("292", { fechaEmision: "2026-10-06", baseGravada: "50.00", igv: "9.00", total: "59.00" }),
    );
    return { prop, b290, b292 };
  }

  it("boleta 291 (aviso, no bloquea) y una agregada a mano: 3 líneas, avisos por código, destinos de IGV nulos", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await ventasBase(m);
    await sembrarManual(admin, m, ventaFactura("F001", "77"));
    const previo = await previoDe(admin, m, "ventas");
    expect(previo.resultado.apto, "las ventas sembradas deben ser aptas").toBe(true);
    const p: ParametrosGenerar = { periodo: PERIODO, libro: "ventas", estadoVisto: "abierto", huella: previo.huella };

    const r = await generar(m, almacen, p);

    const [v, ...otras] = await versionesDe(admin, m.c.id);
    expect(otras).toEqual([]);
    expect(r.resultado).toEqual({ archivoId: v!.id, version: 1, nueva: true, lineas: 3, provisional: true });
    expect(v).toMatchObject({
      libro: "ventas",
      version: 1,
      provisional: true,
      lineas: 3,
      huella: p.huella,
      generado_por: m.u,
      modificadas: 0,
      excluidas: 0,
      agregadas: 1,
      ruta: RUTA(m, v!.id),
    });
    expect(v!.nombre_zip).toMatch(/^CONTAPP-PROVISIONAL-.*\.zip$/);
    // Ventas: sin destinos de IGV (NULL) y total = el del resumen de ventas (la agregada suma su IGV).
    expect([v!.impacto_dg, v!.impacto_dgng, v!.impacto_dng]).toEqual([null, null, null]);
    expect(v!.impacto_total).toBe("18.00");
    // CA-10: «Falta B001-291» llega como conteo por código, no como lista de filas.
    expect(v!.avisos).toEqual({ SALTO_CORRELATIVIDAD: 1 });

    const zip = await almacen.leer(v!.ruta);
    expect(sha256Hex(zip)).toBe(v!.sha_zip);
    const { nombre, contenido } = leerZipUnico(zip);
    expect(nombre).toBe(v!.nombre_txt);
    expect(sha256Hex(contenido)).toBe(v!.sha_txt);
    const txt = contenido.toString("latin1");
    expect(lineasDeTxt(contenido)).toHaveLength(3);
    for (const esperado of ["B001", "290", "292", "F001", "77"]) expect(txt).toContain(esperado);
    expect(txt).not.toContain("291");

    expect(await estadoDe(admin, "ventas", m.c.id)).toMatchObject({ estado: "generado", marcado_por: m.u });
    expect(await descifradosDe(admin, [m.T])).toBe(0);
  });

  it("con la 291 justificada no hay aviso: `avisos` queda vacío", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await ventasBase(m);
    await sembrarSalto(admin, m, { serie: "B001", tipo: "03", desde: 291, hasta: 291 });
    await generar(m, almacen, await parametros(m, "ventas"));
    expect((await versionesDe(admin, m.c.id))[0]!.avisos).toEqual({});
  });

  it("estadoVisto `revisado`: el periodo de ventas pasa a `generado`", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await ventasBase(m);
    await fijarEstado(admin, "ventas", m, "revisado");
    await generar(m, almacen, await parametros(m, "ventas", "revisado"));
    expect(await estadoDe(admin, "ventas", m.c.id)).toMatchObject({ estado: "generado", marcado_por: m.u });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-15 · ventas excluidas
// ---------------------------------------------------------------------------------------------------------------

describe("CA-15: ventas con errores excluidas (D12, P-8)", () => {
  async function ventasConExcluidas(m: MundoVentas) {
    const prop = await sembrarPropuesta(admin, m, { filas: 4 });
    await sembrarVentaSire(admin, m, prop, ventaBoleta("290"));
    await sembrarVentaSire(
      admin,
      m,
      prop,
      ventaBoleta("292", { fechaEmision: "2026-10-06", baseGravada: "50.00", igv: "9.00", total: "59.00" }),
    );
    // Descuadrada (100 + 18 no suman 130) y en USD sin tipo de cambio: las dos bloquean si no se excluyen.
    const descuadrada = await sembrarVentaSire(admin, m, prop, ventaFactura("X900", "1", { total: "130.00" }));
    const usd = await sembrarVentaSire(admin, m, prop, ventaFactura("X900", "2", { moneda: "USD" }));
    return { descuadrada, usd };
  }

  it("sin excluir, las dos bloquean el previo (el escenario es el de CA-15)", async () => {
    const m = await mundo();
    await ventasConExcluidas(m);
    const previo = await previoDe(admin, m, "ventas");
    expect(previo.resultado.apto).toBe(false);
    expect(previo.generable).toBe(false);
  });

  it("excluidas: versión con `excluidas = 2`, TXT sin sus líneas y el motivo fuera del TXT, de `resultado` y de los logs", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    const { descuadrada, usd } = await ventasConExcluidas(m);
    const motivoA = motivoCanario();
    const motivoB = motivoCanario();
    await sembrarExclusion(admin, m, descuadrada, motivoA);
    await sembrarExclusion(admin, m, usd, motivoB);
    const previo = await previoDe(admin, m, "ventas");
    expect(previo.resultado.apto, "excluidas, el periodo debe quedar apto").toBe(true);
    const p: ParametrosGenerar = { periodo: PERIODO, libro: "ventas", estadoVisto: "abierto", huella: previo.huella };
    const { logger, llamadas } = loggerEspia();

    const r = await generar(m, almacen, p, { logger: logger as never });

    const [v, ...otras] = await versionesDe(admin, m.c.id);
    expect(otras).toEqual([]);
    expect(r.resultado).toMatchObject({ version: 1, nueva: true, lineas: 2 });
    expect(v).toMatchObject({ excluidas: 2, agregadas: 0, modificadas: 0, lineas: 2 });
    // El impacto en IGV resta el de la descuadrada (18.00); la USD sin TC no se convierte (filasSinConvertir).
    expect(v!.impacto_total).toBe("-18.00");
    const resumen = previo.resumen as { impactoIgv: { total: { toString(): string } }; excluidas: number };
    expect(v!.impacto_total).toBe(resumen.impactoIgv.total.toString());

    const { contenido } = leerZipUnico(await almacen.leer(v!.ruta));
    const txt = contenido.toString("latin1");
    expect(lineasDeTxt(contenido)).toHaveLength(2);
    expect(txt).not.toContain("X900");
    for (const motivo of [motivoA, motivoB]) expect(txt).not.toContain(motivo);

    const afuera = await visible(m, r, llamadas);
    for (const motivo of [motivoA, motivoB]) expect(afuera).not.toContain(motivo);
    expect(afuera).not.toContain(v!.ruta);
  });

  it("la exclusión cambia la huella; restaurar la devuelve (P-2)", async () => {
    const m = await mundo();
    const { descuadrada, usd } = await ventasConExcluidas(m);
    const sinExcluir = await huellaDe(admin, m, "ventas");
    await sembrarExclusion(admin, m, descuadrada, motivoCanario());
    await sembrarExclusion(admin, m, usd, motivoCanario());
    const excluidas = await huellaDe(admin, m, "ventas");
    expect(excluidas).not.toBe(sinExcluir);
    await restaurarExclusion(admin, m, descuadrada);
    expect(await huellaDe(admin, m, "ventas")).not.toBe(excluidas);
  });

  it("restaurada tras encolar: huella distinta, error y estado anterior; sin versión ni ZIP", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    const { descuadrada, usd } = await ventasConExcluidas(m);
    await sembrarExclusion(admin, m, descuadrada, motivoCanario());
    await sembrarExclusion(admin, m, usd, motivoCanario());
    await fijarEstado(admin, "ventas", m, "revisado");
    const p = await parametros(m, "ventas", "revisado");
    const antes = await estadoDe(admin, "ventas", m.c.id);

    await restaurarExclusion(admin, m, descuadrada); // entre el encolado y el worker

    const r = await intentar(m, almacen, p);
    esRechazo(r, "resumen_cambiado");
    await sinRastro(m, "ventas", almacen, antes);
  });

  it("todas las ventas excluidas: SIN_FILAS no es apto y no se genera", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    const prop = await sembrarPropuesta(admin, m, { filas: 1 });
    const unica = await sembrarVentaSire(admin, m, prop, ventaFactura("X900", "1", { total: "130.00" }));
    await sembrarExclusion(admin, m, unica, motivoCanario());
    const p = await parametros(m, "ventas");
    const r = await intentar(m, almacen, p);
    esRechazo(r, "prevalidacion_fallida");
    await sinRastro(m, "ventas", almacen, null);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-3 · prevalidación
// ---------------------------------------------------------------------------------------------------------------

describe("CA-3: fila con error", () => {
  it("con la huella del dato con error: prevalidacion_fallida, error sin reintento, estado anterior, sin versión ni ZIP", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    const base = await sembrarComprasBase(admin, m);
    // Descuadre: IGV de 20.00 sobre 100.00 no es 18 % ni 10 %.
    await nuevaVersion(admin, m, base.a, { montos: { igvDg: "20.00", total: "120.00" } });
    const p = await parametros(m, "compras"); // la huella ya incluye la fila mala: coincide
    const antes = await estadoDe(admin, "compras", m.c.id);

    const r = await intentar(m, almacen, p);

    esRechazo(r, "prevalidacion_fallida");
    await sinRastro(m, "compras", almacen, antes);
  });

  it("la fila pasa a tener error DESPUÉS de encolar: error sin reintento, el periodo `revisado` sigue `revisado`", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    const base = await sembrarComprasBase(admin, m);
    await fijarEstado(admin, "compras", m, "revisado");
    const p = await parametros(m, "compras", "revisado"); // se encola con el periodo apto
    const antes = await estadoDe(admin, "compras", m.c.id);

    await nuevaVersion(admin, m, base.a, { montos: { igvDg: "20.00", total: "120.00" } });

    const r = await intentar(m, almacen, p);
    esRechazo(r, ["resumen_cambiado", "prevalidacion_fallida"]);
    await sinRastro(m, "compras", almacen, antes);
  });

  it("periodo sin filas (SIN_FILAS): no apto, no genera un TXT vacío", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    const p = await parametros(m, "compras");
    const r = await intentar(m, almacen, p);
    esRechazo(r, "prevalidacion_fallida");
    await sinRastro(m, "compras", almacen, null);
  });

  it("ventas con una descuadrada sin excluir: prevalidacion_fallida", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    const prop = await sembrarPropuesta(admin, m, { filas: 2 });
    await sembrarVentaSire(admin, m, prop, ventaFactura("F001", "1"));
    await sembrarVentaSire(admin, m, prop, ventaFactura("F001", "2", { total: "130.00" }));
    const r = await intentar(m, almacen, await parametros(m, "ventas"));
    esRechazo(r, "prevalidacion_fallida");
    await sinRastro(m, "ventas", almacen, null);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-4 · formato provisional en producción
// ---------------------------------------------------------------------------------------------------------------

describe("CA-4: NODE_ENV=production con solo formatos provisionales", () => {
  it.each<Libro>(["compras", "ventas"])("%s: no genera, formato_no_oficial y el estado queda intacto", async (libro) => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    if (libro === "compras") await sembrarComprasBase(admin, m);
    else {
      const prop = await sembrarPropuesta(admin, m, { filas: 2 });
      await sembrarVentaSire(admin, m, prop, ventaFactura("F001", "1"));
      await sembrarVentaSire(admin, m, prop, ventaFactura("F001", "2"));
    }
    await fijarEstado(admin, libro, m, "revisado");
    const p = await parametros(m, libro, "revisado");
    const antes = await estadoDe(admin, libro, m.c.id);

    const r = await intentar(m, almacen, p, { nodeEnv: "production" });

    esRechazo(r, "formato_no_oficial");
    await sinRastro(m, libro, almacen, antes);
    // El mismo trabajo fuera de producción sí genera: el rechazo era solo por el entorno.
    const ok = await intentar(m, almacen, p, { nodeEnv: "test" });
    expect(ok.error).toBeUndefined();
    expect(ok.resultado).toMatchObject({ version: 1, nueva: true, provisional: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-6 · estados y versiones
// ---------------------------------------------------------------------------------------------------------------

describe("CA-6: reabrir, corregir y generar de nuevo", () => {
  it("la versión 2 es nueva y la 1 se sigue descargando con su hash original", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    const base = await sembrarComprasBase(admin, m);
    const p1 = await parametros(m, "compras");
    const r1 = await generar(m, almacen, p1);
    expect(r1.resultado).toMatchObject({ version: 1, nueva: true });
    const [v1] = await versionesDe(admin, m.c.id);
    const zip1 = await almacen.leer(v1!.ruta);

    // Reabrir (014) y corregir una fila.
    await fijarEstado(admin, "compras", m, "abierto");
    await nuevaVersion(admin, m, base.a, { montos: { biDg: "200.00", igvDg: "36.00", total: "236.00" } });
    const p2 = await parametros(m, "compras");
    expect(p2.huella).not.toBe(p1.huella);

    const r2 = await generar(m, almacen, p2);

    expect(r2.resultado).toMatchObject({ version: 2, nueva: true, lineas: 5 });
    const versiones = await versionesDe(admin, m.c.id);
    expect(versiones.map((v) => v.version)).toEqual([1, 2]);
    expect(versiones[1]!.sha_txt).not.toBe(versiones[0]!.sha_txt);
    expect(new Set(almacen.rutas())).toEqual(new Set([versiones[0]!.ruta, versiones[1]!.ruta]));
    // La versión 1 no cambió: mismos bytes y mismo hash.
    expect(sha256Hex(await almacen.leer(v1!.ruta))).toBe(v1!.sha_zip);
    expect(Buffer.from(await almacen.leer(v1!.ruta)).equals(Buffer.from(zip1))).toBe(true);
    expect(await estadoDe(admin, "compras", m.c.id)).toMatchObject({ estado: "generado", marcado_por: m.u });
  });

  it("estadoVisto que ya no es el vigente (el periodo está `revisado`): estado_invalido y nada cambia", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await sembrarComprasBase(admin, m);
    await fijarEstado(admin, "compras", m, "revisado");
    const p = await parametros(m, "compras", "abierto"); // quien pidió vio `abierto`
    const antes = await estadoDe(admin, "compras", m.c.id);

    const r = await intentar(m, almacen, p);

    esRechazo(r, "estado_invalido");
    await sinRastro(m, "compras", almacen, antes);
  });

  it("el periodo ya está `generado` y la huella pedida no es la de la última versión: estado_invalido", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    const base = await sembrarComprasBase(admin, m);
    await generar(m, almacen, await parametros(m, "compras"));
    const guardados = almacen.rutas();
    // Cambia un dato sin reabrir (en producción lo impediría el 409 `periodo_generado`) y pide generar otra vez.
    await nuevaVersion(admin, m, base.b, { montos: { biDg: "300.00", igvDg: "54.00", total: "354.00" } });
    const p = await parametros(m, "compras", "abierto");

    const r = await intentar(m, almacen, p);

    esRechazo(r, "estado_invalido");
    expect((await versionesDe(admin, m.c.id)).map((v) => v.version)).toEqual([1]);
    expect(almacen.rutas()).toEqual(guardados);
    expect(await estadoDe(admin, "compras", m.c.id)).toMatchObject({ estado: "generado" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-14 · sin cambios
// ---------------------------------------------------------------------------------------------------------------

describe("CA-14 (P-5): reabrir y generar sin cambios", () => {
  it.each<Libro>(["compras", "ventas"])("%s: no crea versión, devuelve la última con nueva:false y el periodo queda `generado`", async (libro) => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    if (libro === "compras") await sembrarComprasBase(admin, m);
    else {
      const prop = await sembrarPropuesta(admin, m, { filas: 2 });
      await sembrarVentaSire(admin, m, prop, ventaFactura("F001", "1"));
      await sembrarVentaSire(admin, m, prop, ventaFactura("F001", "2"));
    }
    const p = await parametros(m, libro);
    const primera = await generar(m, almacen, p);
    expect(primera.resultado.nueva).toBe(true);

    await fijarEstado(admin, libro, m, "abierto"); // reabrir
    const segunda = await generar(m, almacen, p);

    expect(segunda.resultado).toEqual({ ...primera.resultado, nueva: false });
    const versiones = await versionesDe(admin, m.c.id);
    expect(versiones).toHaveLength(1);
    expect(almacen.intentosGuardar).toHaveLength(1); // no guardó un ZIP idéntico
    expect(almacen.rutas()).toEqual([versiones[0]!.ruta]);
    expect(await estadoDe(admin, libro, m.c.id)).toMatchObject({ estado: "generado", marcado_por: m.u });
  });

  it("la huella cambia con cualquier dato del periodo", async () => {
    const m = await mundo();
    const base = await sembrarComprasBase(admin, m);
    const antes = await huellaDe(admin, m, "compras");
    await nuevaVersion(admin, m, base.c, { montos: { biDg: "150.00", igvDg: "27.00", total: "177.00" } });
    expect(await huellaDe(admin, m, "compras")).not.toBe(antes);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-7 · concurrencia e idempotencia
// ---------------------------------------------------------------------------------------------------------------

describe("CA-7: concurrencia, reintentos y numeración", () => {
  it("el reintento después del commit (mismo trabajo) devuelve la misma versión con nueva:false", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await sembrarComprasBase(admin, m);
    const p = await parametros(m, "compras");
    const primera = await generar(m, almacen, p);

    const segunda = await generar(m, almacen, p, { trabajoId: primera.id });

    expect(segunda.resultado).toEqual({ ...primera.resultado, nueva: false });
    expect(await versionesDe(admin, m.c.id)).toHaveLength(1);
    expect(almacen.intentosGuardar).toHaveLength(1);
  });

  it("dos trabajos con la misma huella a la vez dan una sola versión y un solo ZIP", async () => {
    for (let ronda = 0; ronda < 3; ronda++) {
      const periodo = `2026${String(ronda + 1).padStart(2, "0")}`;
      const m = await mundo();
      const almacen = new AlmacenEspia();
      await sembrarComprasBase(admin, m, { periodo });
      const p = await parametros(m, "compras", "abierto", periodo);
      const a = await encolarGenerar(admin, backend, redis, prefijo, m, p);
      const b = await encolarGenerar(admin, backend, redis, prefijo, m, p);
      expect(b).not.toBe(a);

      const [ra, rb] = await Promise.all([
        intentar(m, almacen, p, { trabajoId: a }),
        intentar(m, almacen, p, { trabajoId: b }),
      ]);

      expect(ra.error, `ronda ${ronda}`).toBeUndefined();
      expect(rb.error, `ronda ${ronda}`).toBeUndefined();
      expect([ra.resultado!.nueva, rb.resultado!.nueva].sort()).toEqual([false, true]);
      expect(ra.resultado!.archivoId).toBe(rb.resultado!.archivoId);
      expect(ra.resultado!.version).toBe(1);
      const versiones = await versionesDe(admin, m.c.id, { periodo });
      expect(versiones).toHaveLength(1);
      expect(almacen.rutas()).toEqual([versiones[0]!.ruta]);
      expect(almacen.intentosGuardar).toHaveLength(1);
    }
  });

  it("la numeración es independiente por cliente, periodo y libro", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await sembrarComprasBase(admin, m);
    await sembrarComprasBase(admin, m, { periodo: "202609" });
    const prop = await sembrarPropuesta(admin, m, { filas: 1 });
    await sembrarVentaSire(admin, m, prop, ventaFactura("F001", "1"));
    // Un segundo cliente del mismo estudio, mismo periodo.
    const otro = await e.cliente(m.T, RUC_OTRO_CLIENTE);
    await e.asignar(m.T, otro.id, m.u);
    const mOtro: MundoVentas = { ...m, c: otro };
    await sembrarComprasBase(admin, mOtro);

    const versiones = [
      await generar(m, almacen, await parametros(m, "compras")),
      await generar(m, almacen, await parametros(m, "compras", "abierto", "202609")),
      await generar(m, almacen, await parametros(m, "ventas")),
      await generar(mOtro, almacen, await parametros(mOtro, "compras")),
    ].map((r) => r.resultado.version);

    expect(versiones).toEqual([1, 1, 1, 1]);
    // Y la segunda versión de uno de ellos sigue su propia cuenta.
    await fijarEstado(admin, "compras", m, "abierto");
    const base = (
      await admin.pool.query("select id from compra where cliente_id = $1 and periodo = $2 limit 1", [m.c.id, PERIODO])
    ).rows[0].id as string;
    await nuevaVersion(admin, m, base, { montos: { biDg: "250.00", igvDg: "45.00", total: "295.00" } });
    const segunda = await generar(m, almacen, await parametros(m, "compras"));
    expect(segunda.resultado.version).toBe(2);
    expect((await versionesDe(admin, mOtro.c.id)).map((v) => v.version)).toEqual([1]);
    expect((await versionesDe(admin, m.c.id, { libro: "ventas" })).map((v) => v.version)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-8 · huella
// ---------------------------------------------------------------------------------------------------------------

describe("CA-8 (P-2): la huella cambió entre el encolado y el worker", () => {
  it.each<["abierto" | "revisado"]>([["abierto"], ["revisado"]])(
    "una fila cambió con el periodo `%s`: resumen_cambiado y el estado vuelve atrás",
    async (estado) => {
      const m = await mundo();
      const almacen = new AlmacenEspia();
      const base = await sembrarComprasBase(admin, m);
      if (estado === "revisado") await fijarEstado(admin, "compras", m, "revisado");
      const p = await parametros(m, "compras", estado);
      const antes = await estadoDe(admin, "compras", m.c.id);

      // Sigue siendo apto, pero distinto.
      await nuevaVersion(admin, m, base.c, { montos: { biDg: "150.00", igvDg: "27.00", total: "177.00" } });

      const r = await intentar(m, almacen, p);

      esRechazo(r, "resumen_cambiado");
      await sinRastro(m, "compras", almacen, antes);
    },
  );

  it("una huella cualquiera que no es la del periodo: resumen_cambiado", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await sembrarComprasBase(admin, m);
    const p = { ...(await parametros(m, "compras")), huella: "0".repeat(64) };
    const antes = await estadoDe(admin, "compras", m.c.id);
    esRechazo(await intentar(m, almacen, p), "resumen_cambiado");
    await sinRastro(m, "compras", almacen, antes);
  });

  it("una compra agregada después del previo también cambia la huella", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await sembrarComprasBase(admin, m);
    const p = await parametros(m, "compras");
    await sembrarCompra(admin, m, filaCompra("9100"), { origen: "agregada" });
    const antes = await estadoDe(admin, "compras", m.c.id);
    esRechazo(await intentar(m, almacen, p), "resumen_cambiado");
    await sinRastro(m, "compras", almacen, antes);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Cliente archivado y fallos de BD
// ---------------------------------------------------------------------------------------------------------------

describe("cliente archivado y fallos tras guardar el ZIP", () => {
  it("cliente archivado (se archivó después de encolar): cliente_archivado, sin cambios", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await sembrarComprasBase(admin, m);
    const p = await parametros(m, "compras");
    await archivarCliente(admin, m.c.id);
    const r = await intentar(m, almacen, p);
    esRechazo(r, "cliente_archivado");
    await sinRastro(m, "compras", almacen, null);
  });

  it("falla la inserción de la versión tras `guardar`: se revierte todo, no queda ZIP y el error no lleva la ruta", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await sembrarComprasBase(admin, m);
    const p = await parametros(m, "compras");
    // Un trabajo cuyo `trabajo_id` ya tiene una versión de otro periodo: la inserción del worker choca (23505).
    const trabajoId = await encolarGenerar(admin, backend, redis, prefijo, m, p);
    await sembrarVersion(admin, m, "compras", trabajoId, { periodo: "202609" });
    const { logger, llamadas } = loggerEspia();

    const r = await intentar(m, almacen, p, { trabajoId, logger: logger as never });

    expect(r.error, "la inserción debía fallar").toBeDefined();
    expect(r.error).not.toBeInstanceOf(ErrorArchivo); // fallo de BD: 008 lo reintentaría como transitorio
    // Llegó a guardar el ZIP (es el orden del plan: guardar y luego insertar) y lo borró al fallar.
    expect(almacen.intentosGuardar).toHaveLength(1);
    expect(almacen.rutas()).toEqual([]);
    expect(almacen.eliminados).toEqual(almacen.intentosGuardar);
    // El estado y las versiones del periodo volvieron atrás (solo queda la sembrada de otro periodo).
    expect(await estadoDe(admin, "compras", m.c.id)).toBeNull();
    expect((await versionesDe(admin, m.c.id, { periodo: PERIODO }))).toEqual([]);
    const afuera = `${r.error!.message}\n${r.error!.stack ?? ""}\n${volcado(llamadas)}`;
    expect(afuera).not.toContain(`archivos/${m.T}`);
    expect(afuera).not.toContain(almacen.intentosGuardar[0]!);
  });

  // T16a: si ni siquiera se puede borrar el ZIP huérfano, el error que se propaga sigue siendo el de la BD (el que 008 reintenta).
  describe("el ZIP huérfano no se puede borrar", () => {
    class AlmacenSinBorrado extends AlmacenEspia {
      override async eliminar(ruta: string): Promise<void> {
        this.eliminados.push(ruta);
        throw new Error(`EIO al borrar ${ruta}`);
      }
    }
    const fallaInsercion = async (almacen: AlmacenEspia, o: OpcionesIntento = {}) => {
      const m = await mundo();
      await sembrarComprasBase(admin, m);
      const p = await parametros(m, "compras");
      const trabajoId = await encolarGenerar(admin, backend, redis, prefijo, m, p);
      await sembrarVersion(admin, m, "compras", trabajoId, { periodo: "202609" });
      return intentar(m, almacen, p, { trabajoId, ...o });
    };

    it("con logger: avisa solo con el código (nunca la ruta) y propaga el error de la BD", async () => {
      const almacen = new AlmacenSinBorrado();
      const { logger, llamadas } = loggerEspia();
      const r = await fallaInsercion(almacen, { logger: logger as never });

      expect(r.error, "la inserción debía fallar").toBeDefined();
      expect(r.error).not.toBeInstanceOf(ErrorArchivo);
      expect(r.error!.message).not.toContain("EIO"); // el error del storage no tapa al de la BD
      expect(almacen.intentosGuardar).toHaveLength(1);
      expect(almacen.eliminados).toEqual(almacen.intentosGuardar);
      const avisos = llamadas.filter((l) => l.metodo === "warn");
      expect(avisos).toHaveLength(1);
      expect(volcado(avisos)).toContain("archivo_huerfano");
      expect(volcado(avisos)).toContain("zip_no_borrado");
      expect(volcado(llamadas)).not.toContain(almacen.intentosGuardar[0]!);
    });

    it("sin logger: tampoco falla al borrar y propaga el error de la BD", async () => {
      const almacen = new AlmacenSinBorrado();
      const r = await fallaInsercion(almacen);
      expect(r.error, "la inserción debía fallar").toBeDefined();
      expect(r.error).not.toBeInstanceOf(ErrorArchivo);
      expect(r.error!.message).not.toContain("EIO");
      expect(almacen.eliminados).toEqual(almacen.intentosGuardar);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CA-13 · rendimiento (RNF-035, D11)
// ---------------------------------------------------------------------------------------------------------------

// Límite estricto de RNF-035 / D11 en la corrida normal (`test:int`, `ci:db`). La instrumentación de cobertura v8 encarece la
// misma ejecución (5,8 a 6,4 s con 20.000 filas, frente a menos de 5 s sin ella), así que SOLO `vitest.cobertura-archivos.config.mts`
// fija `CONTAPP_COBERTURA=1` y el límite se multiplica por 3 allí. El rendimiento real se sigue midiendo sin instrumentar.
const FACTOR_COBERTURA = process.env.CONTAPP_COBERTURA === "1" ? 3 : 1;
const LIMITE_MS = 5_000 * FACTOR_COBERTURA;

describe("CA-13 / D11: 20.000 filas se generan en menos de 5 s", () => {
  it("compras: 20.000 filas", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await sembrarCompras(admin, m, 20_000);
    const p = await parametros(m, "compras");
    const id = await encolarGenerar(admin, backend, redis, prefijo, m, p);
    const proc = generarArchivo({ db: dbWorker, storage: almacen });

    const t0 = performance.now();
    const resultado = (await proc(ctxDe(m, id, p))) as ResultadoGenerarArchivo;
    const ms = performance.now() - t0;

    expect(resultado).toMatchObject({ version: 1, nueva: true, lineas: 20_000 });
    expect(ms).toBeLessThan(LIMITE_MS);
    expect((await versionesDe(admin, m.c.id))[0]).toMatchObject({ lineas: 20_000 });
  });

  it("ventas: 20.000 filas", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    const prop = await sembrarPropuesta(admin, m, { filas: 20_000 });
    await sembrarVentasConRuc(admin, m, prop, 20_000);
    const p = await parametros(m, "ventas");
    const id = await encolarGenerar(admin, backend, redis, prefijo, m, p);
    const proc = generarArchivo({ db: dbWorker, storage: almacen });

    const t0 = performance.now();
    const resultado = (await proc(ctxDe(m, id, p))) as ResultadoGenerarArchivo;
    const ms = performance.now() - t0;

    expect(resultado).toMatchObject({ version: 1, nueva: true, lineas: 20_000 });
    expect(ms).toBeLessThan(LIMITE_MS);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Por la cola (008): registro del tipo, resultado, sin reintento y sin datos en logs
// ---------------------------------------------------------------------------------------------------------------

describe("por la cola `archivos`", () => {
  it("la cola `archivos` tiene su fila en config_sistema con concurrencia positiva", async () => {
    const r = await admin.pool.query(
      "select concurrencia_global, concurrencia_tenant from config_sistema where cola = 'archivos'",
    );
    expect(r.rows, "falta la fila de `archivos` en config_sistema (migración/seed de 012b)").toHaveLength(1);
    expect(r.rows[0].concurrencia_global).toBeGreaterThan(0);
    expect(r.rows[0].concurrencia_tenant).toBeGreaterThan(0);
  });

  it("CA-2 / CA-13: el worker ejecuta el trabajo, `resultado` solo lleva los cinco campos y los logs no llevan datos", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await sembrarComprasBase(admin, m);
    await sembrarCompra(
      admin,
      m,
      filaCompra("7", {
        serie: SERIE_CANARIO,
        razonSocialContraparte: RAZON_CANARIO,
        biDg: BASE_CANARIO,
        igvDg: IGV_CANARIO,
        total: TOTAL_CANARIO,
      }),
      { origen: "agregada" },
    );
    const p = await parametros(m, "compras");
    const { logger, llamadas } = loggerEspia();
    const w = await arrancar007b({ prefijo, storage: almacen, logger: logger as never } as Parameters<typeof arrancar007b>[0]);
    try {
      const id = await encolarGenerar(admin, backend, redis, prefijo, m, p, { liberar: false });
      const fila = await esperarTerminal(e, id, 30_000);

      expect(fila.estado).toBe("completado");
      const [v] = await versionesDe(admin, m.c.id);
      expect(v).toBeDefined();
      expect(fila.resultado).toEqual({ archivoId: v!.id, version: 1, nueva: true, lineas: 6, provisional: true });
      expect(JSON.stringify(fila.resultado).length).toBeLessThan(4096);
      expect(almacen.rutas()).toEqual([v!.ruta]);
      const afuera = [await e.volcarJobs(), volcado(llamadas), await volcarTablasArchivos(admin, [m.T])].join("\n");
      for (const prohibido of [RAZON_CANARIO, SERIE_CANARIO, "987660", v!.ruta, "archivos/"]) {
        expect(afuera).not.toContain(prohibido);
      }
      expect(await descifradosDe(admin, [m.T])).toBe(0);
    } finally {
      await w.detener({ esperaMs: 2000 });
    }
  });

  it("CA-3: un rechazo de negocio termina `error / datos_invalidos` sin reintentos y sin dejar nada", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    const base = await sembrarComprasBase(admin, m);
    const p = await parametros(m, "compras");
    const w = await arrancar007b({ prefijo, storage: almacen } as Parameters<typeof arrancar007b>[0]);
    try {
      await nuevaVersion(admin, m, base.a, { montos: { igvDg: "20.00", total: "120.00" } }); // la huella `p` queda vieja
      const id = await encolarGenerar(admin, backend, redis, prefijo, m, p, { liberar: false });
      const fila = await esperarTerminal(e, id, 30_000);

      expect([fila.estado, fila.motivo, fila.intentos]).toEqual(["error", "datos_invalidos", 0]);
      await sinRastro(m, "compras", almacen, null);
    } finally {
      await w.detener({ esperaMs: 2000 });
    }
  });
});
