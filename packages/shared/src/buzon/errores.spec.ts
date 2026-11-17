import { describe, expect, it } from "vitest";
import { CODIGOS_ERROR_BUZON, errorBuzonSchema } from "./index.js";
import * as raiz from "../index.js";

// Spec 023 · T2 (rojo). Códigos de error de las rutas del buzón (plan 023, Contratos: HTTP; D-6).
// Contrato fijado por estas pruebas (packages/shared/src/buzon/errores.ts):
//  - CODIGOS_ERROR_BUZON = [cliente_archivado, credencial_no_configurada, credencial_invalida, captura_reciente]:
//    409 los tres primeros (revisar y abrir) y 429 `captura_reciente` (con Retry-After).
//  - errorBuzonSchema = {codigo: z.enum(CODIGOS_ERROR_BUZON)}: el cuerpo es solo `{codigo}`, sin datos (D-10).
describe("CODIGOS_ERROR_BUZON", () => {
  it.each(["captura_reciente", "credencial_no_configurada", "credencial_invalida", "cliente_archivado"])(
    "incluye %s",
    (c) => {
      expect(CODIGOS_ERROR_BUZON as readonly string[]).toContain(c);
    },
  );
  it("son exactamente cuatro y no se repiten", () => {
    expect(CODIGOS_ERROR_BUZON).toHaveLength(4);
    expect(new Set(CODIGOS_ERROR_BUZON).size).toBe(4);
  });
  it("cada código es minúscula con guion bajo", () => {
    for (const c of CODIGOS_ERROR_BUZON) expect(c).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });
});

describe("errorBuzonSchema", () => {
  it.each(["captura_reciente", "credencial_no_configurada", "credencial_invalida", "cliente_archivado"])(
    "acepta {codigo: %s} y lo devuelve igual",
    (codigo) => {
      const r = errorBuzonSchema.safeParse({ codigo });
      expect(r.success).toBe(true);
      expect((r as { data?: unknown }).data).toEqual({ codigo });
    },
  );
  it.each(["otro", "", "CAPTURA_RECIENTE", "cliente_inexistente", null, 409, undefined, ["captura_reciente"]])(
    "rechaza el código %j",
    (codigo) => {
      expect(errorBuzonSchema.safeParse({ codigo }).success).toBe(false);
    },
  );
  it("exige la clave `codigo`", () => {
    expect(errorBuzonSchema.safeParse({}).success).toBe(false);
    expect(errorBuzonSchema.safeParse(null).success).toBe(false);
    expect(errorBuzonSchema.safeParse("captura_reciente").success).toBe(false);
  });
  it("el cuerpo no deja pasar datos extra (clave, RUC, asunto)", () => {
    const r = errorBuzonSchema.safeParse({ codigo: "credencial_invalida", claveSol: "CANARIO", ruc: "20100070970" });
    expect(r.success).toBe(true);
    expect((r as { data?: unknown }).data).toEqual({ codigo: "credencial_invalida" });
  });
  it("se exportan desde el índice de shared", () => {
    expect(raiz.errorBuzonSchema).toBe(errorBuzonSchema);
    expect(raiz.CODIGOS_ERROR_BUZON).toBe(CODIGOS_ERROR_BUZON);
  });
});
