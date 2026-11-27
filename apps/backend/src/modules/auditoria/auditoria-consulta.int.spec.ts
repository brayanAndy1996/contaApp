/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 031 (T3, rojo): consulta de auditoría con filtros y `GET /auditoria/opciones` (D-1 a D-6; CA-1 a CA-8; P-5, P-6). PG real.
// Contrato (plan 031, «Contratos: HTTP» y «Decisiones»; lo implementan T7 sobre T5 y T6):
//  - `GET /auditoria?usuarioId&clienteId&accion=a&accion=b&desde=AAAA-MM-DD&hasta=AAAA-MM-DD&cursor`: `auditoria.ver`, `no-store`; sale
//    `{ items, siguiente }` como en 017. Los filtros se combinan con AND en las DOS ramas (auditoría y descifrados) antes de cada LIMIT.
//    Las fechas son de Lima (UTC−05:00): de las 00:00 de `desde` a las 00:00 del día siguiente a `hasta`.
//    Un descifrado no guarda actor: con `usuarioId` nunca sale; con `accion` sin `credencial.descifrada` tampoco (D-4).
//  - Alcance (D-3, P-5): Dueño, Administrador y rol propio global ven todo el estudio; un rol propio asignado ve solo sus clientes (ambas
//    ramas, con y sin filtros) y NO las filas sin cliente; sin asignaciones, nada. Un `clienteId` no visible da el 404 `no_encontrado` de uno
//    inexistente. Sin `auditoria.ver`: 403 `permiso_denegado` en los dos endpoints.
//  - 400 `solicitud_invalida` (CA-7) antes de abrir transacción: UUID mal formado, acción fuera del catálogo, más de 10 o repetidas, fecha
//    inexistente, `desde > hasta`, clave desconocida, arreglos u objetos de `qs`.
//  - `GET /auditoria/opciones?q&clienteId` → `{ miembros: {id, nombre, activo}[], clientes: {id, ruc, razonSocial, archivado}[] }`.
//    Miembros: todos los no eliminados del estudio (activos e inactivos), por nombre. Clientes visibles con el alcance: `q` (1–60) por prefijo
//    de RUC o razón social `ILIKE` con comodines escapados, máx. 20, con archivados; `clienteId` agrega ese cliente si es visible.
// Rojo: los filtros y `/opciones` aún no existen (T7): la consulta con filtros da 400 y `/opciones` 404 de ruta.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ACCIONES_AUDITORIA } from "@contapp/shared";
import { abrirBancoCola, canario, filtrados, type BancoCola } from "../../../test/soporte-credenciales.js";
import { CLAVES_INTERNAS, esNoStore, limpiarAvisosDeEstudios, quitarMembresiaSinRestricciones } from "../../../test/soporte-notificaciones.js";
import { capturarLogs } from "../../../test/soporte.js";
import {
  api,
  de,
  escenario,
  idsDe,
  ordenado,
  qs,
  referencia,
  sembrarDescifradoEn,
  sembrarEn,
  sembrarMasa,
  type Api,
  type Esc,
  type FiltrosQ,
} from "../../../test/soporte-auditoria.js";

vi.setConfig({ testTimeout: 90_000 });

let b: BancoCola;
let h: Api;
const estudios: string[] = [];

beforeAll(async () => {
  b = await abrirBancoCola();
  h = api(b);
});
afterAll(async () => {
  if (b) await limpiarAvisosDeEstudios(estudios);
  await b?.cerrar();
});

const sql = <T = any>(t: string, v?: unknown[]) => b.sql<T>(t, v);
const esc = (): Promise<Esc> => escenario(b, estudios);
const INVALIDA = { codigo: "solicitud_invalida" };

/* ---------------------------------------------------------------------------------------------------------------------------------
 * Datos de referencia (instantes fijos de marzo de 2026, con huso de Lima = UTC−05:00). Más nueva primero:
 *   d2 12/03 11:00 Lima · r4 12/03 10:00 · r3 11/03 10:00 · d1 10/03 13:00 · r6 10/03 12:00 · r5 10/03 11:00 · r2 10/03 10:00 · r1 09/03 10:00
 * --------------------------------------------------------------------------------------------------------------------------------- */
const ORDEN = ["d2", "r4", "r3", "d1", "r6", "r5", "r2", "r1"] as const;
type Clave = (typeof ORDEN)[number];
interface Mundo {
  e: Esc;
  contador: Awaited<ReturnType<Esc["miembro"]>>;
  semilla: Record<Clave, string>;
  ids: string[];
  /** Instante (ISO) de cada semilla, para comprobar `ocurridaEn`. */
  en: Record<Clave, string>;
}
/** r1 A dueño cliente.editado · r2 A contador credencial.guardada · r3 B contador cliente.editado · r4 B dueño periodo.estado_cambiado ·
 *  r5 sin cliente dueño miembro.rol_cambiado · r6 A trabajo (lo lanzó el contador) propuesta.cargada · d1 descifrado de A · d2 descifrado de B. */
async function mundo(): Promise<Mundo> {
  const e = await esc();
  const contador = await e.miembro("contador", "Carlos Contador");
  const t = e.E.tenantId;
  const r1 = await sembrarEn(sql, { tenantId: t, en: "2026-03-09T15:00:00.000Z", usuarioId: e.dueno.id, clienteId: e.A.id, accion: "cliente.editado", datos: { cambios: { razon_social: ["VIEJA SAC", "SAN JUAN SAC"] } } });
  const r2 = await sembrarEn(sql, { tenantId: t, en: "2026-03-10T15:00:00.000Z", usuarioId: contador.id, clienteId: e.A.id, accion: "credencial.guardada", entidad: "credencial", datos: { tipo: "sol" } });
  const r3 = await sembrarEn(sql, { tenantId: t, en: "2026-03-11T15:00:00.000Z", usuarioId: contador.id, clienteId: e.B.id, accion: "cliente.editado", datos: { cambios: { razon_social: ["B1", "B2"] } } });
  const r4 = await sembrarEn(sql, { tenantId: t, en: "2026-03-12T15:00:00.000Z", usuarioId: e.dueno.id, clienteId: e.B.id, accion: "periodo.estado_cambiado", entidad: "periodo", datos: { libro: "compras", periodo: "202610", de: "abierto", a: "cerrado" } });
  const r5 = await sembrarEn(sql, { tenantId: t, en: "2026-03-10T16:00:00.000Z", usuarioId: e.dueno.id, accion: "miembro.rol_cambiado", entidad: "membresia", datos: { de: "contador", a: "admin" } });
  const r6 = await sembrarEn(sql, { tenantId: t, en: "2026-03-10T17:00:00.000Z", actorTipo: "trabajo", usuarioId: contador.id, clienteId: e.A.id, accion: "propuesta.cargada", entidad: "propuesta", entidadId: randomUUID(), datos: { libro: "compras", periodo: "202610", fuente: "sire", filasRecibidas: 12 } });
  const d1 = await sembrarDescifradoEn(sql, { tenantId: t, clienteId: e.A.id, en: "2026-03-10T18:00:00.000Z" });
  const d2 = await sembrarDescifradoEn(sql, { tenantId: t, clienteId: e.B.id, en: "2026-03-12T16:00:00.000Z" });
  const semilla = { r1: r1.id, r2: r2.id, r3: r3.id, r4: r4.id, r5: r5.id, r6: r6.id, d1: d1.id, d2: d2.id };
  const en = { r1: r1.en, r2: r2.en, r3: r3.en, r4: r4.en, r5: r5.en, r6: r6.en, d1: d1.en, d2: d2.en };
  return { e, contador, semilla, ids: Object.values(semilla), en };
}
/** Ids de las semillas con esas claves, más nueva primero. */
const esperadas = (m: Mundo, claves: readonly Clave[]): string[] => ORDEN.filter((c) => claves.includes(c)).map((c) => m.semilla[c]);

