import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCredencial } from "../errores.js";
import type { CredencialSol, Declaracion621 } from "../puertos.js";
import { MockSolPortal } from "./sol-portal.mock.js";

// Spec 026 (T9; D-2; 01 §7.4; fixtures/LEEME.md). El fixture del repo `fixtures/sol/pdt621/{ruc}.json` del contribuyente de
// prueba (el cliente de la E2E): 11 meses declarados (2025-11 a 2026-09) y 2026-10 (M) sin declarar, una rectificatoria,
// ventas gravadas y no gravadas (exoneradas) y una prorrata usada en 2026-09 distinta de la calculada.
const RAIZ = resolve(__dirname, "../../../..");
const RUC = "20700000002";
const RUTA = resolve(RAIZ, "fixtures/sol/pdt621", `${RUC}.json`);
const cred: CredencialSol = { ruc: RUC, usuarioSol: "CANARIO-USUARIO-sol", claveSol: "CANARIO-SOL-clave" };
const VENTANA = ["202511", "202512", "202601", "202602", "202603", "202604", "202605", "202606", "202607", "202608", "202609", "202610"];

async function ventana(puerto: MockSolPortal): Promise<Map<string, Declaracion621[]>> {
  const m = new Map<string, Declaracion621[]>();
  for (const periodo of VENTANA) m.set(periodo, await puerto.obtenerDeclaraciones621(cred, { periodo }));
  return m;
}
const vigente = (l: Declaracion621[]) => [...l].sort((a, b) => Number(BigInt(b.numeroOrden) - BigInt(a.numeroOrden)))[0]!;

describe("fixtures/sol/pdt621 del contribuyente de prueba", () => {
  it("existe, es JSON, pesa menos de 1 MiB y su RUC está en rucs-prueba.json", () => {
    expect(existsSync(RUTA)).toBe(true);
    expect(readFileSync(RUTA).byteLength).toBeLessThan(1_048_576);
    const rucs = (JSON.parse(readFileSync(resolve(RAIZ, "fixtures/rucs-prueba.json"), "utf8")) as { ruc: string }[]).map((r) => r.ruc);
    expect(rucs).toContain(RUC);
  });

  it("el mock del repo lo usa (sin dirFixtures): 11 meses declarados y 2026-10 sin declarar", async () => {
    const m = await ventana(new MockSolPortal());
    expect(VENTANA.filter((p) => m.get(p)!.length > 0)).toEqual(VENTANA.slice(0, 11));
    expect(m.get("202610")).toEqual([]);
  });

  it("trae una sola rectificatoria, de mayor orden que su original", async () => {
    const m = await ventana(new MockSolPortal());
    const conRect = VENTANA.filter((p) => m.get(p)!.some((d) => d.tipo === "rectificatoria"));
    expect(conRect).toHaveLength(1);
    const lista = m.get(conRect[0]!)!;
    expect(lista).toHaveLength(2);
    expect(vigente(lista).tipo).toBe("rectificatoria");
    expect(lista.some((d) => d.tipo === "original")).toBe(true);
  });

  it("todos los meses declarados traen ventas gravadas y no gravadas (exoneradas), sin exportaciones", async () => {
    const m = await ventana(new MockSolPortal());
    for (const p of VENTANA.slice(0, 11)) {
      const d = vigente(m.get(p)!);
      expect(Number(d.ventasGravadasBase)).toBeGreaterThan(0);
      expect(Number(d.noGravadas)).toBeGreaterThan(0);
      expect(Number(d.igvAdquisicionesDgng)).toBeGreaterThan(0);
      expect(d.exportaciones).toBe("0.00");
    }
  });

  it("la prorrata usada del mes anterior a M (2026-09) es la única y difiere de la calculada", async () => {
    const m = await ventana(new MockSolPortal());
    const conUsada = VENTANA.filter((p) => m.get(p)!.some((d) => d.prorrataUsada !== null));
    expect(conUsada).toEqual(["202609"]);
    const usada = vigente(m.get("202609")!).prorrataUsada!;
    expect(usada).toBe("72.00");
    // Coeficiente de los meses declarados (ventana 2025-11 a 2026-09): 72.91, que no es 72.00.
    let num = 0n;
    let tot = 0n;
    const cent = (s: string) => BigInt(s.replace(".", ""));
    for (const p of VENTANA.slice(0, 11)) {
      const d = vigente(m.get(p)!);
      num += cent(d.ventasGravadasBase) + cent(d.exportaciones);
      tot += cent(d.ventasGravadasBase) + cent(d.exportaciones) + cent(d.noGravadas);
    }
    const porcentaje = Number((num * 10000n + tot / 2n) / tot) / 100;
    expect(porcentaje).not.toBe(Number(usada));
    expect(Math.abs(porcentaje - Number(usada))).toBeGreaterThan(0.5);
  });

  it("la clave centinela sigue dando ErrorCredencial con el fixture del repo", async () => {
    await expect(new MockSolPortal().obtenerDeclaraciones621({ ...cred, claveSol: "clave-errada" }, { periodo: "202609" })).rejects.toBeInstanceOf(ErrorCredencial);
  });
});
