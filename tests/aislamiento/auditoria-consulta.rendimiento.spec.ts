// Spec 031 (T1, rojo) · CA-9 (RNF-034): la consulta de auditoria con filtros escala como indice, no como recorrido, con 200 000 filas de
// auditoria y 50 000 descifrados. Se mide COMPLEJIDAD, no milisegundos (regla del proyecto, plan §Decisiones): razon entre un cuarto de la carga
// y la carga completa, con los buffers (shared hit + read) de `EXPLAIN (ANALYZE, BUFFERS)` de la propia consulta (no se lee el pseudo-FS de procesos: en CI
// Postgres es un contenedor de servicio; `medirEscala` mide CPU del proceso de Node, no de PG), rondas intercaladas con el orden invertido
// en las impares, tope <= 2 (indice ~ 1; lineal ~ 4). No se sube un tope para que pase.
// Ademas: cada filtro usa el indice esperado y no hace recorrido secuencial (contadores de pg_stat_user_*). El p95 en ms es informativo.
// Va en `*.rendimiento.spec.ts` y queda fuera de la cobertura. Rojo por: 0088 ausente (filtros e indices) o filtros que se ignoran.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abrirAdmin, exportado } from "./auditoria-soporte";
import { EscenarioConsulta, SIN_FILTROS, filtros, type Alcance, type Filtros } from "./auditoria-consulta-soporte";
import type { ContappDb, Tx } from "./soporte";

const N_AUD = 200_000;
const N_DES = 50_000;
const FACTOR = 4; // el lado chico lleva un cuarto de la carga
const SPAN_MS = 39 * 86_400_000; // las dos cargas cubren los mismos 39 dias: una ventana de fechas toca mas filas en la completa
const RONDAS = 3; // los buffers son deterministas: unas pocas rondas intercaladas bastan (se toma el minimo de cada lado)
const TOPE_RAZON = 2;
const PISO_BUFFERS = 10; // una pagina de 50 filas ya cuesta mas: el piso solo evita dividir por casi cero
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

interface Carga {
  tenantId: string;
  nAud: number;
  uRaro: string; // 40 filas de auditoria
  uAsignado: string; // asignado a cChico
  cGrande: string; // la mitad de las filas
  cChico: string; // 40 filas de auditoria y 40 descifrados
  userId: string; // sesion
  ventana: { desde: Date; hastaExclusivo: Date }; // 1 hora al medio del periodo
}

let admin: Pool;
let ec: EscenarioConsulta;
let db: ContappDb;
let completa: Carga;
let cuarto: Carga;
const listar = (): ((tx: Tx, o: unknown) => Promise<{ id: string }[]>) => exportado("listarAuditoria");

async function sembrar(nAud: number, nDes: number): Promise<Carga> {
  const tenantId = (await ec.estudio()).id;
  const userId = (await ec.miembro(tenantId)).id;
  const uRaro = (await ec.miembro(tenantId)).id;
  const uAsignado = (await ec.miembro(tenantId)).id;
  const cGrande = (await ec.cliente(tenantId)).id;
  const cChico = (await ec.cliente(tenantId)).id;
  await ec.asignar(tenantId, cChico, uAsignado, "colaborador");
  const pasoAud = Math.floor(SPAN_MS / nAud);
  const pasoDes = Math.floor(SPAN_MS / nDes);
  const raraAud = Math.floor(nAud / 40); // residuos 3, 5 y 7 de g % raraAud: 40 filas cada uno, sea cual sea la carga
  const raraDes = Math.floor(nDes / 40);
  await admin.query(
    `insert into auditoria (tenant_id, ocurrida_en, actor_tipo, usuario_id, accion, cliente_id, entidad, datos)
     select $1, ts, case when u is null then 'sistema' else 'usuario' end, u, a, c, 'cliente', '{}'::jsonb
       from (select g,
               date_trunc('milliseconds', $2::timestamptz + (g::float8 * $3::float8) * interval '1 millisecond') as ts,
               case when g % $5::int = 3 then $6::uuid
                    when g % 7 = 0 then null
                    else ('00000000-0000-4000-8000-' || lpad((g % 10)::text, 12, '0'))::uuid end as u,
               case when g % $5::int = 5 then 'venta.salto_justificado'
                    when g % 3 = 0 then 'cliente.editado'
                    when g % 3 = 1 then 'compra.operacion'
                    else 'periodo.estado_cambiado' end as a,
               case when g % $5::int = 7 then $8::uuid
                    when g % 2 = 0 then $7::uuid
                    else ('00000000-0000-4000-8001-' || lpad((g % 50)::text, 12, '0'))::uuid end as c
               from generate_series(1, $4::int) g) s`,
    [tenantId, new Date(T0).toISOString(), pasoAud, nAud, raraAud, uRaro, cGrande, cChico],
  );
  await admin.query(
    `insert into auditoria_descifrado (tenant_id, credencial_id, cliente_id, tipo, motivo, resultado, created_at)
     select $1, gen_random_uuid(),
            case when g % $5::int = 7 then $3::uuid when g % 2 = 0 then $2::uuid else null end,
            'sol', 'verificar', 'ok', $4::timestamptz + (g::float8 * $6::float8) * interval '1 millisecond'
       from generate_series(1, $7::int) g`,
    [tenantId, cGrande, cChico, new Date(T0).toISOString(), raraDes, pasoDes, nDes],
  );
  const medio = T0 + Math.floor(SPAN_MS / 2);
  return {
    tenantId,
    nAud,
    uRaro,
    uAsignado,
    cGrande,
    cChico,
    userId,
    ventana: { desde: new Date(medio), hastaExclusivo: new Date(medio + 3_600_000) },
  };
}

