import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  atenderLoteBodySchema,
  atenderMensajeBodySchema,
  comentarioAtencionSchema,
  comentarioRequerido,
  eventoAtencionSchema,
  respuestaLoteSchema,
} from "./index.js";
import { ACCIONES_AUDITORIA, accionAuditoriaSchema } from "../auditoria/index.js";
import * as raiz from "../index.js";

// Spec 024 · T1 (rojo). Atención de mensajes (plan 024, Contratos: shared; D-5 a D-8; U-3; CA-4, CA-5, CA-7).
// Contrato fijado por estas pruebas (packages/shared/src/buzon/atencion.ts, exportado por buzon/index.ts y por src/index.ts):
//  - comentarioAtencionSchema: string que se recorta; 1..500 tras recortar; sin controles (\p{Cc}) salvo \n (rechaza \u0000, \r, \t, \u007f)
//    ni bidi (U+202A–202E, U+2066–2069, U+200E, U+200F, U+061C); «<script>» es texto válido (nunca se interpreta como HTML).
//  - comentarioRequerido({critico, accion}) = accion === "marcar" && critico.
//  - atenderMensajeBodySchema = {accion: "marcar"|"deshacer", comentario?} (.strict()).
//  - atenderLoteBodySchema = {mensajes: uuid[1..100] sin repetidos, comentario?} (.strict(); solo marca: `accion` es clave extra, U-3).
//  - respuestaLoteSchema = {atendidos: uuid[], omitidos: uuid[]}.
//  - eventoAtencionSchema = {accion: "atendido"|"deshecho", comentario: string|null, usuario: {id: uuid, nombre}, en: ISO}.
//  - ACCIONES_AUDITORIA suma buzon.atendido y buzon.atencion_deshecha.
interface Esquema {
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
}
const esq = (s: Esquema | undefined): Esquema => {
  if (!s) throw new Error("no implementado: export ausente");
  return s;
};
const ok = (s: Esquema | undefined, v: unknown) => esq(s).safeParse(v).success;
const datos = (s: Esquema | undefined, v: unknown) => {
  const r = esq(s).safeParse(v);
  expect(r.success).toBe(true);
  return r.data as Record<string, unknown>;
};
const U1 = "01920000-0000-7000-8000-0000000000a1";

describe("comentarioAtencionSchema", () => {
  const parse = (v: unknown) => esq(comentarioAtencionSchema).safeParse(v) as { success: boolean; data?: string };

  it("acepta un comentario normal y lo devuelve igual", () => {
    const c = "Se presentó el escrito de reclamo el 12/11 (ñandú, acción, 100%).";
    const r = parse(c);
    expect(r.success).toBe(true);
    expect(r.data).toBe(c);
  });
  it("recorta los espacios de los extremos", () => {
    expect(parse("   hola   ").data).toBe("hola");
    expect(parse("\n  hola  \n").data).toBe("hola");
  });
  it("rechaza el vacío y el que solo tiene espacios", () => {
    for (const malo of ["", " ", "     ", "\n", " \n "]) expect(parse(malo).success).toBe(false);
  });
  it("500 caracteres se aceptan y 501 se rechazan", () => {
    expect(parse("a".repeat(500)).success).toBe(true);
    expect(parse("a".repeat(501)).success).toBe(false);
  });
  it("el límite cuenta después de recortar: 500 más espacios sigue siendo válido", () => {
    const r = parse(`  ${"a".repeat(500)}  `);
    expect(r.success).toBe(true);
    expect(r.data).toBe("a".repeat(500));
    expect(parse(`  ${"a".repeat(501)}  `).success).toBe(false);
  });
  it.each([
    ["RLO U+202E", "pago‮atras"],
    ["LRI U+2066", "texto⁦aislado"],
    ["RLI U+2067", "texto⁧aislado"],
    ["FSI U+2068", "texto⁨aislado"],
    ["PDI U+2069", "texto⁩aislado"],
    ["LRE U+202A", "texto‪incrustado"],
    ["RLE U+202B", "texto‫incrustado"],
    ["PDF U+202C", "texto‬fin"],
    ["LRO U+202D", "texto‭forzado"],
    ["LRM U+200E", "texto‎marca"],
    ["RLM U+200F", "texto‏marca"],
    ["ALM U+061C", "texto؜marca"],
  ])("rechaza el carácter bidi %s", (_n, texto) => {
    expect(parse(texto).success).toBe(false);
  });
  it.each([
    ["NUL \\u0000", "a\u0000b"],
    ["retorno de carro \\r", "a\rb"],
    ["CRLF", "a\r\nb"],
    ["tabulación \\t", "a\tb"],
    ["ESC \\u001b", "a\u001Bb"],
    ["DEL \\u007f", "a\u007Fb"],
    ["control C1 \\u0085", "a\u0085b"],
  ])("rechaza el carácter de control %s", (_n, texto) => {
    expect(parse(texto).success).toBe(false);
  });
  it("rechaza un carácter prohibido aunque esté al final o al inicio", () => {
    expect(parse("‮hola").success).toBe(false);
    expect(parse("hola\u0000").success).toBe(false);
  });
  it("acepta el salto de línea \\n en medio del texto", () => {
    const r = parse("primera línea\nsegunda línea");
    expect(r.success).toBe(true);
    expect(r.data).toBe("primera línea\nsegunda línea");
  });
  it("acepta «<script>» como texto y lo devuelve sin tocar (se escapa al pintar, no aquí)", () => {
    const c = "<script>alert(1)</script> & <b>negrita</b>";
    const r = parse(c);
    expect(r.success).toBe(true);
    expect(r.data).toBe(c);
  });
  it.each([null, undefined, 5, true, {}, ["a"]])("rechaza el valor que no es texto %j", (v) => {
    expect(parse(v).success).toBe(false);
  });
  it("se exporta desde el índice de shared", () => {
    expect(comentarioAtencionSchema).toBeDefined();
    expect(raiz.comentarioAtencionSchema).toBe(comentarioAtencionSchema);
  });
});