/* ================================ CA-1 · cada filtro contra la consulta de referencia ================================ */
describe("CA-1 · filtros solos y combinados iguales a la consulta de referencia (con descifrados)", () => {
  interface Caso {
    nombre: string;
    filtros: (m: Mundo) => FiltrosQ;
    claves: readonly Clave[];
  }
  const DESC = "credencial.descifrada";
  const casos: Caso[] = [
    { nombre: "usuarioId (incluye lo que hizo un trabajo que lanzó, P-6; sin descifrados, D-4)", filtros: (m) => ({ usuarioId: m.contador.id }), claves: ["r6", "r3", "r2"] },
    { nombre: "clienteId (con su descifrado)", filtros: (m) => ({ clienteId: m.e.A.id }), claves: ["d1", "r6", "r2", "r1"] },
    { nombre: "accion única", filtros: () => ({ accion: ["cliente.editado"] }), claves: ["r3", "r1"] },
    { nombre: "dos acciones", filtros: () => ({ accion: ["cliente.editado", "periodo.estado_cambiado"] }), claves: ["r4", "r3", "r1"] },
    { nombre: "solo credencial.descifrada: solo la rama de descifrados", filtros: () => ({ accion: [DESC] }), claves: ["d2", "d1"] },
    { nombre: "credencial.descifrada y otra acción", filtros: () => ({ accion: [DESC, "cliente.editado"] }), claves: ["d2", "r3", "d1", "r1"] },
    { nombre: "solo desde (día de Lima)", filtros: () => ({ desde: "2026-03-10" }), claves: ["d2", "r4", "r3", "d1", "r6", "r5", "r2"] },
    { nombre: "solo hasta (día de Lima incluido)", filtros: () => ({ hasta: "2026-03-10" }), claves: ["d1", "r6", "r5", "r2", "r1"] },
    { nombre: "desde y hasta", filtros: () => ({ desde: "2026-03-10", hasta: "2026-03-11" }), claves: ["r3", "d1", "r6", "r5", "r2"] },
    { nombre: "usuarioId + clienteId", filtros: (m) => ({ usuarioId: m.e.dueno.id, clienteId: m.e.B.id }), claves: ["r4"] },
    { nombre: "clienteId + acciones + desde", filtros: (m) => ({ clienteId: m.e.A.id, accion: [DESC, "propuesta.cargada"], desde: "2026-03-10" }), claves: ["d1", "r6"] },
    { nombre: "usuarioId + credencial.descifrada: vacío (no guarda actor)", filtros: (m) => ({ usuarioId: m.contador.id, accion: [DESC] }), claves: [] },
    { nombre: "los cinco filtros", filtros: (m) => ({ usuarioId: m.contador.id, clienteId: m.e.A.id, accion: ["credencial.guardada", "propuesta.cargada"], desde: "2026-03-10", hasta: "2026-03-10" }), claves: ["r6", "r2"] },
    { nombre: "acción rara sin filas", filtros: () => ({ accion: ["regla.eliminada"] }), claves: [] },
  ];
  it.each(casos)("$nombre", async (caso) => {
    const m = await mundo();
    const f = caso.filtros(m);
    const r = await h.recorrer(m.e.dueno, f);
    expect(de(r.items, m.ids), "las semillas, en orden").toEqual(esperadas(m, caso.claves));
    // Igual a la consulta de referencia sobre las dos tablas (incluye las filas que genera la propia API).
    expect(ordenado(idsDe(r.items))).toEqual(ordenado(await referencia(sql, m.e.E.tenantId, f)));
    expect(new Set(idsDe(r.items)).size).toBe(r.items.length);
    for (const x of r.items) {
      if (f.clienteId !== undefined) expect(x.cliente?.id).toBe(f.clienteId);
      if (f.usuarioId !== undefined) expect(x.accion).not.toBe(DESC);
      if (f.accion !== undefined) expect(f.accion).toContain(x.accion);
    }
    expect(r.texto).not.toContain("tenantId");
  });

  it("una sola `accion` se toma como lista y varias repetidas dan la unión; la salida no cambia (D-5)", async () => {
    const m = await mundo();
    const una = await h.pagina(m.e.dueno, { accion: ["cliente.editado"] });
    const x = una.items.find((y) => y.id === m.semilla.r1)!;
    expect(Object.keys(x).sort()).toEqual(["accion", "actor", "cliente", "datos", "entidad", "entidadId", "id", "objetivo", "ocurridaEn"]);
    expect(x.ocurridaEn).toBe(m.en.r1);
    expect(de(una.items, m.ids)).toEqual(esperadas(m, ["r3", "r1"]));
    const r = await h.get(m.e.dueno, "/auditoria?accion=cliente.editado&accion=propuesta.cargada");
    expect(r.status, r.text).toBe(200);
    expect(de(r.body.items, m.ids)).toEqual(esperadas(m, ["r6", "r3", "r1"]));
    expect(esNoStore(r.headers["cache-control"])).toBe(true);
  });

  it("los 10 códigos de acción distintos del catálogo son válidos (el máximo)", async () => {
    const m = await mundo();
    const diez = ACCIONES_AUDITORIA.slice(0, 10) as string[];
    const r = await h.get(m.e.dueno, `/auditoria${qs({ accion: diez })}`);
    expect(r.status, r.text).toBe(200);
  });

  it("desde y hasta iguales (un solo día de Lima) y un día sin filas", async () => {
    const m = await mundo();
    const dia = await h.pagina(m.e.dueno, { desde: "2026-03-11", hasta: "2026-03-11" });
    expect(de(dia.items, m.ids)).toEqual(esperadas(m, ["r3"]));
    const vacio = await h.pagina(m.e.dueno, { desde: "2026-03-13", hasta: "2026-03-13" });
    expect(de(vacio.items, m.ids)).toEqual([]);
    expect(vacio.siguiente).toBeNull();
  });
});

