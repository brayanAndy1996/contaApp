import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as shared from "../index.js";

// Spec 027 · T2 (rojo). Vistas de respuesta y códigos de error de los gastos no deducibles (spec 027 R-4, R-7, R-11, R-13; D-2, D-3; plan 027, Contratos: shared).
// Contrato fijado por estas pruebas (packages/shared/src/gastos/{vistas,errores}.ts, exportado por gastos/index.ts y src/index.ts). Fechas ISO con
// `Date.prototype.toISOString`; los autores usan `autorSchema` de 017 ({id, nombre, activo}). Ninguna vista lleva glosas ni texto de XML (R-5).
//  - gastosEstudioVistaSchema = {umbral 1..20, versionUmbral >= 0, activasPropias >= 0, limitePropias: 2000 (literal),
//    globales: [{id uuid, palabra, categoria, excepciones: string[], desactivadaPorEstudio: boolean}],
//    propias: [{id uuid, palabra, categoria, excepciones, origen: manual|aprendida, activa, version >= 1, autor, compraOrigenId: uuid|null, creadaEn}]}.
//  - categoriasClienteVistaSchema = {ciiu: 4 dígitos|null, seccion: letra A-U|null, base: categorias[], permitidas, quitadas, efectivas, version >= 0}.
//  - propuestaAprenderVistaSchema = {terminos: string[] de 0 a 10}.
//  - aprenderRespuestaSchema = {guardadas: string[], omitidas: string[]} (palabras normalizadas; cada lista <= 10).
//  - diccionarioGlobalVistaSchema = {palabras: [{id, palabra, categoria, excepciones, activa, version >= 1, actualizadaEn}]}.
//  - historialGlobalVistaSchema = {items: [{id, palabraGlobalId, palabra, accion: agregada|editada, antes: objeto|null, despues: objeto, autor, ocurridaEn}],
//    siguiente: ISO|null} (paginado por fecha, como `auth.gnd_global_historial(hash, limite, antes)`).
//  - CODIGOS_ERROR_GASTOS = version_cambiada, palabra_existente, limite_palabras, compra_no_excluida, compra_sin_xml, periodo_no_abierto;
//    errorGastosSchema = {codigo}. Se reutilizan cliente_archivado, solicitud_invalida, no_encontrado y permiso_denegado (no se redefinen aquí).
// Los esquemas se piden por nombre: si el export no existe, la prueba falla con «no implementado», no al cargar el archivo.
interface Esquema {
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
}
const esquema = (nombre: string): Esquema => {
  const s = (shared as Record<string, unknown>)[nombre] as Esquema | undefined;
  if (s === undefined) throw new Error(`no implementado: @contapp/shared no exporta ${nombre}`);
  return s;
};
const ok = (nombre: string, v: unknown) => esquema(nombre).safeParse(v).success;
const datos = (nombre: string, v: unknown) => {
  const r = esquema(nombre).safeParse(v);
  expect(r.success).toBe(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return r.data as Record<string, any>;
};

type Json = Record<string, unknown>;
const autor = (o: Json = {}): Json => ({ id: randomUUID(), nombre: "Ana Pérez", activo: true, ...o });
const AHORA = "2026-11-22T10:00:00.000Z";

const global = (o: Json = {}): Json => ({ id: randomUUID(), palabra: "zapatilla", categoria: "calzado-ropa", excepciones: ["seguridad", "punta de acero"], desactivadaPorEstudio: false, ...o });
const propia = (o: Json = {}): Json => ({
  id: randomUUID(),
  palabra: "audifonos",
  categoria: "entretenimiento",
  excepciones: [],
  origen: "aprendida",
  activa: true,
  version: 1,
  autor: autor(),
  compraOrigenId: randomUUID(),
  creadaEn: AHORA,
  ...o,
});
const vistaEstudio = (o: Json = {}): Json => ({
  umbral: 3,
  versionUmbral: 0,
  activasPropias: 1,
  limitePropias: 2000,
  globales: [global(), global({ palabra: "polo", excepciones: ["a tierra"], desactivadaPorEstudio: true })],
  propias: [propia(), propia({ palabra: "mochila", origen: "manual", compraOrigenId: null, categoria: "utiles-escolares" })],
  ...o,
});

describe("exportaciones de @contapp/shared para las vistas de gastos no deducibles (027)", () => {
  it.each([
    "gastosEstudioVistaSchema",
    "categoriasClienteVistaSchema",
    "propuestaAprenderVistaSchema",
    "aprenderRespuestaSchema",
    "diccionarioGlobalVistaSchema",
    "historialGlobalVistaSchema",
    "errorGastosSchema",
  ])("exporta %s", (nombre) => {
    expect((shared as Record<string, unknown>)[nombre]).toBeDefined();
  });
  it("exporta CODIGOS_ERROR_GASTOS", () => {
    expect((shared as Record<string, unknown>).CODIGOS_ERROR_GASTOS).toBeDefined();
  });
});

describe("gastosEstudioVistaSchema (R-4, R-11; CA-3)", () => {
  const S = "gastosEstudioVistaSchema";

  it("acepta la vista con globales, propias, umbral por defecto y límite 2000", () => {
    const d = datos(S, vistaEstudio());
    expect(d.umbral).toBe(3);
    expect(d.limitePropias).toBe(2000);
    expect(d.globales).toHaveLength(2);
    expect(d.propias).toHaveLength(2);
    expect(d.globales[1].desactivadaPorEstudio).toBe(true);
  });
  it("acepta el estudio sin palabras propias ni globales", () => {
    expect(ok(S, vistaEstudio({ globales: [], propias: [], activasPropias: 0 }))).toBe(true);
  });
  it.each(["umbral", "versionUmbral", "activasPropias", "limitePropias", "globales", "propias"])("%s es obligatorio", (clave) => {
    const o = vistaEstudio();
    delete o[clave];
    expect(ok(S, o)).toBe(false);
  });
  it.each([1, 3, 20])("acepta el umbral %j", (umbral) => {
    expect(ok(S, vistaEstudio({ umbral }))).toBe(true);
  });
  it.each([0, 21, 3.5, "3", null])("rechaza el umbral %j", (umbral) => {
    expect(ok(S, vistaEstudio({ umbral }))).toBe(false);
  });
  it("limitePropias es exactamente 2000", () => {
    for (const malo of [1999, 2001, "2000", null]) expect(ok(S, vistaEstudio({ limitePropias: malo })), String(malo)).toBe(false);
  });
  it.each([-1, 1.5, "1", null])("rechaza versionUmbral %j", (versionUmbral) => {
    expect(ok(S, vistaEstudio({ versionUmbral }))).toBe(false);
  });
  it.each([-1, 0.5, "1", null])("rechaza activasPropias %j", (activasPropias) => {
    expect(ok(S, vistaEstudio({ activasPropias }))).toBe(false);
  });

  describe("globales", () => {
    const con = (g: Json) => vistaEstudio({ globales: [g] });
    it.each(["id", "palabra", "categoria", "excepciones", "desactivadaPorEstudio"])("%s es obligatorio", (clave) => {
      const g = global();
      delete g[clave];
      expect(ok(S, con(g))).toBe(false);
    });
    it("rechaza id que no es uuid, categoría fuera de las 6, excepciones no lista y desactivada no booleana", () => {
      expect(ok(S, con(global({ id: "no-uuid" })))).toBe(false);
      expect(ok(S, con(global({ categoria: "personal" })))).toBe(false);
      expect(ok(S, con(global({ excepciones: "seguridad" })))).toBe(false);
      expect(ok(S, con(global({ excepciones: null })))).toBe(false);
      expect(ok(S, con(global({ desactivadaPorEstudio: "no" })))).toBe(false);
    });
    it("rechaza más de 5 excepciones", () => {
      expect(ok(S, con(global({ excepciones: ["a1", "b2", "c3", "d4", "e5", "f6"] })))).toBe(false);
    });
  });

  describe("propias", () => {
    const con = (p: Json) => vistaEstudio({ propias: [p] });
    it.each(["id", "palabra", "categoria", "excepciones", "origen", "activa", "version", "autor", "compraOrigenId", "creadaEn"])("%s es obligatorio (null no equivale a ausente)", (clave) => {
      const p = propia();
      delete p[clave];
      expect(ok(S, con(p))).toBe(false);
    });
    it.each(["manual", "aprendida"])("acepta el origen %s", (origen) => {
      expect(ok(S, con(propia({ origen, compraOrigenId: origen === "manual" ? null : randomUUID() })))).toBe(true);
    });
    it.each(["automatica", "Manual", "", null, 1])("rechaza el origen %j", (origen) => {
      expect(ok(S, con(propia({ origen })))).toBe(false);
    });
    it("compraOrigenId admite uuid o null y rechaza otra cosa", () => {
      expect(ok(S, con(propia({ compraOrigenId: null })))).toBe(true);
      expect(ok(S, con(propia({ compraOrigenId: "x" })))).toBe(false);
      expect(ok(S, con(propia({ compraOrigenId: 1 })))).toBe(false);
    });
    it("version es entero >= 1", () => {
      expect(ok(S, con(propia({ version: 7 })))).toBe(true);
      for (const malo of [0, -1, 1.5, "1", null]) expect(ok(S, con(propia({ version: malo }))), String(malo)).toBe(false);
    });
    it("el autor lleva id, nombre y activo; el autor desactivado (activo: false) es válido", () => {
      expect(ok(S, con(propia({ autor: autor({ activo: false }) })))).toBe(true);
      expect(ok(S, con(propia({ autor: { nombre: "Ana" } })))).toBe(false);
      expect(ok(S, con(propia({ autor: null })))).toBe(false);
    });
    it("creadaEn es una fecha ISO", () => {
      expect(ok(S, con(propia({ creadaEn: "ayer" })))).toBe(false);
      expect(ok(S, con(propia({ creadaEn: 1700000000000 })))).toBe(false);
      expect(ok(S, con(propia({ creadaEn: null })))).toBe(false);
    });
    it("activa es booleano", () => {
      expect(ok(S, con(propia({ activa: false })))).toBe(true);
      expect(ok(S, con(propia({ activa: "si" })))).toBe(false);
    });
  });
  it("rechaza null, lista y cadena", () => {
    for (const malo of [null, undefined, [], "vista"]) expect(ok(S, malo)).toBe(false);
  });
});

describe("categoriasClienteVistaSchema (R-13, D-6; CA-6)", () => {
  const S = "categoriasClienteVistaSchema";
  const vista = (o: Json = {}): Json => ({
    ciiu: "5610",
    seccion: "I",
    base: ["alimentos-personales"],
    permitidas: ["entretenimiento"],
    quitadas: [],
    efectivas: ["alimentos-personales", "entretenimiento"],
    version: 3,
    ...o,
  });
  it("acepta un cliente con CIIU, sección, base, ajuste y efectivas", () => {
    expect(datos(S, vista()).efectivas).toEqual(["alimentos-personales", "entretenimiento"]);
  });
  it("acepta un cliente sin CIIU (ciiu y seccion null), sin base y versión 0", () => {
    expect(ok(S, vista({ ciiu: null, seccion: null, base: [], permitidas: [], quitadas: [], efectivas: [], version: 0 }))).toBe(true);
  });
  it("acepta una sección de comercio (G) con base vacía", () => {
    expect(ok(S, vista({ ciiu: "4752", seccion: "G", base: [], efectivas: ["entretenimiento"] }))).toBe(true);
  });
  it.each(["ciiu", "seccion", "base", "permitidas", "quitadas", "efectivas", "version"])("%s es obligatorio", (clave) => {
    const o = vista();
    delete o[clave];
    expect(ok(S, o)).toBe(false);
  });
  it.each(["475", "47521", "47a2", "", 4752, " 5610"])("rechaza el ciiu %j", (ciiu) => {
    expect(ok(S, vista({ ciiu }))).toBe(false);
  });
  it.each(["a", "V", "II", "", 1])("rechaza la sección %j", (seccion) => {
    expect(ok(S, vista({ seccion }))).toBe(false);
  });
  it.each(["base", "permitidas", "quitadas", "efectivas"])("%s rechaza categorías fuera de las 6 y valores que no son lista", (clave) => {
    expect(ok(S, vista({ [clave]: ["personal"] }))).toBe(false);
    expect(ok(S, vista({ [clave]: "juguetes" }))).toBe(false);
    expect(ok(S, vista({ [clave]: null }))).toBe(false);
  });
  it.each([-1, 1.5, "1", null])("rechaza version %j", (version) => {
    expect(ok(S, vista({ version }))).toBe(false);
  });
});

describe("propuestaAprenderVistaSchema (R-7; CA-9)", () => {
  const S = "propuestaAprenderVistaSchema";
  it("acepta de 0 a 10 términos", () => {
    expect(datos(S, { terminos: ["audifonos", "bluetooth", "jbl"] }).terminos).toEqual(["audifonos", "bluetooth", "jbl"]);
    expect(ok(S, { terminos: [] })).toBe(true);
    expect(ok(S, { terminos: Array.from({ length: 10 }, (_, i) => `t${i}x`) })).toBe(true);
  });
  it("rechaza 11 términos", () => {
    expect(ok(S, { terminos: Array.from({ length: 11 }, (_, i) => `t${i}x`) })).toBe(false);
  });
  it.each([[null], ["audifonos"], [[1]], [[null]], [undefined]])("rechaza terminos %j", (terminos) => {
    expect(ok(S, { terminos })).toBe(false);
  });
  it("exige terminos y rechaza null", () => {
    expect(ok(S, {})).toBe(false);
    expect(ok(S, null)).toBe(false);
  });
});

describe("aprenderRespuestaSchema (R-7)", () => {
  const S = "aprenderRespuestaSchema";
  it("acepta guardadas y omitidas", () => {
    expect(datos(S, { guardadas: ["audifonos"], omitidas: ["jbl"] })).toEqual({ guardadas: ["audifonos"], omitidas: ["jbl"] });
    expect(ok(S, { guardadas: [], omitidas: [] })).toBe(true);
  });
  it.each([
    ["sin guardadas", { omitidas: [] }],
    ["sin omitidas", { guardadas: [] }],
    ["guardadas número (no hay conteo)", { guardadas: 1, omitidas: [] }],
    ["omitidas null", { guardadas: [], omitidas: null }],
    ["más de 10 guardadas", { guardadas: Array.from({ length: 11 }, (_, i) => `t${i}x`), omitidas: [] }],
    ["más de 10 omitidas", { guardadas: [], omitidas: Array.from({ length: 11 }, (_, i) => `t${i}x`) }],
    ["elemento no cadena", { guardadas: [1], omitidas: [] }],
  ])("rechaza %s", (_c, v) => {
    expect(ok(S, v)).toBe(false);
  });
});

describe("diccionarioGlobalVistaSchema (super-admin, D-2)", () => {
  const S = "diccionarioGlobalVistaSchema";
  const palabra = (o: Json = {}): Json => ({ id: randomUUID(), palabra: "zapatilla", categoria: "calzado-ropa", excepciones: ["seguridad"], activa: true, version: 1, actualizadaEn: AHORA, ...o });
  it("acepta la lista de palabras globales", () => {
    expect(datos(S, { palabras: [palabra(), palabra({ palabra: "polo", activa: false, version: 4 })] }).palabras).toHaveLength(2);
    expect(ok(S, { palabras: [] })).toBe(true);
  });
  it.each(["id", "palabra", "categoria", "excepciones", "activa", "version", "actualizadaEn"])("%s de cada palabra es obligatorio", (clave) => {
    const p = palabra();
    delete p[clave];
    expect(ok(S, { palabras: [p] })).toBe(false);
  });
  it("rechaza categoría fuera de las 6, version 0 y fecha inválida", () => {
    expect(ok(S, { palabras: [palabra({ categoria: "personal" })] })).toBe(false);
    expect(ok(S, { palabras: [palabra({ version: 0 })] })).toBe(false);
    expect(ok(S, { palabras: [palabra({ actualizadaEn: "ayer" })] })).toBe(false);
  });
  it("exige palabras", () => {
    expect(ok(S, {})).toBe(false);
    expect(ok(S, null)).toBe(false);
  });
});

describe("historialGlobalVistaSchema (super-admin, D-4)", () => {
  const S = "historialGlobalVistaSchema";
  const item = (o: Json = {}): Json => ({
    id: randomUUID(),
    palabraGlobalId: randomUUID(),
    palabra: "zapatilla",
    accion: "editada",
    antes: { categoria: "calzado-ropa", excepciones: ["seguridad"], activa: true },
    despues: { categoria: "calzado-ropa", excepciones: ["seguridad", "punta de acero"], activa: true },
    autor: autor(),
    ocurridaEn: AHORA,
    ...o,
  });
  it("acepta una página con la siguiente fecha para continuar", () => {
    const d = datos(S, { items: [item(), item({ accion: "agregada", antes: null })], siguiente: AHORA });
    expect(d.items).toHaveLength(2);
    expect(d.siguiente).toBe(AHORA);
  });
  it("acepta la última página (siguiente null) y la vacía", () => {
    expect(ok(S, { items: [item()], siguiente: null })).toBe(true);
    expect(ok(S, { items: [], siguiente: null })).toBe(true);
  });
  it.each(["agregada", "editada"])("acepta la acción %s", (accion) => {
    expect(ok(S, { items: [item({ accion })], siguiente: null })).toBe(true);
  });
  it.each(["eliminada", "Editada", "", null, 1])("rechaza la acción %j", (accion) => {
    expect(ok(S, { items: [item({ accion })], siguiente: null })).toBe(false);
  });
  it.each(["id", "palabraGlobalId", "palabra", "accion", "antes", "despues", "autor", "ocurridaEn"])("%s de cada ítem es obligatorio", (clave) => {
    const i = item();
    delete i[clave];
    expect(ok(S, { items: [i], siguiente: null })).toBe(false);
  });
  it("siguiente es obligatorio y es ISO o null", () => {
    expect(ok(S, { items: [] })).toBe(false);
    expect(ok(S, { items: [], siguiente: "ayer" })).toBe(false);
    expect(ok(S, { items: [], siguiente: 5 })).toBe(false);
  });
});

describe("CODIGOS_ERROR_GASTOS y errorGastosSchema (spec 027, mapeo de SQLSTATE del plan)", () => {
  const CODIGOS = ["compra_no_excluida", "compra_sin_xml", "limite_palabras", "palabra_existente", "periodo_no_abierto", "version_cambiada"];
  const lista = () => (shared as Record<string, unknown>).CODIGOS_ERROR_GASTOS as readonly string[] | undefined;

  it("son los seis códigos del plan, sin repetidos", () => {
    expect(lista()).toBeDefined();
    expect([...lista()!].sort()).toEqual(CODIGOS);
    expect(new Set(lista()).size).toBe(lista()!.length);
  });
  it("no redefine los códigos que se reutilizan", () => {
    expect(lista()).toBeDefined();
    for (const reutilizado of ["cliente_archivado", "solicitud_invalida", "no_encontrado", "permiso_denegado"]) {
      expect(lista()).not.toContain(reutilizado);
    }
  });
  it.each(CODIGOS)("errorGastosSchema acepta {codigo: %s}", (codigo) => {
    expect(datos("errorGastosSchema", { codigo })).toEqual({ codigo });
  });
  it.each(["version_cambiada ", "Version_cambiada", "version_obsoleta", "cliente_archivado", "mes_cambiado", "", null, 409, undefined])(
    "errorGastosSchema rechaza el código %j",
    (codigo) => {
      expect(ok("errorGastosSchema", { codigo })).toBe(false);
    },
  );
  it("el cuerpo es solo {codigo}: una clave extra (palabra, glosa) se rechaza o se descarta, nunca se devuelve", () => {
    const r = esquema("errorGastosSchema").safeParse({ codigo: "palabra_existente", palabra: "zapato", glosa: "ZAPATILLAS" });
    if (r.success) expect(r.data).toEqual({ codigo: "palabra_existente" });
  });
});
