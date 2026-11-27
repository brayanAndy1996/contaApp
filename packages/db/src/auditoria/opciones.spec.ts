// Spec 031 (T1, rojo): `opcionesAuditoria` con una `tx` falsa (D-6, CA-7). El comportamiento con datos (activos e inactivos, archivados,
// maximo 20, alcance, estudios) se prueba contra la BD en tests/aislamiento/auditoria-consulta.spec.ts. Aqui: texto SQL fijo, `q` solo como
// parametro y con los comodines % _ \ escapados, alcance y forma de la salida. Rojo: el modulo `./opciones` aun no existe.
import { describe, expect, it } from "vitest";
import type { Alcance } from "../acceso/alcance";
import { opcionesAuditoria } from "./opciones";

const C = "0190a031-0000-7000-8000-0000000000c1";
const A = "0190a031-0000-7000-8000-0000000000f1";
const GLOBAL: Alcance = { tipo: "global" };
const ASIGNADO: Alcance = { tipo: "asignado", usuarioId: A };

function txCon() {
  const consultas: { texto: string; valores: unknown[] }[] = [];
  return {
    consultas,
    query: async (texto: string, valores: unknown[]) => {
      consultas.push({ texto, valores });
      return { rows: [] };
    },
  };
}

const planos = (valores: unknown[]): unknown[] => valores.flatMap((v) => (Array.isArray(v) ? v : [v]));

async function correr(o: { q: string | null; clienteId: string | null; alcance: Alcance }) {
  const tx = txCon();
  const r = await opcionesAuditoria(tx as never, o);
  return { r, consultas: tx.consultas };
}

describe("opcionesAuditoria: forma de la salida", () => {
  it("devuelve { miembros, clientes } (listas) aunque no haya filas", async () => {
    const { r } = await correr({ q: "alfa", clienteId: null, alcance: GLOBAL });
    expect(r).toEqual({ miembros: [], clientes: [] });
  });

  it("sin q ni clienteId no falla y aun lista los miembros", async () => {
    const { r, consultas } = await correr({ q: null, clienteId: null, alcance: GLOBAL });
    expect(r.miembros).toEqual([]);
    expect(consultas.length).toBeGreaterThanOrEqual(1);
  });
});

describe("opcionesAuditoria: q y clienteId solo como parametros (CA-7)", () => {
  it("el texto SQL no cambia con q, clienteId ni con valores hostiles", async () => {
    const textos = async (o: { q: string | null; clienteId: string | null; alcance: Alcance }) => (await correr(o)).consultas.map((c) => c.texto);
    const base = await textos({ q: "alfa", clienteId: null, alcance: GLOBAL });
    for (const q of ["otro", "x'; drop table cliente; --", "%", "_", "\\", "20100000001"]) {
      expect(await textos({ q, clienteId: C, alcance: GLOBAL }), q).toEqual(base);
    }
  });

  it("q y clienteId no aparecen en el texto y si en los valores", async () => {
    const { consultas } = await correr({ q: "Alfa Beta", clienteId: C, alcance: GLOBAL });
    for (const c of consultas) {
      expect(c.texto).not.toContain("Alfa Beta");
      expect(c.texto).not.toContain(C);
    }
    const v = consultas.flatMap((c) => planos(c.valores));
    expect(v).toContain(C);
    expect(v.some((x) => typeof x === "string" && x.includes("Alfa Beta"))).toBe(true);
  });

  it.each(["50%", "a_b", "x\\y", "%_\\"])("q = %j: los comodines de ILIKE viajan escapados (en el valor) o el SQL los escapa con replace()", async (q) => {
    const { consultas } = await correr({ q, clienteId: null, alcance: GLOBAL });
    const escapado = q.replace(/[\\%_]/g, "\\$&");
    const conQ = consultas.filter((c) => planos(c.valores).some((x) => typeof x === "string" && (x.includes(escapado) || x.includes(q))));
    expect(conQ.length, "alguna consulta recibe q").toBeGreaterThan(0);
    for (const c of conQ) {
      const v = planos(c.valores).filter((x): x is string => typeof x === "string");
      const enJs = v.some((x) => x.includes(escapado));
      const enSql = v.some((x) => x.includes(q)) && /replace\s*\(/i.test(c.texto);
      expect(enJs || enSql, `valores ${JSON.stringify(v)} para q = ${q}`).toBe(true);
    }
  });

  it("a lo sumo 20 clientes por busqueda (D-6)", async () => {
    const { consultas } = await correr({ q: "alfa", clienteId: null, alcance: GLOBAL });
    const hay20 = consultas.some((c) => /\blimit\s+20\b/i.test(c.texto) || planos(c.valores).includes(20));
    expect(hay20).toBe(true);
  });
});

describe("opcionesAuditoria: alcance (D-3)", () => {
  it("el alcance asignado restringe los clientes con las asignaciones del usuario; el global no", async () => {
    const asignado = (await correr({ q: "alfa", clienteId: C, alcance: ASIGNADO })).consultas;
    const global = (await correr({ q: "alfa", clienteId: C, alcance: GLOBAL })).consultas;
    expect(asignado.some((c) => /asignacion/i.test(c.texto))).toBe(true);
    expect(asignado.flatMap((c) => planos(c.valores))).toContain(A);
    expect(global.some((c) => /asignacion/i.test(c.texto))).toBe(false);
    expect(global.flatMap((c) => planos(c.valores))).not.toContain(A);
  });

  it("falla cerrado: sin alcance valido nunca lista todos los clientes del estudio", async () => {
    for (const malo of [undefined, null, {}, { tipo: "todos" }]) {
      const tx = txCon();
      try {
        await opcionesAuditoria(tx as never, { q: "alfa", clienteId: C, alcance: malo as never });
      } catch {
        continue;
      }
      expect(tx.consultas.some((c) => /asignacion/i.test(c.texto)), JSON.stringify(malo)).toBe(true);
    }
  });
});
