/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 014 T18 · correcciones de la ronda adversarial que se ven por HTTP o en los servicios con PostgreSQL real (rojo hasta T20).
// A diferencia de `compras.adv.int.spec.ts` (ataques), cada prueba fija una corrección de forma determinista y lleva su caso feliz.
//  - H-014-1: la masiva de excluir con filas del SIRE y agregadas bloquea las compras en UN orden por id (ascendente), también las
//    agregadas que se descartan: mientras espera una fila no retiene otra de id mayor, y contra un deshacer concurrente no hay
//    40P01 ni 500. Se prueba reteniendo una fila desde otra transacción y mirando qué retiene la masiva mientras espera.
//  - H-014-2: el Excel y el resumen son una foto del periodo. Se prueba con un servicio real sobre una transacción espiada: tras
//    CADA sentencia que lee `compra` se confirma, desde otra conexión, un excluir/restaurar; lo que sale tiene que ser el
//    periodo tal como estaba al empezar (una compra en una sola hoja; el resumen igual al calculado sin interferencias).
//  - H-014-3: un carácter de control (NUL incluido) en la razón social al agregar, en el motivo al excluir (individual y masivo)
//    y en `q` del listado es 400 `solicitud_invalida` y no escribe nada (antes 500 `error_interno`).
//  - H-014-5: `GET …/compras/propuestas/:id/diferencias` acepta el UUID en mayúsculas igual que el detalle de una compra.
//  - DU-23 (usuario 2026-11-07): `POST …/estado/reabrir` lleva `{ estadoVisto: "revisado" | "generado" }` y es compare-and-set
//    contra ESE estado: si el periodo ya no lo está, 409 `estado_invalido` y no cambia nada; el cuerpo sin estadoVisto es 400.
import "reflect-metadata";
import { createDb, type ContappDb } from "@contapp/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoCompras,
  base,
  leerLibroXlsx,
  PERIODO,
  type Actor,
  type BancoCompras,
  type Estudio,
  type HojaXlsx,
} from "../../../test/soporte-compras.js";
import type { SesionResuelta } from "../auth/auth.service.js";
import { ExportarComprasService } from "./exportar.service.js";
import { ResumenComprasService } from "./resumen.service.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoCompras;
let E: Estudio;
let contador: Actor;
let asistente: Actor;
let dbBackend: ContappDb;

beforeAll(async () => {
  v = await abrirBancoCompras();
  E = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!url) throw new Error("falta MIGRATIONS_DATABASE_URL");
  dbBackend = createDb({ rolApp: "contapp_backend", url, poolMax: 4 });
});
afterAll(async () => {
  await dbBackend?.close();
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const nuevoCliente = () => v.cliente(E, { responsable: contador.id, colaboradores: [asistente.id] });
const u = (): string => E.titular.id;
const post = (a: Actor, c: Cliente, ruta: string, cuerpo: unknown = {}, periodo = PERIODO) =>
  v.llamar(a, "POST", `${base(c.id, periodo)}${ruta}`, cuerpo);
const get = (a: Actor, c: Cliente, ruta: string) => v.llamar(a, "GET", `${base(c.id)}${ruta}`);
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
const menor = (a: string, b: string): boolean => a.toLowerCase() < b.toLowerCase();

// ------------------------------------------------------------------------------------------------------------------------
// H-014-1 · un solo orden de bloqueo por id
// ------------------------------------------------------------------------------------------------------------------------

/** Otra transacción retiene `ids` con FOR UPDATE hasta `soltar()`. `xid` es su transacción, a la que esperan los bloqueados. */
async function retener(ids: string[]): Promise<{ xid: string; soltar: () => Promise<void> }> {
  let fin!: () => void;
  const hastaFin = new Promise<void>((r) => (fin = r));
  let listo!: (xid: string) => void;
  let fallo!: (e: unknown) => void;
  const xidListo = new Promise<string>((res, rej) => {
    listo = res;
    fallo = rej;
  });
  const tarea = dbBackend
    .withTenant({ tenantId: E.tenantId }, async (tx) => {
      for (const id of ids) await tx.query("select id from compra where id = $1 for update", [id]);
      listo((await tx.query("select pg_current_xact_id()::xid::text as x")).rows[0].x as string);
      await hastaFin;
    })
    .catch(fallo);
  const xid = await xidListo;
  return {
    xid,
    soltar: async () => {
      fin();
      await tarea;
    },
  };
}

/** Espera a que haya al menos `n` peticiones bloqueadas esperando la transacción `xid` (o, con `cola`, en la cola de la fila). */
async function esperarBloqueados(xid: string, n: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [{ esperando }] = await v.b.sql(
      `select count(*)::int as esperando from pg_locks
         where not granted and ((locktype = 'transactionid' and transactionid::text = $1)
                                or (locktype = 'tuple' and relation = 'compra'::regclass))`,
      [xid],
    );
    if (esperando >= n) return;
    await espera(50);
  }
  throw new Error(`no llegaron ${n} peticiones a esperar la fila retenida`);
}

/**
 * Espera a que haya una cadena de dos esperas: una petición bloqueada por la transacción `xid` y otra bloqueada por esa
 * primera (la masiva retiene la fila de id menor y espera la mayor; el deshacer espera a la masiva, no al retenedor).
 * Se observa con `pg_blocking_pids`, no con un tiempo fijo.
 */
async function esperarCadena(xid: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [{ n }] = await v.b.sql(
      `select count(*)::int as n
         from pg_stat_activity y
         join pg_stat_activity x on x.pid = any(pg_blocking_pids(y.pid))
         join pg_locks r on r.locktype = 'transactionid' and r.granted and r.transactionid::text = $1
        where r.pid = any(pg_blocking_pids(x.pid))`,
      [xid],
    );
    if (n >= 1) return;
    await espera(50);
  }
  throw new Error("no se formó la cadena retenedor <- masiva <- deshacer");
}

