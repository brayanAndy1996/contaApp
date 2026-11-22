import { describe, expect, it } from "vitest";
import { ACCIONES_AUDITORIA, accionAuditoriaSchema } from "./acciones.js";

// Spec 027 · T2 (rojo). Acciones de auditoría del diccionario de gastos no deducibles (spec 027 D-4, U-13; plan 027, Contratos: shared y BD 0069/0070; CA-10).
// Contrato fijado por estas pruebas (packages/shared/src/auditoria/acciones.ts): ACCIONES_AUDITORIA suma estas 8 (52 + 8 = 60), todas con forma
// entidad.hecho y prefijo `gnd.`, todas con actor usuario (las registran las funciones acotadas del backend). Los cambios del super-admin NO
// son acciones: quedan en `gnd_global_historial`.
const NUEVAS = [
  "gnd.palabra_agregada",
  "gnd.palabra_desactivada",
  "gnd.palabra_reactivada",
  "gnd.palabra_aprendida",
  "gnd.global_desactivada",
  "gnd.global_reactivada",
  "gnd.umbral_cambiado",
  "gnd.categorias_cliente",
];

describe("acciones de auditoría de 027", () => {
  it.each(NUEVAS)("ACCIONES_AUDITORIA incluye %s", (a) => {
    expect(ACCIONES_AUDITORIA as readonly string[]).toContain(a);
  });
  it.each(NUEVAS)("accionAuditoriaSchema acepta %s", (a) => {
    expect(accionAuditoriaSchema.safeParse(a).success).toBe(true);
  });
  it("suma exactamente las ocho acciones con prefijo gnd.", () => {
    expect(ACCIONES_AUDITORIA.filter((a) => a.startsWith("gnd.")).sort()).toEqual([...NUEVAS].sort());
  });
  it("el catálogo queda en 60 sin repetidos y todas con forma entidad.hecho", () => {
    expect(ACCIONES_AUDITORIA).toHaveLength(60);
    expect(new Set(ACCIONES_AUDITORIA).size).toBe(ACCIONES_AUDITORIA.length);
    for (const a of ACCIONES_AUDITORIA) expect(a).toMatch(/^[a-z]+\.[a-z_]+$/);
  });
  it.each([
    "gnd.palabra_borrada",
    "gnd.palabra_editada",
    "gnd.global_agregada",
    "gnd.global_editada",
    "gnd.",
    "gnd.umbral",
    "Gnd.umbral_cambiado",
    "gnd.umbral_cambiado ",
    "gnd.categorias_cliente_cambiadas",
    "gnd.ciiu_guardado",
  ])("accionAuditoriaSchema rechaza %j", (a) => {
    expect(accionAuditoriaSchema.safeParse(a).success).toBe(false);
  });
  it("las acciones previas siguen: sesion.ingreso, regla.creada, buzon.atendido, prorrata.usada_guardada y sunat.envio", () => {
    for (const a of ["sesion.ingreso", "regla.creada", "buzon.atendido", "prorrata.usada_guardada", "sunat.envio"]) {
      expect(ACCIONES_AUDITORIA as readonly string[]).toContain(a);
    }
  });
});
