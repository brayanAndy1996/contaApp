/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 014 · T18: ronda adversarial (caja negra y luego blanca), acotada por el usuario a tres frentes:
//  - inmutabilidad: compra_version, identidad y puntero de compra, deshacer y rehacer;
//  - concurrencia: masivas, deshacer contra edición, Excel contra acciones, orden de bloqueo, estado del periodo;
//  - alcance: estudios y clientes ajenos, rutas de propuestas y diferencias, Excel con fórmulas y caracteres de control;
// más el punto del Resultado de T13: un solo hallazgo por regla y versión (dos destinos de la misma regla no dan 23505).
// Una prueba en rojo es un hallazgo H-014-n (ver tasks.md, T18). Las verdes quedan como regresión.
import { createDb, insertarCompras, type ContappDb } from "@contapp/db";
import { crearEvaluarCompras } from "@contapp/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  abrirBancoCompras,
  base,
  leerLibroXlsx,
  montos,
  PERIODO,
  type Actor,
  type BancoCompras,
  type Estudio,
  type HojaXlsx,
} from "../../../test/soporte-compras.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let v: BancoCompras;
let E: Estudio;
let contador: Actor;
let asistente: Actor;
let dbBackend: ContappDb;
let dbWorker: ContappDb;

beforeAll(async () => {
  v = await abrirBancoCompras();
  E = await v.estudio();
  const p = v.b.c.p.b;
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!url) throw new Error("falta MIGRATIONS_DATABASE_URL");
  dbBackend = createDb({ rolApp: "contapp_backend", url, poolMax: 3 });
  dbWorker = createDb({ rolApp: "contapp_worker", url, poolMax: 2 });
});
afterAll(async () => {
  await dbBackend?.close();
  await dbWorker?.close();
  await v?.cerrar();
});

type Cliente = { id: string; ruc: string };
const nuevoCliente = () => v.cliente(E, { responsable: contador.id, colaboradores: [asistente.id] });
const u = (): string => E.titular.id;
const post = (a: Actor, c: Cliente, ruta: string, cuerpo: unknown = {}, periodo = PERIODO) =>
  v.llamar(a, "POST", `${base(c.id, periodo)}${ruta}`, cuerpo);
const get = (a: Actor, c: Cliente, ruta: string) => v.llamar(a, "GET", `${base(c.id)}${ruta}`);
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Una sentencia como `contapp_backend` en el estudio E, siempre revertida: dice si la BD la aceptó y con qué SQLSTATE. */
class Revertir extends Error {}
async function intentar(sql: string, valores: unknown[]): Promise<{ ok: boolean; codigo?: string }> {
  try {
    await dbBackend.withTenant({ tenantId: E.tenantId }, async (tx) => {
      await tx.query(sql, valores);
      throw new Revertir();
    });
  } catch (e) {
    if (e instanceof Revertir) return { ok: true };
    return { ok: false, codigo: (e as { code?: string }).code };
  }
  return { ok: true };
}

/** Ids sembrados en orden de creación (uuid v7): el primero es menor que el segundo. */
const menor = (a: string, b: string): boolean => a.toLowerCase() < b.toLowerCase();

// ------------------------------------------------------------------------------------------------------------------------
// Inmutabilidad
// ------------------------------------------------------------------------------------------------------------------------