beforeAll(async () => {
  admin = abrirAdmin(6);
  ec = new EscenarioConsulta(admin);
  db = ec.backend;
  cuarto = await sembrar(N_AUD / FACTOR, N_DES / FACTOR);
  completa = await sembrar(N_AUD, N_DES);
  await admin.query("analyze auditoria");
  await admin.query("analyze auditoria_descifrado");
}, 900_000);

afterAll(async () => {
  await ec?.limpiar();
  await ec?.cerrar();
  await admin?.end();
}, 300_000);

const global: Alcance = { tipo: "global" };

interface Caso {
  nombre: string;
  f: (c: Carga) => Filtros;
  alcance: (c: Carga) => Alcance;
  /** Indices que la consulta debe usar (por definicion: el nombre lo elige T5). */
  indices: { tabla: "auditoria" | "auditoria_descifrado"; patron: RegExp }[];
}

const IDX = {
  accion: { tabla: "auditoria", patron: /\(tenant_id, accion, ocurrida_en DESC(?: NULLS (?:LAST|FIRST))?, id DESC(?: NULLS (?:LAST|FIRST))?\)/ },
  usuario: { tabla: "auditoria", patron: /\(tenant_id, usuario_id, ocurrida_en DESC(?: NULLS (?:LAST|FIRST))?, id DESC(?: NULLS (?:LAST|FIRST))?\)/ },
  clienteAud: { tabla: "auditoria", patron: /\(tenant_id, cliente_id, ocurrida_en DESC(?: NULLS (?:LAST|FIRST))?, id DESC(?: NULLS (?:LAST|FIRST))?\)/ },
  fechaAud: { tabla: "auditoria", patron: /\(tenant_id, ocurrida_en DESC(?: NULLS (?:LAST|FIRST))?, id DESC(?: NULLS (?:LAST|FIRST))?\)/ },
  fechaDes: { tabla: "auditoria_descifrado", patron: /\(tenant_id, (?!cliente_id)(?!created_at).*created_at.*, id DESC(?: NULLS (?:LAST|FIRST))?\)/ },
  clienteDes: { tabla: "auditoria_descifrado", patron: /\(tenant_id, cliente_id, (?!created_at).*created_at.*, id DESC(?: NULLS (?:LAST|FIRST))?\)/ },
} as const;