/** `true` si otra transacción retiene la fila (SELECT … FOR UPDATE NOWAIT da 55P03). */
async function filaRetenida(id: string): Promise<boolean> {
  try {
    await dbBackend.withTenant({ tenantId: E.tenantId }, (tx) => tx.query("select id from compra where id = $1 for update nowait", [id]));
    return false;
  } catch (e) {
    if ((e as { code?: string }).code === "55P03") return true;
    throw e;
  }
}

/** La agregada se crea ANTES que la del SIRE: con uuid v7 su id es menor (el caso que rompía el orden). */
async function agregadaYSire(c: Cliente, serie: string): Promise<{ g1: string; s2: string }> {
  const g1 = await v.sembrarCompra(E.tenantId, c.id, { serie, numero: "1", doc: "20700001301", origen: "agregada", usuarioId: u() });
  await espera(5);
  const s2 = await v.sembrarCompra(E.tenantId, c.id, { serie, numero: "2", doc: "20700001302", usuarioId: u() });
  expect(menor(g1, s2), "precondición: id de la agregada < id de la del SIRE").toBe(true);
  return { g1, s2 };
}

describe("H-014-1 · la masiva de excluir bloquea en un único orden por id (D-2)", () => {
  it("caso feliz: sin contención, una agregada y una del SIRE se excluyen de una vez (la agregada se descarta, la del SIRE queda excluida)", async () => {
    const c = await nuevoCliente();
    const { g1, s2 } = await agregadaYSire(c, "F301");
    const r = await post(contador, c, "/masivas/excluir", {
      items: [
        { compraId: s2, versionBase: 1 },
        { compraId: g1, versionBase: 1 },
      ],
      motivo: "no es del giro",
    });
    expect(r.status, r.text).toBe(200);
    expect(r.body.aplicadas).toBe(2);
    expect(r.body.rechazadas).toEqual([]);
    const compras = await v.compras(c.id);
    expect(compras.find((x) => x.id === g1)?.descartada).toBe(true);
    expect(compras.find((x) => x.id === s2)?.descartada).toBe(false);
    const vs = await v.versiones(s2);
    expect(vs).toHaveLength(2);
    expect(vs[1]).toMatchObject({ accion: "excluir", excluida: true, motivo: "no es del giro" });
  });

  it("mientras espera la fila de id menor (la agregada), la masiva NO retiene la del SIRE, de id mayor", async () => {
    const c = await nuevoCliente();
    const { g1, s2 } = await agregadaYSire(c, "F302");
    const retenedor = await retener([g1]);
    let masiva: Promise<any> | undefined;
    let retieneS2: boolean | undefined;
    try {
      masiva = post(contador, c, "/masivas/excluir", {
        items: [
          { compraId: s2, versionBase: 1 },
          { compraId: g1, versionBase: 1 },
        ],
      });
      await esperarBloqueados(retenedor.xid, 1);
      retieneS2 = await filaRetenida(s2);
    } finally {
      await retenedor.soltar();
    }
    const r = await masiva!;
    expect(retieneS2, "la masiva ya tenía bloqueada la del SIRE (s2) mientras esperaba la agregada (g1): dos órdenes de bloqueo").toBe(false);
    expect(r.status, r.text).toBe(200);
    expect(r.body.aplicadas).toBe(2);
  });

  it("la masiva de excluir y el deshacer de otra persona sobre las mismas filas no se interbloquean: ninguna responde 500 y las dos terminan", async () => {
    const c = await nuevoCliente();
    const { g1, s2 } = await agregadaYSire(c, "F303");
    // El Dueño clasifica las dos en una masiva: su deshacer bloqueará g1 y luego s2 (id ascendente).
    const op = await post(E.titular, c, "/masivas/clasificar", {
      items: [g1, s2].map((compraId) => ({ compraId, versionBase: 1 })),
      destino: "DNG",
    });
    expect(op.status, op.text).toBe(200);
    // Un tercero retiene s2 para fijar el orden de llegada: la masiva y el deshacer esperan.
    const retenedor = await retener([s2]);
    let masiva: Promise<any> | undefined;
    let des: Promise<any> | undefined;
    try {
      masiva = post(contador, c, "/masivas/excluir", {
        items: [
          { compraId: s2, versionBase: 2 },
          { compraId: g1, versionBase: 2 },
        ],
      });
      await esperarBloqueados(retenedor.xid, 1);
      des = post(E.titular, c, "/deshacer");
      // Con un único orden ascendente la masiva toma g1 y espera s2 (la cola de la fila del retenedor es de 1); el deshacer
      // espera a la masiva por g1, no al retenedor. Se espera esa cadena en lugar de «2 en la cola de s2».
      await esperarCadena(retenedor.xid);
    } finally {
      await retenedor.soltar();
    }
    const [m, d] = await Promise.all([masiva!, des!]);
    const resumen = `masiva ${m.status} ${m.text} · deshacer ${d.status} ${d.text}`;
    expect(m.status, resumen).not.toBe(500);
    expect(d.status, resumen).not.toBe(500);
    // Gana una y la otra ve la fila cambiada (409): nunca las dos ni a medias.
    const ok = [m.status, d.status].filter((s) => s === 200).length;
    expect(ok, resumen).toBeGreaterThanOrEqual(1);
    for (const r of [m, d]) expect([200, 409], resumen).toContain(r.status);
  });
});

