/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON y filas de BD dinámicos en pruebas */
// Spec 024 · T4 (rojo): bandeja unificada `GET /buzon/mensajes` y bandeja fijada `GET /clientes/:clienteId/buzon/mensajes` ampliada
// (D-2 a D-4, D-10, D-12; CA-1, CA-2). Contrato fijado por estas pruebas (módulo `buzon`, T8):
//  - Permiso `buzon.ver`; `Cache-Control: no-store`. Respuesta global 200 `respuestaBandejaSchema` = `{ mensajes, siguiente }`; la ruta del
//    cliente 200 `paginaMensajesBuzonSchema` = `{ estado, mensajes, siguiente }`. Cada fila es la de 023 más `cliente { id, razonSocial,
//    archivado }` y `atencion { estado, por, en }` (nunca RUC, tenantId, idSunat ni el comentario).
//  - Alcance: global (Dueño, Administrador) o asignado (los demás); sin `archivados=1` los clientes archivados no aportan filas;
//    `responsable=yo` deja los clientes en que la persona es `responsable` (también para Dueño y Administrador). En la ruta del
//    cliente el cliente se muestra aunque esté archivado y `responsable`/`archivados` son parámetros desconocidos (400).
//  - Estado de atención (partición, igual que en `packages/db`): atendido si tiene `atendido_en`; si no, histórico si `historico`; si
//    no, pendiente. `pendientes`, `atendidos` (histórico o no), `historicos` (sin atender) y `todos` (por omisión en la API).
//  - Orden fecha desc e id desc; `limite` 1..100 (50 por omisión). Fechas `desde`/`hasta`: días de Lima, inclusive.
//  - 400 `solicitud_invalida` para parámetros desconocidos o inválidos (el código que ya usa 023; el plan lo llama `parametros_invalidos`
//    pero no existe en la API) y 400 `cursor_invalido` para un cursor que no es una posición de ESA consulta: base64url de
//    `{ v: 1, f, i, h }` (plan 024, «Cursor»): `h` = huella de los filtros y de la ruta; cambiar filtros o ruta, o alterarlo, es 400.
//  - 404 `no_encontrado` igual al de un cliente inexistente para un cliente no visible, de otro estudio o inexistente.
// Rojo: la ruta global no existe (404) y la de cliente aún no devuelve `cliente` ni `atencion`; el estado de atención necesita las
// columnas de la migración 0059 (T7).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abrirBancoBandeja,
  CATEGORIAS,
  cumple,
  diaLima,
  FECHAS,
  sinPermiso,
  type Actor,
  type BancoBandeja,
  type Estudio,
} from "../../../test/soporte-bandeja.js";
import { forma } from "../../../test/soporte.js";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

interface Cl {
  id: string;
  razonSocial: string;
  archivado: boolean;
  i: number;
}
interface Msg {
  id: string;
  cl: Cl;
  fecha: string;
  categoria: string;
  critico: boolean;
  leido: boolean;
  estado: "pendiente" | "atendido" | "historico";
}

const N_CLIENTES = 120;
const POR_CLIENTE = 3;
// Estado por posición: pendiente ×4, atendido ×2, histórico sin atender ×1 y histórico atendido ×1 (cuenta como atendido).
const PLAN_ESTADOS = [
  "pendiente",
  "pendiente",
  "pendiente",
  "atendido",
  "historico",
  "historico_atendido",
  "pendiente",
  "atendido",
] as const;

let b: BancoBandeja;
let E: Estudio;
let F: Estudio;
let dueno: Actor;
let admin: Actor;
let contador: Actor;
let asistente: Actor;
let lectura: Actor;
let clientes: Cl[] = [];
let mensajes: Msg[] = [];
let faltaEsquema: string | null = null;

// Quién ve y quién es responsable de qué (índices de `clientes`). Archivados: i % 10 === 9.
const CONTADOR_VE = Array.from({ length: 15 }, (_, i) => i); // responsable de 0..4, colaborador de 5..14 (9 archivado)
const CONTADOR_RESP = [0, 1, 2, 3, 4];
const LECTURA_VE = [0, 1, 2, 20, 21, 22];
const DUENO_RESP = [40, 41, 42, 43, 49]; // 49 archivado
const ASISTENTE_RESP = [30, 31, 32];

type Quien = "dueno" | "admin" | "contador" | "lectura" | "asistente";
const visibles = (q: Quien): ReadonlySet<number> | "todos" =>
  q === "dueno" || q === "admin"
    ? "todos"
    : new Set(q === "contador" ? CONTADOR_VE : q === "lectura" ? LECTURA_VE : ASISTENTE_RESP);
const responsables = (q: Quien): ReadonlySet<number> =>
  new Set(q === "dueno" ? DUENO_RESP : q === "contador" ? CONTADOR_RESP : q === "asistente" ? ASISTENTE_RESP : []);