/* ================================ CA-2 · cursor y bordes ================================ */
describe("CA-2 · cursor con filtros, entre ramas y en los bordes del día de Lima", () => {
  it("con clienteId + acciones de las dos ramas: ni repite ni salta, páginas de 50 y `siguiente` null solo al final", async () => {
    const e = await esc();
    const t = e.E.tenantId;
    const masa = await sembrarMasa(sql, { tenantId: t, clienteId: e.A.id, usuarioId: e.dueno.id, n: 70 });
    const f: FiltrosQ = { clienteId: e.A.id, accion: ["cliente.editado", "credencial.descifrada"], desde: "2026-03-10", hasta: "2026-03-10" };
    const r = await h.recorrer(e.dueno, f);
    const esperado = await referencia(sql, t, f);
    expect(esperado).toHaveLength(140);
    expect(idsDe(r.items)).toEqual(esperado); // orden (instante, id) desc, sin repetir ni saltar
    expect(r.paginas.map((p) => p.length)).toEqual([50, 50, 40]);
    expect(new Set(idsDe(r.items)).size).toBe(140);
    expect(ordenado(idsDe(r.items))).toEqual(ordenado([...masa.auditoria, ...masa.descifrados]));
    // Intercala las dos ramas: la primera página trae filas de las dos.
    const acciones = new Set(r.paginas[0]!.map((x) => x.accion));
    expect(acciones).toEqual(new Set(["cliente.editado", "credencial.descifrada"]));
    // Cada página con `siguiente` salvo la última.
    const p1 = await h.pagina(e.dueno, f);
    expect(typeof p1.siguiente).toBe("string");
    expect(p1.siguiente).not.toMatch(/\d{4}-\d{2}-\d{2}/); // opaco
    const p2 = await h.pagina(e.dueno, { ...f, cursor: p1.siguiente! });
    expect(typeof p2.siguiente).toBe("string");
    const p3 = await h.pagina(e.dueno, { ...f, cursor: p2.siguiente! });
    expect(p3.items).toHaveLength(40);
    expect(p3.siguiente).toBeNull();
  });

  it.each([
    ["solo la rama de auditoría", ["cliente.editado"]],
    ["solo la rama de descifrados", ["credencial.descifrada"]],
  ])("pagina %s con filtros", async (_n, accion) => {
    const e = await esc();
    await sembrarMasa(sql, { tenantId: e.E.tenantId, clienteId: e.A.id, usuarioId: e.dueno.id, n: 60 });
    const f: FiltrosQ = { clienteId: e.A.id, accion };
    const r = await h.recorrer(e.dueno, f);
    expect(idsDe(r.items)).toEqual(await referencia(sql, e.E.tenantId, f));
    expect(r.items).toHaveLength(60);
    expect(r.paginas.map((p) => p.length)).toEqual([50, 10]);
  });

  it("con exactamente 50 filas del filtro, `siguiente` es null; con 51, hay otra página de 1", async () => {
    const e = await esc();
    const t = e.E.tenantId;
    await sembrarMasa(sql, { tenantId: t, clienteId: e.A.id, usuarioId: e.dueno.id, n: 50 });
    await sembrarMasa(sql, { tenantId: t, clienteId: e.B.id, usuarioId: e.dueno.id, n: 51 });
    const a = await h.pagina(e.dueno, { clienteId: e.A.id, accion: ["cliente.editado"] });
    expect(a.items).toHaveLength(50);
    expect(a.siguiente).toBeNull();
    const b51 = await h.pagina(e.dueno, { clienteId: e.B.id, accion: ["cliente.editado"] });
    expect(b51.items).toHaveLength(50);
    expect(typeof b51.siguiente).toBe("string");
    const resto = await h.pagina(e.dueno, { clienteId: e.B.id, accion: ["cliente.editado"], cursor: b51.siguiente! });
    expect(resto.items).toHaveLength(1);
    expect(resto.siguiente).toBeNull();
    // El mismo corte con el filtro de la otra rama.
    const d = await h.pagina(e.dueno, { clienteId: e.A.id, accion: ["credencial.descifrada"] });
    expect(d.items).toHaveLength(50);
    expect(d.siguiente).toBeNull();
  });

  it("bordes de milisegundo de `desde` y `hasta` (Lima) en las dos ramas", async () => {
    const e = await esc();
    const t = e.E.tenantId;
    const aud = (en: string) => sembrarEn(sql, { tenantId: t, en, usuarioId: e.dueno.id, clienteId: e.A.id, accion: "cliente.editado" });
    const des = (en: string) => sembrarDescifradoEn(sql, { tenantId: t, clienteId: e.A.id, en });
    // Día 2026-03-10 de Lima = [2026-03-10T05:00:00.000Z, 2026-03-11T05:00:00.000Z).
    const antesA = await aud("2026-03-10T04:59:59.999Z");
    const inicioA = await aud("2026-03-10T05:00:00.000Z");
    const finA = await aud("2026-03-11T04:59:59.999Z");
    const despuesA = await aud("2026-03-11T05:00:00.000Z");
    const antesD = await des("2026-03-10T04:59:59.999Z");
    const inicioD = await des("2026-03-10T05:00:00.000Z");
    const finD = await des("2026-03-11T04:59:59.999Z");
    const despuesD = await des("2026-03-11T05:00:00.000Z");
    const todos = [antesA, inicioA, finA, despuesA, antesD, inicioD, finD, despuesD].map((x) => x.id);
    const r = await h.recorrer(e.dueno, { clienteId: e.A.id, desde: "2026-03-10", hasta: "2026-03-10" });
    expect(de(r.items, todos).sort()).toEqual([inicioA.id, finA.id, inicioD.id, finD.id].sort());
    const salida = new Map(r.items.map((x) => [x.id, x.ocurridaEn]));
    expect(salida.get(inicioA.id)).toBe("2026-03-10T05:00:00.000Z");
    expect(salida.get(finA.id)).toBe("2026-03-11T04:59:59.999Z");
    expect(salida.get(inicioD.id)).toBe("2026-03-10T05:00:00.000Z");
    expect(salida.get(finD.id)).toBe("2026-03-11T04:59:59.999Z");
    // Cada borde con cada filtro de fecha por separado.
    const soloDesde = await h.recorrer(e.dueno, { clienteId: e.A.id, desde: "2026-03-10" });
    expect(de(soloDesde.items, todos).sort()).toEqual([inicioA.id, finA.id, despuesA.id, inicioD.id, finD.id, despuesD.id].sort());
    const soloHasta = await h.recorrer(e.dueno, { clienteId: e.A.id, hasta: "2026-03-10" });
    expect(de(soloHasta.items, todos).sort()).toEqual([antesA.id, inicioA.id, finA.id, antesD.id, inicioD.id, finD.id].sort());
    // El día siguiente empieza justo donde acaba el anterior: ninguna fila queda sin día ni en dos.
    const sig = await h.recorrer(e.dueno, { clienteId: e.A.id, desde: "2026-03-11", hasta: "2026-03-11" });
    expect(de(sig.items, todos).sort()).toEqual([despuesA.id, despuesD.id].sort());
  });
});

