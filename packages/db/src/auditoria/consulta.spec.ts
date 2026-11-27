// Spec 031 (T1, rojo): `listarAuditoria` con filtros y alcance, con una `tx` falsa (D-1, D-3, CA-7). Lo que se fija aqui no depende de la
// BD: el texto SQL es fijo para un alcance dado (los filtros viajan como parametros, nunca en el texto), el alcance asignado cambia el SQL
// (agrega `asignacion`) y el global no, y cada rama de la union lleva su LIMIT. P-5 y P-6 se prueban contra la BD en
// tests/aislamiento/auditoria-consulta.spec.ts. Rojo: `listarAuditoria` aun ignora `alcance` y `filtros` y tiene un solo LIMIT.
import { describe, expect, it } from "vitest";
import type { Alcance } from "../acceso/alcance";
import { listarAuditoria, type FiltrosAuditoria } from "./lectura";

const U = "0190a031-0000-7000-8000-0000000000a1";
const C = "0190a031-0000-7000-8000-0000000000c1";
const ID = "0190a031-0000-7000-8000-0000000000e1";
const ASIGNADO_A = "0190a031-0000-7000-8000-0000000000f1";
const DESDE = new Date("2026-03-10T05:00:00.000Z");
const HASTA = new Date("2026-03-11T05:00:00.000Z");
const GLOBAL: Alcance = { tipo: "global" };
const ASIGNADO: Alcance = { tipo: "asignado", usuarioId: ASIGNADO_A };
const NINGUNO: FiltrosAuditoria = { usuarioId: null, clienteId: null, acciones: null, desde: null, hastaExclusivo: null };
const TODOS: FiltrosAuditoria = {
  usuarioId: U,
  clienteId: C,
  acciones: ["cliente.editado", "credencial.descifrada"],
  desde: DESDE,
  hastaExclusivo: HASTA,
};

function txCon(rows: Record<string, unknown>[] = []) {
  const consultas: { texto: string; valores: unknown[] }[] = [];
  return {
    consultas,
    query: async (texto: string, valores: unknown[]) => {
      consultas.push({ texto, valores });
      return { rows };
    },
  };
}

async function consulta(o: Parameters<typeof listarAuditoria>[1]) {
  const tx = txCon();
  await listarAuditoria(tx as never, o);
  return tx.consultas[0]!;
}

/** Todos los valores enviados, con los arreglos aplanados. */
const planos = (valores: unknown[]): unknown[] => valores.flatMap((v) => (Array.isArray(v) ? v : [v]));

describe("listarAuditoria: el texto SQL es fijo y todo valor viaja como parametro (D-1, CA-7)", () => {
  it.each([
    ["global", GLOBAL],
    ["asignado", ASIGNADO],
  ])("alcance %s: el texto no cambia con ningun filtro", async (_n, alcance) => {
    const base = await consulta({ alcance, filtros: NINGUNO });
    for (const f of [
      TODOS,
      { ...NINGUNO, usuarioId: U },
      { ...NINGUNO, clienteId: C },
      { ...NINGUNO, acciones: ["cliente.editado"] },
      { ...NINGUNO, desde: DESDE },
      { ...NINGUNO, hastaExclusivo: HASTA },
    ]) {
      expect((await consulta({ alcance, filtros: f })).texto).toBe(base.texto);
    }
    expect((await consulta({ alcance })).texto, "sin la clave filtros").toBe(base.texto);
  });

  it("ningun valor aparece en el texto y todos viajan como parametros", async () => {
    const q = await consulta({ alcance: ASIGNADO, filtros: TODOS, antes: { en: DESDE, id: ID }, limite: 20 });
    // (`credencial.descifrada` es la etiqueta fija de la rama de descifrados: puede estar en el texto; los demas valores no)
    for (const crudo of [U, C, ID, ASIGNADO_A, "cliente.editado", "2026-03-1"]) {
      expect(q.texto, crudo).not.toContain(crudo);
    }
    const v = planos(q.valores);
    for (const esperado of [U, C, ASIGNADO_A, "cliente.editado", "credencial.descifrada", ID]) expect(v, String(esperado)).toContain(esperado);
    expect(v.filter((x) => x instanceof Date).map((d) => (d as Date).getTime())).toEqual(expect.arrayContaining([DESDE.getTime(), HASTA.getTime()]));
  });

  it("valores hostiles (comillas, ;, comentarios, %) no cambian el texto: solo van como parametros", async () => {
    const base = await consulta({ alcance: GLOBAL, filtros: TODOS });
    const hostil = "x'; drop table auditoria; -- %_\\\"";
    const q = await consulta({
      alcance: GLOBAL,
      filtros: { ...TODOS, usuarioId: hostil, clienteId: hostil, acciones: [hostil, "a'b"] },
    });
    expect(q.texto).toBe(base.texto);
    expect(q.texto).not.toContain("drop table");
    expect(planos(q.valores)).toEqual(expect.arrayContaining([hostil, "a'b"]));
  });

  it("el cursor y el limite viajan como parametros, el limite recortado a 1..50", async () => {
    const q = await consulta({ alcance: GLOBAL, filtros: NINGUNO, antes: { en: DESDE, id: ID }, limite: 5000 });
    const v = planos(q.valores);
    expect(v).toEqual(expect.arrayContaining([ID, 50]));
    expect(v).not.toContain(5000);
    expect(v.some((x) => x instanceof Date && x.getTime() === DESDE.getTime())).toBe(true);
    expect(planos((await consulta({ alcance: GLOBAL, filtros: NINGUNO, limite: 0 })).valores)).toContain(1);
  });
});

