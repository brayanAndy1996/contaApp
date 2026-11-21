import { describe, expect, it } from "vitest";
import { leerProveedoresConRegla } from "./lectura";

// Spec 025 · T12: `leerProveedoresConRegla` (los proveedores con regla viva y activa del cliente, para R-STD). Unitaria con una `tx` simulada;
// el comportamiento con reglas inactivas, eliminadas y de otro cliente está en `apps/backend/src/modules/compras/std.int.spec.ts`.
const CLIENTE = "0190b0c0-0000-7000-8000-000000000001";

function txCon(filas: Record<string, unknown>[]) {
  const llamadas: { texto: string; valores: unknown[] }[] = [];
  const tx = {
    query: (texto: string, valores: unknown[]) => {
      llamadas.push({ texto, valores });
      return Promise.resolve({ rows: filas });
    },
  };
  return { tx: tx as never, llamadas };
}

describe("leerProveedoresConRegla (025)", () => {
  it("devuelve solo tipo y número de documento, con una consulta que filtra por cliente, no eliminadas y activas", async () => {
    const { tx, llamadas } = txCon([
      { doc_tipo: "6", doc_numero: "20100070970", razon_social: "NO VIAJA" },
      { doc_tipo: "1", doc_numero: "12345678" },
    ]);
    expect(await leerProveedoresConRegla(tx, CLIENTE)).toEqual([
      { tipo: "6", numero: "20100070970" },
      { tipo: "1", numero: "12345678" },
    ]);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.valores).toEqual([CLIENTE]);
    expect(llamadas[0]!.texto).toMatch(/eliminada_en is null and activa/);
  });

  it("un id que no es uuid no llega a la BD", async () => {
    const { tx, llamadas } = txCon([{ doc_tipo: "6", doc_numero: "20100070970" }]);
    expect(await leerProveedoresConRegla(tx, "no-es-uuid")).toEqual([]);
    expect(llamadas).toHaveLength(0);
  });
});