/* ================================ CA-3 · HU-39: historial de un cliente ================================ */
describe("CA-3 (HU-39) · el historial de un cliente", () => {
  it("con clienteId salen los cambios con su antes → después, el estado de periodo, el tipo de asignación, las credenciales con autor, el descifrado como Sistema y la compra; sin cliente, no", async () => {
    const e = await esc();
    const t = e.E.tenantId;
    const ana = await e.miembro("contador", "Ana Contadora");
    const objetivo = await e.miembro("lectura", "Beto Objetivo");
    const sembrar = (en: string, accion: string, datos: Record<string, unknown>, usuarioId: string | null = e.dueno.id, entidad = "cliente") =>
      sembrarEn(sql, { tenantId: t, en, usuarioId, clienteId: e.A.id, accion, entidad, datos });
    const edit = await sembrar("2026-03-10T10:00:00.000Z", "cliente.editado", { cambios: { razon_social: ["VIEJA SAC", "SAN JUAN SAC"], regimen: ["rer", "rg"] } });
    const periodo = await sembrar("2026-03-10T11:00:00.000Z", "periodo.estado_cambiado", { libro: "compras", periodo: "202610", de: "abierto", a: "cerrado" }, ana.id, "periodo");
    const tipo = await sembrar("2026-03-10T12:00:00.000Z", "asignacion.tipo_cambiado", { usuarioId: objetivo.id, de: "colaborador", a: "responsable" }, e.dueno.id, "asignacion");
    const guardada = await sembrar("2026-03-10T13:00:00.000Z", "credencial.guardada", { tipo: "sol" }, ana.id, "credencial");
    const verificada = await sembrar("2026-03-10T14:00:00.000Z", "credencial.verificada", { tipo: "sol" }, ana.id, "credencial");
    const invalidada = await sembrar("2026-03-10T15:00:00.000Z", "credencial.invalidada", { tipo: "sire_api" }, ana.id, "credencial");
    const compra = await sembrar("2026-03-10T16:00:00.000Z", "compra.operacion", { tipo: "clasificar", periodo: "202610", filas: 12, referenciaId: randomUUID() }, ana.id, "compra_operacion");
    const desc = await sembrarDescifradoEn(sql, { tenantId: t, clienteId: e.A.id, en: "2026-03-10T17:00:00.000Z", tipo: "sire_api", motivo: "sire.propuesta.descargar", resultado: "ok" });
    const sinCliente = await sembrarEn(sql, { tenantId: t, en: "2026-03-10T18:00:00.000Z", usuarioId: e.dueno.id, accion: "miembro.rol_cambiado", entidad: "membresia", datos: { de: "contador", a: "admin" } });
    const deB = await sembrarEn(sql, { tenantId: t, en: "2026-03-10T19:00:00.000Z", usuarioId: e.dueno.id, clienteId: e.B.id, accion: "cliente.editado", datos: { cambios: { razon_social: ["X", "Y"] } } });
    const r = await h.recorrer(e.dueno, { clienteId: e.A.id });
    const por = new Map(r.items.map((x) => [x.id, x]));
    expect(por.get(edit.id)).toMatchObject({ accion: "cliente.editado", datos: { cambios: { razon_social: ["VIEJA SAC", "SAN JUAN SAC"], regimen: ["rer", "rg"] } }, actor: { tipo: "usuario", autor: { id: e.dueno.id, activo: true } } });
    expect(por.get(periodo.id)).toMatchObject({ accion: "periodo.estado_cambiado", datos: { periodo: "202610", de: "abierto", a: "cerrado" } });
    expect(por.get(tipo.id)).toMatchObject({ accion: "asignacion.tipo_cambiado", datos: { de: "colaborador", a: "responsable" } });
    for (const x of [guardada, verificada, invalidada]) expect(por.get(x.id)).toMatchObject({ actor: { tipo: "usuario", autor: { id: ana.id, nombre: "Ana Contadora", activo: true } }, cliente: { id: e.A.id } });
    expect(por.get(invalidada.id)!.datos).toEqual({ tipo: "sire_api" });
    expect(por.get(compra.id)).toMatchObject({ accion: "compra.operacion", datos: { tipo: "clasificar", periodo: "202610", filas: 12 } });
    expect(por.get(desc.id)).toMatchObject({ accion: "credencial.descifrada", actor: { tipo: "sistema", autor: null, trabajoId: null }, datos: { tipo: "sire_api", motivo: "sire.propuesta.descargar", resultado: "ok" } });
    expect(por.has(sinCliente.id), "sin cliente no sale").toBe(false);
    expect(por.has(deB.id), "de otro cliente no sale").toBe(false);
    expect(r.items.every((x) => x.cliente?.id === e.A.id)).toBe(true);
    // Más nueva primero.
    expect(de(r.items, [edit.id, periodo.id, tipo.id, guardada.id, verificada.id, invalidada.id, compra.id, desc.id])).toEqual([desc.id, compra.id, invalidada.id, verificada.id, guardada.id, tipo.id, periodo.id, edit.id]);
  });

  it("editar un cliente por la API aparece primero en su historial, con el de → a de la razón social", async () => {
    const e = await esc();
    const antes = await h.pagina(e.dueno, { clienteId: e.A.id });
    const editar = await b.c.p.b.llamar(e.dueno, "PATCH", `/clientes/${e.A.id}`, { razonSocial: "RAZON NUEVA 031 SAC" });
    expect(editar.status, editar.text).toBe(200);
    const despues = await h.pagina(e.dueno, { clienteId: e.A.id });
    const nueva = despues.items.filter((x) => !idsDe(antes.items).includes(x.id));
    expect(nueva.map((x) => x.accion)).toEqual(["cliente.editado"]);
    expect(despues.items[0]!.id).toBe(nueva[0]!.id);
    expect(nueva[0]!.datos).toEqual({ cambios: { razon_social: [e.A.razonSocial, "RAZON NUEVA 031 SAC"] } });
    expect(nueva[0]!.actor).toMatchObject({ tipo: "usuario", autor: { id: e.dueno.id } });
    expect(nueva[0]!.cliente).toMatchObject({ id: e.A.id });
  });
});

