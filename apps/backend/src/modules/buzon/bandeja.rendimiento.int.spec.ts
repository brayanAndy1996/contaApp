/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON, filas de BD y planes de ejecución dinámicos en pruebas */
// Spec 024 · T4 (rojo): rendimiento de la bandeja y del indicador (RNF-034; D-9; CA-9).
// Un estudio con 2.000 clientes y 100.000 mensajes (70 % pendientes: 15 % atendidos y 15 % históricos), sembrados con SQL masivo como
// `contapp_migrator` y con `VACUUM (ANALYZE)` (así el plan ve el mapa de visibilidad). La distribución es a propósito desigual para que
// la página 20 exista en todos los casos: los clientes 1..15 (los del usuario «asignado a 15») tienen 500 mensajes cada uno, los
// 16..500 tienen 100 y el resto 29 o 30. 25 % de los mensajes son críticos.
//  - p95 < 300 ms en 30 lecturas de la primera página y de la 20 (límite 50) para global, asignado a 15 y asignado a 500, con las vistas
//    sin filtros, «Pendientes» (`atencion=pendientes`) y «Críticos pendientes» (`atencion=pendientes&categoria=criticos`), y del listado
//    de clientes con indicador. Como en `compras/detalle.int.spec.ts`, el tiempo no se evalúa bajo cobertura (DT-1).
//  - `EXPLAIN (FORMAT JSON)` de cada consulta del repositorio (`listarBandeja`, `listarClientesFiltrado` y `indicadorBuzon`, con la `tx`
//    de `withTenant` y el rol de la app: la RLS entra en el plan): ningún nodo `Seq Scan` sobre `buzon_mensaje`.
// Rojo: la ruta global no existe (404), el indicador no viaja y el repositorio de la bandeja no está implementado (T7/T8); las
// columnas `historico`, `atendido_en` y `atendido_por` son de la migración 0059 (T7).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "@contapp/db";
import * as repo from "@contapp/db";
import { abrirBancoBandeja, type Actor, type BancoBandeja, type Estudio } from "../../../test/soporte-bandeja.js";
import { BAJO_COBERTURA } from "../../../test/tiempos.js";

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });

const N_CLIENTES = 2000;
const MUESTRAS = 30;
const LIMITE_MS = 300;

let b: BancoBandeja;
let E: Estudio;
let dueno: Actor;
let a15: Actor;
let a500: Actor;
let clienteIds: string[] = [];
let falloSiembra: string | null = null;

const p95 = (ms: readonly number[]): number => {
  const orden = [...ms].sort((x, y) => x - y);
  return orden[Math.ceil(orden.length * 0.95) - 1]!;
};

/** Mensajes por cliente (índice 0-based): 500 para los 15 primeros, 100 hasta el 500, 30 hasta el 1000 y 29 el resto = 100.000. */
const mensajesDe = (idx: number): number => (idx < 15 ? 500 : idx < 500 ? 100 : idx < 1000 ? 30 : 29);

beforeAll(async () => {
  b = await abrirBancoBandeja();
  E = await b.estudio();
  const p = b.v.b.c.p.b;
  dueno = E.titular;
  a15 = await p.miembro(E.tenantId, "contador");
  a500 = await p.miembro(E.tenantId, "contador");
  const cs = await b.clientesMasivos(E.tenantId, N_CLIENTES, { prefijo: "Rendimiento", archivado: (i) => i % 50 === 49 });
  clienteIds = cs.map((c) => c.id);
  await b.asignarMasivo(E.tenantId, a15.id, clienteIds.slice(0, 15), "colaborador");
  await b.asignarMasivo(E.tenantId, a500.id, clienteIds.slice(0, 500), "colaborador");
  try {
    await b.sqlReplica(
      `insert into buzon_mensaje
         (id, tenant_id, cliente_id, id_sunat, asunto, remitente, fecha, categoria, critico, motivo_critico, version_catalogo, avisado,
          leido_sunat, primera_captura_en, ultima_captura_en, adjuntos_declarados, historico, atendido_en, atendido_por)
       select gen_random_uuid(), $1, c.id, 'R-' || c.idx || '-' || g, 'Asunto ' || g, 'SUNAT',
              now() - (((c.idx * 37 + g * 1013) % 400000) * interval '1 minute'),
              case when x.h % 4 = 0 then 'coactiva' else 'otro' end, x.h % 4 = 0, case when x.h % 4 = 0 then 'codigo' end, 1, false,
              x.h % 3 = 0, now(), now(), 0,
              x.h >= 85, case when x.h between 70 and 84 then now() - interval '1 hour' end,
              case when x.h between 70 and 84 then $4::uuid end
         from (select u.id, (u.idx - 1)::int as idx, u.n from unnest($2::uuid[], $3::int[]) with ordinality as u(id, n, idx)) c
        cross join lateral generate_series(1, c.n) g
        cross join lateral (select ((c.idx * 19 + g * 29) % 100) as h) x`,
      [E.tenantId, clienteIds, clienteIds.map((_, i) => mensajesDe(i)), dueno.id],
      // Sin triggers ni RLS: la siembra la hace el migrador en modo réplica, como en CA-9.
    );
  } catch (e) {
    falloSiembra = e instanceof Error ? e.message : String(e);
    return;
  }
  await b.sql("VACUUM (ANALYZE) buzon_mensaje");
  await b.sql("ANALYZE cliente");
  await b.sql("ANALYZE asignacion");
});
afterAll(async () => {
  await b?.cerrar();
});

