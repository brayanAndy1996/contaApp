/* eslint-disable @typescript-eslint/no-explicit-any -- cuerpos JSON, filas de BD y planes de ejecución dinámicos en pruebas */
// Spec 025 (T6, rojo): rendimiento de la lista de candidatas (RNF-034; CA-13; plan «Riesgos: lista de 1.000 candidatas con conflicto calculado»).
// Un cliente con una importación completada y 1.000 candidatas: 400 propuestas, 300 en conflicto (150 `ya_aprendida` y 150 `distinto`,
// con su regla viva), 150 sin criterio claro y 150 resueltas (60 activadas con su regla y 90 descartadas). Para que el plan no pueda
// elegir un barrido por ser la tabla pequeña, otros 20 clientes del estudio llevan 1.500 candidatas pendientes cada uno (30.000 filas
// más), todo con `ANALYZE`.
//  - p95 < 300 ms en 30 lecturas por grupo (primera página de 100 y una intermedia por cursor). Como en `buzon/bandeja.rendimiento.int.spec.ts`,
//    el tiempo no se evalúa bajo cobertura (DT-1); lo funcional corre siempre.
//  - `EXPLAIN (FORMAT JSON)` de cada consulta de `listarCandidatas` (repositorio de `@contapp/db`, con la `tx` de `withTenant` y el rol
//    del backend: la RLS entra en el plan): ningún nodo `Seq Scan` sobre `regla_candidata`.
// Rojo: la ruta no existe (404) y `listarCandidatas` lanza «no implementado» (T10 y T12); las tablas son de T10.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "@contapp/db";
import * as repo from "@contapp/db";
import { BAJO_COBERTURA } from "../../../test/tiempos.js";
import {
  abrirBancoAprendizaje,
  rutaCandidatas,
  type Actor,
  type BancoAprendizaje,
  type Destino,
  type Estudio,
} from "../../../test/soporte-aprendizaje.js";

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });

const MUESTRAS = 30;
const LIMITE_MS = 300;
const N_RELLENO = 20;
const POR_RELLENO = 1500;
const GRUPOS = { propuestas: 400, sin_criterio: 150, conflicto: 300, resueltas: 150 } as const;
type Grupo = keyof typeof GRUPOS;

let v: BancoAprendizaje;
let E: Estudio;
let contador: Actor;
let cliente: { id: string; ruc: string };
let importacionId = "";
let falloSiembra: string | null = null;

const p95 = (ms: readonly number[]): number => {
  const orden = [...ms].sort((x, y) => x - y);
  return orden[Math.ceil(orden.length * 0.95) - 1]!;
};
const doc = (n: number): string => `20800${String(n).padStart(6, "0")}`;

beforeAll(async () => {
  v = await abrirBancoAprendizaje();
  E = await v.estudio();
  contador = await v.b.c.p.b.miembro(E.tenantId, "contador");
  cliente = await v.cliente(E, { responsable: contador.id });
  const u = E.titular.id;
  try {
    importacionId = await v.sembrarImportacion(E.tenantId, cliente.id, { usuarioId: u, candidatas: 1000, solicitadaHace: "1 hour" });
    const destinos: Destino[] = ["DG", "DGNG", "DNG"];
    const reglas: { id: string; docNumero: string; destino: Destino; version: number }[] = [];
    const specs: Parameters<BancoAprendizaje["sembrarCandidatas"]>[3][number][] = [];
    let n = 0;
    for (let i = 0; i < GRUPOS.propuestas; i++) specs.push({ docNumero: doc(++n), destinoPropuesto: destinos[i % 3]! });
    for (let i = 0; i < 150; i++) {
      // ya_aprendida: la regla viva tiene el mismo destino que la propuesta.
      const d = destinos[i % 3]!;
      reglas.push({ id: randomUUID(), docNumero: doc(++n), destino: d, version: 1 });
      specs.push({ docNumero: doc(n), destinoPropuesto: d });
    }
    for (let i = 0; i < 150; i++) {
      // distinta: la regla viva (versión 3) tiene otro destino.
      reglas.push({ id: randomUUID(), docNumero: doc(++n), destino: destinos[(i + 1) % 3]!, version: 3 });
      specs.push({ docNumero: doc(n), destinoPropuesto: destinos[i % 3]! });
    }
    for (let i = 0; i < GRUPOS.sin_criterio; i++) specs.push({ docNumero: doc(++n), destinoPropuesto: null });
    for (let i = 0; i < 60; i++) {
      const d = destinos[i % 3]!;
      const id = randomUUID();
      reglas.push({ id, docNumero: doc(++n), destino: d, version: 1 });
      specs.push({ docNumero: doc(n), destinoPropuesto: d, estado: "activada", reglaId: id });
    }
    for (let i = 0; i < 90; i++) specs.push({ docNumero: doc(++n), destinoPropuesto: "DNG", estado: "descartada" });
    await v.sembrarReglasVivas(E.tenantId, cliente.id, reglas, u);
    await v.sembrarCandidatas(E.tenantId, cliente.id, importacionId, specs, u);

    // Relleno: otros clientes del estudio con muchas candidatas pendientes (sin conflicto) para que el plan use el índice.
    const clientes: string[] = [];
    const importaciones: string[] = [];
    for (let i = 0; i < N_RELLENO; i++) {
      const c = await v.cliente(E, { responsable: contador.id });
      clientes.push(c.id);
      importaciones.push(await v.sembrarImportacion(E.tenantId, c.id, { usuarioId: u, candidatas: POR_RELLENO, solicitadaHace: "1 hour" }));
    }
    await v.b.sql(
      `insert into regla_candidata (tenant_id, cliente_id, importacion_id, doc_tipo, doc_numero, razon_social, destino_propuesto,
         n_dg, n_dgng, n_dng, n_mixto, n_total, periodos_con_proveedor, estado)
       select $1, c.cid, c.iid, '6', '20' || lpad(((g * 7919) % 999999999)::text, 9, '0'), 'RELLENO ' || g, 'DNG', 0, 0, 4, 1, 5, 3, 'pendiente'
         from unnest($2::uuid[], $3::uuid[]) as c(cid, iid) cross join generate_series(1, $4::int) g`,
      [E.tenantId, clientes, importaciones, POR_RELLENO],
    );
    await v.b.sql("ANALYZE regla_candidata");
    await v.b.sql("ANALYZE regla_aprendida");
    await v.b.sql("ANALYZE regla_importacion");
  } catch (e) {
    // Sin las tablas de T10 no se puede sembrar: las pruebas dirán por qué; con ellas, cualquier otro error se muestra igual.
    falloSiembra = e instanceof Error ? e.message : String(e);
  }
});
afterAll(async () => {
  await v?.cerrar();
});