describe("T18 · inmutabilidad", () => {
  it("[caja blanca] el puntero version_vigente solo avanza a una versión que existe y una compra del SIRE no se descarta, aun con UPDATE directo del rol backend", async () => {
    const c = await nuevoCliente();
    const id = await v.sembrarCompra(E.tenantId, c.id, {
      serie: "F101",
      numero: "1",
      usuarioId: u(),
      versiones: [{ montos: { biDg: "110.00", igvDg: "19.80" }, accion: "editar" }],
    });
    // La fila está en la versión 2. Lo único mutable es el puntero «con compare-and-set» (D-1): el CAS lo hace la aplicación,
    // pero la BD acepta cualquier entero.
    const colgante = await intentar("update compra set version_vigente = 99 where id = $1 and version_vigente = 2", [id]);
    const atras = await intentar("update compra set version_vigente = 1 where id = $1 and version_vigente = 2", [id]);
    const sire = await intentar("update compra set descartada_en = now() where id = $1", [id]);
    expect.soft(colgante.ok, "puntero a una versión que no existe: la compra desaparece de listado, resumen, Excel y 012b").toBe(false);
    expect.soft(atras.ok, "puntero hacia atrás: cambia la vigente sin dejar versión, autor ni fecha (D-12)").toBe(false);
    expect.soft(sire.ok, "descartar una compra del SIRE (D-7: las del SIRE se excluyen, no se descartan)").toBe(false);
  });

  it("[caja negra] deshacer, rehacer y deshacer sobre una masiva y una edición: versión 1 intacta, versiones consecutivas, puntero en la última y nada se borra", async () => {
    const c = await nuevoCliente();
    const ids: string[] = [];
    for (let i = 1; i <= 3; i++)
      ids.push(await v.sembrarCompra(E.tenantId, c.id, { serie: "F102", numero: String(i), doc: `207000020${i}0`, usuarioId: u() }));
    const v1 = await Promise.all(ids.map(async (id) => (await v.versiones(id))[0]));

    const pasos: [string, () => Promise<any>][] = [
      ["masiva DNG", () => post(contador, c, "/masivas/clasificar", { items: ids.map((compraId) => ({ compraId, versionBase: 1 })), destino: "DNG" })],
      ["editar fila 0", () => post(contador, c, `/${ids[0]}/editar`, { versionBase: 2, cambios: { biDng: "200.00", igvDng: "36.00" } })],
      ["deshacer edición", () => post(contador, c, "/deshacer")],
      ["deshacer masiva", () => post(contador, c, "/deshacer")],
      ["rehacer masiva", () => post(contador, c, "/rehacer")],
      ["rehacer edición", () => post(contador, c, "/rehacer")],
      ["deshacer edición otra vez", () => post(contador, c, "/deshacer")],
    ];
    for (const [nombre, paso] of pasos) {
      const r = await paso();
      expect(r.status, `${nombre}: ${r.text}`).toBe(200);
    }

    const esperadas = [8, 4, 4];
    for (const [k, id] of ids.entries()) {
      const vs = await v.versiones(id);
      expect(vs.map((x) => x.n), `fila ${k}: n consecutivos desde 1`).toEqual(Array.from({ length: esperadas[k]! }, (_, i) => i + 1));
      expect(vs[0], `fila ${k}: la versión 1 no cambia`).toEqual(v1[k]);
      expect(vs[0]!.accion).toBe("original");
      for (const x of vs.slice(1)) {
        expect(x.usuario_id, `fila ${k} v${x.n}: autor`).toBe(contador.id);
        expect(x.operacion_id, `fila ${k} v${x.n}: operación`).not.toBeNull();
      }
      const [compra] = (await v.compras(c.id)).filter((x) => x.id === id);
      expect(compra!.version_vigente, `fila ${k}: el puntero apunta a la última versión`).toBe(esperadas[k]);
      // Tras rehacer la masiva y deshacer otra vez la edición, las tres quedan como las dejó la masiva (BI e IGV en DNG).
      expect(vs.at(-1)).toMatchObject({ biDg: "0.00", igvDg: "0.00", biDng: "100.00", igvDng: "18.00", total: "118.00" });
    }
    const repetidos = await v.b.sql(
      `select compra_id, version_n, regla, count(*)::int as n from compra_hallazgo
         where compra_id = any($1::uuid[]) group by 1, 2, 3 having count(*) > 1`,
      [ids],
    );
    expect(repetidos).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------------------------------
// Concurrencia
// ------------------------------------------------------------------------------------------------------------------------

describe("T18 · concurrencia", () => {
  it("[caja blanca] orden de bloqueo: una masiva de excluir con una agregada no interbloquea con quien bloquea compras por id ascendente (40P01)", async () => {
    const c = await nuevoCliente();
    // La agregada se crea ANTES que la del SIRE: con uuid v7 su id es menor.
    const g1 = await v.sembrarCompra(E.tenantId, c.id, { serie: "F103", numero: "1", doc: "20700000301", origen: "agregada", usuarioId: u() });
    await espera(5);
    const s2 = await v.sembrarCompra(E.tenantId, c.id, { serie: "F103", numero: "2", doc: "20700000302", usuarioId: u() });
    expect(menor(g1, s2), "precondición: id de la agregada < id de la del SIRE").toBe(true);

    let errorOrdenada: string | undefined;
    let masiva: Promise<any> | undefined;
    // Una transacción que respeta el orden del plan («compra por id ascendente»), como una masiva de clasificar o un deshacer
    // que incluyan las dos filas: primero g1, luego s2.
    await dbBackend
      .withTenant({ tenantId: E.tenantId }, async (tx) => {
        await tx.query("select id from compra where id = $1 for update", [g1]);
        masiva = post(contador, c, "/masivas/excluir", {
          items: [
            { compraId: s2, versionBase: 1 },
            { compraId: g1, versionBase: 1 },
          ],
        });
        // Espera a que la masiva quede bloqueada (ya tomó s2 y pide g1).
        for (let i = 0; i < 100; i++) {
          const [w] = await v.b.sql(
            `select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid
               where not l.granted and a.query ilike '%from compra where id = $1%for update%'`,
          );
          if (w.n > 0) break;
          await espera(50);
        }
        await tx.query("select id from compra where id = $1 for update", [s2]);
      })
      .catch((e: { code?: string }) => {
        errorOrdenada = e.code ?? "error";
      });
    const r = await masiva!;
    expect.soft(errorOrdenada, "la transacción ordenada por id fue víctima de un interbloqueo").toBeUndefined();
    expect.soft(r.status, `la masiva de excluir: ${r.text}`).toBe(200);
  });

  it("[caja negra] 10 rondas: deshacer de A y edición de B sobre la misma fila a la vez; gana exactamente una y la otra no escribe", async () => {
    const c = await nuevoCliente();
    for (let i = 1; i <= 10; i++) {
      const id = await v.sembrarCompra(E.tenantId, c.id, { serie: "F104", numero: String(i), doc: "20700000400", usuarioId: u() });
      const ed = await post(contador, c, `/${id}/editar`, { versionBase: 1, cambios: { biDg: "110.00" } });
      expect(ed.status, ed.text).toBe(200);
      const [des, otro] = await Promise.all([
        post(contador, c, "/deshacer"),
        post(E.titular, c, `/${id}/editar`, { versionBase: 2, cambios: { biDg: "120.00" } }),
      ]);
      const vs = await v.versiones(id);
      const ronda = `ronda ${i}: deshacer ${des.status} ${des.text} · editar ${otro.status} ${otro.text}`;
      expect(vs.length, ronda).toBe(3);
      if (des.status === 200) {
        expect(otro.status, ronda).toBe(409);
        expect(otro.body?.codigo, ronda).toBe("version_obsoleta");
        expect(vs[2], ronda).toMatchObject({ accion: "deshacer", biDg: "100.00" });
      } else {
        expect(des.status, ronda).toBe(409);
        expect(des.body, ronda).toEqual({ codigo: "fila_cambiada", ids: [id] });
        expect(otro.status, ronda).toBe(200);
        expect(vs[2], ronda).toMatchObject({ accion: "editar", biDg: "120.00" });
      }
    }
  });

  it("[caja blanca] el Excel es una foto del periodo: con excluir y restaurar a la vez, cada fila sale en una sola hoja (ni en las dos ni en ninguna)", async () => {
    const c = await nuevoCliente();
    await v.sembrarVolumen(E.tenantId, c.id, 4500, { usuarioId: u() });
    // La primera fila en el orden del listado (fecha, serie, número): la lee el primer lote de la hoja «Compras».
    const objetivo = await v.sembrarCompra(E.tenantId, c.id, {
      serie: "A001",
      numero: "1",
      doc: "20700000500",
      fecha: "2026-10-01",
      razonSocial: "FILA OBJETIVO SAC",
      usuarioId: u(),
    });
    let detener = false;
    let version = 1;
    const fallosAgitador: string[] = [];
    const agitador = (async () => {
      while (!detener) {
        for (const ruta of ["excluir", "restaurar"]) {
          const r = await post(contador, c, `/${objetivo}/${ruta}`, { versionBase: version });
          if (r.status !== 200) fallosAgitador.push(`${ruta} ${r.status} ${r.text}`);
          else version = r.body.fila.version;
        }
      }
    })();
    const veces = (h: HojaXlsx): number =>
      h.filas.filter((f) => f.some((x) => x !== null && x.tipo === "texto" && x.valor === "FILA OBJETIVO SAC")).length;
    const inconsistentes: string[] = [];
    try {
      // Hasta 20 descargas: con el agitador cada una tiene alrededor de una oportunidad entre dos de caer entre las dos lecturas.
      for (let k = 0; k < 20 && inconsistentes.length === 0; k++) {
        const r = await v.bin(contador, "GET", `${base(c.id)}/exportar.xlsx`);
        expect(r.status).toBe(200);
        const [compras, excluidas] = leerLibroXlsx(new Uint8Array(r.bytes));
        const enCompras = veces(compras!);
        const enExcluidas = veces(excluidas!);
        if (enCompras + enExcluidas !== 1) inconsistentes.push(`descarga ${k + 1}: Compras ${enCompras}, Excluidas ${enExcluidas}`);
      }
    } finally {
      detener = true;
      await agitador;
    }
    expect(fallosAgitador).toEqual([]);
    expect(inconsistentes).toEqual([]);
  });

  it("[caja blanca, ronda 2] dos peticiones reales: la masiva de excluir con una agregada y el deshacer de otra persona sobre las mismas filas no interbloquean (40P01)", async () => {
    const c = await nuevoCliente();
    const g1 = await v.sembrarCompra(E.tenantId, c.id, { serie: "F112", numero: "1", doc: "20700001201", origen: "agregada", usuarioId: u() });
    await espera(5);
    const s2 = await v.sembrarCompra(E.tenantId, c.id, { serie: "F112", numero: "2", doc: "20700001202", usuarioId: u() });
    expect(menor(g1, s2), "precondición: id de la agregada < id de la del SIRE").toBe(true);
    // El Dueño clasifica las dos en una masiva: su deshacer bloqueará g1 y luego s2 (id ascendente).
    const op = await post(E.titular, c, "/masivas/clasificar", {
      items: [g1, s2].map((compraId) => ({ compraId, versionBase: 1 })),
      destino: "DNG",
    });
    expect(op.status, op.text).toBe(200);

    const esperando = async (n: number): Promise<void> => {
      for (let i = 0; i < 100; i++) {
        const [w] = await v.b.sql(
          `select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid
             where not l.granted and a.datname = current_database() and a.query ilike '%compra%for update%'`,
        );
        if (w.n >= n) return;
        await espera(50);
      }
    };
    let masiva: Promise<any> | undefined;
    let des: Promise<any> | undefined;
    // Un tercero retiene s2 para fijar el orden de llegada: la masiva espera s2; el deshacer toma g1 y espera s2.
    const retenedor = dbBackend.withTenant({ tenantId: E.tenantId }, async (tx) => {
      await tx.query("select id from compra where id = $1 for update", [s2]);
      masiva = post(contador, c, "/masivas/excluir", {
        items: [
          { compraId: s2, versionBase: 2 },
          { compraId: g1, versionBase: 2 },
        ],
      });
      await esperando(1);
      des = post(E.titular, c, "/deshacer");
      await esperando(2);
    });
    await retenedor;
    const [m, d] = await Promise.all([masiva!, des!]);
    const resumen = `masiva ${m.status} ${m.text} · deshacer ${d.status} ${d.text}`;
    expect.soft(m.status, resumen).not.toBe(500);
    expect.soft(d.status, resumen).not.toBe(500);
  });

  it("[caja negra] 8 rondas: marcar revisado mientras el asistente aplica una masiva; la masiva entra entera (200) o nada (403 periodo_revisado), nunca a medias ni 500", async () => {
    const c = await nuevoCliente();
    for (let i = 1; i <= 8; i++) {
      const periodo = `20260${i}`;
      const ids = await v.sembrarVolumen(E.tenantId, c.id, 150, { usuarioId: u(), periodo });
      const [m, rev] = await Promise.all([
        post(asistente, c, "/masivas/clasificar", { items: ids.map((compraId) => ({ compraId, versionBase: 1 })), destino: "DNG" }, periodo),
        (async () => {
          await espera(i * 3);
          return post(contador, c, "/estado/revisar", {}, periodo);
        })(),
      ]);
      const ronda = `ronda ${i}: masiva ${m.status} ${m.text.slice(0, 120)} · revisar ${rev.status} ${rev.text}`;
      expect(rev.status, ronda).toBe(200);
      const [{ n }] = await v.b.sql(
        "select count(*)::int as n from compra_version v join compra c on c.id = v.compra_id where c.cliente_id = $1 and c.periodo = $2 and v.n = 2",
        [c.id, periodo],
      );
      if (m.status === 200) {
        expect(m.body.aplicadas, ronda).toBe(150);
        expect(n, ronda).toBe(150);
      } else {
        expect(m.status, ronda).toBe(403);
        expect(m.body, ronda).toEqual({ codigo: "periodo_revisado" });
        expect(n, ronda).toBe(0);
      }
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------
// Alcance, rutas nuevas y Excel
// ------------------------------------------------------------------------------------------------------------------------

describe("T18 · alcance", () => {
  it("[caja negra] GET propuestas/:id/diferencias acepta el UUID en mayúsculas igual que GET :compraId (no da 404 a una propuesta propia)", async () => {
    const c = await nuevoCliente();
    const propuestaId = await v.sembrarPropuesta(E.tenantId, c.id, { libro: "compras", nuevas: 1, distintas: 1, usuarioId: u() });
    await v.sembrarDiferenciaCompra(E.tenantId, propuestaId, {
      clave: "01|F105|1|6|20700000501",
      campos: ["total"],
      valoresSire: { total: "1.00" },
    });
    const compra = await v.sembrarCompra(E.tenantId, c.id, { serie: "F105", numero: "2", doc: "20700000501", propuestaId, usuarioId: u() });
    // Control: el detalle de una compra acepta el id en mayúsculas.
    const detalle = await get(contador, c, `/${compra.toUpperCase()}`);
    expect(detalle.status, detalle.text).toBe(200);
    const min = await get(contador, c, `/propuestas/${propuestaId}/diferencias`);
    expect(min.status, min.text).toBe(200);
    expect(min.body).toHaveLength(1);
    const may = await get(contador, c, `/propuestas/${propuestaId.toUpperCase()}/diferencias`);
    expect(may.status, `mayúsculas: ${may.text}`).toBe(200);
    expect(may.body).toEqual(min.body);
  });

  it("[caja blanca] masiva de excluir: una agregada de otro cliente, de otro periodo o ya descartada sale no_encontrada y no se descarta (el descarte no filtra por cliente)", async () => {
    const c = await nuevoCliente();
    const otro = await nuevoCliente();
    const agregada = (cliente: string, numero: string, extra: Record<string, unknown> = {}) =>
      v.sembrarCompra(E.tenantId, cliente, { serie: "F106", numero, doc: "20700000600", origen: "agregada", usuarioId: u(), ...extra });
    const propia = await agregada(c.id, "1");
    const sire = await v.sembrarCompra(E.tenantId, c.id, { serie: "F106", numero: "2", doc: "20700000601", usuarioId: u() });
    const deOtro = await agregada(otro.id, "3");
    const deOtroPeriodo = await agregada(c.id, "4", { periodo: "202609" });
    const yaDescartada = await agregada(c.id, "5", { descartada: true });
    const r = await post(contador, c, "/masivas/excluir", {
      items: [propia, sire, deOtro, deOtroPeriodo, yaDescartada].map((compraId) => ({ compraId, versionBase: 1 })),
    });
    expect(r.status, r.text).toBe(200);
    expect(r.body.aplicadas).toBe(2);
    const codigos = Object.fromEntries(r.body.rechazadas.map((x: any) => [x.compraId, x.codigo]));
    expect(codigos).toEqual({ [deOtro]: "no_encontrada", [deOtroPeriodo]: "no_encontrada", [yaDescartada]: "no_encontrada" });
    expect((await v.compras(otro.id)).find((x) => x.id === deOtro)?.descartada).toBe(false);
    expect((await v.compras(c.id, "202609")).find((x) => x.id === deOtroPeriodo)?.descartada).toBe(false);
  });

  it("[caja negra] un NUL en la razón social, en el motivo o en la búsqueda es 400 solicitud_invalida, no un 500 de la BD", async () => {
    const c = await nuevoCliente();
    const id = await v.sembrarCompra(E.tenantId, c.id, { serie: "F107", numero: "1", doc: "20700000700", usuarioId: u() });
    const antes = await v.foto(c.id);
    const agregar = await post(contador, c, "", {
      tipo: "01",
      serie: "F107",
      numero: "2",
      proveedor: { tipo: "6", numero: "20700000701", razonSocial: "ACME\u0000 SAC" },
      fecha: "2026-10-15",
      moneda: "PEN",
      montos: { biDg: "100.00", igvDg: "18.00" },
    });
    const excluir = await post(contador, c, `/${id}/excluir`, { versionBase: 1, motivo: "no es del giro\u0000" });
    const buscar = await get(contador, c, "?q=AC%00ME");
    expect.soft(agregar.status, `agregar: ${agregar.text}`).toBe(400);
    expect.soft(excluir.status, `excluir: ${excluir.text}`).toBe(400);
    expect.soft(buscar.status, `buscar: ${buscar.text}`).toBe(400);
    expect(await v.foto(c.id)).toEqual(antes);
  });

  it("[caja blanca] Excel: caracteres de control, espacios Unicode y fórmulas en la razón social y en el motivo de exclusión salen como texto neutralizado", async () => {
    const c = await nuevoCliente();
    const razones = ["\n=1+1", " =1+1", "﻿@SUM(1)", "\u0001=1+1", " -2+3", " +1", "A\u0007B SAC"];
    for (const [i, razonSocial] of razones.entries())
      await v.sembrarCompra(E.tenantId, c.id, { serie: "F108", numero: String(i + 1), doc: `2070000080${i}`, razonSocial, usuarioId: u() });
    for (const [i, motivo] of ['=HYPERLINK("http://x")', "\t+1", "-1"].entries())
      await v.sembrarCompra(E.tenantId, c.id, {
        serie: "F109",
        numero: String(i + 1),
        doc: `2070000090${i}`,
        razonSocial: "EXCLUIDA SAC",
        usuarioId: u(),
        versiones: [{ excluida: true, motivo, accion: "excluir" }],
      });
    const r = await v.bin(contador, "GET", `${base(c.id)}/exportar.xlsx`);
    expect(r.status).toBe(200);
    const hojas = leerLibroXlsx(new Uint8Array(r.bytes));
    const textos = hojas.flatMap((h) => h.filas.flat()).filter((x): x is NonNullable<typeof x> => x !== null);
    for (const x of textos) {
      expect(x.tipo, JSON.stringify(x.valor)).not.toBe("formula");
      if (x.tipo !== "texto") continue;
      expect(x.valor, `peligroso: ${JSON.stringify(x.valor)}`).not.toMatch(/^[\s﻿]*[=+\-@]/u);
      expect(x.valor, `control: ${JSON.stringify(x.valor)}`).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u);
    }
    const valores = textos.map((x) => x.valor);
    expect(valores).toContain("AB SAC");
    expect(valores).toContain(`'=HYPERLINK("http://x")`);
    expect(valores).toContain("'-1");
    expect(valores).toContain("'=1+1");
  });
});

// ------------------------------------------------------------------------------------------------------------------------
// Resultado de T13: un hallazgo por regla y versión
// ------------------------------------------------------------------------------------------------------------------------

describe("T18 · un solo hallazgo por regla y versión (T13)", () => {
  it("[caja blanca] la descarga (insertarCompras + crearEvaluarCompras, rol worker) con R-MIX y R-ISC en dos destinos de la misma compra no da 23505", async () => {
    const c = await nuevoCliente();
    const propuestaId = await v.sembrarPropuesta(E.tenantId, c.id, { libro: "compras", nuevas: 2, usuarioId: u() });
    const nueva = (numero: string, m: Record<string, string>) => {
      const mm = montos(m);
      return {
        clave: `01|F110|${numero}|6|20700001000`,
        tipoDoc: "01",
        serie: "F110",
        numero,
        docTipo: "6",
        docNumero: "20700001000",
        razonSocial: "DOS DESTINOS SAC",
        fecha: "2026-10-05",
        moneda: "PEN" as const,
        tipoCambio: null,
        montos: mm,
      };
    };
    const filas = [
      nueva("1", { biDg: "21.48", igvDg: "1.61", biDgng: "21.48", igvDgng: "1.61" }),
      nueva("2", { biDg: "770.00", igvDg: "0.00", biDgng: "100.00", igvDgng: "0.00" }),
    ];
    const ids = await dbWorker.withTenant({ tenantId: E.tenantId }, (tx) =>
      insertarCompras(tx, { clienteId: c.id, periodo: PERIODO, propuestaId }, filas, { evaluar: crearEvaluarCompras([]) as any }),
    );
    expect(ids).toHaveLength(2);
    const mix = (await v.hallazgosDe(ids[0]!, 1)).filter((h) => h.regla === "R-MIX");
    expect(mix).toHaveLength(1);
    const repetidos = await v.b.sql(
      `select compra_id, regla from compra_hallazgo where compra_id = any($1::uuid[]) group by 1, version_n, 2 having count(*) > 1`,
      [ids],
    );
    expect(repetidos).toEqual([]);
  });

  it("[caja negra] agregar una compra con R-MIX en DG y DGNG, aceptar la de DG y luego la que reaparece en DGNG: ningún 500 y cada versión con un R-MIX", async () => {
    const c = await nuevoCliente();
    const alta = await post(contador, c, "", {
      tipo: "01",
      serie: "F111",
      numero: "1",
      proveedor: { tipo: "6", numero: "20700001100", razonSocial: "MIXTA DOBLE SAC" },
      fecha: "2026-10-15",
      moneda: "PEN",
      montos: { biDg: "21.48", igvDg: "1.61", biDgng: "21.48", igvDgng: "1.61" },
    });
    expect(alta.status, alta.text).toBe(201);
    const id = alta.body.fila.id as string;
    const mix1 = alta.body.fila.hallazgos.filter((h: any) => h.regla === "R-MIX");
    expect(mix1, alta.text).toHaveLength(1);
    expect(mix1[0].destino).toBe("DG");

    const a1 = await post(contador, c, `/${id}/sugerencias/aceptar`, { versionBase: 1, regla: "R-MIX", confirmar: true, dato: { gravado: "8.97" } });
    expect(a1.status, a1.text).toBe(200);
    expect(a1.body.fila.montos).toMatchObject({ biDg: "8.97", igvDg: "1.61", biDgng: "21.48", noGravado: "12.51" });
    const mix2 = a1.body.fila.hallazgos.filter((h: any) => h.regla === "R-MIX");
    expect(mix2, a1.text).toHaveLength(1);
    expect(mix2[0].destino).toBe("DGNG");

    const a2 = await post(contador, c, `/${id}/sugerencias/aceptar`, { versionBase: 2, regla: "R-MIX", confirmar: true, dato: { gravado: "8.97" } });
    expect(a2.status, a2.text).toBe(200);
    expect(a2.body.fila.montos).toMatchObject({ biDgng: "8.97", igvDgng: "1.61", noGravado: "25.02", total: "46.18" });
    expect(a2.body.fila.hallazgos.map((h: any) => h.regla)).not.toContain("R-MIX");
  });
});