interface Filtros {
  atencion?: "pendientes" | "atendidos" | "historicos" | "todos";
  categoria?: string;
  leido?: "si" | "no";
  desde?: string;
  hasta?: string;
  archivados?: boolean;
  responsable?: boolean;
}
const consulta = (f: Filtros): string =>
  [
    f.atencion && `atencion=${f.atencion}`,
    f.categoria && `categoria=${f.categoria}`,
    f.leido && `leido=${f.leido}`,
    f.desde && `desde=${f.desde}`,
    f.hasta && `hasta=${f.hasta}`,
    f.archivados && "archivados=1",
    f.responsable && "responsable=yo",
  ]
    .filter(Boolean)
    .join("&");

/** Oráculo en memoria: filas esperadas, en orden fecha desc e id desc. */
function esperados(q: Quien, f: Filtros, clienteFijo?: number): Msg[] {
  const vis = visibles(q);
  const resp = responsables(q);
  return mensajes
    .filter((m) => {
      if (clienteFijo !== undefined) {
        if (m.cl.i !== clienteFijo) return false;
      } else {
        if (vis !== "todos" && !vis.has(m.cl.i)) return false;
        if (!f.archivados && m.cl.archivado) return false;
        if (f.responsable && !resp.has(m.cl.i)) return false;
      }
      if (f.categoria === "criticos" ? !m.critico : f.categoria !== undefined && m.categoria !== f.categoria) return false;
      if (f.leido !== undefined && m.leido !== (f.leido === "si")) return false;
      if (f.atencion === "pendientes" && m.estado !== "pendiente") return false;
      if (f.atencion === "atendidos" && m.estado !== "atendido") return false;
      if (f.atencion === "historicos" && m.estado !== "historico") return false;
      const dia = diaLima(m.fecha);
      if (f.desde !== undefined && dia < f.desde) return false;
      if (f.hasta !== undefined && dia > f.hasta) return false;
      return true;
    })
    .sort((x, y) => (x.fecha === y.fecha ? (x.id < y.id ? 1 : -1) : x.fecha < y.fecha ? 1 : -1));
}

const actorDe = (q: Quien): Actor =>
  ({ dueno, admin, contador, lectura, asistente })[q];

/** Todas las páginas de una ruta, con `limite`; falla si una página no es 200. */
async function recorrer(a: Actor, ruta: string, query = "", limite = 100): Promise<{ filas: any[]; paginas: number }> {
  const filas: any[] = [];
  let cursor: string | null = null;
  let paginas = 0;
  do {
    const q = [query, `limite=${limite}`, cursor === null ? "" : `cursor=${encodeURIComponent(cursor)}`].filter(Boolean).join("&");
    const r: any = await b.llamar(a, "GET", `${ruta}?${q}`);
    expect(r.status, `${ruta}?${q} -> ${r.text}`).toBe(200);
    filas.push(...r.body.mensajes);
    cursor = r.body.siguiente;
    paginas++;
  } while (cursor !== null && paginas < 400);
  return { filas, paginas };
}
const global = (a: Actor, query = "") => b.llamar(a, "GET", `/buzon/mensajes${query ? `?${query}` : ""}`);
const delCliente = (a: Actor, id: string, query = "") =>
  b.llamar(a, "GET", `/clientes/${id}/buzon/mensajes${query ? `?${query}` : ""}`);
const decodificar = (c: string): any => JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
const codificar = (o: unknown): string => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");

