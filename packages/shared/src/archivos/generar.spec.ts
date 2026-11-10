import { describe, expect, it } from "vitest";
import { generarArchivoSchema } from "./index.js";

// Spec 012b · T2 (rojo). Cuerpo de `POST …/archivos` (plan, Contratos: HTTP; D1, D2, P-2; CA-4, CA-8).
// Contrato fijado por estas pruebas (packages/shared/src/archivos/esquemas.ts, exportado por el índice de shared):
//  - generarArchivoSchema: ESTRICTO, solo {estadoVisto: "abierto"|"revisado", huella}.
//  - huella: 64 caracteres hexadecimales en minúscula (sha256Hex del canon).
//  - `libro` sale de la ruta; `registro` y `permitirProvisional` los decide el servidor: cualquier clave extra
//    (también tenantId, usuarioId, clienteId) se RECHAZA (no se descarta): 400 solicitud_invalida.
const HUELLA = "a".repeat(64);
const valido = { estadoVisto: "abierto", huella: HUELLA };

const ok = (v: unknown) => generarArchivoSchema.safeParse(v).success;

describe("generarArchivoSchema", () => {
  it("acepta el cuerpo mínimo en abierto y en revisado y devuelve los mismos datos", () => {
    const r = generarArchivoSchema.safeParse(valido);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(valido);
    expect(ok({ estadoVisto: "revisado", huella: HUELLA })).toBe(true);
  });

  it("estadoVisto solo admite abierto o revisado (generado, vacío, otro tipo o ausente se rechazan)", () => {
    for (const estadoVisto of ["generado", "ABIERTO", "", " abierto", null, 1, undefined]) {
      expect(ok({ estadoVisto, huella: HUELLA })).toBe(false);
    }
    expect(ok({ huella: HUELLA })).toBe(false);
  });

  it("la huella es hexadecimal minúscula de exactamente 64 caracteres", () => {
    expect(ok({ estadoVisto: "abierto", huella: "0123456789abcdef".repeat(4) })).toBe(true);
    for (const huella of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), `${"a".repeat(63)} `, "", null, 64, undefined]) {
      expect(ok({ estadoVisto: "abierto", huella })).toBe(false);
    }
    expect(ok({ estadoVisto: "abierto" })).toBe(false);
  });

  it("rechaza permitirProvisional, registro, libro y cualquier clave extra (estricto)", () => {
    for (const extra of [
      { permitirProvisional: true },
      { permitirProvisional: false },
      { registro: "compras" },
      { libro: "ventas" },
      { tenantId: "x" },
      { usuarioId: "x" },
      { clienteId: "x" },
      { cualquiera: 1 },
    ]) {
      expect(ok({ ...valido, ...extra })).toBe(false);
    }
  });

  it("rechaza un cuerpo que no es objeto", () => {
    for (const v of [null, undefined, "x", 1, [], [valido]]) expect(ok(v)).toBe(false);
  });
});
