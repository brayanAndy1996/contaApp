import { describe, expect, it } from "vitest";
import {
  CONTRASENA_MAX_PUNTOS,
  CONTRASENA_MIN_PUNTOS,
  cambiarContrasenaSchema,
  cambiarEstudioSchema,
  contrasenaNuevaSchema,
  loginSchema,
  longitudContrasenaValida,
  recuperarSchema,
  restablecerSchema,
} from "./esquemas.js";

// Contrato (plan 004, packages/shared/src/auth/esquemas.ts):
//  - constantes CONTRASENA_MIN_PUNTOS = 12 y CONTRASENA_MAX_PUNTOS = 128 (puntos de código);
//  - longitudContrasenaValida(s): 12 <= [...s].length <= 128 (CA-4, P5);
//  - contrasenaNuevaSchema: string con esa longitud, sin reglas de composición;
//  - loginSchema {correo, contrasena}: NO limita la longitud de la contraseña (una de más de
//    128 puntos se responde 401 genérico en el servicio, no 400);
//  - recuperarSchema {correo}, restablecerSchema {token, contrasena},
//    cambiarContrasenaSchema {actual, nueva}, cambiarEstudioSchema {tenantId: uuid}.
const rep = (s: string, n: number) => s.repeat(n);

describe("constantes de la política de longitud", () => {
  it("12 y 128 puntos de código", () => {
    expect(CONTRASENA_MIN_PUNTOS).toBe(12);
    expect(CONTRASENA_MAX_PUNTOS).toBe(128);
  });
});

describe("longitudContrasenaValida (CA-4, P5)", () => {
  it.each([
    ["11 caracteres", rep("a", 11), false],
    ["12 caracteres", rep("a", 12), true],
    ["128 caracteres", rep("a", 128), true],
    ["129 caracteres", rep("a", 129), false],
    ["vacía", "", false],
  ])("%s -> %s", (_n, valor, esperado) => {
    expect(longitudContrasenaValida(valor)).toBe(esperado);
  });

  it("cuenta puntos de código, no unidades UTF-16: 12 emojis valen", () => {
    expect(rep("😀", 12)).toHaveLength(24);
    expect(longitudContrasenaValida(rep("😀", 12))).toBe(true);
  });

  it("11 emojis (22 unidades UTF-16) no alcanzan el mínimo", () => {
    expect(longitudContrasenaValida(rep("😀", 11))).toBe(false);
  });

  it("128 emojis (256 unidades UTF-16) están en el máximo; 129 lo exceden", () => {
    expect(longitudContrasenaValida(rep("😀", 128))).toBe(true);
    expect(longitudContrasenaValida(rep("😀", 129))).toBe(false);
  });

  it("los combinantes cuentan como puntos de código aparte", () => {
    // 'e' + U+0301 son 2 puntos de código: 6 pares = 12 (vale), 5 pares = 10 (no vale).
    expect(longitudContrasenaValida(rep("é", 6))).toBe(true);
    expect(longitudContrasenaValida(rep("é", 5))).toBe(false);
  });

  it("no impone reglas de composición (solo minúsculas, solo dígitos, solo espacios)", () => {
    expect(longitudContrasenaValida(rep("a", 12))).toBe(true);
    expect(longitudContrasenaValida(rep("7", 12))).toBe(true);
    expect(longitudContrasenaValida(rep(" ", 12))).toBe(true);
  });
});

describe("contrasenaNuevaSchema", () => {
  it("acepta 12 y 128 puntos de código", () => {
    expect(contrasenaNuevaSchema.safeParse(rep("a", 12)).success).toBe(true);
    expect(contrasenaNuevaSchema.safeParse(rep("a", 128)).success).toBe(true);
    expect(contrasenaNuevaSchema.safeParse(rep("😀", 128)).success).toBe(true);
  });

  it("rechaza 11, 129 y 129 emojis", () => {
    expect(contrasenaNuevaSchema.safeParse(rep("a", 11)).success).toBe(false);
    expect(contrasenaNuevaSchema.safeParse(rep("a", 129)).success).toBe(false);
    expect(contrasenaNuevaSchema.safeParse(rep("😀", 129)).success).toBe(false);
  });

  it.each([[undefined], [null], [123456789012], [["aaaaaaaaaaaa"]], [{}]])(
    "rechaza un valor que no es cadena (%j)",
    (valor) => {
      expect(contrasenaNuevaSchema.safeParse(valor).success).toBe(false);
    },
  );
});

