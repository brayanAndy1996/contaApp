import { describe, expect, it } from "vitest";
import { ACCIONES_AUDITORIA, accionAuditoriaSchema } from "./acciones.js";

// Spec 028 · T2 (rojo). Acción de auditoría del correo (spec 028 R-10; plan 028, Contratos: shared y BD 0073/0074; CA-1, CA-8).
// Contrato fijado por estas pruebas (packages/shared/src/auditoria/acciones.ts): ACCIONES_AUDITORIA suma UNA, `correo.preferencia_cambiada`
// (60 + 1 = 61), con forma entidad.hecho y actor usuario (la registran `correo_preferencias_fijar` y `auth.correo_baja_aplicar`; `datos` =
// {tipo, de, a, origen: app | enlace}). Los envíos NO se auditan uno por uno (su registro es `correo_envio`).
const NUEVA = "correo.preferencia_cambiada";

describe("acciones de auditoría de 028", () => {
  it("ACCIONES_AUDITORIA incluye correo.preferencia_cambiada", () => {
    expect(ACCIONES_AUDITORIA as readonly string[]).toContain(NUEVA);
  });
  it("accionAuditoriaSchema la acepta", () => {
    expect(accionAuditoriaSchema.safeParse(NUEVA).success).toBe(true);
  });
  it("es la única acción con prefijo correo.", () => {
    expect(ACCIONES_AUDITORIA.filter((a) => a.startsWith("correo."))).toEqual([NUEVA]);
  });
  it("el catálogo queda en 61 sin repetidos y todas con forma entidad.hecho", () => {
    expect(ACCIONES_AUDITORIA).toHaveLength(61);
    expect(new Set(ACCIONES_AUDITORIA).size).toBe(ACCIONES_AUDITORIA.length);
    for (const a of ACCIONES_AUDITORIA) expect(a).toMatch(/^[a-z]+\.[a-z_]+$/);
  });
  it.each([
    "correo.enviado",
    "correo.envio",
    "correo.baja",
    "correo.preferencia",
    "correo.preferencia_cambiadas",
    "correo.",
    "Correo.preferencia_cambiada",
    "correo.preferencia_cambiada ",
    "preferencia.cambiada",
    "correo.preferencias_cambiadas",
  ])("accionAuditoriaSchema rechaza %j", (a) => {
    expect(accionAuditoriaSchema.safeParse(a).success).toBe(false);
  });
  it("las acciones previas siguen: sesion.ingreso, regla.creada, buzon.atendido, prorrata.usada_guardada, gnd.umbral_cambiado y sunat.envio", () => {
    for (const a of ["sesion.ingreso", "regla.creada", "buzon.atendido", "prorrata.usada_guardada", "gnd.umbral_cambiado", "sunat.envio"]) {
      expect(ACCIONES_AUDITORIA as readonly string[]).toContain(a);
    }
  });
});