/* ================================ CA-4 · alcance ================================ */
describe("CA-4 · alcance de la auditoría (D-3, P-5)", () => {
  /** Estudio con A (responsable), C (colaborador) y B (sin asignar); filas de las dos ramas en los tres y una sin cliente. */
  async function conAsignado() {
    const m = await mundo();
    const C = await b.c.sembrar(m.e.E.tenantId, { razonSocial: `COLABORADOR SAC ${randomUUID().slice(0, 6)}` });
    const asig = await m.e.conRolPropio("asignado");
    await b.c.p.b.asignar(m.e.E.tenantId, m.e.A.id, asig.id, "responsable");
    await b.c.p.b.asignar(m.e.E.tenantId, C.id, asig.id, "colaborador");
    const rC = await sembrarEn(sql, { tenantId: m.e.E.tenantId, en: "2026-03-10T20:00:00.000Z", usuarioId: m.e.dueno.id, clienteId: C.id, accion: "cliente.editado" });
    const dC = await sembrarDescifradoEn(sql, { tenantId: m.e.E.tenantId, clienteId: C.id, en: "2026-03-10T21:00:00.000Z" });
    return { m, asig, C, rC, dC, visibles: [m.e.A.id, C.id] };
  }

  it("sin filtros: el rol propio asignado ve solo sus clientes en ambas ramas y nada sin cliente (P-5)", async () => {
    const { m, asig, rC, dC, visibles } = await conAsignado();
    const r = await h.recorrer(asig);
    expect(de(r.items, m.ids)).toEqual(esperadas(m, ["d1", "r6", "r2", "r1"]));
    expect(de(r.items, [rC.id, dC.id]).sort()).toEqual([rC.id, dC.id].sort());
    expect(r.items.every((x) => x.cliente !== null && visibles.includes(x.cliente.id))).toBe(true);
    expect(ordenado(idsDe(r.items))).toEqual(ordenado(await referencia(sql, m.e.E.tenantId, {}, visibles)));
    expect(r.texto).not.toContain(m.e.B.razonSocial);
    expect(r.texto).not.toContain(m.e.B.ruc);
  });

  it.each([
    ["usuarioId", (m: Mundo) => ({ usuarioId: m.contador.id })],
    ["acción de la rama de auditoría", () => ({ accion: ["cliente.editado"] })],
    ["acción de descifrados", () => ({ accion: ["credencial.descifrada"] })],
    ["fechas", () => ({ desde: "2026-03-10", hasta: "2026-03-12" })],
    ["clienteId asignado", (m: Mundo) => ({ clienteId: m.e.A.id })],
    ["todos a la vez", (m: Mundo) => ({ usuarioId: m.contador.id, clienteId: m.e.A.id, accion: ["credencial.guardada", "propuesta.cargada"], desde: "2026-03-10", hasta: "2026-03-10" })],
  ] as const)("con filtro de %s: el alcance sigue aplicando en las dos ramas", async (_n, filtros) => {
    const { m, asig, visibles } = await conAsignado();
    const f = (filtros as (m: Mundo) => FiltrosQ)(m);
    const r = await h.recorrer(asig, f);
    expect(ordenado(idsDe(r.items))).toEqual(ordenado(await referencia(sql, m.e.E.tenantId, f, visibles)));
    expect(r.items.every((x) => x.cliente !== null && visibles.includes(x.cliente.id))).toBe(true);
    expect(de(r.items, [m.semilla.r3, m.semilla.r4, m.semilla.r5, m.semilla.d2]), "B y lo sin cliente nunca").toEqual([]);
  });

  it("un clienteId no asignado, de otro estudio o inexistente da el mismo 404 no_encontrado", async () => {
    const { m, asig } = await conAsignado();
    const otro = await esc();
    const resp = [m.e.B.id, otro.A.id, randomUUID()].map((id) => h.get(asig, `/auditoria${qs({ clienteId: id })}`));
    for (const r of await Promise.all(resp)) {
      expect(r.status, r.text).toBe(404);
      expect(r.body).toEqual({ codigo: "no_encontrado" });
    }
    const r = await h.get(asig, `/auditoria${qs({ clienteId: m.e.B.id, accion: ["cliente.editado"], desde: "2026-03-10" })}`);
    expect(r.status).toBe(404);
    expect(r.text).not.toContain(m.e.B.razonSocial);
  });

  it("pagina con alcance asignado: solo sus clientes, ambas ramas, sin repetir ni saltar", async () => {
    const e = await esc();
    const asig = await e.conRolPropio("asignado");
    await b.c.p.b.asignar(e.E.tenantId, e.A.id, asig.id, "responsable");
    await sembrarMasa(sql, { tenantId: e.E.tenantId, clienteId: e.A.id, usuarioId: e.dueno.id, n: 60 });
    await sembrarMasa(sql, { tenantId: e.E.tenantId, clienteId: e.B.id, usuarioId: e.dueno.id, n: 60 });
    const f: FiltrosQ = { accion: ["cliente.editado", "credencial.descifrada"] };
    const r = await h.recorrer(asig, f);
    expect(idsDe(r.items)).toEqual(await referencia(sql, e.E.tenantId, f, [e.A.id]));
    expect(r.items).toHaveLength(120);
    expect(r.items.every((x) => x.cliente.id === e.A.id)).toBe(true);
    expect(r.paginas.map((p) => p.length)).toEqual([50, 50, 20]);
  });

  it("sin asignaciones: lista vacía con y sin filtros, y 404 con cualquier clienteId", async () => {
    const m = await mundo();
    const solo = await m.e.conRolPropio("asignado");
    for (const f of [{}, { usuarioId: m.contador.id }, { accion: ["credencial.descifrada"] }, { desde: "2026-03-01", hasta: "2026-03-31" }] as FiltrosQ[]) {
      const p = await h.pagina(solo, f);
      expect(p.items, JSON.stringify(f)).toEqual([]);
      expect(p.siguiente).toBeNull();
    }
    const r = await h.get(solo, `/auditoria${qs({ clienteId: m.e.A.id })}`);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ codigo: "no_encontrado" });
  });

  it("al quitarle la asignación durante la sesión, la siguiente consulta ya no ve ese cliente (404 y vacío)", async () => {
    const m = await mundo();
    const asig = await m.e.conRolPropio("asignado");
    await b.c.p.b.asignar(m.e.E.tenantId, m.e.A.id, asig.id, "responsable");
    const antes = await h.pagina(asig, { clienteId: m.e.A.id });
    expect(de(antes.items, m.ids)).toEqual(esperadas(m, ["d1", "r6", "r2", "r1"]));
    const quitar = await b.c.p.b.llamar(m.e.dueno, "DELETE", `/clientes/${m.e.A.id}/asignaciones/${asig.id}`);
    expect(quitar.status, quitar.text).toBeLessThan(300);
    const r = await h.get(asig, `/auditoria${qs({ clienteId: m.e.A.id })}`);
    expect(r.status, r.text).toBe(404);
    const sin = await h.pagina(asig);
    expect(sin.items).toEqual([]);
  });

  it("Dueño, Administrador y rol propio global ven todo el estudio, también lo que no tiene cliente", async () => {
    const m = await mundo();
    const admin = await m.e.miembro("admin");
    const global = await m.e.conRolPropio("global");
    const esperado = ordenado(await referencia(sql, m.e.E.tenantId, {}, null));
    for (const a of [m.e.dueno, admin, global]) {
      const r = await h.recorrer(a);
      expect(ordenado(idsDe(r.items)), a.rol).toEqual(esperado);
      expect(de(r.items, m.ids)).toEqual(esperadas(m, [...ORDEN]));
      const f = await h.pagina(a, { clienteId: m.e.B.id });
      expect(de(f.items, m.ids)).toEqual(esperadas(m, ["d2", "r4", "r3"]));
    }
  });
});

/* ================================ CA-5 · dos estudios ================================ */
describe("CA-5 (RNF-001) · dos estudios", () => {
  it("ni ids ajenos ni filtros con datos del otro estudio devuelven filas del otro", async () => {
    const m = await mundo();
    const otro = await mundo();
    const dueno = m.e.dueno;
    // Un clienteId del otro estudio es inexistente aquí: 404.
    const cli = await h.get(dueno, `/auditoria${qs({ clienteId: otro.e.A.id })}`);
    expect(cli.status, cli.text).toBe(404);
    expect(cli.body).toEqual({ codigo: "no_encontrado" });
    expect(cli.text).not.toContain(otro.e.A.razonSocial);
    // Un usuarioId del otro estudio no es un error: la RLS lo acota y no hay filas.
    const usr = await h.recorrer(dueno, { usuarioId: otro.e.dueno.id });
    expect(usr.items).toEqual([]);
    const usr2 = await h.recorrer(dueno, { usuarioId: otro.contador.id, accion: ["credencial.guardada"] });
    expect(usr2.items).toEqual([]);
    // Los descifrados del otro estudio no salen ni con su clienteId (404) ni con acción de descifrado.
    const desc = await h.recorrer(dueno, { accion: ["credencial.descifrada"] });
    expect(de(desc.items, otro.ids)).toEqual([]);
    expect(de(desc.items, m.ids)).toEqual(esperadas(m, ["d2", "d1"]));
    const todo = await h.recorrer(dueno, { desde: "2026-03-01", hasta: "2026-03-31" });
    expect(de(todo.items, otro.ids)).toEqual([]);
    for (const marca of [otro.e.E.tenantId, otro.e.dueno.id, otro.e.A.id, otro.e.A.ruc, otro.e.A.razonSocial, otro.contador.id]) expect(todo.texto, marca).not.toContain(marca);
    // Con el X-Estudio del otro no se llega al negocio.
    const cruzada = await b.c.p.b.llamar(dueno, "GET", `/auditoria${qs({ clienteId: otro.e.A.id })}`, undefined, { estudio: otro.e.E.tenantId });
    expect([403, 404, 409]).toContain(cruzada.status);
    expect(cruzada.text).not.toContain(otro.e.A.razonSocial);
    // Y a la inversa: el otro estudio sigue viendo lo suyo.
    const deOtro = await h.recorrer(otro.e.dueno, { clienteId: otro.e.A.id });
    expect(de(deOtro.items, otro.ids)).toEqual(esperadas(otro, ["d1", "r6", "r2", "r1"]));
    expect(de(deOtro.items, m.ids)).toEqual([]);
  });
});

