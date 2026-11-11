// Spec 012b (T4, rojo): las firmas nuevas de ventas no pueden confundirse con las de compras (el nombre `leerEstadoPeriodo` es de 014).
// Unitaria: lee el codigo fuente. Hasta T10 falla porque los archivos no existen.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const leer = (f: string) =>
  existsSync(`${__dirname}/${f}`)
    ? readFileSync(`${__dirname}/${f}`, "utf8")
    : "";

describe("ventas/periodo.ts, exclusion.ts y filas-reemplazo.ts (plan «Archivos»)", () => {
  it("periodo.ts exporta leerEstadoPeriodoVentas y fijarEstadoPeriodoVentas, y consulta venta_periodo (no compra_periodo)", () => {
    const c = leer("periodo.ts");
    expect(c, "falta periodo.ts (T10)").not.toBe("");
    expect(c).toMatch(/export\s+(async\s+)?function\s+leerEstadoPeriodoVentas/);
    expect(c).toMatch(
      /export\s+(async\s+)?function\s+fijarEstadoPeriodoVentas/,
    );
    expect(c).toContain("venta_periodo");
    expect(
      c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""),
    ).not.toContain("compra_periodo");
  });

  it("exclusion.ts exporta excluirVenta, restaurarVenta y exclusionVigente; el INSERT es ON CONFLICT DO NOTHING y la restauracion solo escribe restaurada_*", () => {
    const c = leer("exclusion.ts");
    expect(c, "falta exclusion.ts (T10)").not.toBe("");
    for (const n of ["excluirVenta", "restaurarVenta", "exclusionVigente"])
      expect(c).toMatch(new RegExp(`export\\s+(async\\s+)?function\\s+${n}`));
    expect(c).toMatch(/on conflict[\s\S]*do nothing/i);
    expect(c).toMatch(/update venta_exclusion set restaurada_por/i);
    expect(c).not.toMatch(/delete from venta_exclusion/i);
  });

  it("filas-reemplazo.ts exporta leerFilasReemplazoVentas y leerExcluidasVentas con SQL estatico y parametrizado", () => {
    const c = leer("filas-reemplazo.ts");
    expect(c, "falta filas-reemplazo.ts (T10)").not.toBe("");
    expect(c).toMatch(
      /export\s+(async\s+)?function\s+leerFilasReemplazoVentas/,
    );
    expect(c).toMatch(/export\s+(async\s+)?function\s+leerExcluidasVentas/);
    expect(
      c,
      "nada de SQL armado con plantillas de texto con datos",
    ).not.toMatch(/`[^`]*\$\{\s*(clienteId|periodo|ventaId|motivo)\b/);
  });
});
