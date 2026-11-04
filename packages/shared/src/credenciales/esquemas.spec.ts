import { describe, expect, it } from "vitest";
import {
  TIPOS_CREDENCIAL,
  credencialEstadoSchema,
  guardarCredencialRespuestaSchema,
  guardarCredencialSireSchema,
  guardarCredencialSolSchema,
  tipoCredencialSchema,
} from "./esquemas.js";

// Spec 007b (D1, D4, D5, D6; CA-4). Contrato fijado por estas pruebas (plan: Contratos HTTP; zod y DTOs de
// credenciales en packages/shared/src/credenciales/esquemas.ts, exportados por el índice de shared):
//  - TIPOS_CREDENCIAL = ["sol", "sire_api"] y tipoCredencialSchema (enum de ambos).
//  - guardarCredencialSolSchema {usuario, clave} y guardarCredencialSireSchema {clientId, clientSecret}:
//    cada campo es string de 1 a 256 BYTES UTF-8 (no caracteres), sin sustitutos sueltos (UTF-16 mal formado),
//    sin `trim` ni ninguna otra normalización de la clave (se cifra tal cual), y las claves desconocidas
//    se descartan (z.object), de modo que un `tenantId` o `estado` del cuerpo no viaja.
//  - guardarCredencialRespuestaSchema {tipo, estado}: respuesta del PUT; nunca sobre ni secreto.
//  - credencialEstadoSchema (DTO del GET): {tipo, estado, fecha: string|null, motivo: string|null}; estado es
//    EstadoCredencial. Sin ningún campo del sobre ni de secretos (se descartan si llegan).
interface Esquema {
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
}
const ok = (s: Esquema, v: unknown) => s.safeParse(v).success;
const datos = (s: Esquema, v: unknown) => {
  const r = s.safeParse(v);
  expect(r.success).toBe(true);
  return r.data as Record<string, unknown>;
};
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

const SOL = { usuario: "MODDATOS", clave: "moddatos" };
const SIRE = {
  clientId: "11111111-2222-3333-4444-555555555555",
  clientSecret: "s3cr3t0",
};

describe("tipoCredencialSchema", () => {
  it("expone los dos tipos", () => {
    expect([...TIPOS_CREDENCIAL]).toEqual(["sol", "sire_api"]);
  });
  it.each(["sol", "sire_api"])("acepta %s", (t) => {
    expect(ok(tipoCredencialSchema, t)).toBe(true);
  });
  it.each(["SOL", "sire", "", "sol ", null, 1, undefined, "__proto__"])(
    "rechaza %j",
    (t) => {
      expect(ok(tipoCredencialSchema, t)).toBe(false);
    },
  );
});

const casos = [
  ["sol", guardarCredencialSolSchema, SOL, "usuario", "clave"],
  ["sire_api", guardarCredencialSireSchema, SIRE, "clientId", "clientSecret"],
] as const;

