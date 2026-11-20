/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 024 · T11 · ronda adversarial 1 (D-11): alcance de la bandeja, lote de atención, cursor e indicador.
// Caja negra (spec + contratos del plan): parámetros repetidos / arreglos / mayúsculas, desasignación con sesión viva, cursor
// forjado o de otra ruta, lotes de 100 + 1, ids ajenos mezclados, comentarios con controles y bidi, bordes de Lima, indicador.
// Caja blanca (0059, 0060, bandeja.ts, atencion.service.ts, cursor.ts): el cursor no se firma (la huella se recalcula a mano
// para forjarlo), la visibilidad del lote se decide fuera de la función acotada (lectura previa en la misma tx), la función
// llamada directo con otro contexto, el orden de bloqueo frente a archivar y la concurrencia lote ∥ deshacer ∥ marcar.
// Resultado de la ronda 1: sin hallazgos (las 15 pasan y quedan como regresión).
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "@contapp/db";
import {
  abrirBancoBandeja,
  sinPermiso,
  type Actor,
  type BancoBandeja,
  type Estudio,
} from "../../../test/soporte-bandeja.js";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let b: BancoBandeja;
let E: Estudio;
let F: Estudio;
let dueno: Actor;
let deF: Actor; // dueño del estudio F
let raiz: ReturnType<typeof createDb>; // superusuario: transacciones retenidas (archivar a mitad de un lote)
let backend: ReturnType<typeof createDb>; // rol contapp_backend: la función llamada directo
let worker: ReturnType<typeof createDb>; // rol contapp_worker

beforeAll(async () => {
  b = await abrirBancoBandeja();
  E = await b.estudio();
  F = await b.estudio();
  dueno = E.titular;
  deF = F.titular;
  const url = process.env.MIGRATIONS_DATABASE_URL!;
  const app = process.env.DATABASE_URL!;
  raiz = createDb({ rolApp: "contapp_backend", url, poolMax: 2 });
  backend = createDb({ rolApp: "contapp_backend", url: app, poolMax: 2 });
  worker = createDb({ rolApp: "contapp_worker", url: app, poolMax: 2 });
});
afterAll(async () => {
  await raiz?.close();
  await backend?.close();
  await worker?.close();
  await b?.cerrar();
});

// ---------------------------------------------------------------------------------------------------------------------------
const p = () => b.v.b.c.p.b;
const miembro = (rol: "contador" | "asistente" | "lectura" | "admin") => p().miembro(E.tenantId, rol);
/** `n` clientes nuevos de E con el prefijo dado (razón social única por prueba). */
const clientes = (n: number, prefijo: string, archivado?: (i: number) => boolean) =>
  b.clientesMasivos(E.tenantId, n, { prefijo, ...(archivado ? { archivado } : {}) });
const asignar = (u: Actor, ids: string[], tipo: "responsable" | "colaborador" = "colaborador") =>
  b.asignarMasivo(E.tenantId, u.id, ids, tipo);
/** Fecha en la forma fija de la BD a partir de un ISO con milisegundos y los microsegundos dados. */
const f = (iso: string, us = "000"): string => `${iso.slice(0, 23)}${us}Z`;

const GET = (a: Actor, ruta: string) => b.llamar(a, "GET", ruta);
const lote = (a: Actor, cuerpo: unknown) => b.llamar(a, "POST", "/buzon/atencion", cuerpo);
const atender = (a: Actor, clienteId: string, m: string, cuerpo: unknown) =>
  b.llamar(a, "POST", `/clientes/${clienteId}/buzon/mensajes/${m}/atencion`, cuerpo);

/** Recorre todas las páginas de `ruta` (con `?` ya puesto o no) y devuelve los ids en orden. */
async function recorrer(a: Actor, ruta: string, limite = 1): Promise<string[]> {
  const sep = ruta.includes("?") ? "&" : "?";
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 500; i++) {
    const r: any = await GET(a, `${ruta}${sep}limite=${limite}${cursor ? `&cursor=${cursor}` : ""}`);
    expect(r.status, r.text).toBe(200);
    ids.push(...r.body.mensajes.map((m: any) => m.id));
    cursor = r.body.siguiente;
    if (cursor === null) return ids;
  }
  throw new Error("recorrido sin fin");
}

/** Huella de cursor.ts recalculada (white-box): `sha256(JSON [ruta, atencion, categoria, leido, desde, hasta, arch, resp])[0..16]`. */
function huella(ruta: string, o: { atencion?: string; archivados?: boolean; responsable?: boolean } = {}): string {
  const canon = JSON.stringify([ruta, o.atencion ?? "todos", null, null, null, null, o.archivados === true, o.responsable === true]);
  return createHash("sha256").update(canon, "utf8").digest("hex").slice(0, 16);
}
const cursorDe = (obj: unknown): string => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");

