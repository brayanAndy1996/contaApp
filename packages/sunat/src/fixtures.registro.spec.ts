import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FilaPropuestaSire, TokenSire } from "./puertos.js";
import { MockSireApiClient } from "./mock/sire-api-client.mock.js";

// Spec 025 (T9): los fixtures del registro presentado traen los casos de U-2 y el cliente de Huánuco tiene su propuesta.
const RAIZ = join(__dirname, "..", "..", "..", "fixtures");
const TOKEN: TokenSire = { token: "t", expiraEn: new Date("2026-11-21T16:00:00Z") };

describe("fixtures del registro presentado (025)", () => {
  it("el genérico trae proveedores repetidos con los casos de U-2 (DNI, nota de crédito y mixto incluidos)", async () => {
    const r = await new MockSireApiClient().descargarRegistroPresentado(TOKEN, { ruc: "20100000001", periodo: "202609" });
    const porProveedor = new Map<string, FilaPropuestaSire[]>();
    for (const f of r.filas) porProveedor.set(f.rucContraparte, [...(porProveedor.get(f.rucContraparte) ?? []), f]);
    expect(porProveedor.size).toBeGreaterThanOrEqual(7);
    expect(r.filas.some((f) => f.tipoDocContraparte === "1")).toBe(true);
    expect(r.filas.some((f) => f.tipo === "07" && f.biDg.startsWith("-"))).toBe(true);
    expect(r.filas.some((f) => f.biDg !== "0.00" && f.biDgng !== "0.00")).toBe(true);
    for (const f of r.filas) expect(f.fechaEmision).toMatch(/^2026-09-\d{2}$/);
  });

  it("el cliente de Huánuco tiene propuesta de compras con base en DG o DGNG (para R-STD)", async () => {
    const r = await new MockSireApiClient().descargarPropuesta(TOKEN, { ruc: "20700000100", periodo: "202610", libro: "compras" });
    expect(r.libro).toBe("compras");
    const rucs = JSON.parse(readFileSync(join(RAIZ, "rucs-prueba.json"), "utf8")) as Array<{ ruc: string }>;
    expect(rucs.some((x) => x.ruc === "20700000100")).toBe(true);
    expect(r.filas.length).toBeGreaterThan(0);
  });
});
