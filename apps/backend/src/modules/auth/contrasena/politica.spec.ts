import { describe, expect, it, vi } from "vitest";
import { ContrasenaInvalidaError } from "../errores.js";
import { cargarComunes, fijarContrasena, validarContrasena } from "./politica.js";

// CA-4 / P5 / P12 (spec 004). Contrato (plan: Decisiones: Política):
//   cargarComunes(): ReadonlySet<string>   // lee comunes.txt (junto al módulo): minúsculas, sin líneas vacías
//   validarContrasena(plano, comunes): null | "longitud" | "comun"
//     longitud = [...plano].length fuera de 12..128; común = comparación sin distinguir
//     mayúsculas contra el conjunto; "longitud" se evalúa antes que "comun".
//   fijarContrasena(plano, { hasher, comunes }): Promise<string>  // política + hash; función de
//     dominio que reutiliza la spec 005. Si la política falla lanza ContrasenaInvalidaError
//     (propiedad `motivo`: "longitud" | "comun") sin llamar al hasher.
// ContrasenaInvalidaError vive en apps/backend/src/modules/auth/errores.ts.
const comunes = cargarComunes();

describe("cargarComunes (P12)", () => {
  it("carga unos cientos de entradas, todas en minúsculas y sin líneas vacías", () => {
    expect(comunes.size).toBeGreaterThan(300);
    expect(comunes.has("")).toBe(false);
    for (const entrada of comunes) {
      expect(entrada).toBe(entrada.trim().toLowerCase());
      expect([...entrada].length).toBeGreaterThanOrEqual(12);
    }
  });

  it("contiene entradas conocidas de la lista local", () => {
    expect(comunes.has("qwertyuiop12")).toBe(true);
    expect(comunes.has("qwerty123456789")).toBe(true);
  });
});

describe("validarContrasena", () => {
  it("una contraseña larga y no común es válida", () => {
    expect(validarContrasena("ola-de-calor-sobre-lima-2031", comunes)).toBeNull();
  });

  it("no impone composición: 12 letras iguales no comunes pasan", () => {
    expect(validarContrasena("zzzzzzzzzzzz", comunes)).toBeNull();
  });

  it.each([
    ["vacía", ""],
    ["11 caracteres", "abcdefghijk"],
    ["129 caracteres", "a".repeat(129)],
    ["129 emojis", "😀".repeat(129)],
    ["11 emojis", "😀".repeat(11)],
  ])("%s -> longitud", (_n, plano) => {
    expect(validarContrasena(plano, comunes)).toBe("longitud");
  });

  it.each([
    ["12 caracteres", "k".repeat(12)],
    ["128 caracteres", "b".repeat(128)],
    ["12 emojis", "😀".repeat(12)],
    ["128 emojis", "😀".repeat(128)],
  ])("%s (límite inclusivo) -> válida", (_n, plano) => {
    expect(validarContrasena(plano, comunes)).toBeNull();
  });

  it("una contraseña común en minúsculas -> comun", () => {
    expect(validarContrasena("qwertyuiop12", comunes)).toBe("comun");
  });

  it("una común en mayúsculas o mixtas -> comun (sin distinguir mayúsculas)", () => {
    expect(validarContrasena("QWERTYUIOP12", comunes)).toBe("comun");
    expect(validarContrasena("QwertyUIop12", comunes)).toBe("comun");
  });

  it("usa el conjunto recibido, no uno fijo", () => {
    const propio = new Set(["mi-clave-comun-1"]);
    expect(validarContrasena("MI-CLAVE-COMUN-1", propio)).toBe("comun");
    expect(validarContrasena("qwertyuiop12", propio)).toBeNull();
  });

  it("una contraseña común pero fuera de longitud se reporta como longitud", () => {
    const propio = new Set(["corta"]);
    expect(validarContrasena("corta", propio)).toBe("longitud");
  });
});

describe("fijarContrasena (función de dominio para 005)", () => {
  const fabricaHasher = () => ({
    calcular: vi.fn(async () => "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA"),
    verificar: vi.fn(async () => true),
    necesitaRehash: vi.fn(() => false),
    hashFicticio: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$ZmljdGljaW8",
  });

  it("con una contraseña válida devuelve el hash del hasher y lo calcula una vez", async () => {
    const hasher = fabricaHasher();
    const resultado = await fijarContrasena("ola-de-calor-sobre-lima-2031", { hasher, comunes });
    expect(resultado).toBe("$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA");
    expect(hasher.calcular).toHaveBeenCalledTimes(1);
    expect(hasher.calcular).toHaveBeenCalledWith("ola-de-calor-sobre-lima-2031");
  });

  it("una contraseña corta lanza ContrasenaInvalidaError(longitud) sin calcular el hash", async () => {
    const hasher = fabricaHasher();
    const error = await fijarContrasena("corta", { hasher, comunes }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContrasenaInvalidaError);
    expect((error as ContrasenaInvalidaError).motivo).toBe("longitud");
    expect(hasher.calcular).not.toHaveBeenCalled();
  });

  it("una contraseña común lanza ContrasenaInvalidaError(comun) sin calcular el hash", async () => {
    const hasher = fabricaHasher();
    const error = await fijarContrasena("QWERTYUIOP12", { hasher, comunes }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ContrasenaInvalidaError);
    expect((error as ContrasenaInvalidaError).motivo).toBe("comun");
    expect(hasher.calcular).not.toHaveBeenCalled();
  });

  it("una contraseña de más de 128 puntos no llega al hasher", async () => {
    const hasher = fabricaHasher();
    await expect(
      fijarContrasena("😀".repeat(129), { hasher, comunes }),
    ).rejects.toBeInstanceOf(ContrasenaInvalidaError);
    expect(hasher.calcular).not.toHaveBeenCalled();
  });
});
