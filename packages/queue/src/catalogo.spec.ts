import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  TipoDesconocidoError,
  TipoInvalidoError,
  definicionDe,
  registrarTipo,
} from "./index.js";

// Contrato (plan 008, packages/queue/src/catalogo.ts), D7, CA-15:
//  - registrarTipo(def: DefinicionTrabajo<P>) / definicionDe(tipo) -> la definicion registrada
//    ({ tipo, cola, canal, credencial, permiso, idempotente, parametros: ZodType }).
//  - definicionDe de un tipo no registrado LANZA TipoDesconocidoError (extiende Error, codigo
//    "tipo_desconocido"): falla cerrado (un payload forjado con otro tipo no ejecuta nada).
//    Funciona solo con tipos propios: "constructor", "__proto__", "toString" son desconocidos.
//  - registrarTipo rechaza (lanza TipoInvalidoError, codigo "tipo_invalido") un `tipo` que no cumple
//    /^[a-z]+(\.[a-z_]+)+$/ (igual que el CHECK de job_registro.tipo).
//  - `prueba.eco` se registra SOLO con NODE_ENV=test (vitest lo fija); con cualquier otro valor
//    definicionDe("prueba.eco") lanza TipoDesconocidoError.
const def = {
  tipo: "test.catalogo",
  cola: "sire",
  canal: "sire",
  credencial: "sire_api",
  permiso: "sire.descargar",
  idempotente: true,
  parametros: z.object({ periodo: z.string().regex(/^\d{6}$/) }),
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("catalogo de tipos de trabajo", () => {
  it("exporta las clases de error", () => {
    expect(typeof TipoDesconocidoError).toBe("function");
    expect(typeof TipoInvalidoError).toBe("function");
  });

  it("registra un tipo y devuelve su definicion", () => {
    registrarTipo(def);
    const r = definicionDe("test.catalogo");
    expect(r).toMatchObject({
      tipo: "test.catalogo",
      cola: "sire",
      canal: "sire",
      credencial: "sire_api",
      permiso: "sire.descargar",
      idempotente: true,
    });
    expect(r.parametros.safeParse({ periodo: "202610" }).success).toBe(true);
    expect(r.parametros.safeParse({ periodo: "oct" }).success).toBe(false);
  });

  it("un tipo no registrado lanza TipoDesconocidoError", () => {
    expect(() => definicionDe("no.existe")).toThrow(TipoDesconocidoError);
    try {
      definicionDe("no.existe");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as { codigo?: string }).codigo).toBe("tipo_desconocido");
    }
  });

  it.each([
    "constructor",
    "__proto__",
    "toString",
    "hasOwnProperty",
    "",
    "TEST.catalogo",
  ])("no resuelve %j (ni por prototipo ni por mayusculas)", (tipo) => {
    registrarTipo(def);
    expect(() => definicionDe(tipo)).toThrow(TipoDesconocidoError);
  });

  it.each([
    "Mal",
    "sin_punto",
    "a.B",
    "a..b",
    ".a",
    "a.",
    "a b.c",
    "a.b-c",
    "1a.b",
  ])("registrarTipo rechaza el tipo mal formado %j", (tipo) => {
    expect(() => registrarTipo({ ...def, tipo })).toThrow(TipoInvalidoError);
  });

  it("acepta tipos con varios niveles y guion bajo", () => {
    registrarTipo({ ...def, tipo: "test.sire.reemplazo_enviar" });
    expect(definicionDe("test.sire.reemplazo_enviar").tipo).toBe(
      "test.sire.reemplazo_enviar",
    );
  });
});

describe("prueba.eco solo existe con NODE_ENV=test", () => {
  it("con NODE_ENV=test esta registrado", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(definicionDe("prueba.eco").tipo).toBe("prueba.eco");
  });

  it.each(["production", "development", ""])(
    "con NODE_ENV=%j no existe",
    async (valor) => {
      vi.stubEnv("NODE_ENV", valor);
      vi.resetModules();
      const m = await import("./index.js");
      expect(typeof m.TipoDesconocidoError).toBe("function");
      expect(() => m.definicionDe("prueba.eco")).toThrow(
        m.TipoDesconocidoError,
      );
    },
  );
});
