import type { ContappDb } from "@contapp/db";
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
  AlmacenEspia,
  PERIODO,
  ctxDe,
  encolarGenerar,
  estadoDe,
  fijarEstado,
  huellaDe,
  limpiarArchivos,
  sembrarComprasBase,
  sembrarExclusion,
  sembrarVentaSire,
  sha256Hex,
  ventaFactura,
  versionesDe,
  type Libro,
  type ParametrosGenerar,
} from "../../../test/archivos.js";
import {
  RUC_FIXTURE,
  limpiarCompras,
  nuevaVersion,
} from "../../../test/compras.js";
import {
  Escenario,
  crearDbAdmin,
  crearDbRol,
  conectarRedis,
  limpiarPrefijo,
  nuevoPrefijo,
} from "../../../test/trabajos.js";
import {
  mundoVentas,
  sembrarPropuesta,
  type MundoVentas,
} from "../../../test/ventas.js";
import {
  ErrorArchivo,
  generarArchivo,
  type ResultadoGenerarArchivo,
} from "./generar-archivo.js";

// Spec 012b, T21 (rojo): correcciones de la ronda adversarial 2 sobre el procesador `archivo.generar` (D4, D5, D6, P-5; CA-7,
// CA-14). H-012b-3: una versión confirmada conserva su ZIP aunque el acuse del COMMIT se pierda. H-012b-4: un reintento cuyo
// commit ya ocurrió devuelve SIEMPRE la versión de su `trabajo_id`. H-012b-6 (decisión del usuario, 2026-11-11): ese reintento
// la devuelve tal cual y NO toca el estado del periodo (si se reabrió, sigue abierto). Los casos marcados «guarda» ya pasan hoy:
// fijan lo que la corrección no debe romper (sobre todo: el ZIP de lo que NO se confirmó sí se borra).

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

let admin: ContappDb;
let backend: ContappDb;
let dbWorker: ContappDb;
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
  backend = crearDbRol("contapp_backend", 6);
  dbWorker = crearDbRol("contapp_worker", 8);
  redis = conectarRedis();
  e = new Escenario(admin);
});

afterAll(async () => {
  await limpiarArchivos(admin, e?.estudios ?? []).catch(() => undefined);
  await limpiarCompras(admin, e?.estudios ?? []).catch(() => undefined);
  await e?.limpiar();
  for (const x of prefijos)
    await limpiarPrefijo(redis, x).catch(() => undefined);
  redis?.disconnect();
  await Promise.all([backend?.close(), dbWorker?.close(), admin?.close()]);
});

// ---------------------------------------------------------------------------------------------------------------
// Soporte local
// ---------------------------------------------------------------------------------------------------------------

const mundo = (): Promise<MundoVentas> =>
  mundoVentas(e, backend, { ruc: RUC_FIXTURE });

async function parametros(
  m: MundoVentas,
  libro: Libro,
  periodo = PERIODO,
): Promise<ParametrosGenerar> {
  return {
    periodo,
    libro,
    estadoVisto: "abierto",
    huella: await huellaDe(admin, m, libro, periodo),
  };
}

/** Siembra el libro con datos aptos: compras (base de 5 líneas) o ventas (dos buenas y una descuadrada excluida). */
async function sembrar(m: MundoVentas, libro: Libro): Promise<void> {
  if (libro === "compras") {
    await sembrarComprasBase(admin, m);
    return;
  }
  const prop = await sembrarPropuesta(admin, m, { filas: 3 });
  await sembrarVentaSire(admin, m, prop, ventaFactura("F001", "1"));
  await sembrarVentaSire(admin, m, prop, ventaFactura("F001", "2"));
  const mala = await sembrarVentaSire(
    admin,
    m,
    prop,
    ventaFactura("F001", "3", { total: "119.00" }),
  );
  await sembrarExclusion(admin, m, mala, "descuadrada en el SIRE");
}

type Db = Pick<ContappDb, "withTenant">;
type Corrida = {
  id: string;
  resultado?: ResultadoGenerarArchivo;
  error?: Error;
};