beforeAll(async () => {
  b = await abrirBancoBandeja();
  E = await b.estudio();
  F = await b.estudio();
  const p = b.v.b.c.p.b;
  dueno = E.titular;
  admin = await p.miembro(E.tenantId, "admin");
  contador = await p.miembro(E.tenantId, "contador");
  asistente = await p.miembro(E.tenantId, "asistente");
  lectura = await p.miembro(E.tenantId, "lectura");

  clientes = (await b.clientesMasivos(E.tenantId, N_CLIENTES, { prefijo: "Bandeja", archivado: (i) => i % 10 === 9 })).map((c, i) => ({ ...c, i }));
  const ids = (idx: number[]) => idx.map((i) => clientes[i]!.id);
  await b.asignarMasivo(E.tenantId, contador.id, ids(CONTADOR_RESP), "responsable");
  await b.asignarMasivo(E.tenantId, contador.id, ids(CONTADOR_VE.filter((i) => !CONTADOR_RESP.includes(i))), "colaborador");
  await b.asignarMasivo(E.tenantId, lectura.id, ids(LECTURA_VE), "colaborador");
  await b.asignarMasivo(E.tenantId, asistente.id, ids(ASISTENTE_RESP), "responsable");
  await b.asignarMasivo(E.tenantId, dueno.id, ids(DUENO_RESP), "responsable");

  // 3 mensajes por cliente, con fechas que se repiten (empates al microsegundo y bordes del día de Lima).
  const filas = clientes.flatMap((c) =>
    Array.from({ length: POR_CLIENTE }, (_, m) => {
      const k = c.i * POR_CLIENTE + m;
      return { clienteId: c.id, fecha: FECHAS[k % FECHAS.length]!, categoria: CATEGORIAS[k % CATEGORIAS.length]!, leido: k % 3 === 0, plan: PLAN_ESTADOS[k % PLAN_ESTADOS.length]! };
    }),
  );
  const idsMsg = await b.sembrarLote(E.tenantId, filas);
  mensajes = filas.map((f, n) => ({
    id: idsMsg[n]!,
    cl: clientes.find((c) => c.id === f.clienteId)!,
    fecha: f.fecha,
    categoria: f.categoria,
    critico: f.categoria !== "otro",
    leido: f.leido,
    estado: f.plan === "pendiente" ? "pendiente" : f.plan === "historico" ? "historico" : "atendido",
  }));
  // Estado de atención y de histórico: necesita las columnas de 0059 (T7). Si faltan, solo fallan las pruebas que lo usan.
  try {
    const poPlan = (x: (typeof PLAN_ESTADOS)[number]) => filas.flatMap((f, n) => (f.plan === x ? [idsMsg[n]!] : []));
    await b.fijarEstado([...poPlan("historico"), ...poPlan("historico_atendido")], { historico: true });
    await b.fijarEstado([...poPlan("atendido"), ...poPlan("historico_atendido")], { atendidoPor: dueno.id });
  } catch (e) {
    faltaEsquema = e instanceof Error ? e.message : String(e);
  }

  // Otro estudio con las mismas fechas: nada de él debe verse desde E.
  const cF = await b.clientesMasivos(F.tenantId, 4, { prefijo: "Otro estudio" });
  await b.sembrarLote(
    F.tenantId,
    cF.flatMap((c, i) => FECHAS.slice(0, 6).map((fecha, j) => ({ clienteId: c.id, fecha, categoria: CATEGORIAS[(i + j) % 5]! }))),
  );
});
afterAll(async () => {
  await b?.cerrar();
});

const exigirEsquema = () => {
  if (faltaEsquema !== null) throw new Error(`falta el esquema de 0059 (T7): ${faltaEsquema}`);
};

describe("CA-1 · alcance: quién ve qué clientes (GET /buzon/mensajes)", () => {
  beforeEach(exigirEsquema);

  it("el Contador asignado a 15 de 120 ve solo mensajes de esos 15 (14 activos y, con archivados, los 15)", async () => {
    const activos = await recorrer(contador, "/buzon/mensajes");
    expect(new Set(activos.filas.map((f) => f.cliente.id))).toEqual(
      new Set(CONTADOR_VE.filter((i) => !clientes[i]!.archivado).map((i) => clientes[i]!.id)),
    );
    const todos = await recorrer(contador, "/buzon/mensajes", "archivados=1");
    expect(new Set(todos.filas.map((f) => f.cliente.id))).toEqual(new Set(CONTADOR_VE.map((i) => clientes[i]!.id)));
    expect(todos.filas).toHaveLength(15 * POR_CLIENTE);
  });

  it.each([
    ["Dueño", () => dueno],
    ["Administrador", () => admin],
  ])("%s ve los 120 clientes (108 activos; con archivados, todos) y nunca los del otro estudio", async (_n, quien) => {
    const activos = await recorrer(quien(), "/buzon/mensajes");
    expect(new Set(activos.filas.map((f) => f.cliente.id)).size).toBe(108);
    expect(activos.filas.some((f) => f.cliente.archivado)).toBe(false);
    const todos = await recorrer(quien(), "/buzon/mensajes", "archivados=1");
    expect(new Set(todos.filas.map((f) => f.cliente.id))).toEqual(new Set(clientes.map((c) => c.id)));
    expect(todos.filas).toHaveLength(N_CLIENTES * POR_CLIENTE);
  });

  it("Lectura ve solo los de sus asignados", async () => {
    const r = await recorrer(lectura, "/buzon/mensajes");
    expect(new Set(r.filas.map((f) => f.cliente.id))).toEqual(new Set(LECTURA_VE.map((i) => clientes[i]!.id)));
  });

  it("«solo donde soy responsable» deja solo esos clientes, también para el Dueño", async () => {
    const d = await recorrer(dueno, "/buzon/mensajes", "responsable=yo");
    expect(new Set(d.filas.map((f) => f.cliente.id))).toEqual(
      new Set(DUENO_RESP.filter((i) => !clientes[i]!.archivado).map((i) => clientes[i]!.id)),
    );
    const dA = await recorrer(dueno, "/buzon/mensajes", "responsable=yo&archivados=1");
    expect(new Set(dA.filas.map((f) => f.cliente.id))).toEqual(new Set(DUENO_RESP.map((i) => clientes[i]!.id)));
    const c = await recorrer(contador, "/buzon/mensajes", "responsable=yo");
    expect(new Set(c.filas.map((f) => f.cliente.id))).toEqual(new Set(CONTADOR_RESP.map((i) => clientes[i]!.id)));
    expect((await recorrer(admin, "/buzon/mensajes", "responsable=yo")).filas).toEqual([]);
  });

  it("no filtra nada del otro estudio ni sus textos, y la fila no lleva RUC, tenantId, idSunat ni comentario", async () => {
    const r = await global(dueno, "archivados=1&limite=100");
    expect(r.status, r.text).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(r.text).not.toContain(F.tenantId);
    expect(r.text).not.toContain("Otro estudio");
    for (const prohibido of ["ruc", "tenantId", "idSunat", "tenant_id", "comentario"]) expect(r.text).not.toContain(`"${prohibido}"`);
    expect(r.body.mensajes[0].cliente).toEqual({ id: expect.any(String), razonSocial: expect.stringMatching(/^Bandeja \d{4}$/), archivado: expect.any(Boolean) });
  });

  it("sin sesión: 401", async () => {
    expect((await b.sinSesion("GET", "/buzon/mensajes")).status).toBe(401);
  });
});