const sqlstate = (e: any): string | undefined => e?.code ?? e?.codigo ?? e?.cause?.code ?? e?.cause?.codigo;
async function falla(promesa: Promise<unknown>): Promise<string | undefined> {
  try {
    await promesa;
  } catch (e) {
    return sqlstate(e) ?? "error-sin-sqlstate";
  }
  return undefined;
}
const SQL_FN = "select * from public.buzon_atencion_aplicar($1::uuid, $2::uuid[], $3::text, $4::text)";

// ===========================================================================================================================
describe("Alcance de la bandeja (D-2, D-3; CA-1)", () => {
  it("parámetros repetidos, arreglos, mayúsculas, claves ajenas y valores fuera de forma dan 400 (no cuelan cliente ni archivados)", async () => {
    const contador = await miembro("contador");
    const [vis, oculto] = await clientes(2, "Adv-Param");
    await asignar(contador, [vis!.id]);
    const malos = [
      "?archivados=1&archivados=1",
      "?archivados[]=1",
      "?archivados[0]=1",
      "?Archivados=1",
      "?archivados=true",
      "?atencion=pendientes&atencion=todos",
      "?atencion[]=pendientes",
      "?atencion=PENDIENTES",
      `?clienteId=${oculto!.id}`,
      `?cliente=${oculto!.id}`,
      "?responsable=YO",
      `?responsable=${contador.id}`,
      "?responsable=yo&responsable=yo",
      "?limite=101",
      "?limite=0",
      "?limite=1&limite=2",
      "?limite=1e2",
      "?desde=2026-02-30",
      "?desde=2026-11-13&hasta=2026-11-12",
      "?cursor=",
      "?cursor[]=abc",
    ];
    for (const q of malos) {
      const r = await GET(contador, `/buzon/mensajes${q}`);
      expect(r.status, `${q} → ${r.text}`).toBe(400);
    }
    // En la bandeja fijada no existen «responsable» ni «archivados».
    for (const q of ["?archivados=1", "?responsable=yo", `?clienteId=${oculto!.id}`]) {
      const r = await GET(contador, `/clientes/${vis!.id}/buzon/mensajes${q}`);
      expect(r.status, `${q} → ${r.text}`).toBe(400);
    }
  });

  it("desasignado con la sesión viva: la página siguiente (con el cursor ya emitido) ya no trae al cliente y un lote con su id da 404", async () => {
    const contador = await miembro("contador");
    const [A, B] = await clientes(2, "Adv-Desasig");
    await asignar(contador, [A!.id, B!.id]);
    const base = "2026-11-18T03:00:00.000";
    const [a1, b1, a2, b2] = await b.sembrarLote(E.tenantId, [
      { clienteId: A!.id, fecha: f(base, "004") },
      { clienteId: B!.id, fecha: f(base, "003") },
      { clienteId: A!.id, fecha: f(base, "002") },
      { clienteId: B!.id, fecha: f(base, "001") },
    ]);
    const r1 = await GET(contador, "/buzon/mensajes?limite=1");
    expect(r1.status, r1.text).toBe(200);
    expect(r1.body.mensajes.map((m: any) => m.id)).toEqual([a1]);
    await b.sql("delete from asignacion where cliente_id = $1 and usuario_id = $2", [B!.id, contador.id]);
    const resto: string[] = [];
    let cursor: string | null = r1.body.siguiente;
    while (cursor !== null) {
      const r = await GET(contador, `/buzon/mensajes?limite=1&cursor=${cursor}`);
      expect(r.status, r.text).toBe(200);
      resto.push(...r.body.mensajes.map((m: any) => m.id));
      cursor = r.body.siguiente;
    }
    expect(resto).toEqual([a2]);
    expect(resto).not.toContain(b1);
    const antes = await b.instantanea([a2!, b2!]);
    const rl = await lote(contador, { mensajes: [a2, b2] });
    expect(rl.status, rl.text).toBe(404);
    expect(await b.instantanea([a2!, b2!])).toEqual(antes);
    // Su bandeja fijada también es 404 (igual que inexistente).
    expect((await GET(contador, `/clientes/${B!.id}/buzon/mensajes`)).status).toBe(404);
  });

  it("«solo donde soy responsable» para el Dueño: solo sus clientes responsables, sin archivados, y su cursor no vale sin el filtro", async () => {
    const [R1, R2, Otro, RArch] = await clientes(4, "Adv-Resp", (i) => i === 3);
    await asignar(dueno, [R1!.id, R2!.id, RArch!.id], "responsable");
    await asignar(dueno, [Otro!.id], "colaborador");
    const fecha = f("2026-11-19T10:00:00.000", "500");
    const [m1, m2, mo, ma] = await b.sembrarLote(E.tenantId, [
      { clienteId: R1!.id, fecha },
      { clienteId: R2!.id, fecha },
      { clienteId: Otro!.id, fecha },
      { clienteId: RArch!.id, fecha },
    ]);
    const ids = await recorrer(dueno, "/buzon/mensajes?responsable=yo");
    expect(new Set(ids)).toEqual(new Set([m1, m2]));
    expect(ids).toHaveLength(2);
    const conArch = await recorrer(dueno, "/buzon/mensajes?responsable=yo&archivados=1");
    expect(new Set(conArch)).toEqual(new Set([m1, m2, ma]));
    expect(conArch).not.toContain(mo);
    const r = await GET(dueno, "/buzon/mensajes?responsable=yo&limite=1");
    expect(r.status).toBe(200);
    expect(r.body.siguiente).not.toBeNull();
    const sinFiltro = await GET(dueno, `/buzon/mensajes?limite=1&cursor=${r.body.siguiente}`);
    expect(sinFiltro.status, sinFiltro.text).toBe(400);
    expect(sinFiltro.body.codigo).toBe("cursor_invalido");
  });
});