/* ================================ CA-6 · permisos ================================ */
describe("CA-6 · sin auditoria.ver, los dos endpoints dan 403", () => {
  const RUTAS = (e: Esc): string[] => [
    "/auditoria",
    `/auditoria${qs({ clienteId: e.A.id })}`,
    `/auditoria${qs({ accion: ["cliente.editado"], desde: "2026-03-10" })}`,
    "/auditoria/opciones",
    `/auditoria/opciones${qs({ q: "SAN" })}`,
  ];

  it("tabla: con permiso 200 (Dueño, Administrador, rol propio global y asignado); sin él 403 permiso_denegado sin datos", async () => {
    const m = await mundo();
    const e = m.e;
    const admin = await e.miembro("admin");
    const conGlobal = await e.conRolPropio("global");
    const conAsignado = await e.conRolPropio("asignado");
    const sinGlobal = await e.conRolPropio("global", ["clientes.ver", "buzon.ver"], true);
    const sinAsignado = await e.conRolPropio("asignado", ["clientes.ver"], true);
    const contador = await e.miembro("contador");
    const asistente = await e.miembro("asistente");
    const lectura = await e.miembro("lectura");
    for (const [a, etiqueta] of [[e.dueno, "dueño"], [admin, "admin"], [conGlobal, "rol global con auditoria.ver"], [conAsignado, "rol asignado con auditoria.ver"]] as const) {
      for (const ruta of RUTAS(e)) {
        const r = await h.get(a, ruta);
        // El asignado sin asignaciones recibe 404 con un clienteId y 200 sin él: nunca 403.
        expect(r.status, `${etiqueta} ${ruta}: ${r.text}`).not.toBe(403);
        if (etiqueta !== "rol asignado con auditoria.ver" || !ruta.includes("clienteId")) expect(r.status, `${etiqueta} ${ruta}: ${r.text}`).toBe(200);
        expect(esNoStore(r.headers["cache-control"]), `${etiqueta} ${ruta}`).toBe(true);
      }
    }
    for (const [a, etiqueta] of [[sinGlobal, "rol global sin auditoria.ver"], [sinAsignado, "rol asignado sin auditoria.ver"], [contador, "contador"], [asistente, "asistente"], [lectura, "lectura"]] as const) {
      for (const ruta of RUTAS(e)) {
        const r = await h.get(a, ruta);
        expect(r.status, `${etiqueta} ${ruta}: ${r.text}`).toBe(403);
        expect(r.body, `${etiqueta} ${ruta}`).toEqual({ codigo: "permiso_denegado" });
        expect(r.text).not.toContain(e.A.razonSocial);
        expect(r.text).not.toContain("credencial.descifrada");
        expect(r.text).not.toContain(e.dueno.id);
      }
    }
  });

  it("el permiso se evalúa antes que los filtros: sin él, una consulta inválida es 403 y no 400", async () => {
    const e = await esc();
    const lectura = await e.miembro("lectura");
    for (const ruta of ["/auditoria?usuarioId=no-es-uuid", "/auditoria?foo=1", "/auditoria?desde=2026-02-30", "/auditoria/opciones?q=", "/auditoria/opciones?foo=1"]) {
      const r = await h.get(lectura, ruta);
      expect(r.status, `${ruta}: ${r.text}`).toBe(403);
      expect(r.body).toEqual({ codigo: "permiso_denegado" });
    }
  });

  it("sin sesión, los dos endpoints dan 401 sesion_invalida", async () => {
    for (const ruta of ["/auditoria", `/auditoria${qs({ accion: ["cliente.editado"] })}`, "/auditoria/opciones", "/auditoria/opciones?q=SAN"]) {
      const r = await b.c.p.b.h.pedir({ ruta });
      expect(r.status, ruta).toBe(401);
      expect(r.body).toEqual({ codigo: "sesion_invalida" });
    }
  });
});