describe("CA-1 · permiso buzon.ver (rol simulado: ningún rol de sistema lo pierde)", () => {
  it("sin buzon.ver, la bandeja global y la del cliente dan 403 permiso_denegado", async () => {
    // Control: con el permiso, la ruta existe y responde 200 (si no, un 404 de ruta pasaría por «no autorizado»).
    const con = await global(lectura);
    expect(con.status, con.text).toBe(200);
    await sinPermiso("lectura", "buzon.ver", async () => {
      const g = await global(lectura);
      expect(g.status, g.text).toBe(403);
      expect(g.body).toEqual({ codigo: "permiso_denegado" });
      const c = await delCliente(lectura, clientes[0]!.id);
      expect(c.status, c.text).toBe(403);
      expect(c.body).toEqual({ codigo: "permiso_denegado" });
    });
    expect((await global(lectura)).status).toBe(200); // la matriz se restauró
  });
});

describe("CA-2 · filtros: validación (400)", () => {
  it.each([
    "clienteId=00000000-0000-4000-8000-000000000001",
    "tenantId=00000000-0000-4000-8000-000000000001",
    "usuarioId=x",
    "foo=1",
    "q=texto",
    "atencion=nuevos",
    "atencion=Pendientes",
    "atencion=",
    "categoria=inexistente",
    "categoria=Coactiva",
    "leido=true",
    "leido=1",
    "responsable=todos",
    "responsable=1",
    "archivados=0",
    "archivados=true",
    "desde=2026-02-30",
    "hasta=2026-13-01",
    "desde=20-11-2026",
    "desde=2026-11-21&hasta=2026-11-20",
    "limite=0",
    "limite=101",
    "limite=-1",
    "limite=1.5",
    "limite=abc",
    "limite=",
  ])("%s es 400 solicitud_invalida", async (query) => {
    const r = await global(dueno, query);
    expect(r.status, r.text).toBe(400);
    expect(r.body).toEqual({ codigo: "solicitud_invalida" });
  });

  it("un filtro repetido o un parámetro de otro tipo (arreglo) también es 400", async () => {
    for (const query of ["atencion=pendientes&atencion=todos", "categoria[]=coactiva", "archivados=1&archivados=1"]) {
      const r = await global(dueno, query);
      expect(r.status, `${query}: ${r.text}`).toBe(400);
    }
  });

  it("la ruta del cliente rechaza además `responsable`, `archivados` y `clienteId`", async () => {
    for (const query of ["responsable=yo", "archivados=1", `clienteId=${clientes[1]!.id}`, "tenantId=x"]) {
      const r = await delCliente(dueno, clientes[0]!.id, query);
      expect(r.status, `${query}: ${r.text}`).toBe(400);
      expect(r.body).toEqual({ codigo: "solicitud_invalida" });
    }
  });
});