const CASOS: Caso[] = [
  { nombre: "accion rara", f: () => filtros({ acciones: ["venta.salto_justificado"] }), alcance: () => global, indices: [IDX.accion] },
  { nombre: "usuario raro", f: (c) => filtros({ usuarioId: c.uRaro }), alcance: () => global, indices: [IDX.usuario] },
  { nombre: "cliente de pocas filas", f: (c) => filtros({ clienteId: c.cChico }), alcance: () => global, indices: [IDX.clienteAud, IDX.clienteDes] },
  {
    nombre: "asignado a un cliente de pocas filas",
    f: () => SIN_FILTROS,
    alcance: (c) => ({ tipo: "asignado", usuarioId: c.uAsignado }),
    indices: [IDX.clienteAud, IDX.clienteDes],
  },
  {
    nombre: "solo credencial.descifrada",
    f: () => filtros({ acciones: ["credencial.descifrada"] }),
    alcance: () => global,
    indices: [IDX.fechaDes],
  },
  { nombre: "ventana de una hora", f: (c) => filtros(c.ventana), alcance: () => global, indices: [IDX.fechaAud, IDX.fechaDes] },
  { nombre: "sin filtros (primera pagina)", f: () => SIN_FILTROS, alcance: () => global, indices: [IDX.fechaAud, IDX.fechaDes] },
];

// ---- medicion --------------------------------------------------------------------------------------------------------------------------
/**
 * Buffers (shared hit + read) que toca el plan de la consulta, medidos con `EXPLAIN (ANALYZE, BUFFERS)` sobre el MISMO texto y parametros que
 * `listarAuditoria` (se intercepta su unica llamada a `tx.query`). Es la metrica de la prueba y no el tiempo de CPU del backend de PG: leer
 * el sistema de archivos de procesos del SO exige que PG corra en el mismo kernel/espacio de pids que el runner, y en CI Postgres es un contenedor de servicio.
 * Los buffers son deterministas (no dependen de la carga de la maquina ni de la cache) y miden exactamente "escala como indice": un indice
 * toca ~log(n) paginas mas las de las filas devueltas; un recorrido, ~n. Es el nodo raiz del plan (acumulado, incluye la funcion de descifrados).
 */
