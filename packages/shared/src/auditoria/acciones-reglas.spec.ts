import { describe, expect, it } from "vitest";
import { ACCIONES_AUDITORIA, accionAuditoriaSchema } from "./acciones.js";

// Spec 021 · T2 (rojo). Acciones de auditoría nuevas (plan 021, BD: triggers de 0047–0049; CA-7, CA-13).
// Contrato fijado por estas pruebas (packages/shared/src/auditoria/acciones.ts): ACCIONES_AUDITORIA suma estas 8
// (31 + 8 = 39), todas con forma entidad.hecho. Al implementar, `acciones.spec.ts` (T1 de 017) debe actualizar su lista exacta.
const REGLAS_CLIENTE = ["regla.creada", "regla.editada", "regla.activada", "regla.desactivada", "regla.eliminada"];
const ESTUDIO = ["estudio.regla_motor", "estudio.aporte_catalogo"];
const COMPRA = ["compra.historial"];
const NUEVAS = [...REGLAS_CLIENTE, ...ESTUDIO, ...COMPRA];

describe("acciones de auditoría de 021", () => {
  it.each(NUEVAS)("ACCIONES_AUDITORIA incluye %s", (a) => {
    expect(ACCIONES_AUDITORIA as readonly string[]).toContain(a);
  });
  it.each(NUEVAS)("accionAuditoriaSchema acepta %s", (a) => {
    expect(accionAuditoriaSchema.safeParse(a).success).toBe(true);
  });
  it("son 8 nuevas y el catálogo queda en 39 sin repetidos", () => {
    expect(NUEVAS).toHaveLength(8);
    expect(ACCIONES_AUDITORIA).toHaveLength(39);
    expect(new Set(ACCIONES_AUDITORIA).size).toBe(ACCIONES_AUDITORIA.length);
  });
  it("todas son minúsculas con forma entidad.hecho", () => {
    for (const a of ACCIONES_AUDITORIA) expect(a).toMatch(/^[a-z]+\.[a-z_]+$/);
  });
  it.each(["regla.borrada", "regla.reactivada", "Regla.creada", "regla.creada ", "estudio.regla", "compra.historia", "compra.aprendida"])("sigue rechazando %j", (a) => {
    expect(accionAuditoriaSchema.safeParse(a).success).toBe(false);
  });
  it("las acciones previas siguen: sesion.ingreso, compra.operacion y sunat.envio", () => {
    for (const a of ["sesion.ingreso", "compra.operacion", "sunat.envio", "credencial.descifrada"]) expect(ACCIONES_AUDITORIA as readonly string[]).toContain(a);
  });
});