describe("CA-2 · tabla de casos contra el oráculo en memoria", () => {
  beforeEach(exigirEsquema);

  const CASOS: [string, Filtros][] = [
    ["sin filtros", {}],
    ["pendientes", { atencion: "pendientes" }],
    ["atendidos", { atencion: "atendidos" }],
    ["históricos", { atencion: "historicos" }],
    ["todos", { atencion: "todos" }],
    ["coactiva", { categoria: "coactiva" }],
    ["otro", { categoria: "otro" }],
    ["todos los críticos", { categoria: "criticos" }],
    ["leídos", { leido: "si" }],
    ["no leídos", { leido: "no" }],
    ["incluir archivados", { archivados: true }],
    ["solo donde soy responsable", { responsable: true }],
    ["responsable y archivados", { responsable: true, archivados: true }],
    ["críticos pendientes", { categoria: "criticos", atencion: "pendientes" }],
    ["críticos pendientes no leídos", { categoria: "criticos", atencion: "pendientes", leido: "no" }],
    ["desde (día de Lima)", { desde: "2026-11-12" }],
    ["hasta (día de Lima)", { hasta: "2026-11-11" }],
    ["un solo día de Lima: el 12 (incluye 00:00 y 23:30)", { desde: "2026-11-12", hasta: "2026-11-12" }],
    ["el 11: llega hasta 23:59:59.999999 de Lima", { desde: "2026-11-11", hasta: "2026-11-11" }],
    ["el 15 entero", { desde: "2026-11-15", hasta: "2026-11-15" }],
    ["rango sin mensajes", { desde: "2026-12-30" }],
    ["históricos con archivados", { atencion: "historicos", archivados: true }],
    ["resolución de multa, atendidos, leídos, con archivados", { categoria: "resolucion_multa", atencion: "atendidos", leido: "si", archivados: true }],
    ["requerimiento no leído, responsable, rango", { categoria: "requerimiento_fiscalizacion", leido: "no", responsable: true, desde: "2026-11-10", hasta: "2026-11-16", archivados: true }],
    ["todos los filtros a la vez", { categoria: "criticos", atencion: "todos", leido: "si", desde: "2026-10-01", hasta: "2026-11-30", archivados: true, responsable: true }],
  ];

  for (const quien of ["dueno", "contador"] as const) {
    it.each(CASOS)(`${quien}: %s`, async (_nombre, filtros) => {
      const a = actorDe(quien);
      const { filas } = await recorrer(a, "/buzon/mensajes", consulta(filtros));
      const esperado = esperados(quien, filtros);
      expect(filas.map((f) => f.id)).toEqual(esperado.map((m) => m.id));
      for (const [n, f] of filas.entries()) {
        const m = esperado[n]!;
        expect(f.cliente).toEqual({ id: m.cl.id, razonSocial: m.cl.razonSocial, archivado: m.cl.archivado });
        expect(f.atencion.estado, f.id).toBe(m.estado);
        expect(f.categoria).toBe(m.categoria);
        expect(f.critico).toBe(m.critico);
        expect(f.leidoEnSunat).toBe(m.leido);
        expect(Math.abs(new Date(f.fecha).getTime() - new Date(`${m.fecha.slice(0, 23)}Z`).getTime())).toBeLessThanOrEqual(1);
        expect(f.atencion.por === null).toBe(m.estado !== "atendido");
        expect(f.atencion.en === null).toBe(m.estado !== "atendido");
      }
    });
  }

  it.each(["admin", "lectura", "asistente"] as const)("%s: sin filtros, pendientes y críticos pendientes", async (quien) => {
    for (const filtros of [{}, { atencion: "pendientes" }, { categoria: "criticos", atencion: "pendientes" }, { archivados: true }] as Filtros[]) {
      const { filas } = await recorrer(actorDe(quien), "/buzon/mensajes", consulta(filtros));
      expect(filas.map((f) => f.id), `${quien} ${consulta(filtros)}`).toEqual(esperados(quien, filtros).map((m) => m.id));
    }
  });

  it("el orden es fecha descendente y, con la misma fecha, id descendente (hay empates al microsegundo)", async () => {
    const { filas } = await recorrer(dueno, "/buzon/mensajes", "archivados=1");
    const claves = filas.map((f) => `${mensajes.find((m) => m.id === f.id)!.fecha}|${f.id}`);
    expect(claves).toEqual([...claves].sort().reverse());
    expect(new Set(filas.map((f) => mensajes.find((m) => m.id === f.id)!.fecha)).size).toBeLessThan(FECHAS.length);
  });

  it("recorrer con limite=7 da cada fila una vez y la misma lista que una pasada de 100", async () => {
    for (const [quien, filtros] of [
      ["dueno", { archivados: true }],
      ["contador", { atencion: "pendientes" }],
      ["dueno", { categoria: "criticos", atencion: "pendientes" }],
    ] as [Quien, Filtros][]) {
      const chico = await recorrer(actorDe(quien), "/buzon/mensajes", consulta(filtros), 7);
      const ids = chico.filas.map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(esperados(quien, filtros).map((m) => m.id));
      expect(chico.paginas).toBe(Math.ceil(ids.length / 7));
    }
  });

  it("por omisión la página es de 50 y trae siguiente; limite=100 es el máximo", async () => {
    const r = await global(dueno, "archivados=1");
    expect(r.status, r.text).toBe(200);
    expect(r.body.mensajes).toHaveLength(50);
    expect(r.body.siguiente).toEqual(expect.any(String));
    expect(cumple("respuestaBandejaSchema", r.body)).toBe(true);
    const cien = await global(dueno, "archivados=1&limite=100");
    expect(cien.body.mensajes).toHaveLength(100);
    const ultima = await recorrer(dueno, "/buzon/mensajes", "archivados=1", 100);
    expect(ultima.paginas).toBe(4); // 360 filas
  });
});