async function buffers(c: Carga, caso: Caso): Promise<number> {
  return db.withTenant({ tenantId: c.tenantId, userId: c.userId }, async (tx) => {
    let total = -1;
    const espia = {
      query: async (texto: string, valores?: unknown[]) => {
        const r = await tx.query(`explain (analyze, buffers, format json) ${texto}`, valores);
        const plan = (r.rows[0] as { "QUERY PLAN": { Plan: Record<string, number> }[] })["QUERY PLAN"][0]!.Plan;
        total = (plan["Shared Hit Blocks"] ?? 0) + (plan["Shared Read Blocks"] ?? 0);
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Tx;
    await listar()(espia, { limite: 50, alcance: caso.alcance(c), filtros: caso.f(c) });
    expect(total, `${caso.nombre}: no se obtuvo el plan`).toBeGreaterThan(0);
    return total;
  });
}

describe("CA-9 · la consulta con filtros escala como indice (carga completa / un cuarto <= 2)", () => {
  it("las dos cargas existen con la proporcion esperada y devuelven filas por cada caso (no se mide una respuesta vacia)", async () => {
    const n = async (t: string, tabla: string) => Number((await admin.query(`select count(*) as n from ${tabla} where tenant_id = $1`, [t])).rows[0].n);
    expect(await n(completa.tenantId, "auditoria")).toBeGreaterThanOrEqual(N_AUD);
    expect(await n(completa.tenantId, "auditoria_descifrado")).toBe(N_DES);
    expect(await n(cuarto.tenantId, "auditoria")).toBeGreaterThanOrEqual(N_AUD / FACTOR);
    for (const caso of CASOS) {
      for (const c of [completa, cuarto]) {
        const filas = await db.withTenant({ tenantId: c.tenantId, userId: c.userId }, (tx) =>
          listar()(tx, { limite: 50, alcance: caso.alcance(c), filtros: caso.f(c) }),
        );
        expect(filas.length, `${caso.nombre} (${c === completa ? "completa" : "cuarto"})`).toBeGreaterThan(0);
      }
    }
  }, 120_000);

  it.each(CASOS)("escala: $nombre", async (caso) => {
    let minCuarto = Infinity;
    let minCompleta = Infinity;
    await buffers(completa, caso); // calentamiento de ambos lados (como medirEscala; con buffers no cambia el valor, solo estabiliza el plan)
    await buffers(cuarto, caso);
    for (let r = 0; r < RONDAS; r++) {
      if (r % 2 === 0) {
        minCuarto = Math.min(minCuarto, await buffers(cuarto, caso));
        minCompleta = Math.min(minCompleta, await buffers(completa, caso));
      } else {
        minCompleta = Math.min(minCompleta, await buffers(completa, caso));
        minCuarto = Math.min(minCuarto, await buffers(cuarto, caso));
      }
    }
    const razon = minCompleta / Math.max(minCuarto, PISO_BUFFERS);
    console.info(`[CA-9 razon] ${caso.nombre}: ${minCuarto} (1/4) -> ${minCompleta} (completa) buffers = ${razon.toFixed(2)}`);
    expect(
      razon,
      `${caso.nombre}: ${minCuarto} buffers (1/4) -> ${minCompleta} buffers (completa) por consulta (shared hit + read de EXPLAIN ANALYZE)`,
    ).toBeLessThanOrEqual(TOPE_RAZON);
  }, 300_000);
});

describe("CA-9 · cada filtro usa el indice esperado y no recorre las tablas (pg_stat_user_indexes / pg_stat_user_tables)", () => {
  let defs: { tablename: string; indexname: string; indexdef: string }[];
  beforeAll(async () => {
    defs = (
      await admin.query(
        "select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' and tablename in ('auditoria', 'auditoria_descifrado')",
      )
    ).rows;
  });

  const idxScan = async (nombre: string): Promise<number> =>
    Number((await admin.query("select coalesce(sum(idx_scan), 0) as n from pg_stat_user_indexes where schemaname = 'public' and indexrelname = $1", [nombre])).rows[0].n);
  const seqScan = async (): Promise<number> =>
    Number((await admin.query("select coalesce(sum(seq_scan), 0) as n from pg_stat_user_tables where schemaname = 'public' and relname in ('auditoria', 'auditoria_descifrado')")).rows[0].n);
  const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it.each(CASOS)("$nombre", async (caso) => {
    const buscados = caso.indices.map((i) => {
      const d = defs.find((x) => x.tablename === i.tabla && i.patron.test(x.indexdef));
      expect(d, `falta el indice ${String(i.patron)} en ${i.tabla}`).toBeDefined();
      return d!.indexname;
    });
    const antes = await Promise.all(buscados.map(idxScan));
    const seqAntes = await seqScan();
    const filas = await db.withTenant({ tenantId: completa.tenantId, userId: completa.userId }, async (tx) => {
      const r = await listar()(tx, { limite: 50, alcance: caso.alcance(completa), filtros: caso.f(completa) });
      // Sin esto PG difiere el volcado de pg_stat hasta ~10 s (PGSTAT_IDLE_INTERVAL): fuerza que el COMMIT lo publique.
      await tx.query("select pg_stat_force_next_flush()");
      return r;
    });
    expect(filas.length).toBeGreaterThan(0);
    // Tras el COMMIT las estadisticas ya estan publicadas; el bucle solo absorbe la latencia de lectura.
    let usados: boolean[] = [];
    for (let i = 0; i < 20; i++) {
      usados = (await Promise.all(buscados.map(idxScan))).map((n, k) => n > antes[k]!);
      if (usados.every(Boolean)) break;
      await pausa(250);
    }
    expect(usados, `indices usados ${buscados.join(", ")}`).toEqual(buscados.map(() => true));
    expect(await seqScan(), "sin recorrido secuencial de auditoria ni de auditoria_descifrado").toBe(seqAntes);
  }, 60_000);
});

describe("CA-9 · p95 por filtro con la carga completa (informativo: sin tope de reloj)", () => {
  it.each(CASOS)("$nombre", async (caso) => {
    const tiempos: number[] = [];
    await db.withTenant({ tenantId: completa.tenantId, userId: completa.userId }, async (tx) => {
      const f = listar();
      for (let i = 0; i < 40; i++) {
        const t0 = performance.now();
        await f(tx, { limite: 50, alcance: caso.alcance(completa), filtros: caso.f(completa) });
        tiempos.push(performance.now() - t0);
      }
    });
    tiempos.sort((a, b) => a - b);
    const p95 = tiempos[Math.ceil(tiempos.length * 0.95) - 1]!;
    console.info(`[CA-9 p95] ${caso.nombre}: ${p95.toFixed(1)} ms (mediana ${tiempos[Math.floor(tiempos.length / 2)]!.toFixed(1)} ms)`);
    expect(p95).toBeGreaterThan(0);
  }, 120_000);
});