const exigirSiembra = () => {
  if (falloSiembra !== null) throw new Error(`no se pudo sembrar (¿migración 0059 de T7?): ${falloSiembra}`);
};

describe("siembra de CA-9", () => {
  it("2.000 clientes y 100.000 mensajes en un estudio, 70 % pendientes", async () => {
    exigirSiembra();
    const [f] = await b.sql(
      `select count(*)::int total,
              count(*) filter (where atendido_en is null and not historico)::int pendientes,
              count(*) filter (where atendido_en is not null)::int atendidos,
              count(*) filter (where historico and atendido_en is null)::int historicos,
              count(*) filter (where critico and atendido_en is null and not historico)::int criticos_pendientes
         from buzon_mensaje where tenant_id = $1`,
      [E.tenantId],
    );
    expect(f.total).toBe(100_000);
    expect(f.pendientes / f.total).toBeGreaterThan(0.68);
    expect(f.pendientes / f.total).toBeLessThan(0.72);
    expect(f.atendidos).toBeGreaterThan(10_000);
    expect(f.historicos).toBeGreaterThan(10_000);
    expect(f.criticos_pendientes).toBeGreaterThan(15_000);
    expect(Number((await b.sql("select count(*)::int n from cliente where tenant_id = $1", [E.tenantId]))[0].n)).toBe(N_CLIENTES);
  });
});

interface Vista {
  nombre: string;
  query: string;
  filtros: { atencion?: "pendientes"; categoria?: "criticos" };
}
const VISTAS: Vista[] = [
  { nombre: "sin filtros", query: "", filtros: {} },
  { nombre: "Pendientes", query: "atencion=pendientes", filtros: { atencion: "pendientes" } },
  { nombre: "Críticos pendientes", query: "atencion=pendientes&categoria=criticos", filtros: { atencion: "pendientes", categoria: "criticos" } },
];
const USUARIOS: { nombre: string; actor: () => Actor; alcance: () => { tipo: "global" } | { tipo: "asignado"; usuarioId: string } }[] = [
  { nombre: "global (Dueño)", actor: () => dueno, alcance: () => ({ tipo: "global" }) },
  { nombre: "asignado a 15", actor: () => a15, alcance: () => ({ tipo: "asignado", usuarioId: a15.id }) },
  { nombre: "asignado a 500", actor: () => a500, alcance: () => ({ tipo: "asignado", usuarioId: a500.id }) },
];

describe("CA-9 · p95 < 300 ms de la primera página y de la página 20 de la bandeja", () => {
  for (const u of USUARIOS) {
    for (const v of VISTAS) {
      it(`${u.nombre} · ${v.nombre}`, async () => {
        exigirSiembra();
        const a = u.actor();
        const url = (cursor: string | null) =>
          `/buzon/mensajes?${[v.query, "limite=50", cursor === null ? "" : `cursor=${encodeURIComponent(cursor)}`].filter(Boolean).join("&")}`;
        // La página 20 se alcanza recorriendo 19 páginas (sin medir) para tener su cursor.
        let cursor: string | null = null;
        for (let pagina = 1; pagina < 20; pagina++) {
          const r: any = await b.llamar(a, "GET", url(cursor));
          expect(r.status, `página ${pagina}: ${r.text}`).toBe(200);
          expect(r.body.mensajes, `página ${pagina}`).toHaveLength(50);
          cursor = r.body.siguiente;
          expect(cursor, `la página ${pagina + 1} debe existir`).not.toBeNull();
        }
        for (const [nombre, c] of [["primera", null], ["20", cursor]] as const) {
          for (let i = 0; i < 3; i++) await b.llamar(a, "GET", url(c)); // calentamiento: plan y caché
          const ms: number[] = [];
          for (let i = 0; i < MUESTRAS; i++) {
            const r = await b.llamar(a, "GET", url(c));
            expect(r.status, r.text).toBe(200);
            expect(r.body.mensajes.length).toBeGreaterThan(0);
            ms.push(r.ms);
          }
          if (!BAJO_COBERTURA) expect(p95(ms), `página ${nombre}: p95 ${p95(ms)} ms`).toBeLessThan(LIMITE_MS);
        }
      });
    }
  }
});