describe("comentarioRequerido", () => {
  const req = (critico: boolean, accion: "marcar" | "deshacer") => {
    if (!comentarioRequerido) throw new Error("no implementado: export ausente");
    return comentarioRequerido({ critico, accion });
  };
  it("marcar un crítico exige comentario", () => {
    expect(req(true, "marcar")).toBe(true);
  });
  it("marcar un no crítico no lo exige", () => {
    expect(req(false, "marcar")).toBe(false);
  });
  it("deshacer no lo exige, sea crítico o no", () => {
    expect(req(true, "deshacer")).toBe(false);
    expect(req(false, "deshacer")).toBe(false);
  });
  it("devuelve un booleano estricto", () => {
    for (const critico of [true, false]) {
      for (const accion of ["marcar", "deshacer"] as const) expect(typeof req(critico, accion)).toBe("boolean");
    }
  });
  it("se exporta desde el índice de shared", () => {
    expect(comentarioRequerido).toBeDefined();
    expect(raiz.comentarioRequerido).toBe(comentarioRequerido);
  });
});

describe("atenderMensajeBodySchema", () => {
  it.each(["marcar", "deshacer"])("acepta {accion: %s} sin comentario", (accion) => {
    expect(datos(atenderMensajeBodySchema, { accion })).toEqual({ accion });
  });
  it("acepta un comentario y lo devuelve recortado", () => {
    expect(datos(atenderMensajeBodySchema, { accion: "marcar", comentario: "  Presentado  " })).toEqual({
      accion: "marcar",
      comentario: "Presentado",
    });
  });
  it("acepta un comentario con \\n y con «<script>»", () => {
    expect(ok(atenderMensajeBodySchema, { accion: "deshacer", comentario: "línea 1\nlínea 2" })).toBe(true);
    expect(ok(atenderMensajeBodySchema, { accion: "marcar", comentario: "<script>x</script>" })).toBe(true);
  });
  it.each(["atender", "Marcar", "MARCAR", "", "desmarcar", "atendido", "deshecho", null, 1, undefined])(
    "rechaza accion=%j",
    (accion) => {
      expect(ok(atenderMensajeBodySchema, { accion })).toBe(false);
    },
  );
  it("exige la acción", () => {
    expect(ok(atenderMensajeBodySchema, {})).toBe(false);
    expect(ok(atenderMensajeBodySchema, { comentario: "hola" })).toBe(false);
  });
  it.each(["clienteId", "mensajeId", "tenantId", "usuarioId", "foo"])("rechaza la clave extra %s (.strict())", (clave) => {
    expect(ok(atenderMensajeBodySchema, { accion: "marcar", [clave]: U1 })).toBe(false);
  });
  it.each(["", "   ", "a".repeat(501), "x‮y", "x\u0000y", "x\ry", null, 5])("rechaza el comentario %j", (comentario) => {
    expect(ok(atenderMensajeBodySchema, { accion: "marcar", comentario })).toBe(false);
  });
  it("acepta un comentario de 500 caracteres", () => {
    expect(ok(atenderMensajeBodySchema, { accion: "marcar", comentario: "a".repeat(500) })).toBe(true);
  });
  it("no valida el carácter crítico: eso lo decide el servidor con comentarioRequerido", () => {
    expect(ok(atenderMensajeBodySchema, { accion: "marcar" })).toBe(true);
  });
  it("se exporta desde el índice de shared", () => {
    expect(atenderMensajeBodySchema).toBeDefined();
    expect(raiz.atenderMensajeBodySchema).toBe(atenderMensajeBodySchema);
  });
});