describe.each(casos)(
  "esquema de guardado de %s",
  (_t, esquema, valido, campoA, campoB) => {
    it("acepta un cuerpo válido y lo devuelve igual", () => {
      expect(datos(esquema, valido)).toEqual(valido);
    });

    it.each([campoA, campoB])("%s: largo de 1 a 256 bytes UTF-8", (campo) => {
      expect(ok(esquema, { ...valido, [campo]: "a" })).toBe(true);
      expect(ok(esquema, { ...valido, [campo]: "a".repeat(256) })).toBe(true);
      expect(ok(esquema, { ...valido, [campo]: "" })).toBe(false);
      expect(ok(esquema, { ...valido, [campo]: "a".repeat(257) })).toBe(false);
    });

    it.each([campoA, campoB])(
      "%s: el tope cuenta bytes, no caracteres",
      (campo) => {
        const dobles = "ñ".repeat(128); // 256 bytes en 128 caracteres
        expect(bytes(dobles)).toBe(256);
        expect(ok(esquema, { ...valido, [campo]: dobles })).toBe(true);
        expect(ok(esquema, { ...valido, [campo]: "ñ".repeat(129) })).toBe(
          false,
        );
        const emojis = "😀".repeat(64); // 256 bytes en 64 puntos de código
        expect(bytes(emojis)).toBe(256);
        expect(ok(esquema, { ...valido, [campo]: emojis })).toBe(true);
        expect(ok(esquema, { ...valido, [campo]: "😀".repeat(65) })).toBe(
          false,
        );
        // 255 bytes + un carácter de 2 bytes = 257
        expect(ok(esquema, { ...valido, [campo]: "a".repeat(255) + "ñ" })).toBe(
          false,
        );
      },
    );

    it.each([campoA, campoB])(
      "%s: rechaza sustitutos sueltos (UTF-16 mal formado)",
      (campo) => {
        for (const malo of ["\ud800", "ab\udc00cd", "\ud83d", "x\ude00"]) {
          expect(ok(esquema, { ...valido, [campo]: malo })).toBe(false);
        }
        // un par bien formado sí
        expect(ok(esquema, { ...valido, [campo]: "😀" })).toBe(true);
      },
    );

    it.each([campoA, campoB])("%s: rechaza lo que no es string", (campo) => {
      for (const malo of [null, undefined, 123, true, ["a"], { a: 1 }]) {
        expect(ok(esquema, { ...valido, [campo]: malo })).toBe(false);
      }
    });

    it("exige ambos campos", () => {
      expect(
        ok(esquema, { [campoA]: valido[campoA as keyof typeof valido] }),
      ).toBe(false);
      expect(
        ok(esquema, { [campoB]: valido[campoB as keyof typeof valido] }),
      ).toBe(false);
      expect(ok(esquema, {})).toBe(false);
      expect(ok(esquema, null)).toBe(false);
      expect(ok(esquema, "texto")).toBe(false);
    });

    it(`${campoB}: no se recorta ni se normaliza (se cifra tal cual)`, () => {
      for (const clave of [
        " con espacios ",
        "\tx\n",
        "  ",
        "é",
        "-empieza",
        "=f",
        "@a",
      ]) {
        const r = datos(esquema, { ...valido, [campoB]: clave });
        expect(r[campoB]).toBe(clave);
      }
    });

    it("descarta las claves desconocidas", () => {
      const r = datos(esquema, {
        ...valido,
        tenantId: "x",
        estado: "verificada",
        sobre: "abc",
        tipo: "sol",
        __proto__: { admin: true },
      });
      expect(Object.keys(r).sort()).toEqual([campoA, campoB].sort());
    });
  },
);

describe("guardarCredencialRespuestaSchema", () => {
  it("acepta {tipo, estado} y descarta todo lo demás", () => {
    const r = datos(guardarCredencialRespuestaSchema, {
      tipo: "sol",
      estado: "configurada",
      clave: "CANARIO-no-debe-pasar",
      sobre: "x",
    });
    expect(r).toEqual({ tipo: "sol", estado: "configurada" });
    expect(JSON.stringify(r)).not.toContain("CANARIO");
  });
  it.each([
    { tipo: "otro", estado: "configurada" },
    { tipo: "sol", estado: "rara" },
    { tipo: "sol" },
    { estado: "configurada" },
  ])("rechaza %j", (v) => {
    expect(ok(guardarCredencialRespuestaSchema, v)).toBe(false);
  });
});

describe("credencialEstadoSchema (DTO de GET /credenciales)", () => {
  it.each([
    { tipo: "sol", estado: "no_configurada", fecha: null, motivo: null },
    { tipo: "sol", estado: "configurada", fecha: null, motivo: null },
    {
      tipo: "sire_api",
      estado: "verificada",
      fecha: "2026-11-03T10:00:00.000Z",
      motivo: null,
    },
    {
      tipo: "sire_api",
      estado: "invalida",
      fecha: "2026-11-03T10:00:00.000Z",
      motivo: "credencial_invalida",
    },
  ])("acepta %j", (v) => {
    expect(datos(credencialEstadoSchema, v)).toEqual(v);
  });

  it("fecha y motivo son obligatorios (null explícito, no ausentes)", () => {
    expect(
      ok(credencialEstadoSchema, { tipo: "sol", estado: "configurada" }),
    ).toBe(false);
  });

  it.each([
    { tipo: "otro", estado: "configurada", fecha: null, motivo: null },
    { tipo: "sol", estado: "desconocida", fecha: null, motivo: null },
    { tipo: "sol", estado: "verificada", fecha: 123, motivo: null },
    { tipo: "sol", estado: "invalida", fecha: null, motivo: 5 },
  ])("rechaza %j", (v) => {
    expect(ok(credencialEstadoSchema, v)).toBe(false);
  });

  it("descarta sobre, versión y secretos que lleguen por error", () => {
    const r = datos(credencialEstadoSchema, {
      tipo: "sol",
      estado: "verificada",
      fecha: "2026-11-03T10:00:00.000Z",
      motivo: null,
      sobre: "CANARIO-sobre",
      clave: "CANARIO-clave",
      version: "123",
      tenantId: "t",
    });
    expect(Object.keys(r).sort()).toEqual([
      "estado",
      "fecha",
      "motivo",
      "tipo",
    ]);
    expect(JSON.stringify(r)).not.toContain("CANARIO");
  });
});