describe("CA-9 · p95 < 300 ms del listado de clientes con indicador", () => {
  for (const u of USUARIOS) {
    it(`${u.nombre}: GET /clientes con \`buzon\` en cada fila`, async () => {
      exigirSiembra();
      const a = u.actor();
      const primera = await b.llamar(a, "GET", "/clientes");
      expect(primera.status, primera.text).toBe(200);
      const esperados = u.nombre.includes("15") ? 15 : u.nombre.includes("500") ? 490 : N_CLIENTES - N_CLIENTES / 50; // sin los archivados
      expect((primera.body as any[]).length).toBe(esperados);
      for (const c of primera.body as any[]) expect(c.buzon, c.razonSocial).toEqual({ nuevos: expect.any(Number), criticosNuevos: expect.any(Number) });
      const total = (primera.body as any[]).reduce((n, c) => n + c.buzon.nuevos, 0);
      expect(total).toBeGreaterThan(0);
      for (let i = 0; i < 3; i++) await b.llamar(a, "GET", "/clientes");
      const ms: number[] = [];
      for (let i = 0; i < MUESTRAS; i++) {
        const r = await b.llamar(a, "GET", "/clientes");
        expect(r.status, r.text).toBe(200);
        ms.push(r.ms);
      }
      if (!BAJO_COBERTURA) expect(p95(ms), `p95 ${p95(ms)} ms`).toBeLessThan(LIMITE_MS);
    });
  }

  it("con el filtro «con mensajes nuevos» también", async () => {
    exigirSiembra();
    const ms: number[] = [];
    for (let i = 0; i < MUESTRAS + 3; i++) {
      const r = await b.llamar(dueno, "GET", "/clientes?conMensajesNuevos=1");
      expect(r.status, r.text).toBe(200);
      expect((r.body as any[]).length).toBeGreaterThan(0);
      expect((r.body as any[]).every((c) => c.buzon?.nuevos > 0), "solo clientes con mensajes nuevos").toBe(true);
      if (i >= 3) ms.push(r.ms);
    }
    if (!BAJO_COBERTURA) expect(p95(ms), `p95 ${p95(ms)} ms`).toBeLessThan(LIMITE_MS);
  });
});

// --- Planes de ejecución -------------------------------------------------------------------------------------------------------