describe("atenderLoteBodySchema", () => {
  const ids = (n: number) => Array.from({ length: n }, () => randomUUID());

  it("acepta 1 mensaje y lo devuelve igual", () => {
    const m = ids(1);
    expect(datos(atenderLoteBodySchema, { mensajes: m })).toEqual({ mensajes: m });
  });
  it("acepta 100 mensajes", () => {
    expect(ok(atenderLoteBodySchema, { mensajes: ids(100) })).toBe(true);
  });
  it("rechaza 0 mensajes y 101 mensajes", () => {
    expect(ok(atenderLoteBodySchema, { mensajes: [] })).toBe(false);
    expect(ok(atenderLoteBodySchema, { mensajes: ids(101) })).toBe(false);
  });
  it("rechaza ids repetidos", () => {
    const a = randomUUID();
    expect(ok(atenderLoteBodySchema, { mensajes: [a, a] })).toBe(false);
    const m = ids(50);
    expect(ok(atenderLoteBodySchema, { mensajes: [...m, m[10]] })).toBe(false);
  });
  it("rechaza ids repetidos que solo difieren en mayúsculas", () => {
    expect(ok(atenderLoteBodySchema, { mensajes: [U1, U1.toUpperCase()] })).toBe(false);
  });
  it.each(["no-uuid", "", "123", 5, null, undefined, "01920000-0000-7000-8000-0000000000a"])("rechaza el id %j", (id) => {
    expect(ok(atenderLoteBodySchema, { mensajes: [randomUUID(), id] })).toBe(false);
  });
  it("rechaza mensajes que no es una lista, o ausente", () => {
    expect(ok(atenderLoteBodySchema, {})).toBe(false);
    expect(ok(atenderLoteBodySchema, { mensajes: randomUUID() })).toBe(false);
    expect(ok(atenderLoteBodySchema, { mensajes: null })).toBe(false);
  });
  it("acepta un comentario único para todo el lote, recortado", () => {
    const m = ids(3);
    expect(datos(atenderLoteBodySchema, { mensajes: m, comentario: "  Revisado en conjunto  " })).toEqual({
      mensajes: m,
      comentario: "Revisado en conjunto",
    });
  });
  it.each(["", "   ", "a".repeat(501), "x⁦y", "x\u0000y", 7])("rechaza el comentario %j", (comentario) => {
    expect(ok(atenderLoteBodySchema, { mensajes: ids(2), comentario })).toBe(false);
  });
  it("solo marca: `accion` es una clave extra y se rechaza (deshacer en lote no existe, U-3)", () => {
    expect(ok(atenderLoteBodySchema, { mensajes: ids(2), accion: "marcar" })).toBe(false);
    expect(ok(atenderLoteBodySchema, { mensajes: ids(2), accion: "deshacer" })).toBe(false);
  });
  it.each(["clienteId", "tenantId", "usuarioId", "foo"])("rechaza la clave extra %s (.strict())", (clave) => {
    expect(ok(atenderLoteBodySchema, { mensajes: ids(2), [clave]: U1 })).toBe(false);
  });
  it("se exporta desde el índice de shared", () => {
    expect(atenderLoteBodySchema).toBeDefined();
    expect(raiz.atenderLoteBodySchema).toBe(atenderLoteBodySchema);
  });
});

describe("respuestaLoteSchema", () => {
  it("acepta atendidos y omitidos y los devuelve iguales", () => {
    const r = { atendidos: [randomUUID(), randomUUID()], omitidos: [randomUUID()] };
    expect(datos(respuestaLoteSchema, r)).toEqual(r);
  });
  it("acepta listas vacías (todos omitidos, o ninguno)", () => {
    expect(ok(respuestaLoteSchema, { atendidos: [], omitidos: [randomUUID()] })).toBe(true);
    expect(ok(respuestaLoteSchema, { atendidos: [randomUUID()], omitidos: [] })).toBe(true);
  });
  it("rechaza ids que no son uuid y claves ausentes", () => {
    expect(ok(respuestaLoteSchema, { atendidos: ["x"], omitidos: [] })).toBe(false);
    expect(ok(respuestaLoteSchema, { atendidos: [], omitidos: [5] })).toBe(false);
    expect(ok(respuestaLoteSchema, { atendidos: [] })).toBe(false);
    expect(ok(respuestaLoteSchema, { omitidos: [] })).toBe(false);
  });
  it("descarta claves desconocidas: el comentario no vuelve en la respuesta", () => {
    const r = datos(respuestaLoteSchema, { atendidos: [], omitidos: [], comentario: "CANARIO", tenantId: U1 });
    expect(r).not.toHaveProperty("comentario");
    expect(r).not.toHaveProperty("tenantId");
  });
  it("se exporta desde el índice de shared", () => {
    expect(respuestaLoteSchema).toBeDefined();
    expect(raiz.respuestaLoteSchema).toBe(respuestaLoteSchema);
  });
});