/* ================================ CA-7 · consulta estricta ================================ */
describe("CA-7 · 400 solicitud_invalida sin tocar la BD", () => {
  const U = randomUUID();
  const DIEZ = ACCIONES_AUDITORIA.slice(0, 10) as string[];
  const ONCE = ACCIONES_AUDITORIA.slice(0, 11) as string[];
  const crudas: [string, string][] = [
    ["usuarioId no UUID", `usuarioId=no-es-uuid`],
    ["usuarioId vacío", `usuarioId=`],
    ["usuarioId con un carácter de más", `usuarioId=${U}x`],
    ["clienteId numérico", `clienteId=123`],
    ["clienteId con comilla y punto y coma", `clienteId=${encodeURIComponent(`${U}';--`)}`],
    ["usuarioId con inyección", `usuarioId=${encodeURIComponent("' OR 1=1; --")}`],
    ["usuarioId repetido (arreglo)", `usuarioId=${U}&usuarioId=${randomUUID()}`],
    ["usuarioId[] (arreglo de qs)", `usuarioId[]=${U}`],
    ["usuarioId[a] (objeto de qs)", `usuarioId[a]=${U}`],
    ["clienteId[$ne] (objeto de qs)", `clienteId[$ne]=${U}`],
    ["acción fuera del catálogo", `accion=cliente.inventada`],
    ["acción con punto y coma", `accion=${encodeURIComponent("cliente.editado;drop table auditoria")}`],
    ["acción con comillas", `accion=${encodeURIComponent("' OR '1'='1")}`],
    ["acción vacía", `accion=`],
    ["11 acciones", ONCE.map((a) => `accion=${a}`).join("&")],
    ["acción repetida", `accion=cliente.editado&accion=cliente.editado`],
    ["accion[a] (objeto de qs)", `accion[a]=cliente.editado`],
    ["fecha inexistente 2026-02-30", `desde=2026-02-30`],
    ["hasta inexistente 2026-02-30", `hasta=2026-02-30`],
    ["mes 13", `desde=2026-13-01`],
    ["sin ceros", `desde=2026-2-3`],
    ["con hora", `desde=${encodeURIComponent("2026-03-10T00:00:00Z")}`],
    ["texto", `hasta=hoy`],
    ["desde repetido", `desde=2026-03-10&desde=2026-03-11`],
    ["desde > hasta", `desde=2026-03-11&hasta=2026-03-10`],
    ["clave desconocida", `foo=1`],
    ["tenantId", `tenantId=${U}`],
    ["limite", `limite=10`],
    ["orden", `orden=asc`],
    ["cursor repetido", `cursor=a&cursor=b`],
    ["cursor mal formado", `cursor=!!!`],
  ];

  it.each(crudas)("GET /auditoria con %s → 400", async (_n, consulta) => {
    const e = await esc();
    const r = await h.get(e.dueno, `/auditoria?${consulta}`);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual(INVALIDA);
  });

  it("un filtro inválido gana al 404: valida antes de abrir transacción (clienteId inexistente + fecha inexistente = 400)", async () => {
    const e = await esc();
    const asig = await e.conRolPropio("asignado");
    for (const a of [e.dueno, asig]) {
      for (const c of [`clienteId=${randomUUID()}&desde=2026-02-30`, `clienteId=${randomUUID()}&accion=cliente.inventada`, `clienteId=${e.B.id}&usuarioId=no-es-uuid`, `clienteId=${e.B.id}&foo=1`]) {
        const r = await h.get(a, `/auditoria?${c}`);
        expect(r.status, `${a.rol} ${c}: ${r.text}`).toBe(400);
        expect(r.body).toEqual(INVALIDA);
      }
    }
  });

  it("comillas, punto y coma y comodines no alteran la consulta: las tablas y la lista quedan intactas", async () => {
    const m = await mundo();
    const t = m.e.E.tenantId;
    const total = async () => Number((await sql("select (select count(*) from auditoria where tenant_id = $1) + (select count(*) from auditoria_descifrado where tenant_id = $1) as n", [t]))[0].n);
    const antes = await total();
    const r0 = await h.recorrer(m.e.dueno);
    for (const [, consulta] of crudas) await h.get(m.e.dueno, `/auditoria?${consulta}`);
    for (const q of ["%", "_", "'; drop table auditoria; --", "\\", "a'b\"c;"]) {
      const r = await h.opciones(m.e.dueno, { q });
      expect(r.status, `${q}: ${r.text}`).toBe(200);
    }
    expect(await total()).toBe(antes);
    expect(await sql("select to_regclass('auditoria') is not null as ok")).toEqual([{ ok: true }]);
    const r1 = await h.recorrer(m.e.dueno);
    expect(idsDe(r1.items)).toEqual(idsDe(r0.items));
  });

  it("los casos válidos del borde responden 200: 10 acciones, desde = hasta, solo desde, solo hasta y UUID válidos", async () => {
    const m = await mundo();
    for (const f of [{ accion: DIEZ }, { desde: "2026-03-10", hasta: "2026-03-10" }, { desde: "2026-02-28" }, { hasta: "2026-02-28" }, { usuarioId: m.contador.id, clienteId: m.e.A.id }] as FiltrosQ[]) {
      const r = await h.get(m.e.dueno, `/auditoria${qs({ ...f })}`);
      expect(r.status, `${JSON.stringify(f)}: ${r.text}`).toBe(200);
      expect(Object.keys(r.body).sort()).toEqual(["items", "siguiente"]);
    }
    const bisiesto = await h.get(m.e.dueno, "/auditoria?desde=2028-02-29&hasta=2028-02-29");
    expect(bisiesto.status, bisiesto.text).toBe(200);
    const noBisiesto = await h.get(m.e.dueno, "/auditoria?desde=2027-02-29");
    expect(noBisiesto.status).toBe(400);
  });

  it.each([
    ["q vacía", "q="],
    ["q de 61 caracteres", `q=${"a".repeat(61)}`],
    ["q repetida", "q=a&q=b"],
    ["q[] (arreglo)", "q[]=a"],
    ["q[a] (objeto)", "q[a]=a"],
    ["clienteId no UUID", "clienteId=no-es-uuid"],
    ["clienteId repetido", `clienteId=${U}&clienteId=${U}`],
    ["clave desconocida", "foo=1"],
    ["tenantId", `tenantId=${U}`],
    ["limite", "limite=10"],
    ["usuarioId (no es de este endpoint)", `usuarioId=${U}`],
  ])("GET /auditoria/opciones con %s → 400", async (_n, consulta) => {
    const e = await esc();
    const r = await h.get(e.dueno, `/auditoria/opciones?${consulta}`);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual(INVALIDA);
  });
});

/* ================================ /auditoria/opciones ================================ */
describe("D-6 · GET /auditoria/opciones", () => {
  it("miembros: todos los no eliminados del estudio (activos e inactivos), por nombre, con la forma exacta y no-store", async () => {
    const e = await esc();
    const otro = await esc();
    await sql("update usuario set nombre = 'Dueño D' where id = $1", [e.dueno.id]);
    const ana = await e.miembro("contador", "Ana A");
    const beto = await e.miembro("lectura", "Beto B");
    const carla = await e.miembro("asistente", "Carla C");
    const fuera = await e.miembro("contador", "Zoe Eliminada");
    await sql("update membresia set desactivada_en = now() where tenant_id = $1 and usuario_id = $2", [e.E.tenantId, beto.id]);
    await quitarMembresiaSinRestricciones(e.E.tenantId, fuera.id);
    await sql("update usuario set nombre = 'Zoe Secreta Ajena' where id = $1", [otro.dueno.id]);
    const r = await h.opciones(e.dueno);
    expect(r.status, r.text).toBe(200);
    expect(esNoStore(r.headers["cache-control"])).toBe(true);
    expect(Object.keys(r.body).sort()).toEqual(["clientes", "miembros"]);
    expect(r.body.miembros).toEqual([
      { id: ana.id, nombre: "Ana A", activo: true },
      { id: beto.id, nombre: "Beto B", activo: false },
      { id: carla.id, nombre: "Carla C", activo: true },
      { id: e.dueno.id, nombre: "Dueño D", activo: true },
    ]);
    expect(r.text).not.toContain("Zoe Eliminada");
    expect(r.text).not.toContain("Zoe Secreta Ajena");
    for (const clave of CLAVES_INTERNAS) expect(r.text, clave).not.toContain(clave);
    for (const x of r.body.miembros) expect(Object.keys(x).sort()).toEqual(["activo", "id", "nombre"]);
  });

  it("los miembros salen completos también para un rol propio asignado (no dependen del alcance de clientes)", async () => {
    const e = await esc();
    const ana = await e.miembro("contador", "Ana A");
    const asig = await e.conRolPropio("asignado");
    const r = await h.opciones(asig);
    expect(r.status, r.text).toBe(200);
    expect(r.body.miembros.map((x: any) => x.id)).toEqual(expect.arrayContaining([e.dueno.id, ana.id, asig.id]));
  });

  it("clientes: por prefijo de RUC y por razón social sin distinguir mayúsculas; incluye archivados; forma exacta", async () => {
    const e = await esc();
    const arch = await b.c.sembrar(e.E.tenantId, { razonSocial: "SANTIAGO ARCHIVADO SAC", archivado: true });
    const porRuc = await h.opciones(e.dueno, { q: e.A.ruc });
    expect(porRuc.status, porRuc.text).toBe(200);
    expect(porRuc.body.clientes).toEqual([{ id: e.A.id, ruc: e.A.ruc, razonSocial: e.A.razonSocial, archivado: false }]);
    const prefijo = await h.opciones(e.dueno, { q: e.A.ruc.slice(0, 5) });
    expect(idsDe(prefijo.body.clientes)).toContain(e.A.id);
    expect(prefijo.body.clientes.every((c: any) => c.ruc.startsWith(e.A.ruc.slice(0, 5)) || c.razonSocial.toLowerCase().startsWith(e.A.ruc.slice(0, 5)))).toBe(true);
    const porNombre = await h.opciones(e.dueno, { q: "san ju" });
    expect(porNombre.body.clientes.map((c: any) => c.id)).toEqual([e.A.id]);
    const santa = await h.opciones(e.dueno, { q: "SANT" });
    expect(ordenado(santa.body.clientes.map((c: any) => c.id))).toEqual(ordenado([e.B.id, arch.id]));
    expect(santa.body.clientes.find((c: any) => c.id === arch.id)).toEqual({ id: arch.id, ruc: arch.ruc, razonSocial: "SANTIAGO ARCHIVADO SAC", archivado: true });
    expect(santa.body.clientes.find((c: any) => c.id === e.B.id).archivado).toBe(false);
    for (const c of santa.body.clientes) expect(Object.keys(c).sort()).toEqual(["archivado", "id", "razonSocial", "ruc"]);
    const ninguno = await h.opciones(e.dueno, { q: "ZZZNOEXISTE" });
    expect(ninguno.body.clientes).toEqual([]);
  });

  it("clientes: como máximo 20", async () => {
    const e = await esc();
    for (let i = 0; i < 25; i++) await b.c.sembrar(e.E.tenantId, { razonSocial: `LOTE31 ${String(i).padStart(2, "0")} SAC` });
    const r = await h.opciones(e.dueno, { q: "LOTE31" });
    expect(r.status, r.text).toBe(200);
    expect(r.body.clientes).toHaveLength(20);
    expect(new Set(idsDe(r.body.clientes)).size).toBe(20);
  });

  it("clientes: `%` y `_` de `q` son literales, no comodines", async () => {
    const e = await esc();
    const pct = await b.c.sembrar(e.E.tenantId, { razonSocial: "100% PERU SAC" });
    const guion = await b.c.sembrar(e.E.tenantId, { razonSocial: "ABC_DEF SAC" });
    const x = await b.c.sembrar(e.E.tenantId, { razonSocial: "ABCXDEF SAC" });
    const ids = async (q: string): Promise<string[]> => (await h.opciones(e.dueno, { q })).body.clientes.map((c: any) => c.id);
    const soloPct = await ids("%");
    expect(soloPct.every((i) => i === pct.id), "«%» no es comodín").toBe(true);
    expect(soloPct).not.toContain(e.A.id);
    expect(soloPct).not.toContain(x.id);
    expect(await ids("100%")).toEqual([pct.id]);
    const abc = await ids("ABC_");
    expect(abc).toContain(guion.id);
    expect(abc, "«_» no es comodín de un carácter").not.toContain(x.id);
    const soloGuion = await ids("_");
    expect(soloGuion).not.toContain(e.A.id);
    expect(soloGuion).not.toContain(x.id);
    expect(await ids("\\")).not.toContain(e.A.id);
  });

  it("clientes: con alcance asignado solo los visibles; sin asignaciones, ninguno; `clienteId` agrega ese cliente si es visible", async () => {
    const e = await esc();
    const asig = await e.conRolPropio("asignado");
    const sin = await e.conRolPropio("asignado");
    await b.c.p.b.asignar(e.E.tenantId, e.A.id, asig.id, "colaborador");
    const q = await h.opciones(asig, { q: "SAN" });
    expect(q.status, q.text).toBe(200);
    expect(q.body.clientes.map((c: any) => c.id)).toEqual([e.A.id]); // «SANTA ROSA» (B) no está asignado
    expect(q.text).not.toContain(e.B.razonSocial);
    expect((await h.opciones(sin, { q: "SAN" })).body.clientes).toEqual([]);
    expect((await h.opciones(sin, { q: e.A.ruc })).body.clientes).toEqual([]);
    // `clienteId` sin `q`: agrega ese cliente solo si es visible (para pintarlo al recargar).
    const propio = await h.opciones(asig, { clienteId: e.A.id });
    expect(propio.status, propio.text).toBe(200);
    expect(propio.body.clientes.map((c: any) => c.id)).toContain(e.A.id);
    const ajeno = await h.opciones(asig, { clienteId: e.B.id });
    expect(ajeno.status, ajeno.text).toBe(200);
    expect(ajeno.body.clientes.map((c: any) => c.id)).not.toContain(e.B.id);
    expect(ajeno.text).not.toContain(e.B.razonSocial);
    const duenoVe = await h.opciones(e.dueno, { clienteId: e.B.id });
    expect(duenoVe.body.clientes.map((c: any) => c.id)).toContain(e.B.id);
    const unido = await h.opciones(e.dueno, { q: "SAN JU", clienteId: e.B.id });
    expect(ordenado(unido.body.clientes.map((c: any) => c.id))).toEqual(ordenado([e.A.id, e.B.id]));
  });

  it("aislamiento: ni clientes ni miembros de otro estudio, ni por q ni por clienteId", async () => {
    const e = await esc();
    const otro = await esc();
    await sql("update usuario set nombre = 'Marca Ajena 031' where id = $1", [otro.dueno.id]);
    const porQ = await h.opciones(e.dueno, { q: otro.A.ruc });
    expect(porQ.body.clientes).toEqual([]);
    const porId = await h.opciones(e.dueno, { clienteId: otro.A.id });
    expect(porId.status, porId.text).toBe(200);
    expect(porId.body.clientes).toEqual([]);
    for (const r of [porQ, porId, await h.opciones(e.dueno)]) {
      expect(r.text).not.toContain(otro.A.razonSocial);
      expect(r.text).not.toContain("Marca Ajena 031");
      expect(r.text).not.toContain(otro.dueno.id);
    }
  });
});

/* ================================ CA-8 · centinelas ================================ */
describe("CA-8 · ningún valor centinela en respuestas ni logs de la consulta con filtros ni de /opciones", () => {
  it("guardar y descifrar credenciales con centinelas y consultarlas con filtros, como Dueño y como asignado", async () => {
    const e = await esc();
    const contador = await e.miembro("contador", "Cora Contadora");
    const asig = await e.conRolPropio("asignado");
    const cl = await b.c.sembrar(e.E.tenantId, { responsable: contador.id });
    await b.c.p.b.asignar(e.E.tenantId, cl.id, asig.id, "colaborador");
    const centinelas = [canario("usuario"), canario("clave"), canario("client-id"), canario("client-secret")];
    const { resultado, logs } = await capturarLogs(async () => {
      const g1 = await b.c.p.b.llamar(e.dueno, "PUT", `/clientes/${cl.id}/credenciales/sol`, { usuario: centinelas[0], clave: centinelas[1] });
      const g2 = await b.c.p.b.llamar(e.dueno, "PUT", `/clientes/${cl.id}/credenciales/sire_api`, { clientId: centinelas[2], clientSecret: centinelas[3] });
      expect(g1.status, g1.text).toBe(200);
      expect(g2.status, g2.text).toBe(200);
      await sql("update credencial set estado = 'invalida' where cliente_id = $1 and tipo = 'sol'", [cl.id]);
      await sembrarDescifradoEn(sql, { tenantId: e.E.tenantId, clienteId: cl.id, en: "2026-03-10T10:00:00.000Z", tipo: "sol", motivo: "credencial.verificar", resultado: "ok" });
      const porCliente = await h.recorrer(e.dueno, { clienteId: cl.id });
      const porAccion = await h.recorrer(e.dueno, { accion: ["credencial.guardada", "credencial.invalidada", "credencial.descifrada"], usuarioId: e.dueno.id });
      const porAccion2 = await h.recorrer(e.dueno, { accion: ["credencial.guardada", "credencial.invalidada", "credencial.descifrada"], desde: "2026-03-01" });
      const comoAsignado = await h.recorrer(asig, { clienteId: cl.id, accion: ["credencial.guardada", "credencial.descifrada"] });
      const opciones = [await h.opciones(e.dueno, { q: cl.ruc }), await h.opciones(asig, { q: cl.ruc }), await h.opciones(e.dueno, { clienteId: cl.id })];
      for (const o of opciones) expect(o.status, o.text).toBe(200);
      return { porCliente, porAccion, porAccion2, comoAsignado, textos: opciones.map((o) => o.text) };
    });
    // Control de que la prueba no es vacía: la consulta filtrada ve las credenciales, solo con el tipo (lista blanca).
    const guardadas = resultado.porCliente.items.filter((x) => x.accion === "credencial.guardada");
    expect(guardadas.map((x) => x.datos).sort((p, q) => p.tipo.localeCompare(q.tipo))).toEqual([{ tipo: "sire_api" }, { tipo: "sol" }]);
    expect(resultado.porCliente.items.some((x) => x.accion === "credencial.invalidada")).toBe(true);
    expect(resultado.porCliente.items.some((x) => x.accion === "credencial.descifrada")).toBe(true);
    expect(resultado.comoAsignado.items.some((x) => x.accion === "credencial.guardada")).toBe(true);
    expect(resultado.porAccion2.items.some((x) => x.accion === "credencial.descifrada")).toBe(true);
    for (const x of resultado.porCliente.items.filter((y) => y.accion.startsWith("credencial."))) expect(Object.keys(x.datos).every((k) => ["tipo", "motivo", "resultado"].includes(k)), JSON.stringify(x.datos)).toBe(true);
    expect(filtrados(centinelas, resultado.porCliente.texto, resultado.porAccion.texto, resultado.porAccion2.texto, resultado.comoAsignado.texto, ...resultado.textos, logs)).toEqual([]);
  });

  it("los datos inválidos de una consulta no se reflejan en la respuesta de error ni en los logs", async () => {
    const e = await esc();
    const marca = canario("filtro");
    const { resultado, logs } = await capturarLogs(async () => {
      const a = await h.get(e.dueno, `/auditoria${qs({ usuarioId: marca })}`);
      const c = await h.get(e.dueno, `/auditoria${qs({ accion: [marca] })}`);
      const d = await h.get(e.dueno, `/auditoria/opciones${qs({ q: marca, foo: marca })}`);
      return [a, c, d];
    });
    for (const r of resultado) {
      expect(r.status, r.text).toBe(400);
      expect(r.body).toEqual(INVALIDA);
    }
    expect(filtrados([marca], ...resultado.map((r) => r.text), logs)).toEqual([]);
  });
});