type Plan = Record<string, any>;
interface PlanDe {
  /** Primeros caracteres del SELECT que emitió el repositorio (sin valores), para el mensaje del fallo. */
  consulta: string;
  plan: Plan;
}
/** Todos los nodos de un plan de `EXPLAIN (FORMAT JSON)` (incluye subplanes y CTE). */
function nodos(plan: Plan | undefined): Plan[] {
  if (plan === undefined) return [];
  return [plan, ...((plan.Plans as Plan[] | undefined) ?? []).flatMap((p) => nodos(p))];
}
function barridos(planes: PlanDe[]): string[] {
  return planes.flatMap((p) =>
    nodos(p.plan.Plan)
      .filter((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === "buzon_mensaje")
      .map((n) => `Seq Scan sobre ${n["Relation Name"]} en: ${p.consulta}`),
  );
}

const fn = (nombre: string): ((...a: any[]) => Promise<any>) => {
  const f = (repo as unknown as Record<string, unknown>)[nombre];
  if (typeof f !== "function") throw new Error(`@contapp/db aún no exporta ${nombre} (T7)`);
  return f as (...a: any[]) => Promise<any>;
};

describe("CA-9 · ningún plan hace un barrido secuencial de buzon_mensaje", () => {
  let admin: ReturnType<typeof createDb>;
  beforeAll(() => {
    const url = process.env.MIGRATIONS_DATABASE_URL;
    if (!url) throw new Error("falta MIGRATIONS_DATABASE_URL");
    admin = createDb({ rolApp: "contapp_backend", url, poolMax: 2 });
  });
  afterAll(async () => {
    await admin?.close();
  });

  /** Corre `accion` con la `tx` de withTenant, anota cada SELECT y devuelve el `EXPLAIN` de todos. */
  async function planes(userId: string, accion: (tx: any) => Promise<unknown>): Promise<{ consultas: number; planes: PlanDe[] }> {
    return admin.withTenant({ tenantId: E.tenantId, userId }, async (tx) => {
      const vistas: { texto: string; valores: unknown[] }[] = [];
      const intermedia = {
        query: (texto: string, valores?: unknown[]) => {
          vistas.push({ texto, valores: valores ?? [] });
          return tx.query(texto, valores);
        },
      };
      await accion(intermedia);
      const salida: PlanDe[] = [];
      for (const q of vistas) {
        if (!/^\s*(select|with)\b/i.test(q.texto)) continue;
        // El texto es el SELECT que emitió el repositorio (ya parametrizado): aquí solo se le antepone EXPLAIN para leer su plan.
        // eslint-disable-next-line sql-crudo/sin-sql-crudo -- EXPLAIN del texto del repositorio, con sus mismos parámetros
        const r = await tx.query(`EXPLAIN (FORMAT JSON) ${q.texto}`, q.valores);
        for (const plan of r.rows[0]["QUERY PLAN"] as Plan[]) salida.push({ consulta: q.texto.replace(/\s+/g, " ").slice(0, 160), plan });
      }
      return { consultas: vistas.length, planes: salida };
    });
  }

  for (const u of USUARIOS) {
    for (const v of VISTAS) {
      it(`listarBandeja · ${u.nombre} · ${v.nombre}, primera página y página 20`, async () => {
        exigirSiembra();
        const listar = fn("listarBandeja");
        const usuario = u.actor();
        // Posición de la página 20: la última fila de las 950 primeras (valor, no desplazamiento).
        const hasta950 = await admin.withTenant({ tenantId: E.tenantId, userId: usuario.id }, (tx) => listar(tx, u.alcance(), v.filtros, null, 950));
        expect(hasta950.filas.length, "debe haber al menos 950 filas para la página 20").toBe(950);
        const ultima = hasta950.filas[949];
        const posicion = { fecha: ultima.fechaTexto, id: ultima.id };
        for (const pos of [null, posicion]) {
          const r = await planes(usuario.id, (tx) => listar(tx, u.alcance(), v.filtros, pos, 50));
          expect(r.consultas).toBeGreaterThan(0);
          expect(r.planes.length).toBeGreaterThan(0);
          expect(barridos(r.planes), `${u.nombre} · ${v.nombre} · ${pos === null ? "primera" : "página 20"}`).toEqual([]);
        }
      });
    }
  }

  it("listarBandeja · global con «solo donde soy responsable» y «incluir archivados» no barre buzon_mensaje", async () => {
    exigirSiembra();
    const listar = fn("listarBandeja");
    for (const filtros of [{ responsableId: dueno.id }, { archivados: true }, { atencion: "historicos" }, { atencion: "atendidos" }, { atencion: "todos", leido: false }]) {
      const r = await planes(dueno.id, (tx) => listar(tx, { tipo: "global" }, filtros, null, 50));
      expect(barridos(r.planes), JSON.stringify(filtros)).toEqual([]);
    }
  });

  it("listarBandeja · bandeja fijada en un cliente (con 500 mensajes) tampoco barre buzon_mensaje", async () => {
    exigirSiembra();
    const listar = fn("listarBandeja");
    for (const atencion of ["pendientes", "todos"]) {
      const r = await planes(dueno.id, (tx) => listar(tx, { tipo: "global" }, { clienteId: clienteIds[0], atencion }, null, 50));
      expect(barridos(r.planes), atencion).toEqual([]);
    }
  });

  for (const u of USUARIOS) {
    it(`listado de clientes con indicador · ${u.nombre}: listarClientesFiltrado, conMensajesNuevos e indicadorBuzon`, async () => {
      exigirSiembra();
      const listar = fn("listarClientesFiltrado");
      const indicador = fn("indicadorBuzon");
      const usuario = u.actor();
      const todos = await planes(usuario.id, async (tx) => {
        const filas = await listar(tx, u.alcance(), {});
        await indicador(tx, filas.map((c: any) => c.id));
      });
      expect(todos.planes.length).toBeGreaterThan(1);
      expect(barridos(todos.planes), "listado + indicador").toEqual([]);
      const filtrado = await planes(usuario.id, (tx) => listar(tx, u.alcance(), { conMensajesNuevos: true }));
      expect(barridos(filtrado.planes), "filtro conMensajesNuevos").toEqual([]);
    });
  }

  it("el indicador se calcula en UNA consulta para todos los clientes del listado, no una por cliente", async () => {
    exigirSiembra();
    const indicador = fn("indicadorBuzon");
    const r = await planes(dueno.id, (tx) => indicador(tx, clienteIds.slice(0, 500)));
    expect(r.consultas).toBe(1);
  });
});
