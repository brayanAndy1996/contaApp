// Spec 017 (T14a, CA-5): `leerCambiosDeOperacion` con una `tx` falsa. La versión «antes» es null cuando la operación creó la versión
// 1 de la compra (no hay n-1); con n-1 sale completa. Los montos viajan como cadena exacta.
import { describe, expect, it } from "vitest";
import { leerCambiosDeOperacion } from "./cambios";

const OP = "0190a000-0000-7000-8000-0000000000f1";
const C1 = "0190a000-0000-7000-8000-0000000000c1";
const C2 = "0190a000-0000-7000-8000-0000000000c2";

const MONTOS = ["bi_dg", "igv_dg", "bi_dgng", "igv_dgng", "bi_dng", "igv_dng", "no_gravado", "isc", "icbper", "otros_tributos", "total"];

/** Columnas de una versión con prefijo `d_` o `p_`; `total` distingue a una de otra. */
function version(p: "d" | "p", n: number | null, total = "118.00") {
  const f: Record<string, unknown> = {};
  f[`${p}_n`] = n;
  f[`${p}_excluida`] = n === null ? null : false;
  f[`${p}_clasificada`] = n === null ? null : true;
  f[`${p}_motivo`] = null;
  for (const m of MONTOS) f[`${p}_${m}`] = n === null ? null : "0.00";
  if (n !== null) f[`${p}_total`] = total;
  return f;
}

describe("leerCambiosDeOperacion", () => {
  it("pasa el id de la operación como parámetro y no lo interpola en el texto", async () => {
    const consultas: { texto: string; valores: unknown[] }[] = [];
    const tx = { query: async (texto: string, valores: unknown[]) => (consultas.push({ texto, valores }), { rows: [] }) };
    expect(await leerCambiosDeOperacion(tx as never, OP)).toEqual([]);
    expect(consultas[0]!.valores).toEqual([OP]);
    expect(consultas[0]!.texto).not.toContain(OP);
    expect(consultas[0]!.texto).toContain("::text");
  });

  it("antes es null si la operación creó la versión 1; si hay versión previa sale completa", async () => {
    const tx = {
      query: async () => ({
        rows: [
          { compra_id: C1, ...version("d", 1, "118.00"), ...version("p", null) },
          { compra_id: C2, ...version("d", 3, "236.00"), ...version("p", 2, "118.00") },
        ],
      }),
    };
    const r = await leerCambiosDeOperacion(tx as never, OP);
    expect(r).toHaveLength(2);
    expect(r[0]!.compraId).toBe(C1);
    expect(r[0]!.antes).toBeNull();
    expect(r[0]!.despues).toMatchObject({ n: 1, excluida: false, clasificada: true, motivo: null, total: "118.00", biDg: "0.00" });
    expect(r[1]!.compraId).toBe(C2);
    expect(r[1]!.antes).toMatchObject({ n: 2, total: "118.00" });
    expect(r[1]!.despues).toMatchObject({ n: 3, total: "236.00" });
    expect(typeof r[1]!.despues.total).toBe("string");
  });
});