// ===========================================================================================================================
describe("Cursor (D-4; CA-2)", () => {
  it("forjado (huella recalculada, fecha futura/pasada, id o emisión de otro estudio) no amplía; de otra ruta/cliente/filtro da 400", async () => {
    const contador = await miembro("contador");
    const [vis, oculto] = await clientes(2, "Adv-Forja");
    await asignar(contador, [vis!.id]);
    const gF = (await b.clientesMasivos(F.tenantId, 1, { prefijo: "Adv-ForjaF" }))[0]!;
    const fecha = f("2026-11-19T12:00:00.000", "123");
    const [mv] = await b.sembrarLote(E.tenantId, [{ clienteId: vis!.id, fecha }]);
    await b.sembrarLote(E.tenantId, [{ clienteId: oculto!.id, fecha }]);
    const [mF] = await b.sembrarLote(F.tenantId, [{ clienteId: gF.id, fecha }]);
    const h = huella("global");
    const sinCursor = await recorrer(contador, "/buzon/mensajes", 100);
    expect(sinCursor).toContain(mv);
    const futuro = cursorDe({ v: 1, f: "9999-12-31T23:59:59.999999Z", i: mF, h });
    const r = await GET(contador, `/buzon/mensajes?limite=100&cursor=${futuro}`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.mensajes.map((m: any) => m.id)).toEqual(sinCursor);
    for (const m of r.body.mensajes) expect(m.cliente.id).toBe(vis!.id);
    const pasado = cursorDe({ v: 1, f: "0001-01-01T00:00:00.000000Z", i: mF, h });
    const rp = await GET(contador, `/buzon/mensajes?cursor=${pasado}`);
    expect(rp.status, rp.text).toBe(200);
    expect(rp.body).toMatchObject({ mensajes: [], siguiente: null });
    // Un cursor emitido en el estudio F, usado en E con los mismos filtros: solo filas de E visibles.
    const enF = await GET(deF, "/buzon/mensajes?limite=1");
    expect(enF.status).toBe(200);
    const crudoF = enF.body.siguiente ?? cursorDe({ v: 1, f: "9999-12-31T23:59:59.999999Z", i: mF, h });
    const cruzado = await GET(contador, `/buzon/mensajes?limite=100&cursor=${crudoF}`);
    expect(cruzado.status, cruzado.text).toBe(200);
    for (const m of cruzado.body.mensajes) expect(m.cliente.id).toBe(vis!.id);

    // De otra ruta o de otro cliente: 400 cursor_invalido; el mismo cliente con el uuid en mayúsculas lo acepta.
    const [A, B] = await clientes(2, "Adv-Ruta");
    const fr = f("2026-11-19T13:00:00.000");
    await b.sembrarLote(E.tenantId, [
      { clienteId: A!.id, fecha: fr },
      { clienteId: A!.id, fecha: fr },
      { clienteId: B!.id, fecha: fr },
      { clienteId: B!.id, fecha: fr },
    ]);
    const rA = await GET(dueno, `/clientes/${A!.id}/buzon/mensajes?limite=1`);
    expect(rA.status).toBe(200);
    const cA = rA.body.siguiente as string;
    expect(cA).toBeTruthy();
    const enB = await GET(dueno, `/clientes/${B!.id}/buzon/mensajes?limite=1&cursor=${cA}`);
    expect([enB.status, enB.body.codigo]).toEqual([400, "cursor_invalido"]);
    const enGlobal = await GET(dueno, `/buzon/mensajes?limite=1&cursor=${cA}`);
    expect([enGlobal.status, enGlobal.body.codigo]).toEqual([400, "cursor_invalido"]);
    const otroFiltro = await GET(dueno, `/clientes/${A!.id}/buzon/mensajes?limite=1&atencion=pendientes&cursor=${cA}`);
    expect([otroFiltro.status, otroFiltro.body.codigo]).toEqual([400, "cursor_invalido"]);
    // `atencion=todos` explícito es el mismo filtro que omitirlo (valor por omisión): mismo cursor válido.
    const explicito = await GET(dueno, `/clientes/${A!.id}/buzon/mensajes?limite=1&atencion=todos&cursor=${cA}`);
    expect(explicito.status, explicito.text).toBe(200);
    const mayus = await GET(dueno, `/clientes/${A!.id.toUpperCase()}/buzon/mensajes?limite=1&cursor=${cA}`);
    expect(mayus.status, mayus.text).toBe(200);
    expect(mayus.body.mensajes).toHaveLength(1);
  });

  it("mal formado (relleno, claves extra, otra zona, 7 decimales, versión texto, arreglo, >256) da 400 cursor_invalido, nunca 500", async () => {
    const r0 = await GET(dueno, "/buzon/mensajes?limite=1");
    expect(r0.status).toBe(200);
    const h = huella("global");
    const id = randomUUID();
    const buena = { v: 1, f: "2026-11-19T13:00:00.000000Z", i: id, h };
    const sanos = await GET(dueno, `/buzon/mensajes?cursor=${cursorDe(buena)}`);
    expect(sanos.status, sanos.text).toBe(200); // control: el forjado bien formado se acepta
    const conRelleno = Buffer.from(JSON.stringify(buena), "utf8").toString("base64");
    const variantes = [
      `${cursorDe(buena)}=`,
      conRelleno.endsWith("=") ? conRelleno : `${conRelleno}==`,
      cursorDe({ ...buena, x: 1 }),
      cursorDe({ ...buena, tenant: E.tenantId }),
      cursorDe({ ...buena, f: "2026-11-19T13:00:00.000000+00:00" }),
      cursorDe({ ...buena, f: "2026-11-19T08:00:00.000000-05:00" }),
      cursorDe({ ...buena, f: "2026-11-19T13:00:00.0000001Z" }),
      cursorDe({ ...buena, f: "2026-11-19T13:00:00Z" }),
      cursorDe({ ...buena, f: "2026-02-30T13:00:00.000000Z" }),
      cursorDe({ ...buena, v: "1" }),
      cursorDe({ ...buena, i: `${id}x` }),
      cursorDe({ ...buena, h: h.toUpperCase() }),
      cursorDe([1, buena.f, id, h]),
      cursorDe(null),
      cursorDe({ ...buena, i: "x".repeat(300) }),
      "%00",
      encodeURIComponent("{\"v\":1}"),
    ];
    for (const c of variantes) {
      const r = await GET(dueno, `/buzon/mensajes?cursor=${encodeURIComponent(c)}`);
      expect([r.status, r.body?.codigo], c).toEqual([400, expect.stringMatching(/^(cursor_invalido|solicitud_invalida)$/)]);
    }
  });

  it("empates al microsegundo y filas atendidas a mitad del recorrido de «Pendientes»: ninguna fila repetida ni omitida", async () => {
    const contador = await miembro("contador");
    const [A, B] = await clientes(2, "Adv-Micro");
    await asignar(contador, [A!.id, B!.id]);
    const s = "2026-11-19T15:00:00.000";
    const filas = [
      { clienteId: A!.id, fecha: f(s, "002") },
      { clienteId: B!.id, fecha: f(s, "001") },
      { clienteId: A!.id, fecha: f(s, "001") },
      { clienteId: B!.id, fecha: f(s, "000") },
      { clienteId: A!.id, fecha: f(s, "000") },
      { clienteId: A!.id, fecha: f("2026-11-19T14:59:59.999", "999") },
    ];
    const ids = await b.sembrarLote(E.tenantId, filas);
    const esperado = filas
      .map((x, i) => ({ id: ids[i]!, fecha: x.fecha }))
      .sort((x, y) => (x.fecha === y.fecha ? (x.id < y.id ? 1 : -1) : x.fecha < y.fecha ? 1 : -1))
      .map((x) => x.id);
    // Cada forma de consulta (global asignado, Dueño global, fijada) recorrida de a 1.
    expect(await recorrer(contador, "/buzon/mensajes?atencion=pendientes")).toEqual(esperado);
    const delA = esperado.filter((i) => filas[ids.indexOf(i)]!.clienteId === A!.id);
    expect(await recorrer(contador, `/clientes/${A!.id}/buzon/mensajes?atencion=pendientes`)).toEqual(delA);
    // Recorrido de «Pendientes» atendiendo la fila recién vista: el resto sale una vez y en orden.
    const vistos: string[] = [];
    let cursor: string | null = null;
    do {
      const r: any = await GET(contador, `/buzon/mensajes?atencion=pendientes&limite=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(r.status, r.text).toBe(200);
      const pag = r.body.mensajes.map((m: any) => m.id);
      vistos.push(...pag);
      for (const m of pag) {
        const cl = r.body.mensajes.find((x: any) => x.id === m).cliente.id;
        const at = await atender(contador, cl, m, { accion: "marcar" });
        expect(at.status, at.text).toBe(200);
      }
      cursor = r.body.siguiente;
    } while (cursor !== null);
    expect(vistos).toEqual(esperado);
  });
});

// ===========================================================================================================================
describe("Lote de atención (D-6, D-7; CA-7)", () => {
  it("100 válidos + 1 = 400; 99 válidos + 1 de otro estudio o de un cliente no asignado = 404 sin cambios; el Dueño sí puede", async () => {
    const contador = await miembro("contador");
    const [vis, oculto] = await clientes(2, "Adv-Lote100");
    await asignar(contador, [vis!.id]);
    const gF = (await b.clientesMasivos(F.tenantId, 1, { prefijo: "Adv-LoteF" }))[0]!;
    const propios = await b.sembrarLote(
      E.tenantId,
      Array.from({ length: 100 }, (_, i) => ({ clienteId: vis!.id, fecha: f(`2026-11-0${1 + (i % 9)}T10:00:00.000`, String(i).padStart(3, "0")) })),
    );
    const [deOtro] = await b.sembrarLote(F.tenantId, [{ clienteId: gF.id, fecha: f("2026-11-10T10:00:00.000") }]);
    const [noAsig] = await b.sembrarLote(E.tenantId, [{ clienteId: oculto!.id, fecha: f("2026-11-10T10:00:00.000") }]);
    const todos = [...propios, noAsig!];
    const antes = await b.instantanea(todos);
    const c0 = await b.contadores(E.tenantId);
    const r101 = await lote(contador, { mensajes: [...propios, deOtro] });
    expect(r101.status, r101.text).toBe(400);
    for (const intruso of [deOtro!, noAsig!, noAsig!.toUpperCase()]) {
      const mezcla = [...propios.slice(0, 50), intruso, ...propios.slice(50, 99)];
      const r = await lote(contador, { mensajes: mezcla, comentario: "lote" });
      expect(r.status, `${intruso} → ${r.text}`).toBe(404);
      expect(r.body).toEqual({ codigo: "no_encontrado" });
    }
    expect(await b.instantanea(todos)).toEqual(antes);
    expect(await b.contadores(E.tenantId)).toEqual(c0);
    // El mismo lote con el id de otro estudio también es 404 para el Dueño; sin él, el Dueño marca los 100.
    const rd = await lote(dueno, { mensajes: [...propios.slice(0, 99), deOtro] });
    expect(rd.status, rd.text).toBe(404);
    const ok = await lote(dueno, { mensajes: [...propios.slice(0, 99), noAsig] });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.atendidos).toHaveLength(100);
    expect(ok.body.omitidos).toEqual([]);
  });

  it("ids repetidos con otra capitalización: 400 sin cambios; ids en mayúsculas sin repetir se marcan y se informan", async () => {
    const asistente = await miembro("asistente");
    const [A] = await clientes(1, "Adv-Mayus");
    await asignar(asistente, [A!.id]);
    const [m1, m2] = await b.sembrarLote(E.tenantId, [
      { clienteId: A!.id, fecha: f("2026-11-15T10:00:00.000") },
      { clienteId: A!.id, fecha: f("2026-11-15T11:00:00.000") },
    ]);
    const antes = await b.instantanea([m1!, m2!]);
    const rep = await lote(asistente, { mensajes: [m1, m1!.toUpperCase(), m2] });
    expect(rep.status, rep.text).toBe(400);
    expect(await b.instantanea([m1!, m2!])).toEqual(antes);
    const r = await lote(asistente, { mensajes: [m1!.toUpperCase(), m2!.toUpperCase()] });
    expect(r.status, r.text).toBe(200);
    expect([...r.body.atendidos].map((x: string) => x.toLowerCase()).sort()).toEqual([m1, m2].sort());
    expect(r.body.omitidos).toEqual([]);
    expect((await b.eventos(m1!)).length + (await b.eventos(m2!)).length).toBe(2);
    // Repetirlo: omitidos, sin eventos nuevos.
    const r2 = await lote(asistente, { mensajes: [m2, m1] });
    expect(r2.status, r2.text).toBe(200);
    expect(r2.body).toEqual({ atendidos: [], omitidos: [m2, m1] });
    expect((await b.eventos(m1!)).length + (await b.eventos(m2!)).length).toBe(2);
  });

  it("archivar mientras el lote espera el bloqueo del cliente: 409 cliente_archivado y nada cambia (U-1)", async () => {
    const contador = await miembro("contador");
    const [A, B] = await clientes(2, "Adv-Arch");
    await asignar(contador, [A!.id, B!.id]);
    const ms = await b.sembrarLote(E.tenantId, [
      { clienteId: A!.id, fecha: f("2026-11-16T10:00:00.000") },
      { clienteId: B!.id, fecha: f("2026-11-16T10:00:00.000") },
    ]);
    const antes = await b.instantanea(ms);
    const c0 = await b.contadores(E.tenantId);
    const cx = await raiz.pool.connect();
    let pendiente: Promise<any> | undefined;
    try {
      await cx.query("begin");
      await cx.query("update cliente set archivado_at = now() where id = $1", [B!.id]);
      pendiente = lote(contador, { mensajes: ms });
      const carrera = await Promise.race([pendiente.then(() => "terminó"), new Promise((r) => setTimeout(() => r("espera"), 1500))]);
      expect(carrera).toBe("espera"); // la función espera el FOR SHARE del cliente
      await cx.query("commit");
    } finally {
      cx.release();
    }
    const r = await pendiente!;
    expect(r.status, r.text).toBe(409);
    expect(r.body.codigo).toBe("cliente_archivado");
    expect(await b.instantanea(ms)).toEqual(antes);
    expect(await b.contadores(E.tenantId)).toEqual(c0);
  });

  it("lote ∥ deshacer ∥ marcar sobre los mismos mensajes: solo 200/409, eventos alternados y estado final = último evento", async () => {
    const [contador, asistente, admin] = [await miembro("contador"), await miembro("asistente"), await miembro("admin")];
    const [A] = await clientes(1, "Adv-Carrera");
    await asignar(contador, [A!.id]);
    await asignar(asistente, [A!.id]);
    const ms = await b.sembrarLote(
      E.tenantId,
      Array.from({ length: 4 }, (_, i) => ({ clienteId: A!.id, fecha: f(`2026-11-17T1${i}:00:00.000`), categoria: i === 0 ? "coactiva" : "otro" })),
    );
    for (let ronda = 0; ronda < 3; ronda++) {
      const peticiones = [
        lote(contador, { mensajes: ms, comentario: `lote ${ronda}` }),
        lote(asistente, { mensajes: [...ms].reverse(), comentario: `lote inv ${ronda}` }),
        ...ms.map((m, i) => atender([admin, dueno, asistente, contador][i]!, A!.id, m, { accion: "deshacer" })),
        ...ms.map((m, i) => atender([dueno, contador, admin, asistente][i]!, A!.id, m, { accion: "marcar", comentario: "uno" })),
      ];
      const rs = await Promise.all(peticiones);
      for (const r of rs) expect([200, 409], r.text).toContain(r.status);
    }
    for (const m of ms) {
      const ev = await b.eventos(m);
      ev.forEach((e: any, i: number) => expect(e.accion).toBe(i % 2 === 0 ? "atendido" : "deshecho"));
      const fila = await b.mensaje(m);
      const ultimo = ev.at(-1);
      if (ultimo?.accion === "atendido") {
        expect(fila.atendido_por).toBe(ultimo.usuario_id);
        expect(new Date(fila.atendido_en).getTime()).toBe(new Date(ultimo.creado_en).getTime());
      } else {
        expect(fila.atendido_en).toBeNull();
        expect(fila.atendido_por).toBeNull();
      }
      const aud = (await b.auditoriaTodas(E.tenantId)).filter((x: any) => x.entidad_id === m && String(x.accion).startsWith("buzon.aten"));
      expect(aud).toHaveLength(ev.length);
    }
  });

  it("comentarios con controles, bidi o solo espacios: 400 en individual y en lote, sin eventos; 500 tras recortar sí entra", async () => {
    const asistente = await miembro("asistente");
    const [A] = await clientes(1, "Adv-Coment");
    await asignar(asistente, [A!.id]);
    const [m, n] = await b.sembrarLote(E.tenantId, [
      { clienteId: A!.id, fecha: f("2026-11-14T10:00:00.000"), categoria: "coactiva" },
      { clienteId: A!.id, fecha: f("2026-11-14T11:00:00.000") },
    ]);
    const malos = [
      "‮abc",
      "a⁦b⁩",
      "a‏b",
      "a‎b",
      "a؜b",
      "a\tb",
      "a\rb",
      "a\u0085b",
      "a\u0000b",
      "a\u001Bb",
      "a\u007Fb",
      " 　 \n ",
      "x".repeat(501),
    ];
    const c0 = await b.contadores(E.tenantId);
    for (const c of malos) {
      const r1 = await atender(asistente, A!.id, m!, { accion: "marcar", comentario: c });
      expect(r1.status, JSON.stringify(c)).toBe(400);
      const r2 = await lote(asistente, { mensajes: [m, n], comentario: c });
      expect(r2.status, JSON.stringify(c)).toBe(400);
    }
    expect(await b.contadores(E.tenantId)).toEqual(c0);
    const largo = `  ${"ñ".repeat(496)}\n<b>  `; // 500 tras recortar
    const ok = await lote(asistente, { mensajes: [m, n], comentario: largo });
    expect(ok.status, ok.text).toBe(200);
    const ev = await b.eventos(m!);
    expect(ev.at(-1).comentario).toBe(largo.trim());
  });

  it("el límite de 500 del comentario cuenta caracteres, no unidades UTF-16 (300 emojis = 300 caracteres)", async () => {
    const asistente = await miembro("asistente");
    const [A] = await clientes(1, "Adv-Emoji");
    await asignar(asistente, [A!.id]);
    const [m] = await b.sembrarLote(E.tenantId, [{ clienteId: A!.id, fecha: f("2026-11-14T12:00:00.000"), categoria: "coactiva" }]);
    const comentario = "\u{1F600}".repeat(300); // 300 caracteres (code points y grafemas); 600 unidades UTF-16
    expect([...comentario]).toHaveLength(300);
    // La BD (CHECK y función: char_length ≤ 500) lo acepta; la API debe aceptarlo igual (D-7: «1 a 500 caracteres»).
    const r = await atender(asistente, A!.id, m!, { accion: "marcar", comentario });
    expect(r.status, r.text).toBe(200);
    expect((await b.eventos(m!)).at(-1)?.comentario).toBe(comentario);
  });
});

// ===========================================================================================================================
describe("Función acotada llamada directo (0060; CA-10)", () => {
  it("otro estudio en el contexto, sin usuario, rol worker, membresía desactivada o escritura directa: siempre rechazado", async () => {
    const [A] = await clientes(1, "Adv-Fn");
    const gF = (await b.clientesMasivos(F.tenantId, 1, { prefijo: "Adv-FnF" }))[0]!;
    const [m] = await b.sembrarLote(E.tenantId, [{ clienteId: A!.id, fecha: f("2026-11-13T10:00:00.000") }]);
    const [mF] = await b.sembrarLote(F.tenantId, [{ clienteId: gF.id, fecha: f("2026-11-13T10:00:00.000") }]);
    const antes = await b.instantanea([m!, mF!]);
    // Usuario de E con el estudio F en el contexto: no es miembro de F.
    expect(await falla(backend.withTenant({ tenantId: F.tenantId, userId: dueno.id }, (tx: any) => tx.query(SQL_FN, [null, [mF], "marcar", "x"])))).toBe("42501");
    // Sin usuario.
    expect(await falla(backend.withTenant({ tenantId: E.tenantId }, (tx: any) => tx.query(SQL_FN, [null, [m], "marcar", null])))).toBe("42501");
    // app.user_id basura (no uuid).
    expect(
      await falla(
        backend.withTenant({ tenantId: E.tenantId, userId: dueno.id }, async (tx: any) => {
          // eslint-disable-next-line sql-crudo/sin-sql-crudo -- ataque: contexto de sesión corrupto antes de llamar a la función
          await tx.query("select set_config('app.user_id', 'no-es-uuid', true)");
          return tx.query(SQL_FN, [null, [m], "marcar", null]);
        }),
      ),
    ).toBe("42501");
    // Mensaje de F pedido desde E (como lote y como ruta individual de un cliente de E): inexistente.
    expect(await falla(backend.withTenant({ tenantId: E.tenantId, userId: dueno.id }, (tx: any) => tx.query(SQL_FN, [null, [mF], "marcar", "x"])))).toBe("P0002");
    expect(await falla(backend.withTenant({ tenantId: E.tenantId, userId: dueno.id }, (tx: any) => tx.query(SQL_FN, [A!.id, [m, mF], "marcar", "x"])))).toBe("P0002");
    // Deshacer en lote (U-3).
    expect(await falla(backend.withTenant({ tenantId: E.tenantId, userId: dueno.id }, (tx: any) => tx.query(SQL_FN, [null, [m], "deshacer", null])))).toBe("22023");
    // El worker no puede ejecutarla.
    expect(await falla(worker.withTenant({ tenantId: E.tenantId, userId: dueno.id }, (tx: any) => tx.query(SQL_FN, [null, [m], "marcar", null])))).toBe("42501");
    // Escritura directa del estado o del historial con el rol del backend.
    expect(
      await falla(backend.withTenant({ tenantId: E.tenantId, userId: dueno.id }, (tx: any) => tx.query("update buzon_mensaje set atendido_en = now(), atendido_por = $2 where id = $1", [m, dueno.id]))),
    ).toBe("42501");
    expect(
      await falla(
        backend.withTenant({ tenantId: E.tenantId, userId: dueno.id }, (tx: any) =>
          tx.query("insert into buzon_atencion (tenant_id, cliente_id, mensaje_id, accion, usuario_id) values ($1, $2, $3, 'atendido', $4)", [E.tenantId, A!.id, m, dueno.id]),
        ),
      ),
    ).toBe("42501");
    // Miembro desactivado con la sesión viva: ni por HTTP ni por la función.
    const ex = await miembro("contador");
    await asignar(ex, [A!.id]);
    await b.sql("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [E.tenantId, ex.id]);
    const r = await lote(ex, { mensajes: [m] });
    expect([401, 403, 404], r.text).toContain(r.status);
    expect(await falla(backend.withTenant({ tenantId: E.tenantId, userId: ex.id }, (tx: any) => tx.query(SQL_FN, [null, [m], "marcar", null])))).toBe("42501");
    expect(await b.instantanea([m!, mF!])).toEqual(antes);
  });
});

// ===========================================================================================================================
describe("Indicador de nuevos (D-9, D-12; CA-8)", () => {
  it("cuenta solo pendientes no históricos de clientes visibles; el filtro no cuela clientes no visibles; sin buzon.ver, 403 y sin campo", async () => {
    const contador = await miembro("contador");
    const [A, Bsin, Oculto] = await clientes(3, "Adv-Ind");
    await asignar(contador, [A!.id, Bsin!.id]);
    const fecha = f("2026-11-19T09:00:00.000");
    await b.sembrarLote(E.tenantId, [
      { clienteId: A!.id, fecha, categoria: "coactiva" }, // crítico pendiente
      { clienteId: A!.id, fecha }, // pendiente
      { clienteId: A!.id, fecha, categoria: "coactiva", leido: true }, // crítico pendiente leído en SUNAT: cuenta igual
      { clienteId: A!.id, fecha, categoria: "coactiva", historico: true }, // crítico histórico: no cuenta
      { clienteId: A!.id, fecha, categoria: "resolucion_multa", atendidoPor: contador.id }, // atendido: no cuenta
      { clienteId: A!.id, fecha, historico: true, atendidoPor: dueno.id }, // histórico atendido: no cuenta
      { clienteId: Bsin!.id, fecha, historico: true },
      { clienteId: Bsin!.id, fecha, atendidoPor: dueno.id },
      { clienteId: Oculto!.id, fecha, categoria: "coactiva" },
    ]);
    const r = await GET(contador, "/clientes");
    expect(r.status, r.text).toBe(200);
    const porId = new Map(r.body.map((c: any) => [c.id, c]));
    expect(porId.has(Oculto!.id)).toBe(false);
    expect((porId.get(A!.id) as any).buzon).toEqual({ nuevos: 3, criticosNuevos: 2 });
    expect((porId.get(Bsin!.id) as any).buzon).toEqual({ nuevos: 0, criticosNuevos: 0 });
    const nuevos = await GET(contador, "/clientes?conMensajesNuevos=1");
    expect(nuevos.status, nuevos.text).toBe(200);
    const ids = nuevos.body.map((c: any) => c.id);
    expect(ids).toContain(A!.id);
    expect(ids).not.toContain(Bsin!.id);
    expect(ids).not.toContain(Oculto!.id);
    for (const q of ["?conMensajesNuevos=1&conMensajesNuevos=1", "?conMensajesNuevos=0", "?conMensajesNuevos=true"]) {
      const x = await GET(contador, `/clientes${q}`);
      expect(x.status, `${q} → ${x.text}`).toBe(400);
    }
    // Sin buzon.ver: el indicador no viaja y el filtro es 403.
    await sinPermiso("contador", "buzon.ver" as any, async () => {
      const s = await GET(contador, "/clientes");
      expect(s.status, s.text).toBe(200);
      for (const c of s.body) expect(c).not.toHaveProperty("buzon");
      const sf = await GET(contador, "/clientes?conMensajesNuevos=1");
      expect(sf.status, sf.text).toBe(403);
    });
  });

  it("fechas en los bordes del día de Lima: desde/hasta inclusivos por día de Lima (UTC-5)", async () => {
    const [A] = await clientes(1, "Adv-Lima");
    const [fin11, ini12, fin12, ini15] = await b.sembrarLote(E.tenantId, [
      { clienteId: A!.id, fecha: "2026-11-12T04:59:59.999999Z" }, // 23:59:59.999999 del 11 en Lima
      { clienteId: A!.id, fecha: "2026-11-12T05:00:00.000000Z" }, // 00:00 del 12
      { clienteId: A!.id, fecha: "2026-11-13T04:59:59.999999Z" }, // fin del 12
      { clienteId: A!.id, fecha: "2026-11-15T05:00:00.000000Z" }, // 00:00 del 15
    ]);
    const ruta = `/clientes/${A!.id}/buzon/mensajes`;
    expect(await recorrer(dueno, `${ruta}?desde=2026-11-11&hasta=2026-11-11`)).toEqual([fin11]);
    expect(await recorrer(dueno, `${ruta}?desde=2026-11-12&hasta=2026-11-12`)).toEqual([fin12, ini12]);
    expect(await recorrer(dueno, `${ruta}?desde=2026-11-13&hasta=2026-11-14`)).toEqual([]);
    expect(await recorrer(dueno, `${ruta}?desde=2026-11-15`)).toEqual([ini15]);
    expect(await recorrer(dueno, `${ruta}?hasta=2026-11-11`)).toEqual([fin11]);
    expect(await recorrer(dueno, `${ruta}?desde=0100-01-01&hasta=9999-12-31`)).toEqual([ini15, fin12, ini12, fin11]);
    // Global (Dueño): misma regla.
    const g = await recorrer(dueno, "/buzon/mensajes?desde=2026-11-12&hasta=2026-11-12", 100);
    expect(g).toContain(ini12);
    expect(g).toContain(fin12);
    expect(g).not.toContain(fin11);
    expect(g).not.toContain(ini15);
  });
});