describe("CA-2 · cursor: opaco, ligado a los filtros y a la ruta, nunca amplía el alcance", () => {
  const base = "atencion=pendientes&archivados=1";
  const primera = async (a: Actor = dueno, query = base) => {
    const r = await global(a, `${query}&limite=5`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.siguiente, "debe haber una segunda página").not.toBeNull();
    return r.body.siguiente as string;
  };

  it("el cursor de la primera página lleva a la segunda sin huecos ni repetidos", async () => {
    exigirEsquema();
    const c = await primera();
    expect(c.length).toBeLessThanOrEqual(256);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    const sig = await global(dueno, `${base}&limite=5&cursor=${encodeURIComponent(c)}`);
    expect(sig.status, sig.text).toBe(200);
    const todos = esperados("dueno", { atencion: "pendientes", archivados: true }).map((m) => m.id);
    expect(sig.body.mensajes.map((f: any) => f.id)).toEqual(todos.slice(5, 10));
  });

  it("el mismo cursor sirve con otro `limite` (no forma parte de la huella)", async () => {
    exigirEsquema();
    const c = await primera();
    const r = await global(dueno, `${base}&limite=20&cursor=${encodeURIComponent(c)}`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.mensajes).toHaveLength(20);
  });

  it("alterado, truncado o con otra forma: 400 cursor_invalido", async () => {
    exigirEsquema();
    const c = await primera();
    const o = decodificar(c);
    expect(Object.keys(o).sort()).toEqual(["f", "h", "i", "v"]);
    const malos: Record<string, string> = {
      "truncado a la mitad": c.slice(0, Math.floor(c.length / 2)),
      "sin su último carácter": c.slice(0, -1),
      "con caracteres que no son base64url": `${c.slice(0, 10)}%%%${c.slice(13)}`,
      "texto cualquiera": "no-es-un-cursor",
      "JSON vacío": codificar({}),
      "versión distinta": codificar({ ...o, v: 2 }),
      "huella cambiada": codificar({ ...o, h: "0000000000000000" }),
      "huella ausente": codificar({ v: o.v, f: o.f, i: o.i }),
      "id que no es uuid": codificar({ ...o, i: "no-uuid" }),
      "fecha que no es la de la BD": codificar({ ...o, f: "ayer" }),
      "fecha sin microsegundos": codificar({ ...o, f: "2026-11-12T05:00:00Z" }),
      "clave de más": codificar({ ...o, extra: 1 }),
      "arreglo": codificar([o]),
      "texto JSON plano": codificar("x"),
    };
    for (const [nombre, malo] of Object.entries(malos)) {
      const r = await global(dueno, `${base}&cursor=${encodeURIComponent(malo)}`);
      expect(r.status, `${nombre}: ${r.text}`).toBe(400);
      expect(r.body, nombre).toEqual({ codigo: "cursor_invalido" });
    }
  });

  it("un cursor de más de 256 caracteres es 400 (cursor_invalido o solicitud_invalida) y el vacío es 400", async () => {
    for (const malo of ["a".repeat(257), "a".repeat(600), ""]) {
      const r = await global(dueno, `cursor=${encodeURIComponent(malo)}`);
      expect(r.status, malo.length.toString()).toBe(400);
      expect(["cursor_invalido", "solicitud_invalida"]).toContain(r.body.codigo);
    }
  });

  it("de otros filtros: 400 cursor_invalido (cambiar atencion, categoria, leido, fechas, archivados o responsable)", async () => {
    exigirEsquema();
    const c = await primera();
    for (const otro of [
      "atencion=atendidos&archivados=1",
      "atencion=pendientes",
      "atencion=pendientes&archivados=1&categoria=coactiva",
      "atencion=pendientes&archivados=1&leido=no",
      "atencion=pendientes&archivados=1&desde=2026-11-01",
      "atencion=pendientes&archivados=1&hasta=2026-11-30",
      "atencion=pendientes&archivados=1&responsable=yo",
      "archivados=1",
    ]) {
      const r = await global(dueno, `${otro}&cursor=${encodeURIComponent(c)}`);
      expect(r.status, `${otro}: ${r.text}`).toBe(400);
      expect(r.body, otro).toEqual({ codigo: "cursor_invalido" });
    }
  });

  it("de otra ruta: el de la bandeja global no sirve en la de un cliente y viceversa; tampoco entre clientes", async () => {
    exigirEsquema();
    const global1 = await primera(dueno, "archivados=1");
    const c0 = clientes[0]!.id;
    const c1 = clientes[1]!.id;
    const deCliente = await delCliente(dueno, c0, "limite=1");
    expect(deCliente.status, deCliente.text).toBe(200);
    const cursorC0 = deCliente.body.siguiente as string;
    expect(cursorC0).toEqual(expect.any(String));
    for (const [nombre, r] of [
      ["global en la ruta del cliente", await delCliente(dueno, c0, `cursor=${encodeURIComponent(global1)}`)],
      ["de un cliente en otro cliente", await delCliente(dueno, c1, `cursor=${encodeURIComponent(cursorC0)}`)],
      ["de un cliente en la global", await global(dueno, `archivados=1&cursor=${encodeURIComponent(cursorC0)}`)],
    ] as const) {
      expect(r.status, `${nombre}: ${r.text}`).toBe(400);
      expect(r.body, nombre).toEqual({ codigo: "cursor_invalido" });
    }
    const ok = await delCliente(dueno, c0, `limite=1&cursor=${encodeURIComponent(cursorC0)}`);
    expect(ok.status, ok.text).toBe(200); // control: en su propia ruta sí sirve
  });

  it("el cursor de otro estudio con los mismos filtros no trae filas ajenas: solo cambia la posición", async () => {
    exigirEsquema();
    const deF = await global(F.titular, `${base}&limite=3`);
    expect(deF.status, deF.text).toBe(200);
    expect(deF.body.mensajes.length).toBeGreaterThan(0);
    const cursorF = (await global(F.titular, `atencion=todos&archivados=1&limite=3`)).body.siguiente as string;
    const r = await global(dueno, `atencion=todos&archivados=1&limite=100&cursor=${encodeURIComponent(cursorF)}`);
    // O es 400 (la huella no coincide) o es 200 con filas solo de E; nunca una de F.
    if (r.status === 200) {
      const idsE = new Set(mensajes.map((m) => m.id));
      for (const f of r.body.mensajes) expect(idsE.has(f.id), f.id).toBe(true);
      expect(r.text).not.toContain("Otro estudio");
    } else {
      expect(r.status, r.text).toBe(400);
      expect(r.body).toEqual({ codigo: "cursor_invalido" });
    }
  });

  it("un cursor armado a mano con la posición de otro mensaje y la huella correcta no amplía el alcance del Contador", async () => {
    exigirEsquema();
    const c = await primera(contador, "atencion=todos");
    const o = decodificar(c);
    const ajeno = mensajes.find((m) => !CONTADOR_VE.includes(m.cl.i))!;
    const r = await global(contador, `atencion=todos&limite=100&cursor=${encodeURIComponent(codificar({ ...o, f: `${ajeno.fecha}`, i: ajeno.id }))}`);
    expect(r.status, r.text).toBe(200);
    const visibles = new Set(CONTADOR_VE.map((i) => clientes[i]!.id));
    for (const f of r.body.mensajes) expect(visibles.has(f.cliente.id)).toBe(true);
  });
});