const exigirSiembra = (): void => {
  if (falloSiembra !== null) throw new Error(`no se pudo sembrar (¿migración 0061 de T10?): ${falloSiembra}`);
};

describe("siembra de CA-13", () => {
  it("1.000 candidatas con 300 en conflicto (150 ya aprendidas y 150 distintas), 150 sin criterio y 150 resueltas", async () => {
    exigirSiembra();
    const filas = await v.b.sql(
      `select estado, destino_propuesto is null as sin_destino, count(*)::int n from regla_candidata where cliente_id = $1 group by 1, 2`,
      [cliente.id],
    );
    const total = filas.reduce((s: number, f: any) => s + f.n, 0);
    expect(total).toBe(1000);
    expect(filas.find((f: any) => f.estado === "activada")?.n).toBe(60);
    expect(filas.find((f: any) => f.estado === "descartada")?.n).toBe(90);
    expect(filas.find((f: any) => f.estado === "pendiente" && f.sin_destino)?.n).toBe(150);
    const [r] = await v.b.sql(
      `select count(*)::int n from regla_candidata c join regla_aprendida r on r.tenant_id = c.tenant_id and r.cliente_id = c.cliente_id
         and r.doc_tipo = c.doc_tipo and r.doc_numero = c.doc_numero where c.cliente_id = $1 and c.estado = 'pendiente' and r.activa and r.eliminada_en is null`,
      [cliente.id],
    );
    expect(r.n).toBe(300);
    expect(Number((await v.b.sql("select count(*)::int n from regla_candidata where tenant_id = $1", [E.tenantId]))[0].n)).toBe(1000 + N_RELLENO * POR_RELLENO);
  });
});

