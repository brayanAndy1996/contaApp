import { describe, expect, it } from "vitest";
import { hallazgoVistaSchema, sugerenciaVistaSchema } from "./index.js";

// Spec 027 · T2 (rojo). La sugerencia `excluir` ampliada de R-GP (spec 027 D-1, R-3, R-5; plan 027, Contratos: domain `SugerenciaExcluir` y shared; CA-1, CA-3).
// Contrato fijado por estas pruebas (packages/shared/src/compras/respuestas.ts, `sugerenciaVistaSchema`):
//  - FORMA NUEVA: {tipo: "excluir", palabra: string|null, categoria: string|null, puntaje: entero, senales: Senal[]},
//    Senal = {codigo: S1..S7, puntos: entero (puede ser negativo: S7), palabra?: string, categoria?: string, items?: {coinciden, total}} (.strict(): una
//    señal nunca lleva texto del XML, R-5). `palabra` y `categoria` son null cuando no hay S1 (la compra puntúa por otras señales).
//  - FORMA VIEJA (hallazgos guardados por 011, sin puntaje, se siguen leyendo): {tipo: "excluir", palabra: string, categoria: string}.
//  - No se mezclan: puntaje sin senales o senales sin puntaje se rechazan; la forma vieja no admite palabra o categoría null.
//  - El resto de las sugerencias (mover, separar, ajustar, clasificar) no cambian: lo cubre respuestas.spec.ts.
const hallazgo = {
  regla: "R-GP",
  destino: null,
  explicacion: "Posible gasto no deducible",
  sugerencia: null as unknown,
  requiereConfirmacion: true,
  dato: null,
  masiva: false,
};
const s1 = { codigo: "S1", puntos: 3, palabra: "zapatilla", categoria: "calzado-ropa", items: { coinciden: 1, total: 3 } };
const nueva = (o: Record<string, unknown> = {}) => ({ tipo: "excluir", palabra: "zapatilla", categoria: "calzado-ropa", puntaje: 3, senales: [s1], ...o });
const ok = (s: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => s.safeParse(v).success;
/** Acepta Y conserva todos los campos (un esquema viejo que descarta `puntaje` y `senales` no cuenta como aceptar). */
const conserva = (v: unknown): boolean => {
  const r = sugerenciaVistaSchema.safeParse(v);
  return r.success && JSON.stringify(r.data) === JSON.stringify(v);
};

describe("sugerenciaVistaSchema: excluir de la forma vieja (011)", () => {
  it("acepta {tipo, palabra, categoria} sin puntaje y lo devuelve tal cual", () => {
    const v = { tipo: "excluir", palabra: "ZAPATILLAS", categoria: "personal" };
    const r = sugerenciaVistaSchema.safeParse(v);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(v);
  });
  it.each([
    ["palabra null", { tipo: "excluir", palabra: null, categoria: "personal" }],
    ["categoria null", { tipo: "excluir", palabra: "ZAPATILLAS", categoria: null }],
    ["sin palabra", { tipo: "excluir", categoria: "personal" }],
    ["sin categoria", { tipo: "excluir", palabra: "ZAPATILLAS" }],
  ])("la forma vieja no admite %s", (_c, v) => {
    expect(ok(sugerenciaVistaSchema, v)).toBe(false);
  });
});

describe("sugerenciaVistaSchema: excluir con puntaje y señales (027)", () => {
  it("acepta la sugerencia de CA-1 con S1 y la devuelve con puntaje y señales", () => {
    const r = sugerenciaVistaSchema.safeParse(nueva());
    expect(r.success).toBe(true);
    expect(r.data).toEqual(nueva());
  });
  it("acepta palabra y categoria null cuando no hay S1 (puntúa por S2, S3 y otras)", () => {
    const v = nueva({
      palabra: null,
      categoria: null,
      puntaje: 4,
      senales: [
        { codigo: "S2", puntos: 3 },
        { codigo: "S5", puntos: 1 },
      ],
    });
    expect(conserva(v)).toBe(true);
  });
  it("acepta las siete señales con sus campos opcionales y S7 con puntos negativos", () => {
    const v = nueva({
      puntaje: 5,
      senales: [
        s1,
        { codigo: "S2", puntos: 3 },
        { codigo: "S3", puntos: 2, categoria: "calzado-ropa" },
        { codigo: "S4", puntos: 1 },
        { codigo: "S5", puntos: 1 },
        { codigo: "S6", puntos: 4 },
        { codigo: "S7", puntos: -4 },
      ],
    });
    expect(conserva(v)).toBe(true);
  });
  it("acepta una lista de señales vacía (la vista no recalcula la suma)", () => {
    expect(conserva(nueva({ senales: [] }))).toBe(true);
  });
  it.each(["S1", "S2", "S3", "S4", "S5", "S6", "S7"])("acepta el código de señal %s", (codigo) => {
    expect(conserva(nueva({ senales: [{ codigo, puntos: 1 }] }))).toBe(true);
  });
  it.each(["S0", "S8", "s1", "S1 ", "R-GP", "", null, 1])("rechaza el código de señal %j", (codigo) => {
    expect(ok(sugerenciaVistaSchema, nueva({ senales: [{ codigo, puntos: 1 }] }))).toBe(false);
  });
  it.each([
    ["puntos decimales", { codigo: "S1", puntos: 1.5 }],
    ["puntos como cadena", { codigo: "S1", puntos: "3" }],
    ["sin puntos", { codigo: "S1" }],
    ["items con más coincidencias que total", { codigo: "S1", puntos: 3, items: { coinciden: 4, total: 3 } }],
    ["items con 0 coincidencias", { codigo: "S1", puntos: 3, items: { coinciden: 0, total: 3 } }],
    ["items decimales", { codigo: "S1", puntos: 3, items: { coinciden: 1.5, total: 3 } }],
    ["items sin total", { codigo: "S1", puntos: 3, items: { coinciden: 1 } }],
    ["items con clave extra", { codigo: "S1", puntos: 3, items: { coinciden: 1, total: 3, glosa: "X" } }],
    ["palabra número", { codigo: "S1", puntos: 3, palabra: 5 }],
    ["clave extra glosa (texto del XML)", { codigo: "S1", puntos: 3, glosa: "ZAPATILLAS NIKE" }],
    ["clave extra descripcion", { codigo: "S1", puntos: 3, descripcion: "x" }],
  ])("rechaza una señal con %s", (_c, senal) => {
    expect(ok(sugerenciaVistaSchema, nueva({ senales: [senal] }))).toBe(false);
  });
  it.each([
    ["puntaje decimal", { puntaje: 3.5 }],
    ["puntaje como cadena", { puntaje: "3" }],
    ["puntaje null", { puntaje: null }],
    ["senales null", { senales: null }],
    ["senales como cadena", { senales: "S1" }],
    ["palabra número", { palabra: 5 }],
    ["categoria número", { categoria: 5 }],
  ])("rechaza la sugerencia con %s", (_c, o) => {
    expect(ok(sugerenciaVistaSchema, nueva(o))).toBe(false);
  });
  it("no mezcla las formas: puntaje sin senales o senales sin puntaje", () => {
    const sinSenales = nueva();
    delete (sinSenales as Record<string, unknown>).senales;
    const sinPuntaje = nueva();
    delete (sinPuntaje as Record<string, unknown>).puntaje;
    expect(ok(sugerenciaVistaSchema, sinSenales)).toBe(false);
    expect(ok(sugerenciaVistaSchema, sinPuntaje)).toBe(false);
  });
  it("no deja salir claves ajenas de la sugerencia (tenantId, glosa)", () => {
    const r = sugerenciaVistaSchema.safeParse({ ...nueva(), tenantId: "x", glosa: "ZAPATILLAS" });
    expect(r.success && ("tenantId" in (r.data as object) || "glosa" in (r.data as object))).toBe(false);
  });
});

describe("hallazgoVistaSchema con el hallazgo R-GP de 027", () => {
  it("acepta el hallazgo R-GP con la sugerencia ampliada, confirmación obligatoria y sin masiva", () => {
    const h = { ...hallazgo, sugerencia: nueva() };
    const r = hallazgoVistaSchema.safeParse(h);
    expect(r.success).toBe(true);
    expect((r.data as { sugerencia: unknown }).sugerencia).toEqual(nueva());
  });
  it("sigue leyendo el hallazgo R-GP guardado por 011 (sin puntaje)", () => {
    const h = { ...hallazgo, explicacion: "Posible gasto personal: ZAPATILLAS", sugerencia: { tipo: "excluir", palabra: "ZAPATILLAS", categoria: "personal" } };
    expect(ok(hallazgoVistaSchema, h)).toBe(true);
  });
  it("rechaza el hallazgo con una sugerencia excluir mezclada", () => {
    expect(ok(hallazgoVistaSchema, { ...hallazgo, sugerencia: nueva({ senales: undefined }) })).toBe(false);
  });
});
