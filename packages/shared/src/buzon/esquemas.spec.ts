import { describe, expect, it } from "vitest";
import {
  CATEGORIAS_BUZON,
  CATEGORIAS_CRITICAS_BUZON,
  LIMITE_MAX_MENSAJES_BUZON,
  MOTIVOS_CRITICO_BUZON,
  MOTIVOS_OMITIDO_BUZON,
  categoriaBuzonSchema,
  listarMensajesQuery,
} from "./index.js";
import * as raiz from "../index.js";

// Spec 023 · T2 (rojo). Códigos y query string del buzón SOL (plan 023, Contratos: HTTP y Dominio; D-7, D-8; P-3).
// Contrato fijado por estas pruebas (packages/shared/src/buzon/esquemas.ts, exportado por buzon/index.ts y por src/index.ts):
//  - CATEGORIAS_BUZON = [coactiva, resolucion_determinacion, resolucion_multa, requerimiento_fiscalizacion, otro]
//    (las cuatro críticas de RF-122 y «otro»); CATEGORIAS_CRITICAS_BUZON = las cuatro primeras, sin «otro».
//  - categoriaBuzonSchema = z.enum(CATEGORIAS_BUZON).
//  - MOTIVOS_CRITICO_BUZON = [codigo, asunto, duda] (los de `buzon_mensaje.motivo_critico`);
//    MOTIVOS_OMITIDO_BUZON = [mime, tamano, tope_mensaje] (los de `buzon_adjunto.omitido`).
//  - LIMITE_MAX_MENSAJES_BUZON = 100.
//  - listarMensajesQuery = query string de GET …/buzon/mensajes: {cursor?: string 1..512 opaco, limite?: entero 1..100 que
//    llega como texto ("25") o número y sale como number}. Todo opcional; las claves desconocidas (clienteId, tenantId) se descartan.
interface Esquema {
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
}
const ok = (s: Esquema, v: unknown) => s.safeParse(v).success;

describe("CATEGORIAS_BUZON", () => {
  it("son las cuatro críticas de RF-122 y «otro», en ese orden", () => {
    expect([...CATEGORIAS_BUZON]).toEqual([
      "coactiva",
      "resolucion_determinacion",
      "resolucion_multa",
      "requerimiento_fiscalizacion",
      "otro",
    ]);
  });
  it("las críticas son exactamente las cuatro primeras: «otro» nunca es crítica", () => {
    expect([...CATEGORIAS_CRITICAS_BUZON]).toEqual([
      "coactiva",
      "resolucion_determinacion",
      "resolucion_multa",
      "requerimiento_fiscalizacion",
    ]);
    expect(CATEGORIAS_CRITICAS_BUZON as readonly string[]).not.toContain("otro");
  });
  it("todas son códigos en minúscula con guion bajo, sin repetir", () => {
    for (const c of CATEGORIAS_BUZON) expect(c).toMatch(/^[a-z]+(_[a-z]+)*$/);
    expect(new Set(CATEGORIAS_BUZON).size).toBe(CATEGORIAS_BUZON.length);
  });
  it("categoriaBuzonSchema acepta cada una y rechaza lo demás", () => {
    for (const c of CATEGORIAS_BUZON) expect(ok(categoriaBuzonSchema, c)).toBe(true);
    for (const malo of ["Coactiva", "COACTIVA", "multa", "", null, 1, undefined, " coactiva"]) {
      expect(ok(categoriaBuzonSchema, malo)).toBe(false);
    }
  });
  it("se exporta desde el índice de shared", () => {
    expect(raiz.CATEGORIAS_BUZON).toBe(CATEGORIAS_BUZON);
  });
});

describe("motivos", () => {
  it("MOTIVOS_CRITICO_BUZON = codigo, asunto, duda", () => {
    expect([...MOTIVOS_CRITICO_BUZON]).toEqual(["codigo", "asunto", "duda"]);
  });
  it("MOTIVOS_OMITIDO_BUZON = mime, tamano, tope_mensaje", () => {
    expect([...MOTIVOS_OMITIDO_BUZON]).toEqual(["mime", "tamano", "tope_mensaje"]);
  });
});

describe("listarMensajesQuery", () => {
  const parse = (v: unknown) => listarMensajesQuery.safeParse(v) as { success: boolean; data?: Record<string, unknown> };

  it("el tope es 100", () => {
    expect(LIMITE_MAX_MENSAJES_BUZON).toBe(100);
  });
  it("acepta la consulta vacía (todo opcional)", () => {
    expect(parse({}).success).toBe(true);
  });
  it("limite llega como texto y sale como número", () => {
    const r = parse({ limite: "25" });
    expect(r.success).toBe(true);
    expect(r.data?.limite).toBe(25);
  });
  it("limite numérico se conserva", () => {
    expect(parse({ limite: 40 }).data?.limite).toBe(40);
  });
  it.each(["1", "50", "100", 1, 100])("acepta limite %j", (limite) => {
    expect(ok(listarMensajesQuery, { limite })).toBe(true);
  });
  it.each(["0", "101", "-1", "1.5", "abc", "", " ", "1e2", "0x10", "10 ", 0, 101, -5, 2.5, NaN, null])(
    "rechaza limite %j",
    (limite) => {
      expect(ok(listarMensajesQuery, { limite })).toBe(false);
    },
  );
  it("acepta un cursor opaco y lo devuelve igual", () => {
    const cursor = "eyJmIjoiMjAyNi0xMS0xMlQxMDowMDowMC4wMDBaIiwiaSI6IjEifQ";
    const r = parse({ cursor, limite: "10" });
    expect(r.success).toBe(true);
    expect(r.data?.cursor).toBe(cursor);
  });
  it.each(["", 1, null, {}, ["a"], "x".repeat(513)])("rechaza el cursor %j", (cursor) => {
    expect(ok(listarMensajesQuery, { cursor })).toBe(false);
  });
  it("descarta claves desconocidas: clienteId y tenantId no viajan por la query", () => {
    const r = parse({ limite: "5", clienteId: "x", tenantId: "y" });
    expect(r.success).toBe(true);
    expect(r.data).not.toHaveProperty("clienteId");
    expect(r.data).not.toHaveProperty("tenantId");
  });
  it("se exporta desde el índice de shared", () => {
    expect(raiz.listarMensajesQuery).toBe(listarMensajesQuery);
  });
});