describe("CA-1 · atender o desasignar a mitad del recorrido (estudio propio)", () => {
  let G: Estudio;
  let cG: Actor;
  let dG: Actor;
  let cl: { id: string }[];
  beforeAll(async () => {
    G = await b.estudio();
    dG = G.titular;
    cG = await b.v.b.c.p.b.miembro(G.tenantId, "contador");
    cl = await b.clientesMasivos(G.tenantId, 3, { prefijo: "Recorrido" });
    await b.asignarMasivo(G.tenantId, cG.id, cl.map((c) => c.id), "colaborador");
    await b.sembrarLote(
      G.tenantId,
      cl.flatMap((c, i) => Array.from({ length: 10 }, (_, j) => ({ clienteId: c.id, fecha: FECHAS[(i * 10 + j) % FECHAS.length]!, categoria: "otro" }))),
    );
  });

  it("atender filas a mitad del recorrido no salta ni repite: lo atendido por delante desaparece y lo visto no vuelve", async () => {
    const inicial = (await recorrer(cG, "/buzon/mensajes", "atencion=pendientes", 100)).filas.map((f) => f.id);
    expect(inicial).toHaveLength(30);
    const p1 = await global(cG, "atencion=pendientes&limite=7");
    expect(p1.status, p1.text).toBe(200);
    const vistas = p1.body.mensajes.map((f: any) => f.id) as string[];
    const adelante = [inicial[8]!, inicial[9]!, inicial[20]!]; // todavía no vistas
    for (const id of [...vistas.slice(0, 2), ...adelante]) {
      const m = (await b.sql("select cliente_id from buzon_mensaje where id = $1", [id]))[0];
      const r = await b.llamar(cG, "POST", `/clientes/${m.cliente_id}/buzon/mensajes/${id}/atencion`, { accion: "marcar" });
      expect(r.status, r.text).toBe(200);
    }
    const resto: string[] = [];
    let cursor: string | null = p1.body.siguiente;
    while (cursor !== null) {
      const r: any = await global(cG, `atencion=pendientes&limite=7&cursor=${encodeURIComponent(cursor)}`);
      expect(r.status, r.text).toBe(200);
      resto.push(...r.body.mensajes.map((f: any) => f.id));
      cursor = r.body.siguiente;
    }
    const todo = [...vistas, ...resto];
    expect(new Set(todo).size).toBe(todo.length); // nada repetido
    for (const id of adelante) expect(todo).not.toContain(id); // atendido antes de llegar: ya no sale
    expect(todo).toEqual(inicial.filter((id) => !adelante.includes(id))); // nada saltado y en el mismo orden
  });

  it("desasignar un cliente a mitad del recorrido lo saca de la siguiente página pedida", async () => {
    const p1 = await global(cG, "atencion=todos&limite=5");
    expect(p1.status, p1.text).toBe(200);
    const todas = (await recorrer(cG, "/buzon/mensajes", "atencion=todos", 100)).filas;
    const restantes = todas.slice(5);
    const cliente = restantes[restantes.length - 1]!.cliente.id as string; // tiene filas todavía por delante
    expect(restantes.some((f) => f.cliente.id === cliente)).toBe(true);
    const baja = await b.v.llamar(dG, "DELETE", `/clientes/${cliente}/asignaciones/${cG.id}`);
    expect(baja.status, baja.text).toBe(204);
    const sig = await global(cG, `atencion=todos&limite=100&cursor=${encodeURIComponent(p1.body.siguiente)}`);
    expect(sig.status, sig.text).toBe(200);
    expect(sig.body.mensajes.some((f: any) => f.cliente.id === cliente)).toBe(false);
    expect(sig.body.mensajes.length).toBeGreaterThan(0);
    // y la bandeja fijada en ese cliente ya no es visible para el Contador: 404
    expect((await delCliente(cG, cliente)).status).toBe(404);
  });
});

