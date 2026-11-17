import { describe, expect, it } from "vitest";
import { ACCIONES_AUDITORIA, accionAuditoriaSchema } from "./acciones.js";

// Spec 023 · T2 (rojo). Acciones de auditoría del buzón SOL (plan 023, 0056; CA-4, CA-10).
// Contrato fijado por estas pruebas (packages/shared/src/auditoria/acciones.ts): ACCIONES_AUDITORIA suma estas 5, todas con forma
// entidad.hecho: `buzon.contenido_obtenido` (trigger; actor `trabajo`) y las cuatro que registra el backend con actor usuario
// (`buzon.captura_solicitada`, `buzon.apertura_solicitada`, `buzon.contenido_visto`, `buzon.adjunto_descargado`).
// Al implementar, `acciones.spec.ts` (017) y `acciones-reglas.spec.ts` (021) deben actualizar su lista y total exactos (39 + 5 = 44).
const NUEVAS = [
  "buzon.contenido_obtenido",
  "buzon.captura_solicitada",
  "buzon.apertura_solicitada",
  "buzon.contenido_visto",
  "buzon.adjunto_descargado",
];

describe("acciones de auditoría de 023", () => {
  it.each(NUEVAS)("ACCIONES_AUDITORIA incluye %s", (a) => {
    expect(ACCIONES_AUDITORIA as readonly string[]).toContain(a);
  });
  it.each(NUEVAS)("accionAuditoriaSchema acepta %s", (a) => {
    expect(accionAuditoriaSchema.safeParse(a).success).toBe(true);
  });
  it("suma exactamente cinco acciones con prefijo buzon.", () => {
    expect(ACCIONES_AUDITORIA.filter((a) => a.startsWith("buzon."))).toHaveLength(5);
    expect(ACCIONES_AUDITORIA.filter((a) => a.startsWith("buzon.")).sort()).toEqual([...NUEVAS].sort());
  });
  it("no repite acciones y todas tienen forma entidad.hecho", () => {
    expect(new Set(ACCIONES_AUDITORIA).size).toBe(ACCIONES_AUDITORIA.length);
    for (const a of ACCIONES_AUDITORIA) expect(a).toMatch(/^[a-z]+\.[a-z_]+$/);
  });
  it.each(["buzon.borrado", "buzon.", "buzon.captura", "Buzon.contenido_visto", "buzon.mensaje_marcado_leido"])(
    "accionAuditoriaSchema rechaza %s",
    (a) => {
      expect(accionAuditoriaSchema.safeParse(a).success).toBe(false);
    },
  );
  it("las acciones previas siguen: sesion.ingreso, regla.creada, compra.historial y sunat.envio", () => {
    for (const a of ["sesion.ingreso", "regla.creada", "compra.historial", "sunat.envio"]) {
      expect(ACCIONES_AUDITORIA as readonly string[]).toContain(a);
    }
  });
});
