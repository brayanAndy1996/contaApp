import { describe, expect, it } from "vitest";
import { ACCIONES_AUDITORIA, accionAuditoriaSchema } from "./acciones.js";

// Spec 026 · T2 (rojo). Acciones de auditoría de la prorrata (spec 026 D-6; plan 026, 0065 y 0066; CA-10).
// Contrato fijado por estas pruebas (packages/shared/src/auditoria/acciones.ts): ACCIONES_AUDITORIA suma estas 4 (48 + 4 = 52), todas con
// forma entidad.hecho: `prorrata.declaraciones_obtenidas` (actor trabajo; la registra la función del worker) y las tres del backend con
// actor usuario (`prorrata.mes_manual_guardado`, `prorrata.mes_manual_eliminado`, `prorrata.usada_guardada`).
const NUEVAS = ["prorrata.declaraciones_obtenidas", "prorrata.mes_manual_guardado", "prorrata.mes_manual_eliminado", "prorrata.usada_guardada"];

describe("acciones de auditoría de 026", () => {
  it.each(NUEVAS)("ACCIONES_AUDITORIA incluye %s", (a) => {
    expect(ACCIONES_AUDITORIA as readonly string[]).toContain(a);
  });
  it.each(NUEVAS)("accionAuditoriaSchema acepta %s", (a) => {
    expect(accionAuditoriaSchema.safeParse(a).success).toBe(true);
  });
  it("suma exactamente cuatro acciones con prefijo prorrata.", () => {
    expect(ACCIONES_AUDITORIA.filter((a) => a.startsWith("prorrata.")).sort()).toEqual([...NUEVAS].sort());
  });
  it("el catálogo queda en 52 sin repetidos y todas con forma entidad.hecho", () => {
    expect(ACCIONES_AUDITORIA).toHaveLength(52);
    expect(new Set(ACCIONES_AUDITORIA).size).toBe(ACCIONES_AUDITORIA.length);
    for (const a of ACCIONES_AUDITORIA) expect(a).toMatch(/^[a-z]+\.[a-z_]+$/);
  });
  it.each([
    "prorrata.borrada",
    "prorrata.",
    "prorrata.declaraciones",
    "prorrata.mes_manual_borrado",
    "prorrata.usada_eliminada",
    "Prorrata.usada_guardada",
    "prorrata.usada_guardada ",
    "prorrata.calculada",
  ])("accionAuditoriaSchema rechaza %j", (a) => {
    expect(accionAuditoriaSchema.safeParse(a).success).toBe(false);
  });
  it("las acciones previas siguen: sesion.ingreso, regla.creada, buzon.atendido y regla.historial_importado", () => {
    for (const a of ["sesion.ingreso", "regla.creada", "buzon.atendido", "regla.historial_importado", "sunat.envio"]) {
      expect(ACCIONES_AUDITORIA as readonly string[]).toContain(a);
    }
  });
});