/** Recorre un grupo entero por cursor y devuelve lo visto, en orden. */
async function recorrer(grupo: Grupo, limite = 100): Promise<any[]> {
  const vistas: any[] = [];
  let cursor: string | null = null;
  for (let pagina = 1; pagina <= 20; pagina++) {
    const q: string = `?grupo=${grupo}&limite=${limite}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
    const r = await v.http(contador, "GET", `${rutaCandidatas(cliente.id)}${q}`);
    expect(r.status, `${grupo} página ${pagina}: ${r.text}`).toBe(200);
    vistas.push(...r.body.candidatas);
    cursor = r.body.siguiente;
    if (cursor === null) return vistas;
  }
  throw new Error(`el cursor de ${grupo} no termina`);
}

describe("CA-13 · la lista completa de cada grupo es correcta con 1.000 candidatas", () => {
  it.each(Object.entries(GRUPOS))("%s: %i candidatas, sin repetir y en orden de documento", async (grupo, esperadas) => {
    exigirSiembra();
    const vistas = await recorrer(grupo as Grupo);
    expect(vistas).toHaveLength(esperadas);
    expect(new Set(vistas.map((x) => x.id)).size).toBe(esperadas);
    const docs = vistas.map((x) => `${x.proveedor.tipo}|${x.proveedor.numero}`);
    expect(docs).toEqual([...docs].sort());
    if (grupo === "conflicto") {
      expect(vistas.filter((x) => x.conflicto === "ya_aprendida")).toHaveLength(150);
      expect(vistas.filter((x) => x.conflicto === "distinto")).toHaveLength(150);
      for (const x of vistas) expect(x.regla, x.proveedor.numero).not.toBeNull();
    } else if (grupo === "propuestas") {
      for (const x of vistas) expect(x).toMatchObject({ conflicto: "ninguno", regla: null, estado: "pendiente" });
    } else if (grupo === "sin_criterio") {
      for (const x of vistas) expect(x.destinoPropuesto).toBeNull();
    } else {
      expect(vistas.filter((x) => x.estado === "activada")).toHaveLength(60);
      expect(vistas.filter((x) => x.estado === "descartada")).toHaveLength(90);
    }
  });
});

describe("CA-13 · p95 < 300 ms de las lecturas de la lista de candidatas", () => {
  for (const grupo of Object.keys(GRUPOS) as Grupo[]) {
    it(`${grupo}: primera página (100) y página intermedia por cursor`, async () => {
      exigirSiembra();
      const url = (cursor: string | null) => `${rutaCandidatas(cliente.id)}?grupo=${grupo}&limite=100${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      // Cursor de la página 2 (o de la 1 si el grupo cabe en una página y media): se obtiene sin medir.
      const primera = await v.http(contador, "GET", url(null));
      expect(primera.status, primera.text).toBe(200);
      expect(primera.body.candidatas).toHaveLength(Math.min(100, GRUPOS[grupo]));
      const intermedio: string | null = primera.body.siguiente;
      for (const [nombre, cursor] of [["primera", null], ["intermedia", intermedio]] as const) {
        if (nombre === "intermedia" && cursor === null) continue;
        for (let i = 0; i < 3; i++) await v.http(contador, "GET", url(cursor)); // calentamiento: plan y caché
        const ms: number[] = [];
        for (let i = 0; i < MUESTRAS; i++) {
          const r = await v.http(contador, "GET", url(cursor));
          expect(r.status, r.text).toBe(200);
          expect(r.body.candidatas.length).toBeGreaterThan(0);
          ms.push(r.ms);
        }
        if (!BAJO_COBERTURA) expect(p95(ms), `${grupo} · ${nombre}: p95 ${p95(ms)} ms`).toBeLessThan(LIMITE_MS);
      }
    });
  }
});

// --- Planes de ejecución -------------------------------------------------------------------------------------------------------

type Plan = Record<string, any>;
interface PlanDe {
  consulta: string;
  plan: Plan;
}
function nodos(plan: Plan | undefined): Plan[] {
  if (plan === undefined) return [];
  return [plan, ...((plan.Plans as Plan[] | undefined) ?? []).flatMap((p) => nodos(p))];
}
const barridos = (planes: PlanDe[]): string[] =>
  planes.flatMap((p) =>
    nodos(p.plan.Plan)
      .filter((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === "regla_candidata")
      .map((n) => `Seq Scan sobre ${n["Relation Name"]} en: ${p.consulta}`),
  );

const fn = (nombre: string): ((...a: any[]) => Promise<any>) => {
  const f = (repo as unknown as Record<string, unknown>)[nombre];
  if (typeof f !== "function") throw new Error(`@contapp/db aún no exporta ${nombre} (T10)`);
  return f as (...a: any[]) => Promise<any>;
};

describe("CA-13 · ningún plan hace un barrido secuencial de regla_candidata", () => {
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
  async function planes(accion: (tx: any) => Promise<unknown>): Promise<{ consultas: number; planes: PlanDe[] }> {
    return admin.withTenant({ tenantId: E.tenantId, userId: contador.id }, async (tx) => {
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

  for (const grupo of Object.keys(GRUPOS) as Grupo[]) {
    it(`listarCandidatas · ${grupo}: primera página y página siguiente por posición`, async () => {
      exigirSiembra();
      const listar = fn("listarCandidatas");
      const primera = await admin.withTenant({ tenantId: E.tenantId, userId: contador.id }, (tx) =>
        listar(tx, { clienteId: cliente.id, grupo, posicion: null, limite: 100 }),
      );
      expect(primera.candidatas.length).toBe(Math.min(100, GRUPOS[grupo]));
      const posiciones = [null, primera.siguiente].filter((p, i) => i === 0 || p !== null);
      for (const posicion of posiciones) {
        const r = await planes((tx) => listar(tx, { clienteId: cliente.id, grupo, posicion, limite: 100 }));
        expect(r.consultas).toBeGreaterThan(0);
        expect(r.planes.length).toBeGreaterThan(0);
        expect(barridos(r.planes), `${grupo} · ${posicion === null ? "primera" : "siguiente"}`).toEqual([]);
      }
    });
  }
});