describe("listarAuditoria: alcance (D-3, P-5)", () => {
  it("el alcance asignado agrega las asignaciones al SQL y el global no", async () => {
    const asignado = await consulta({ alcance: ASIGNADO, filtros: NINGUNO });
    const global = await consulta({ alcance: GLOBAL, filtros: NINGUNO });
    expect(asignado.texto).toMatch(/asignacion/i);
    expect(global.texto).not.toMatch(/asignacion/i);
    expect(asignado.texto).toMatch(/cliente_id\s+is\s+not\s+null/i); // P-5: las filas sin cliente no se ven
    expect(planos(asignado.valores)).toContain(ASIGNADO_A);
    expect(planos(global.valores)).not.toContain(ASIGNADO_A);
  });

  it("el alcance es de quien llama, no del filtro: usuarioId no reemplaza al alcance", async () => {
    const q = await consulta({ alcance: ASIGNADO, filtros: { ...NINGUNO, usuarioId: U } });
    expect(planos(q.valores)).toEqual(expect.arrayContaining([U, ASIGNADO_A]));
    expect(q.texto).toMatch(/asignacion/i);
  });

  it("falla cerrado: sin alcance valido nunca se pide el estudio entero", async () => {
    for (const malo of [undefined, null, {}, { tipo: "todos" }, { tipo: "asignado" }]) {
      const tx = txCon();
      let q: { texto: string; valores: unknown[] } | undefined;
      try {
        await listarAuditoria(tx as never, { alcance: malo as never, filtros: NINGUNO });
        q = tx.consultas[0];
      } catch {
        continue; // lanzar tambien es fallar cerrado
      }
      // Si la consulta salio, tiene que haber quedado restringida a asignaciones (como el alcance asignado), nunca el SQL global.
      expect(q?.texto, JSON.stringify(malo)).toMatch(/asignacion/i);
    }
  });
});

describe("listarAuditoria: cada rama lleva sus filtros y su LIMIT (D-1)", () => {
  it("el SQL tiene un LIMIT por rama de la union ademas del de la union (al menos 2 en el texto)", async () => {
    for (const alcance of [GLOBAL, ASIGNADO]) {
      const { texto } = await consulta({ alcance, filtros: TODOS });
      expect((texto.match(/\blimit\b/gi) ?? []).length, JSON.stringify(alcance)).toBeGreaterThanOrEqual(2);
    }
  });

  it("la rama de descifrados se pide con la funcion nueva de 8 argumentos (no la de 017)", async () => {
    const { texto } = await consulta({ alcance: GLOBAL, filtros: TODOS });
    const llamada = /auditoria_descifrado_listar\s*\(([^)]*)\)/i.exec(texto);
    expect(llamada, "llama a auditoria_descifrado_listar").not.toBeNull();
    // 8 parametros posicionales: $1 .. $n separados por coma (con los casts de la llamada)
    expect(llamada![1]!.split(",").length).toBe(8);
  });

  it("el SQL sigue leyendo solo el contrato de 017 (ocurrida_en, id) y ordena por ocurrida_en desc, id desc", async () => {
    const { texto } = await consulta({ alcance: GLOBAL, filtros: NINGUNO });
    expect(texto).toMatch(/order by\s+ocurrida_en\s+desc,\s*id\s+desc/i);
    expect(texto).toMatch(/\bauditoria\b/);
  });
});

describe("listarAuditoria: el mapeo de filas no cambia (D-5)", () => {
  it("pasa de columnas a camelCase y conserva los nulos", async () => {
    const ocurrida = new Date("2026-03-10T12:00:00.123Z");
    const tx = txCon([
      {
        id: ID,
        ocurrida_en: ocurrida,
        accion: "credencial.descifrada",
        actor_tipo: "sistema",
        usuario_id: null,
        trabajo_id: null,
        cliente_id: C,
        entidad: "auditoria_descifrado",
        entidad_id: ID,
        datos: { tipo: "sol" },
      },
    ]);
    expect(await listarAuditoria(tx as never, { alcance: GLOBAL, filtros: TODOS })).toEqual([
      {
        id: ID,
        ocurridaEn: ocurrida,
        accion: "credencial.descifrada",
        actorTipo: "sistema",
        usuarioId: null,
        trabajoId: null,
        clienteId: C,
        entidad: "auditoria_descifrado",
        entidadId: ID,
        datos: { tipo: "sol" },
      },
    ]);
  });
});