describe("D-10 · la ruta del cliente es la bandeja fijada", () => {
  it("sin filtros devuelve lo mismo que en 023 (todos los mensajes, estado de captura) más `cliente` y `atencion`", async () => {
    const c = clientes[0]!;
    const r = await delCliente(contador, c.id);
    expect(r.status, r.text).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
    expect(cumple("paginaMensajesBuzonSchema", r.body)).toBe(true);
    expect(r.body.estado).toEqual({ ultimaCaptura: null, sincronizado: false, revisarDesde: null });
    expect(r.body.siguiente).toBeNull();
    const esperado = mensajes.filter((m) => m.cl.i === 0).sort((x, y) => (x.fecha === y.fecha ? (x.id < y.id ? 1 : -1) : x.fecha < y.fecha ? 1 : -1));
    expect(r.body.mensajes.map((f: any) => f.id)).toEqual(esperado.map((m) => m.id));
    for (const f of r.body.mensajes) {
      expect(Object.keys(f).sort()).toEqual(
        [
          "adjuntosDeclarados", "asunto", "atencion", "categoria", "cliente", "contenidoObtenido", "critico", "fecha", "id",
          "leidoEnSunat", "motivoCritico", "remitente",
        ].sort(),
      );
      expect(f.cliente).toEqual({ id: c.id, razonSocial: c.razonSocial, archivado: false });
      expect(["pendiente", "atendido", "historico"]).toContain(f.atencion.estado);
    }
    expect(r.text).not.toContain("tenantId");
  });

  it("aplica los filtros de atención, categoría, leído y fechas con el oráculo del cliente", async () => {
    exigirEsquema();
    for (const [i, filtros] of [
      [0, { atencion: "pendientes" }],
      [1, { atencion: "atendidos" }],
      [3, { atencion: "historicos" }],
      [4, { categoria: "criticos", atencion: "todos" }],
      [5, { leido: "no" }],
      [6, { desde: "2026-11-12", hasta: "2026-11-15" }],
    ] as [number, Filtros][]) {
      const { filas } = await recorrer(dueno, `/clientes/${clientes[i]!.id}/buzon/mensajes`, consulta(filtros));
      expect(filas.map((f) => f.id), `cliente ${i} ${consulta(filtros)}`).toEqual(esperados("dueno", filtros, i).map((m) => m.id));
    }
  });

  it("un cliente archivado se muestra aunque no se pida «incluir archivados»", async () => {
    const archivado = clientes[9]!;
    expect(archivado.archivado).toBe(true);
    const r = await delCliente(contador, archivado.id);
    expect(r.status, r.text).toBe(200);
    expect(r.body.mensajes).toHaveLength(POR_CLIENTE);
    expect(r.body.mensajes.every((f: any) => f.cliente.archivado === true)).toBe(true);
    // en la global, en cambio, no aporta filas sin `archivados=1`
    const g = await recorrer(contador, "/buzon/mensajes");
    expect(g.filas.some((f) => f.cliente.id === archivado.id)).toBe(false);
  });

  it("cliente no visible, de otro estudio o inexistente: el mismo 404 no_encontrado", async () => {
    const noVisible = await delCliente(lectura, clientes[50]!.id);
    const deOtroEstudio = await delCliente(F.titular, clientes[0]!.id);
    const inexistente = await delCliente(lectura, randomUUID());
    expect(noVisible.status).toBe(404);
    expect(noVisible.body).toEqual({ codigo: "no_encontrado" });
    expect(forma(noVisible)).toEqual(forma(inexistente));
    expect(forma(deOtroEstudio)).toEqual(forma(inexistente));
    expect((await delCliente(dueno, clientes[50]!.id)).status).toBe(200); // control: el Dueño sí
  });

  it("un cursor de la ruta del cliente avanza por el mismo cliente sin salir de él", async () => {
    const p = await recorrer(dueno, `/clientes/${clientes[2]!.id}/buzon/mensajes`, "", 1);
    expect(p.paginas).toBe(POR_CLIENTE);
    expect(new Set(p.filas.map((f) => f.cliente.id))).toEqual(new Set([clientes[2]!.id]));
  });
});
