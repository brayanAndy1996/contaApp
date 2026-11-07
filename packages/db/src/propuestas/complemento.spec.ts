// Unitarias de `aplicarComplemento` (spec 013, D16, D18): el orden de las escrituras, el tope de filas vivas y la primera
// aparición de cada clave nueva, con una transacción falsa que registra las sentencias.
import { describe, expect, it } from "vitest";
import type { TxConsulta } from "./errores";
import {
  aplicarComplemento,
  hashContenido,
  type EntradaComplemento,
  type ExistenteComplementable,
  type FilaComplementable,
  type PlanComplementable,
} from "./complemento";

function txFalsa() {
  const sentencias: Array<{ texto: string; valores: unknown[] }> = [];
  const query = async (texto: string, valores: unknown[]) => {
    sentencias.push({ texto, valores });
    if (texto.includes("insert into propuesta ")) return { rows: [{ id: "p-1" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return { sentencias, query: query as never as TxConsulta["query"] };
}

const fila = (clave: string, total = "1.00"): FilaComplementable<string> => ({
  clave,
  campos: { total },
  datos: clave,
});

function entrada(
  p: Partial<EntradaComplemento<FilaComplementable<string>>> & {
    plan?: PlanComplementable;
    existentes?: ExistenteComplementable[];
  },
) {
  const insertadas: string[][] = [];
  const e: EntradaComplemento<FilaComplementable<string>> = {
    clienteId: "c-1",
    periodo: "202610",
    libro: "ventas",
    fuente: "importacion",
    hash: "a".repeat(64),
    usuarioId: "u-1",
    trabajoId: null,
    filas: [fila("03|B001|1")],
    topeVivas: 20_000,
    leerExistentes: async () => p.existentes ?? [],
    planificar: () => p.plan ?? { nuevas: ["03|B001|1"], iguales: 0, distintas: [] },
    insertar: async (_tx, _id, nuevas) => {
      insertadas.push(nuevas.map((n) => n.datos));
    },
    ...p,
  };
  return { e, insertadas };
}

describe("aplicarComplemento", () => {
  it("bloquea, crea el encabezado con los contadores y guarda solo la primera aparición de cada clave nueva", async () => {
    const tx = txFalsa();
    const { e, insertadas } = entrada({
      filas: [fila("03|B001|1"), fila("03|B001|1", "2.00"), fila("03|B001|2")],
      plan: {
        nuevas: ["03|B001|1", "03|B001|2"],
        iguales: 0,
        distintas: [{ clave: "03|B001|1", origenExistente: "sire", campos: ["total"], valoresSire: { total: "2.00" } }],
      },
    });
    const r = await aplicarComplemento(tx, e);
    expect(r.excedeTope).toBe(false);
    expect(tx.sentencias[0]!.texto).toContain("pg_advisory_xact_lock");
    const crear = tx.sentencias.find((s) => s.texto.includes("insert into propuesta "))!;
    expect(crear.valores).toEqual(["c-1", "202610", "ventas", "importacion", "a".repeat(64), 3, 2, 0, 1, "u-1", null]);
    const difs = tx.sentencias.find((s) => s.texto.includes("insert into propuesta_diferencia"))!;
    expect(JSON.parse(difs.valores[1] as string)).toEqual([
      expect.objectContaining({ clave: "03|B001|1", tipo: "03", serie: "B001", numero: "1", origen_existente: "sire" }),
    ]);
    expect(insertadas).toEqual([["03|B001|1", "03|B001|2"]]);
  });

  it("si lo vivo pasa del tope no escribe nada (ni el encabezado)", async () => {
    const tx = txFalsa();
    const existentes: ExistenteComplementable[] = [
      { clave: "03|S001|1", origen: "sire", campos: {} },
      { clave: "03|S001|2", origen: "sire", campos: {} },
    ];
    const { e, insertadas } = entrada({ existentes, topeVivas: 2 });
    expect(await aplicarComplemento(tx, e)).toEqual({ excedeTope: true });
    expect(tx.sentencias.some((s) => s.texto.includes("insert into"))).toBe(false);
    expect(insertadas).toEqual([]);
  });

  it("justo en el tope se guarda", async () => {
    const tx = txFalsa();
    const { e } = entrada({ existentes: [{ clave: "03|S001|1", origen: "sire", campos: {} }], topeVivas: 2 });
    expect((await aplicarComplemento(tx, e)).excedeTope).toBe(false);
  });
});

describe("hashContenido", () => {
  const a = { tipo: "03", serie: "B001", numero: "1", campos: { total: "1.00" } };
  const b = { tipo: "03", serie: "B001", numero: "2", campos: { total: "2.00" } };

  it("no depende del orden de las filas", () => {
    expect(hashContenido("ventas", "202610", [a, b])).toBe(hashContenido("ventas", "202610", [b, a]));
    expect(hashContenido("ventas", "202610", [a])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cambia con el contenido, el periodo o el libro", () => {
    const base = hashContenido("ventas", "202610", [a]);
    expect(hashContenido("ventas", "202610", [{ ...a, campos: { total: "3.00" } }])).not.toBe(base);
    expect(hashContenido("ventas", "202611", [a])).not.toBe(base);
    expect(hashContenido("compras", "202610", [a])).not.toBe(base);
  });
});