// ------------------------------------------------------------------------------------------------------------------------
// H-014-2 · el Excel y el resumen son una foto del periodo
// ------------------------------------------------------------------------------------------------------------------------

/** Las sentencias que leen la tabla `compra` (no `compra_periodo`, `compra_version`…): tras cada una se confirma un cambio ajeno. */
const LEE_COMPRA = /\bcompra\b(?![_\w])/i;

/**
 * `db` real cuya transacción llama a `despues(k)` al terminar la k-ésima sentencia que lee `compra`, antes de seguir con la
 * siguiente. Sirve para meter un cambio confirmado entre dos lecturas del mismo servicio, sea cual sea su implementación.
 */
function dbEspiada(despues: (k: number) => Promise<void>): Pick<ContappDb, "withTenant"> & { lecturas: () => number } {
  let k = 0;
  return {
    lecturas: () => k,
    withTenant: ((ctx: any, fn: (tx: any) => Promise<unknown>) =>
      dbBackend.withTenant(ctx, (tx) =>
        fn(
          new Proxy(tx, {
            get(blanco, prop) {
              if (prop !== "query") return Reflect.get(blanco, prop, blanco);
              return async (...a: any[]) => {
                const r = await (blanco.query as (...x: any[]) => Promise<any>)(...a);
                if (LEE_COMPRA.test(String(a[0]))) await despues(++k);
                return r;
              };
            },
          }),
        ),
      )) as never,
  };
}

const sesion = (): SesionResuelta => ({ tenantActivo: E.tenantId, usuarioId: contador.id }) as unknown as SesionResuelta;
const veces = (h: HojaXlsx, razonSocial: string): number =>
  h.filas.filter((f) => f.some((x) => x !== null && x.tipo === "texto" && x.valor === razonSocial)).length;