async function correr(
  m: MundoVentas,
  db: Db,
  almacen: AlmacenEspia,
  p: ParametrosGenerar,
  trabajoId?: string,
): Promise<Corrida> {
  const id =
    trabajoId ?? (await encolarGenerar(admin, backend, redis, prefijo, m, p));
  try {
    return {
      id,
      resultado: (await generarArchivo({ db, storage: almacen })(
        ctxDe(m, id, p),
      )) as ResultadoGenerarArchivo,
    };
  } catch (error) {
    return { id, error: error as Error };
  }
}

/**
 * Un `db` cuyo PRIMER `withTenant` es el del trabajo y falla tras su desenlace; los siguientes (p. ej. la comprobación en una
 * conexión nueva) corren contra la BD real salvo que `siguientes` diga otra cosa.
 *  - `"acuse_perdido"`: la transacción SE CONFIRMA y después la conexión «se corta» al leer la respuesta del COMMIT.
 *  - `"rollback"`: la transacción hace todo su trabajo y se revierte (nada se confirma).
 */
function dbQueFalla(
  primero: "acuse_perdido" | "rollback",
  siguientes: "reales" | "caidas" = "reales",
): Db & { llamadas: () => number } {
  let n = 0;
  return {
    llamadas: () => n,
    withTenant: (async (ctx: never, fn: (tx: never) => Promise<unknown>) => {
      n += 1;
      if (n > 1) {
        if (siguientes === "caidas")
          throw new Error("Connection terminated unexpectedly");
        return dbWorker.withTenant(ctx, fn as never);
      }
      if (primero === "acuse_perdido") {
        await dbWorker.withTenant(ctx, fn as never);
        throw new Error("Connection terminated unexpectedly");
      }
      return dbWorker.withTenant(ctx, async (tx) => {
        await fn(tx as never);
        throw new Error("rollback simulado");
      });
    }) as ContappDb["withTenant"],
  };
}

/** Reabre el periodo y cambia los montos de la compra `a` (IGV al 18 %): el siguiente TXT es distinto. */
async function reabrirYCambiar(
  m: MundoVentas,
  compraId: string,
): Promise<void> {
  await fijarEstado(admin, "compras", m, "abierto");
  await nuevaVersion(admin, m, compraId, {
    montos: { biDg: "200.00", igvDg: "36.00", total: "236.00" },
    accion: "editar",
  });
}

// ---------------------------------------------------------------------------------------------------------------
// H-012b-3 (ALTA): el COMMIT ocurrió, la conexión cayó antes del acuse: el ZIP de la versión confirmada no se borra
// ---------------------------------------------------------------------------------------------------------------