describe("eventoAtencionSchema", () => {
  const evento = (o: Record<string, unknown> = {}) => ({
    accion: "atendido",
    comentario: "Se presentó el escrito",
    usuario: { id: U1, nombre: "Ana Paredes" },
    en: "2026-11-13T09:30:00.000Z",
    ...o,
  });
  it("acepta un evento atendido y lo devuelve igual", () => {
    const e = evento();
    expect(datos(eventoAtencionSchema, e)).toEqual(e);
  });
  it("acepta un evento deshecho sin comentario (null)", () => {
    const e = evento({ accion: "deshecho", comentario: null });
    expect(datos(eventoAtencionSchema, e)).toEqual(e);
  });
  it.each(["marcar", "deshacer", "atender", "", null, 1])("rechaza accion=%j (los eventos son atendido|deshecho)", (accion) => {
    expect(ok(eventoAtencionSchema, evento({ accion }))).toBe(false);
  });
  it("rechaza comentario que no es texto ni null, y comentario ausente", () => {
    expect(ok(eventoAtencionSchema, evento({ comentario: 5 }))).toBe(false);
    const sin = evento() as Record<string, unknown>;
    delete sin.comentario;
    expect(ok(eventoAtencionSchema, sin)).toBe(false);
  });
  it("rechaza usuario mal formado, ausente o fecha no ISO", () => {
    expect(ok(eventoAtencionSchema, evento({ usuario: { id: "x", nombre: "A" } }))).toBe(false);
    expect(ok(eventoAtencionSchema, evento({ usuario: { id: U1 } }))).toBe(false);
    expect(ok(eventoAtencionSchema, evento({ usuario: null }))).toBe(false);
    expect(ok(eventoAtencionSchema, evento({ en: "ayer" }))).toBe(false);
    expect(ok(eventoAtencionSchema, evento({ en: null }))).toBe(false);
  });
  it("descarta claves desconocidas: tenantId, mensajeId y el correo del usuario no salen", () => {
    const e = datos(eventoAtencionSchema, evento({ tenantId: U1, mensajeId: U1, usuario: { id: U1, nombre: "Ana", email: "a@x.pe" } })) as {
      usuario: Record<string, unknown>;
    };
    expect(e).not.toHaveProperty("tenantId");
    expect(e).not.toHaveProperty("mensajeId");
    expect(e.usuario).not.toHaveProperty("email");
  });
  it("se exporta desde el índice de shared", () => {
    expect(eventoAtencionSchema).toBeDefined();
    expect(raiz.eventoAtencionSchema).toBe(eventoAtencionSchema);
  });
});

describe("acciones de auditoría de 024 (D-8)", () => {
  const NUEVAS = ["buzon.atendido", "buzon.atencion_deshecha"];
  it.each(NUEVAS)("ACCIONES_AUDITORIA incluye %s", (a) => {
    expect(ACCIONES_AUDITORIA as readonly string[]).toContain(a);
  });
  it.each(NUEVAS)("accionAuditoriaSchema acepta %s", (a) => {
    expect(accionAuditoriaSchema.safeParse(a).success).toBe(true);
  });
  it("las acciones buzon.* son las 5 de 023 más estas 2", () => {
    expect(ACCIONES_AUDITORIA.filter((a) => a.startsWith("buzon.")).sort()).toEqual(
      [
        "buzon.contenido_obtenido",
        "buzon.captura_solicitada",
        "buzon.apertura_solicitada",
        "buzon.contenido_visto",
        "buzon.adjunto_descargado",
        ...NUEVAS,
      ].sort(),
    );
  });
  it("siguen la forma entidad.hecho y no se repiten", () => {
    expect(new Set(ACCIONES_AUDITORIA).size).toBe(ACCIONES_AUDITORIA.length);
    for (const a of ACCIONES_AUDITORIA) expect(a).toMatch(/^[a-z]+\.[a-z_]+$/);
  });
  it.each(["buzon.atender", "buzon.atendida", "buzon.atencion_deshacer", "Buzon.atendido", "buzon.deshecho"])(
    "accionAuditoriaSchema rechaza %s",
    (a) => {
      expect(accionAuditoriaSchema.safeParse(a).success).toBe(false);
    },
  );
  it("las acciones previas siguen", () => {
    for (const a of ["sesion.ingreso", "regla.creada", "compra.historial", "sunat.envio", "buzon.contenido_visto"]) {
      expect(ACCIONES_AUDITORIA as readonly string[]).toContain(a);
    }
  });
});