describe("H-014-2 · el Excel es una foto consistente del periodo (D-17)", () => {
  const PARES = 8;
  /** `PARES` vigentes (X1…) y `PARES` excluidas (Y1…): la hoja «Compras» debe traer las X y la hoja «Excluidas» las Y. */
  async function conXY(c: Cliente): Promise<{ x: string[]; y: string[] }> {
    const x: string[] = [];
    const y: string[] = [];
    for (let i = 1; i <= PARES; i++) {
      x.push(
        await v.sembrarCompra(E.tenantId, c.id, { serie: "A301", numero: String(i), doc: `207000014${i}1`, razonSocial: `FILA X${i} SAC`, usuarioId: u() }),
      );
      y.push(
        await v.sembrarCompra(E.tenantId, c.id, {
          serie: "A302",
          numero: String(i),
          doc: `207000014${i}2`,
          razonSocial: `FILA Y${i} SAC`,
          usuarioId: u(),
          versiones: [{ excluida: true, motivo: "no es del giro", accion: "excluir" }],
        }),
      );
    }
    return { x, y };
  }
  const reparto = (hojas: HojaXlsx[]) => ({
    compras: Array.from({ length: PARES }, (_, i) => [veces(hojas[0]!, `FILA X${i + 1} SAC`), veces(hojas[0]!, `FILA Y${i + 1} SAC`)]),
    excluidas: Array.from({ length: PARES }, (_, i) => [veces(hojas[1]!, `FILA X${i + 1} SAC`), veces(hojas[1]!, `FILA Y${i + 1} SAC`)]),
  });
  const ESPERADO = {
    compras: Array.from({ length: PARES }, () => [1, 0]),
    excluidas: Array.from({ length: PARES }, () => [0, 1]),
  };

  it("caso feliz: sin interferencias, las vigentes salen solo en «Compras» y las excluidas solo en «Excluidas»", async () => {
    const c = await nuevoCliente();
    await conXY(c);
    const r = await v.bin(contador, "GET", `${base(c.id)}/exportar.xlsx`);
    expect(r.status).toBe(200);
    expect(reparto(leerLibroXlsx(new Uint8Array(r.bytes)))).toEqual(ESPERADO);
  });

  it("con excluir y restaurar confirmados tras cada lectura, el archivo es el periodo de cuando empezó: cada compra en una sola hoja", async () => {
    const c = await nuevoCliente();
    const { x, y } = await conXY(c);
    const fallos: string[] = [];
    let cadena: Promise<void> = Promise.resolve();
    // Tras la k-ésima lectura de `compra` se confirma, desde otra conexión, el cambio k: la X_k se excluye y la Y_k se restaura.
    // Si el servicio retuviera algo que bloquea esas acciones no se espera más de 4 s (terminan al confirmar el servicio) y el
    // archivo debe seguir siendo el del inicio.
    const espiada = dbEspiada(async (k) => {
      if (k > PARES) return;
      cadena = cadena.then(async () => {
        const e = await post(contador, c, `/${x[k - 1]}/excluir`, { versionBase: 1 });
        if (e.status !== 200) fallos.push(`excluir ${e.status} ${e.text}`);
        const r = await post(contador, c, `/${y[k - 1]}/restaurar`, { versionBase: 2 });
        if (r.status !== 200) fallos.push(`restaurar ${r.status} ${r.text}`);
      });
      await Promise.race([cadena, espera(4000)]);
    });
    const { datos } = await new ExportarComprasService(espiada as never).exportar(sesion(), { tipo: "global" }, c.id, PERIODO);
    await cadena;
    expect(fallos, "las acciones concurrentes del arnés deben haber entrado").toEqual([]);
    expect(espiada.lecturas(), "el arnés debe haber visto lecturas de compra").toBeGreaterThanOrEqual(2);
    expect(reparto(leerLibroXlsx(new Uint8Array(datos))), "una compra salió en las dos hojas o en ninguna").toEqual(ESPERADO);
    // Control: el arnés escribió de verdad (un Excel nuevo ya ve los cambios).
    const despues = await v.bin(contador, "GET", `${base(c.id)}/exportar.xlsx`);
    expect(reparto(leerLibroXlsx(new Uint8Array(despues.bytes)))).not.toEqual(ESPERADO);
  });
});