describe("loginSchema", () => {
  it("acepta correo y contraseña", () => {
    expect(loginSchema.safeParse({ correo: "ana@estudio.pe", contrasena: "x" }).success).toBe(
      true,
    );
  });

  it("no limita la longitud de la contraseña (más de 128 se resuelve en el servicio)", () => {
    expect(
      loginSchema.safeParse({ correo: "ana@estudio.pe", contrasena: rep("a", 500) }).success,
    ).toBe(true);
  });

  it.each([
    [{ contrasena: "x" }],
    [{ correo: "ana@estudio.pe" }],
    [{ correo: 5, contrasena: "x" }],
    [{ correo: "ana@estudio.pe", contrasena: 5 }],
    [{ correo: "ana@estudio.pe", contrasena: null }],
    [null],
    ["texto"],
  ])("rechaza una entrada incompleta o mal tipada (%j)", (entrada) => {
    expect(loginSchema.safeParse(entrada).success).toBe(false);
  });
});

describe("recuperarSchema", () => {
  it("acepta {correo}", () => {
    expect(recuperarSchema.safeParse({ correo: "ana@estudio.pe" }).success).toBe(true);
  });

  it.each([[{}], [{ correo: 7 }], [{ correo: null }], [null]])("rechaza %j", (entrada) => {
    expect(recuperarSchema.safeParse(entrada).success).toBe(false);
  });
});

describe("restablecerSchema", () => {
  it("acepta {token, contrasena}", () => {
    expect(
      restablecerSchema.safeParse({ token: rep("A", 43), contrasena: rep("a", 12) }).success,
    ).toBe(true);
  });

  it.each([
    [{ contrasena: rep("a", 12) }],
    [{ token: rep("A", 43) }],
    [{ token: 1, contrasena: rep("a", 12) }],
    [{ token: rep("A", 43), contrasena: 1 }],
  ])("rechaza una entrada incompleta o mal tipada (%j)", (entrada) => {
    expect(restablecerSchema.safeParse(entrada).success).toBe(false);
  });
});

describe("cambiarContrasenaSchema", () => {
  it("acepta {actual, nueva}", () => {
    expect(
      cambiarContrasenaSchema.safeParse({ actual: "lo-que-sea", nueva: rep("a", 12) }).success,
    ).toBe(true);
  });

  it.each([
    [{ nueva: rep("a", 12) }],
    [{ actual: "x" }],
    [{ actual: 1, nueva: rep("a", 12) }],
    [{ actual: "x", nueva: null }],
  ])("rechaza una entrada incompleta o mal tipada (%j)", (entrada) => {
    expect(cambiarContrasenaSchema.safeParse(entrada).success).toBe(false);
  });
});

describe("cambiarEstudioSchema", () => {
  it("acepta un uuid como tenantId", () => {
    expect(
      cambiarEstudioSchema.safeParse({ tenantId: "0190a8b2-7c3e-7a11-8f00-123456789abc" }).success,
    ).toBe(true);
  });

  it.each([
    [{}],
    [{ tenantId: 5 }],
    [{ tenantId: "no-es-uuid" }],
    [{ tenantId: "" }],
    [{ tenantId: "0190a8b2-7c3e-7a11-8f00-123456789abc OR 1=1" }],
  ])("rechaza un tenantId ausente o que no es uuid (%j)", (entrada) => {
    expect(cambiarEstudioSchema.safeParse(entrada).success).toBe(false);
  });
});
