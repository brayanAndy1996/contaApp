import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { ContrasenaInvalidaError } from "./errores.js";
import { crearHasher } from "./contrasena/hasher.js";
import { cargarComunes, fijarContrasena, validarContrasena } from "./contrasena/politica.js";

// CA-10 / RNF-004 (spec 004): con una contraseña canario, ninguna de las vistas de un error
// (message, stack, cause, JSON.stringify, util.inspect con toda la profundidad) la contiene.
// Se prueba en los errores del núcleo de autenticación sin BD: Hasher, política y
// ContrasenaInvalidaError. (El filtro, el entorno, la cola y el SMTP lo comprueban en sus specs.)
const PISO = { memoriaKib: 19456, iteraciones: 2, paralelismo: 1 };

function vistas(error: unknown): string[] {
  const salida: string[] = [];
  const e = error as { message?: unknown; stack?: unknown; cause?: unknown };
  salida.push(String(e?.message), String(e?.stack), inspect(e?.cause, { depth: 10 }));
  try {
    salida.push(JSON.stringify(error) ?? "");
  } catch {
    salida.push("");
  }
  salida.push(inspect(error, { depth: 10, showHidden: true }));
  return salida;
}

function sinCanario(error: unknown, canario: string) {
  expect(error).toBeInstanceOf(Error);
  for (const v of vistas(error)) expect(v).not.toContain(canario);
}

describe("las contraseñas no se filtran por los errores (CA-10)", () => {
  it("Hasher.calcular con una contraseña de más de 128 puntos rechaza sin incluirla", async () => {
    const canario = "CANARIO-CONTRASENA-" + "x".repeat(140);
    const hasher = await crearHasher(PISO);
    const error = await hasher.calcular(canario).catch((e: unknown) => e);
    sinCanario(error, canario);
    sinCanario(error, "CANARIO-CONTRASENA");
  });

  it("ContrasenaInvalidaError no contiene la contraseña, solo el motivo", () => {
    const canario = "CANARIO-POLITICA-6631";
    const error = new ContrasenaInvalidaError("comun");
    sinCanario(error, canario);
    expect(error.motivo).toBe("comun");
  });

  it.each([
    ["demasiado corta", "CANARIO-c0"],
    ["demasiado larga", "CANARIO-LARGA-" + "z".repeat(140)],
  ])("fijarContrasena (%s) lanza un error sin la contraseña", async (_n, canario) => {
    const hasher = { calcular: vi.fn(), verificar: vi.fn(), necesitaRehash: vi.fn(), hashFicticio: "" };
    const error = await fijarContrasena(canario, { hasher, comunes: cargarComunes() }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ContrasenaInvalidaError);
    sinCanario(error, canario);
    expect(hasher.calcular).not.toHaveBeenCalled();
  });

  it("validarContrasena devuelve solo el motivo (no una copia de la entrada)", () => {
    const canario = "QWERTYUIOP12";
    const motivo = validarContrasena(canario, cargarComunes());
    expect(motivo).toBe("comun");
    expect(String(motivo)).not.toContain(canario);
  });
});