describe("H-014-2 · el resumen es una foto consistente del periodo (D-8, DU-20)", () => {
  it("con más de 2.000 compras y una exclusión confirmada tras cada lectura por lotes, el resumen es el calculado sin interferencias", async () => {
    const c = await nuevoCliente();
    await v.sembrarVolumen(E.tenantId, c.id, 2100, { usuarioId: u() });
    // Las últimas por id caen en el segundo lote (el primero lee 2.000 en orden de id).
    const finales = (await v.compras(c.id)).map((x) => x.id).sort().slice(-6);
    const servicio = (db: Pick<ContappDb, "withTenant">) => new ResumenComprasService(db as never);
    const esperado = await servicio(dbBackend).resumen(sesion(), { tipo: "global" }, c.id, PERIODO);
    expect(esperado.conIgv.n + esperado.sinIgv.n, "precondición: 2.100 vigentes").toBe(2100);

    const fallos: string[] = [];
    let cadena: Promise<void> = Promise.resolve();
    const espiada = dbEspiada(async (k) => {
      const id = finales[k - 1];
      if (id === undefined) return;
      cadena = cadena.then(async () => {
        const r = await post(contador, c, `/${id}/excluir`, { versionBase: 1 });
        if (r.status !== 200) fallos.push(`excluir ${r.status} ${r.text}`);
      });
      await Promise.race([cadena, espera(4000)]);
    });
    const visto = await servicio(espiada).resumen(sesion(), { tipo: "global" }, c.id, PERIODO);
    await cadena;
    expect(fallos).toEqual([]);
    expect(espiada.lecturas()).toBeGreaterThanOrEqual(1);
    expect(visto, "el resumen mezcló estados del periodo: no coincide con el de cuando empezó").toEqual(esperado);
    // Control: una vez terminadas las exclusiones, un resumen nuevo sí las ve (el arnés escribió de verdad).
    const despues = await servicio(dbBackend).resumen(sesion(), { tipo: "global" }, c.id, PERIODO);
    expect(despues.conIgv.n + despues.sinIgv.n).toBeLessThan(2100);
  });
});

// ------------------------------------------------------------------------------------------------------------------------
// H-014-3 · caracteres de control
// ------------------------------------------------------------------------------------------------------------------------

const CONTROLES: [string, string][] = [
  ["NUL (U+0000)", "\u0000"],
  ["SOH (U+0001)", "\u0001"],
  ["BEL (U+0007)", "\u0007"],
  ["ESC (U+001B)", "\u001b"],
  ["DEL (U+007F)", "\u007f"],
  ["NEL, de control C1 (U+0085)", "\u0085"],
];
const alta = (numero: string, razonSocial: string) => ({
  tipo: "01",
  serie: "F304",
  numero,
  proveedor: { tipo: "6", numero: "20700001500", razonSocial },
  fecha: "2026-10-15",
  moneda: "PEN",
  montos: { biDg: "100.00", igvDg: "18.00" },
});

