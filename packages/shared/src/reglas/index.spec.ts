import { describe, expect, it } from "vitest";
import * as shared from "../index.js";

// Spec 021 · T2 (rojo). Los contratos de reglas salen por la lista del paquete (src/index.ts → reglas/index.ts),
// porque frontend, backend y worker solo importan de `@contapp/shared`.
describe("exportaciones de @contapp/shared para reglas aprendidas", () => {
  it.each([
    "reglaVistaSchema",
    "recordarReglaSchema",
    "editarReglaSchema",
    "eliminarReglaSchema",
    "reglasMotorSchema",
    "fijarReglaMotorSchema",
    "fijarAporteSchema",
    "codigoReglaMotorSchema",
    "errorReglaSchema",
    "CODIGOS_REGLA_MOTOR",
    "CODIGOS_ERROR_REGLA",
  ])("exporta %s", (nombre) => {
    expect((shared as Record<string, unknown>)[nombre]).toBeDefined();
  });
});