describe("H-012b-3 · el ZIP de una versión confirmada se conserva aunque se pierda el acuse del COMMIT", () => {
  it.each<Libro>(["compras", "ventas"])(
    "%s: el ZIP sigue guardado (con su sha256_zip) y el reintento del mismo trabajo devuelve esa versión",
    async (libro) => {
      const m = await mundo();
      const almacen = new AlmacenEspia();
      await sembrar(m, libro);
      const p = await parametros(m, libro);
      const db = dbQueFalla("acuse_perdido");

      const primero = await correr(m, db, almacen, p);

      expect(
        primero.error,
        "el intento falla como transitorio (008 lo reintenta)",
      ).toBeDefined();
      expect(primero.error).not.toBeInstanceOf(ErrorArchivo);
      const [v] = await versionesDe(admin, m.c.id, { libro });
      expect(v, "la versión quedó confirmada en la BD").toBeDefined();
      expect(
        almacen.rutas(),
        "se borró el ZIP de una versión confirmada (la rama de limpieza no comprueba el COMMIT)",
      ).toContain(v!.ruta);
      expect(almacen.eliminados).toEqual([]);
      expect(sha256Hex(await almacen.leer(v!.ruta))).toBe(v!.sha_zip);

      const reintento = await correr(m, dbWorker, almacen, p, primero.id);
      expect(reintento.error).toBeUndefined();
      expect(reintento.resultado).toMatchObject({
        archivoId: v!.id,
        version: 1,
        nueva: false,
      });
      expect(await versionesDe(admin, m.c.id, { libro })).toHaveLength(1);
      expect(
        sha256Hex(await almacen.leer(v!.ruta)),
        "la versión devuelta ya no se puede descargar",
      ).toBe(v!.sha_zip);
    },
  );

  it("antes de decidir comprueba en una conexión NUEVA (otro `withTenant`), no con la transacción que cayó", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await sembrar(m, "compras");
    const db = dbQueFalla("acuse_perdido");

    await correr(m, db, almacen, await parametros(m, "compras"));

    expect(
      db.llamadas(),
      "no hubo una segunda conexión para comprobar si la versión existe",
    ).toBeGreaterThanOrEqual(2);
  });

  it("no puede comprobar (la BD sigue caída): ante la duda conserva el ZIP y propaga el error original", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await sembrar(m, "compras");
    const db = dbQueFalla("acuse_perdido", "caidas");

    const r = await correr(m, db, almacen, await parametros(m, "compras"));

    expect(r.error?.message).toBe("Connection terminated unexpectedly");
    const [v] = await versionesDe(admin, m.c.id);
    expect(v, "la versión quedó confirmada").toBeDefined();
    expect(
      almacen.rutas(),
      "sin poder comprobar, un ZIP borrado deja la versión confirmada sin descarga",
    ).toContain(v!.ruta);
  });

  it("guarda: si la transacción NO se confirmó (rollback), el ZIP sí se borra y no queda versión", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await sembrar(m, "compras");

    const r = await correr(
      m,
      dbQueFalla("rollback"),
      almacen,
      await parametros(m, "compras"),
    );

    expect(r.error?.message).toBe("rollback simulado");
    expect(await versionesDe(admin, m.c.id)).toEqual([]);
    expect(almacen.intentosGuardar).toHaveLength(1);
    expect(almacen.rutas(), "un ZIP sin versión quedó huérfano").toEqual([]);
    expect(almacen.eliminados).toEqual(almacen.intentosGuardar);
  });

  it("guarda: el ZIP huérfano se borra aunque OTRA versión del periodo (de otro trabajo) exista: se comprueba por `trabajo_id`", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    const base = await sembrarComprasBase(admin, m);
    const v1 = await correr(
      m,
      dbWorker,
      almacen,
      await parametros(m, "compras"),
    );
    expect(v1.error).toBeUndefined();
    const [version1] = await versionesDe(admin, m.c.id);

    // Otro trabajo con un TXT distinto cuya transacción se revierte: su ZIP es huérfano; el de la v1 no se toca.
    await reabrirYCambiar(m, base.a);
    const r = await correr(
      m,
      dbQueFalla("rollback"),
      almacen,
      await parametros(m, "compras"),
    );

    expect(r.error?.message).toBe("rollback simulado");
    expect(await versionesDe(admin, m.c.id)).toHaveLength(1);
    expect(almacen.intentosGuardar).toHaveLength(2);
    expect(almacen.rutas(), "debe quedar solo el ZIP de la v1").toEqual([
      version1!.ruta,
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// H-012b-4: el reintento del mismo trabajo devuelve SIEMPRE la versión de su `trabajo_id`
// ---------------------------------------------------------------------------------------------------------------

describe("H-012b-4 · el reintento busca primero por `trabajo_id` (antes de comparar huellas)", () => {
  it("P-5 con otra huella: el trabajo devolvió la v1 (nueva:false) y repetirlo da la misma versión, sin versión ni ZIP nuevos", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    const base = await sembrarComprasBase(admin, m);
    const v1 = await correr(
      m,
      dbWorker,
      almacen,
      await parametros(m, "compras"),
    );
    expect(v1.error).toBeUndefined();

    // Reabrir y clasificar sin cambiar montos: el TXT no cambia, la huella sí.
    await fijarEstado(admin, "compras", m, "abierto");
    await nuevaVersion(admin, m, base.a, {
      clasificada: true,
      accion: "clasificar",
    });
    const p2 = await parametros(m, "compras");
    const segundo = await correr(m, dbWorker, almacen, p2);
    expect(segundo.resultado).toEqual({ ...v1.resultado, nueva: false });
    const guardados = almacen.intentosGuardar.length;

    const repetido = await correr(m, dbWorker, almacen, p2, segundo.id);

    expect(
      repetido.error,
      `el reintento falló con ${(repetido.error as ErrorArchivo | undefined)?.detalle}`,
    ).toBeUndefined();
    expect(repetido.resultado).toEqual(segundo.resultado);
    expect(await versionesDe(admin, m.c.id)).toHaveLength(1);
    expect(almacen.intentosGuardar).toHaveLength(guardados);
  });

  it("la versión del trabajo no es la última: el reintento del trabajo 1 (con el periodo ya en la v2) devuelve la v1", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    const base = await sembrarComprasBase(admin, m);
    const p1 = await parametros(m, "compras");
    const t1 = await correr(m, dbWorker, almacen, p1);
    expect(t1.error).toBeUndefined();

    await reabrirYCambiar(m, base.a);
    const t2 = await correr(
      m,
      dbWorker,
      almacen,
      await parametros(m, "compras"),
    );
    expect(t2.resultado).toMatchObject({ version: 2, nueva: true });
    expect((await estadoDe(admin, "compras", m.c.id))?.estado).toBe("generado");

    const reintento1 = await correr(m, dbWorker, almacen, p1, t1.id);

    expect(
      reintento1.error,
      `el reintento falló con ${(reintento1.error as ErrorArchivo | undefined)?.detalle}`,
    ).toBeUndefined();
    expect(reintento1.resultado).toEqual(t1.resultado);
    expect(reintento1.resultado).toMatchObject({ version: 1, nueva: false });
    expect(await versionesDe(admin, m.c.id)).toHaveLength(2);
  });

  it("guarda: otro trabajo (otro id) con una huella que no es la de la última versión sigue dando `estado_invalido`", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    const base = await sembrarComprasBase(admin, m);
    const v1 = await correr(
      m,
      dbWorker,
      almacen,
      await parametros(m, "compras"),
    );
    expect(v1.error).toBeUndefined();
    await fijarEstado(admin, "compras", m, "abierto");
    await nuevaVersion(admin, m, base.a, {
      clasificada: true,
      accion: "clasificar",
    });
    const p2 = await parametros(m, "compras");
    await correr(m, dbWorker, almacen, p2); // P-5: el periodo vuelve a `generado`, con la v1 de otra huella

    const otro = await correr(m, dbWorker, almacen, p2);

    expect(otro.error).toBeInstanceOf(ErrorArchivo);
    expect((otro.error as ErrorArchivo).detalle).toBe("estado_invalido");
    expect(await versionesDe(admin, m.c.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// H-012b-6 (decisión del usuario, 2026-11-11): el reintento de un trabajo con versión no cambia el estado del periodo
// ---------------------------------------------------------------------------------------------------------------

describe("H-012b-6 · el reintento de un trabajo que ya tiene su versión la devuelve y NO cambia el estado", () => {
  it.each<Libro>(["compras", "ventas"])(
    "%s: generar, reabrir y reintentar el mismo trabajo devuelve la v1, deja el periodo `abierto` y no crea versión",
    async (libro) => {
      const m = await mundo();
      const almacen = new AlmacenEspia();
      await sembrar(m, libro);
      const p = await parametros(m, libro);
      const primero = await correr(m, dbWorker, almacen, p);
      expect(primero.error).toBeUndefined();
      expect(primero.resultado).toMatchObject({ version: 1, nueva: true });

      await fijarEstado(admin, libro, m, "abierto");
      const reabierto = await estadoDe(admin, libro, m.c.id);
      const guardados = almacen.intentosGuardar.length;

      const reintento = await correr(m, dbWorker, almacen, p, primero.id);

      expect(reintento.error).toBeUndefined();
      expect(reintento.resultado).toEqual({
        ...primero.resultado,
        nueva: false,
      });
      expect(
        await estadoDe(admin, libro, m.c.id),
        "el reintento volvió a cerrar el periodo reabierto",
      ).toEqual(reabierto);
      expect(reabierto?.estado).toBe("abierto");
      expect(await versionesDe(admin, m.c.id, { libro })).toHaveLength(1);
      expect(almacen.intentosGuardar).toHaveLength(guardados);
    },
  );

  it("con `estadoVisto: revisado`: reabrir y reintentar deja el periodo `abierto`", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await sembrarComprasBase(admin, m);
    await fijarEstado(admin, "compras", m, "revisado");
    const p: ParametrosGenerar = {
      ...(await parametros(m, "compras")),
      estadoVisto: "revisado",
    };
    const primero = await correr(m, dbWorker, almacen, p);
    expect(primero.error).toBeUndefined();

    await fijarEstado(admin, "compras", m, "abierto");
    const reintento = await correr(m, dbWorker, almacen, p, primero.id);

    expect(reintento.resultado).toEqual({ ...primero.resultado, nueva: false });
    expect((await estadoDe(admin, "compras", m.c.id))?.estado).toBe("abierto");
  });

  it("aunque el periodo reabierto ya cambió (la huella de hoy no es la del trabajo) devuelve la v1, sin `resumen_cambiado`", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    const base = await sembrarComprasBase(admin, m);
    const p = await parametros(m, "compras");
    const primero = await correr(m, dbWorker, almacen, p);
    expect(primero.error).toBeUndefined();

    await reabrirYCambiar(m, base.a); // el contador corrigió algo después del commit del trabajo
    const reabierto = await estadoDe(admin, "compras", m.c.id);
    const reintento = await correr(m, dbWorker, almacen, p, primero.id);

    expect(
      reintento.error,
      `el reintento falló con ${(reintento.error as ErrorArchivo | undefined)?.detalle}`,
    ).toBeUndefined();
    expect(reintento.resultado).toEqual({ ...primero.resultado, nueva: false });
    expect(await estadoDe(admin, "compras", m.c.id)).toEqual(reabierto);
    expect(await versionesDe(admin, m.c.id)).toHaveLength(1);
  });

  it("P-5 con otra huella, luego reabrir: repetir ese trabajo devuelve su versión y deja el periodo `abierto`", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    const base = await sembrarComprasBase(admin, m);
    expect(
      (await correr(m, dbWorker, almacen, await parametros(m, "compras")))
        .error,
    ).toBeUndefined();
    await fijarEstado(admin, "compras", m, "abierto");
    await nuevaVersion(admin, m, base.a, {
      clasificada: true,
      accion: "clasificar",
    });
    const p2 = await parametros(m, "compras");
    const segundo = await correr(m, dbWorker, almacen, p2);
    expect(segundo.resultado).toMatchObject({ version: 1, nueva: false });

    await fijarEstado(admin, "compras", m, "abierto");
    const repetido = await correr(m, dbWorker, almacen, p2, segundo.id);

    expect(repetido.error).toBeUndefined();
    expect(repetido.resultado).toEqual(segundo.resultado);
    expect((await estadoDe(admin, "compras", m.c.id))?.estado).toBe("abierto");
  });

  it("guarda: un trabajo SIN versión sobre un periodo reabierto sí genera y lo deja `generado` (P-5: mismo TXT, nueva:false)", async () => {
    const m = await mundo();
    const almacen = new AlmacenEspia();
    await sembrarComprasBase(admin, m);
    const v1 = await correr(
      m,
      dbWorker,
      almacen,
      await parametros(m, "compras"),
    );
    expect(v1.error).toBeUndefined();

    await fijarEstado(admin, "compras", m, "abierto");
    const otro = await correr(
      m,
      dbWorker,
      almacen,
      await parametros(m, "compras"),
    ); // otro trabajo, sin versión propia

    expect(otro.resultado).toEqual({ ...v1.resultado, nueva: false });
    expect((await estadoDe(admin, "compras", m.c.id))?.estado).toBe("generado");
  });
});