describe("H-014-3 · un carácter de control es 400 solicitud_invalida, no un 500 de la BD", () => {
  it.each(CONTROLES)("razón social al agregar con %s: 400 y no se crea nada", async (_n, ctl) => {
    const c = await nuevoCliente();
    const antes = await v.foto(c.id);
    const r = await post(contador, c, "", alta("1", `ACME${ctl} SAC`));
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it.each(CONTROLES)("motivo al excluir con %s: 400 (individual y masiva) y no se escribe nada", async (_n, ctl) => {
    const c = await nuevoCliente();
    const id = await v.sembrarCompra(E.tenantId, c.id, { serie: "F305", numero: "1", doc: "20700001501", usuarioId: u() });
    const antes = await v.foto(c.id);
    const uno = await post(contador, c, `/${id}/excluir`, { versionBase: 1, motivo: `no es del giro${ctl}` });
    expect(uno.status, `individual: ${uno.text}`).toBe(400);
    expect(uno.body).toEqual({ codigo: "solicitud_invalida" });
    const masiva = await post(contador, c, "/masivas/excluir", { items: [{ compraId: id, versionBase: 1 }], motivo: `${ctl}no es del giro` });
    expect(masiva.status, `masiva: ${masiva.text}`).toBe(400);
    expect(masiva.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it.each(CONTROLES)("búsqueda q del listado con %s: 400", async (_n, ctl) => {
    const c = await nuevoCliente();
    await v.sembrarCompra(E.tenantId, c.id, { serie: "F306", numero: "1", doc: "20700001502", usuarioId: u() });
    const r = await get(contador, c, `?q=${encodeURIComponent(`AC${ctl}ME`)}`);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
  });

  it("caso feliz: tildes, ñ, comillas, &, emoji y HTML se aceptan en los tres lugares y se guardan tal cual", async () => {
    const c = await nuevoCliente();
    const razonSocial = "Peña & Hijos «Perú» S.A.C. ✔ <b>x</b>";
    const alt = await post(contador, c, "", alta("2", razonSocial));
    expect(alt.status, alt.text).toBe(201);
    expect((await v.compras(c.id)).find((x) => x.id === alt.body.fila.id)?.razon_social).toBe(razonSocial);
    const motivo = "No es del giro: «gasto personal» — nº 3";
    const exc = await post(contador, c, `/${alt.body.fila.id}/excluir`, { versionBase: 1, motivo });
    expect(exc.status, exc.text).toBe(200);
    const sire = await v.sembrarCompra(E.tenantId, c.id, { serie: "F307", numero: "1", doc: "20700001503", usuarioId: u() });
    const masiva = await post(contador, c, "/masivas/excluir", { items: [{ compraId: sire, versionBase: 1 }], motivo });
    expect(masiva.status, masiva.text).toBe(200);
    expect((await v.versiones(sire)).at(-1)?.motivo).toBe(motivo);
    const q = await get(contador, c, `?q=${encodeURIComponent("Peña")}`);
    expect(q.status, q.text).toBe(200);
  });
});

// ------------------------------------------------------------------------------------------------------------------------
// H-014-5 · UUID en mayúsculas
// ------------------------------------------------------------------------------------------------------------------------

describe("H-014-5 · GET propuestas/:id/diferencias acepta el UUID en mayúsculas (como el detalle)", () => {
  async function conDiferencia(c: Cliente, serie: string, periodo = PERIODO) {
    const propuestaId = await v.sembrarPropuesta(E.tenantId, c.id, { libro: "compras", nuevas: 1, distintas: 1, periodo, usuarioId: u() });
    await v.sembrarDiferenciaCompra(E.tenantId, propuestaId, {
      clave: `01|${serie}|1|6|20700001600`,
      campos: ["total"],
      valoresSire: { total: "1.00" },
    });
    return propuestaId;
  }

  it("caso feliz: la propuesta propia en minúsculas, en mayúsculas y con mayúsculas y minúsculas mezcladas da lo mismo (200)", async () => {
    const c = await nuevoCliente();
    const id = await conDiferencia(c, "F308");
    const min = await get(contador, c, `/propuestas/${id.toLowerCase()}/diferencias`);
    expect(min.status, min.text).toBe(200);
    expect(min.body).toHaveLength(1);
    const may = await get(contador, c, `/propuestas/${id.toUpperCase()}/diferencias`);
    expect(may.status, `mayúsculas: ${may.text}`).toBe(200);
    expect(may.body).toEqual(min.body);
    const mezcla = id
      .split("")
      .map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase()))
      .join("");
    const mix = await get(contador, c, `/propuestas/${mezcla}/diferencias`);
    expect(mix.status, `mezcla: ${mix.text}`).toBe(200);
    expect(mix.body).toEqual(min.body);
  });

  it("error: la propuesta de OTRO cliente, de otro periodo o inexistente sigue siendo 404 aunque venga en mayúsculas", async () => {
    const c = await nuevoCliente();
    const otro = await nuevoCliente();
    const ajena = await conDiferencia(otro, "F309");
    const deOtroPeriodo = await conDiferencia(c, "F310", "202609");
    for (const [nombre, id] of [
      ["ajena", ajena],
      ["otro periodo", deOtroPeriodo],
      ["inexistente", "0198F6C0-0000-7000-8000-0000000000AA"],
    ] as const) {
      const r = await get(contador, c, `/propuestas/${id.toUpperCase()}/diferencias`);
      expect(r.status, `${nombre}: ${r.text}`).toBe(404);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------
// DU-23 · reabrir con el estado visto
// ------------------------------------------------------------------------------------------------------------------------

describe("DU-23 · reabrir lleva el estado que vio la persona y es compare-and-set contra ese estado", () => {
  const reabrir = (a: Actor, c: Cliente, cuerpo: unknown) => post(a, c, "/estado/reabrir", cuerpo);
  async function conEstado(estado: "abierto" | "revisado" | "generado"): Promise<Cliente> {
    const c = await nuevoCliente();
    await v.sembrarCompra(E.tenantId, c.id, { serie: "F311", numero: "1", doc: "20700001700", usuarioId: u() });
    if (estado !== "abierto") await v.estadoPeriodo(E.tenantId, c.id, PERIODO, estado, contador.id);
    return c;
  }

  it.each(["revisado", "generado"] as const)(
    "caso feliz: el estado visto (%s) coincide con el actual: 200 { estado: abierto, por, en } y la persona vuelve a editar",
    async (estado) => {
      const c = await conEstado(estado);
      const r = await reabrir(contador, c, { estadoVisto: estado });
      expect(r.status, r.text).toBe(200);
      expect(r.body.estado).toBe("abierto");
      expect(r.body.por).toBe(contador.id);
      expect(Number.isNaN(Date.parse(r.body.en))).toBe(false);
      expect((await v.periodoFila(c.id)).estado).toBe("abierto");
    },
  );

  it("el estado cambió mientras tanto (la persona vio «revisado» y 012b ya marcó «generado»): 409 estado_invalido y no cambia nada", async () => {
    const c = await conEstado("revisado");
    await v.estadoPeriodo(E.tenantId, c.id, PERIODO, "generado", contador.id); // 012b genera el TXT
    const antes = await v.foto(c.id);
    const r = await reabrir(contador, c, { estadoVisto: "revisado" });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "estado_invalido" });
    expect(await v.foto(c.id), "ni el estado, ni quién ni cuándo").toEqual(antes);
    expect((await v.periodoFila(c.id)).estado).toBe("generado");
  });

  it("al revés (vio «generado» y ahora está «revisado»): 409 y el periodo sigue revisado", async () => {
    const c = await conEstado("revisado");
    const antes = await v.foto(c.id);
    const r = await reabrir(contador, c, { estadoVisto: "generado" });
    expect(r.status, r.text).toBe(409);
    expect(r.body).toEqual({ codigo: "estado_invalido" });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("un periodo abierto no se reabre, ni con revisado ni con generado como estado visto: 409", async () => {
    const c = await conEstado("abierto");
    for (const estadoVisto of ["revisado", "generado"]) {
      const r = await reabrir(contador, c, { estadoVisto });
      expect(r.status, `${estadoVisto}: ${r.text}`).toBe(409);
      expect(r.body).toEqual({ codigo: "estado_invalido" });
    }
  });

  it("dos reabrir a la vez con el mismo estado visto: uno da 200 y el otro 409 (nadie reabre dos veces)", async () => {
    const c = await conEstado("revisado");
    const rs = await Promise.all([reabrir(contador, c, { estadoVisto: "revisado" }), reabrir(E.titular, c, { estadoVisto: "revisado" })]);
    expect(rs.map((r) => r.status).sort(), rs.map((r) => r.text).join(" · ")).toEqual([200, 409]);
    expect((await v.periodoFila(c.id)).estado).toBe("abierto");
  });

  it.each([
    ["sin cuerpo", {}],
    ["sin el campo", { estado: "revisado" }],
    ["abierto", { estadoVisto: "abierto" }],
    ["otro texto", { estadoVisto: "cerrado" }],
    ["mayúsculas", { estadoVisto: "REVISADO" }],
    ["número", { estadoVisto: 1 }],
    ["nulo", { estadoVisto: null }],
  ])("estado visto inválido (%s): 400 solicitud_invalida y el periodo no cambia", async (_n, cuerpo) => {
    const c = await conEstado("revisado");
    const antes = await v.foto(c.id);
    const r = await reabrir(contador, c, cuerpo);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("reabrir sigue exigiendo sire.aprobar_generar: el asistente con el estado visto correcto recibe 403 y el periodo no cambia", async () => {
    const c = await conEstado("revisado");
    const antes = await v.foto(c.id);
    const r = await reabrir(asistente, c, { estadoVisto: "revisado" });
    expect(r.status, r.text).toBe(403);
    expect(r.body).toEqual({ codigo: "permiso_denegado" });
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("reabrir no crea versiones ni entra en deshacer (DU-14): el estado visto no cambia eso", async () => {
    const c = await conEstado("revisado");
    const antes = (await v.foto(c.id)).versiones;
    expect((await reabrir(contador, c, { estadoVisto: "revisado" })).status).toBe(200);
    expect((await v.foto(c.id)).versiones).toEqual(antes);
    expect((await post(contador, c, "/deshacer")).body).toEqual({ codigo: "nada_que_deshacer" });
  });
});
