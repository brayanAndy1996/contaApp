import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as shared from "../index.js";

// Spec 026 · T2 (rojo). Cuerpos de las solicitudes de prorrata (plan 026, Contratos: shared; D-5; U-4, U-9; CA-4, CA-6).
// Contrato fijado por estas pruebas (packages/shared/src/prorrata/esquemas.ts, exportado por prorrata/index.ts y por src/index.ts):
//  - periodoProrrataSchema = cadena AAAAMM con mes 01-12.
//  - obtenerDeclaracionesSchema = {periodo} (.strict()): el cliente sale de la ruta y la ventana, del periodo.
//  - montoProrrataSchema = cadena decimal con signo, hasta 2 decimales, dentro de NUMERIC(14,2) (12 enteros + 2 decimales). Nunca number.
//  - guardarMesManualSchema = {gravadas, exportaciones, noGravadas, motivo, version} (.strict()). motivo 1..500 sin controles ni bidi;
//    version entero >= 0 (0 = el mes nunca tuvo manual; una versión «eliminado» también cuenta).
//  - eliminarMesManualSchema = {motivo, version} (.strict()), version entero >= 1.
//  - guardarProrrataUsadaSchema = {porcentaje: «0.00»..«100.00» | null, version >= 0} (.strict()); gramática del dominio
//    ^(100(\.0{1,2})?|[0-9]{1,2}(\.[0-9]{1,2})?)$.
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

describe("exportaciones de @contapp/shared para la prorrata (026)", () => {
  it.each([
    "periodoProrrataSchema",
    "obtenerDeclaracionesSchema",
    "montoProrrataSchema",
    "guardarMesManualSchema",
    "eliminarMesManualSchema",
    "guardarProrrataUsadaSchema",
  ])("exporta %s", (nombre) => {
    expect((shared as Record<string, unknown>)[nombre]).toBeDefined();
  });
});

const MALOS_PERIODO: [string, unknown][] = [
  ["mes 13", "202613"],
  ["mes 00", "202600"],
  ["con guion", "2026-10"],
  ["corto", "20261"],
  ["largo", "2026101"],
  ["vacío", ""],
  ["con espacio antes", " 202610"],
  ["con espacio después", "202610 "],
  ["con salto de línea", "202610\n"],
  ["número", 202610],
  ["null", null],
  ["undefined", undefined],
  ["lista", ["202610"]],
  ["objeto", { periodo: "202610" }],
  ["dígitos de ancho completo", "２０２６１０"],
  ["letras", "2026AB"],
  ["texto", "octubre"],
];

describe("periodoProrrataSchema (R-1)", () => {
  const S = "periodoProrrataSchema";
  it.each(["202601", "202610", "202612", "199912", "203001"])("acepta %s", (p) => {
    expect(esquema(S).safeParse(p).data).toBe(p);
  });
  it.each(MALOS_PERIODO)("rechaza %s", (_c, p) => {
    expect(ok(S, p)).toBe(false);
  });
});

describe("obtenerDeclaracionesSchema (D-3)", () => {
  const S = "obtenerDeclaracionesSchema";
  it("acepta {periodo} y lo devuelve tal cual", () => {
    expect(datos(S, { periodo: "202610" })).toEqual({ periodo: "202610" });
  });
  it.each(MALOS_PERIODO)("rechaza un periodo %s", (_c, periodo) => {
    expect(ok(S, { periodo })).toBe(false);
  });
  it("el periodo es obligatorio", () => {
    expect(ok(S, {})).toBe(false);
  });
  it.each([
    ["clienteId", { clienteId: randomUUID() }],
    ["tenantId", { tenantId: randomUUID() }],
    ["ruc", { ruc: "20100070970" }],
    ["claveSol", { claveSol: "CANARIO-SOL-clave", usuarioSol: "CANARIO-USUARIO" }],
    ["periodos", { periodos: ["202610", "202609"] }],
    ["ventana", { ventana: 12 }],
    ["constructor", { constructor: 1 }],
  ])("es estricto: rechaza la clave extra %s", (_c, extra) => {
    expect(ok(S, { periodo: "202610", ...extra })).toBe(false);
  });
  it.each([null, undefined, "202610", 202610, [], [{ periodo: "202610" }], true])("rechaza el cuerpo %j", (cuerpo) => {
    expect(ok(S, cuerpo)).toBe(false);
  });
});

describe("montoProrrataSchema (R-2, U-4)", () => {
  const S = "montoProrrataSchema";
  it.each(["0", "0.00", "5", "0.5", "123.4", "123.45", "-0.01", "-1", "-123.45", "999999999999.99", "-999999999999.99", "999999999999"])(
    "acepta %j",
    (m) => {
      expect(esquema(S).safeParse(m).data).toBe(m);
    },
  );
  it.each([
    ["13 enteros", "1000000000000.00"],
    ["13 enteros negativo", "-1000000000000"],
    ["13 nueves", "9999999999999"],
    ["3 decimales", "1.234"],
    ["3 decimales con ceros", "1.000"],
    ["notación científica", "1e3"],
    ["notación científica con signo", "1E+3"],
    ["con espacio antes", " 1"],
    ["con espacio después", "1 "],
    ["con espacio en medio", "1 000"],
    ["vacío", ""],
    ["solo signo", "-"],
    ["texto", "abc"],
    ["coma decimal", "1,5"],
    ["separador de miles", "1,000.00"],
    ["punto final", "1."],
    ["doble signo", "--1"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["hexadecimal", "0x10"],
    ["guion bajo", "1_000"],
    ["salto de línea", "1\n"],
    ["número", 1],
    ["número decimal", 1.5],
    ["null", null],
    ["undefined", undefined],
    ["lista", ["1"]],
    ["objeto", { valor: "1" }],
  ])("rechaza %s", (_c, m) => {
    expect(ok(S, m)).toBe(false);
  });
});

describe("guardarMesManualSchema (RF-133, U-4)", () => {
  const S = "guardarMesManualSchema";
  const cuerpo = (o: Record<string, unknown> = {}) => ({
    gravadas: "100000.00",
    exportaciones: "0.00",
    noGravadas: "25000.50",
    motivo: "Declaración física del cliente, mes anterior a la obligación electrónica",
    version: 0,
    ...o,
  });

  it("acepta un cuerpo completo y lo devuelve tal cual", () => {
    expect(datos(S, cuerpo())).toEqual(cuerpo());
  });
  it("acepta el mes en cero (0 = «sin operaciones», R-6)", () => {
    expect(ok(S, cuerpo({ gravadas: "0", exportaciones: "0", noGravadas: "0" }))).toBe(true);
  });
  it("acepta montos negativos (más notas de crédito que ventas, R-4)", () => {
    expect(ok(S, cuerpo({ gravadas: "-120.00", noGravadas: "-0.01" }))).toBe(true);
  });
  it.each(["gravadas", "exportaciones", "noGravadas"])("%s exige un monto válido: 3 decimales, 1e3, número, null y fuera de NUMERIC(14,2)", (campo) => {
    for (const malo of ["1.234", "1e3", " 1", "1 ", "", "abc", 1000, null, undefined, "1000000000000.00"]) {
      expect(ok(S, cuerpo({ [campo]: malo })), `${campo}=${String(malo)}`).toBe(false);
    }
  });
  it.each(["gravadas", "exportaciones", "noGravadas", "motivo", "version"])("%s es obligatorio", (clave) => {
    const o: Record<string, unknown> = cuerpo();
    delete o[clave];
    expect(ok(S, o)).toBe(false);
  });

  describe("motivo", () => {
    it("acepta 1 y 500 caracteres", () => {
      expect(ok(S, cuerpo({ motivo: "x" }))).toBe(true);
      expect(ok(S, cuerpo({ motivo: "a".repeat(500) }))).toBe(true);
      expect(ok(S, cuerpo({ motivo: "ñ".repeat(500) }))).toBe(true);
    });
    it("rechaza vacío y 501 caracteres", () => {
      expect(ok(S, cuerpo({ motivo: "" }))).toBe(false);
      expect(ok(S, cuerpo({ motivo: "a".repeat(501) }))).toBe(false);
    });
    it.each([
      ["NUL", "a\u0000b"],
      ["tabulación", "a\tb"],
      ["retorno de carro", "a\rb"],
      ["DEL", "a\u007fb"],
      ["control C1", "a\u0085b"],
      ["escape", "a\u001bb"],
    ])("rechaza el carácter de control %s", (_c, motivo) => {
      expect(ok(S, cuerpo({ motivo }))).toBe(false);
    });
    it.each([
      ["RLO U+202E", "texto‮oculto"],
      ["LRE U+202A", "texto‪oculto"],
      ["PDF U+202C", "texto‬oculto"],
      ["LRI U+2066", "texto⁦aislado"],
      ["PDI U+2069", "texto⁩aislado"],
      ["LRM U+200E", "texto‎oculto"],
      ["RLM U+200F", "texto‏oculto"],
      ["ALM U+061C", "texto؜oculto"],
    ])("rechaza el carácter bidi %s", (_c, motivo) => {
      expect(ok(S, cuerpo({ motivo }))).toBe(false);
    });
    it.each([null, undefined, 1, [], {}, true])("rechaza el motivo %j", (motivo) => {
      expect(ok(S, cuerpo({ motivo }))).toBe(false);
    });
    it("«<script>» y comillas son texto válido: se escapan al pintar, no aquí", () => {
      expect(ok(S, cuerpo({ motivo: `<script>alert("x")</script> 'ajuste'` }))).toBe(true);
    });
  });

  describe("version (CAS, D-4)", () => {
    it.each([0, 1, 2, 41])("acepta %j", (version) => {
      expect(datos(S, cuerpo({ version })).version).toBe(version);
    });
    it.each([-1, 1.5, 0.1, "1", "", null, undefined, Number.NaN, Number.POSITIVE_INFINITY, true, [], [1], {}])("rechaza version = %j", (version) => {
      expect(ok(S, cuerpo({ version }))).toBe(false);
    });
  });

  it.each([
    ["clienteId", { clienteId: randomUUID() }],
    ["tenantId", { tenantId: randomUUID() }],
    ["periodo", { periodo: "202610" }],
    ["origen", { origen: "declarado" }],
    ["autor", { autor: randomUUID() }],
    ["total", { total: "125000.50" }],
    ["constructor", { constructor: 1 }],
  ])("es estricto: rechaza la clave extra %s (periodo y cliente salen de la ruta)", (_c, extra) => {
    expect(ok(S, cuerpo(extra))).toBe(false);
  });
  it.each([null, undefined, "x", 1, [], [cuerpo()]])("rechaza el cuerpo %j", (malo) => {
    expect(ok(S, malo)).toBe(false);
  });
});

describe("eliminarMesManualSchema", () => {
  const S = "eliminarMesManualSchema";
  const cuerpo = (o: Record<string, unknown> = {}) => ({ motivo: "Se cargó en el mes equivocado", version: 3, ...o });

  it("acepta {motivo, version} y lo devuelve tal cual", () => {
    expect(datos(S, cuerpo())).toEqual(cuerpo());
  });
  it("version >= 1: no hay nada que eliminar en la versión 0", () => {
    expect(ok(S, cuerpo({ version: 1 }))).toBe(true);
    expect(ok(S, cuerpo({ version: 0 }))).toBe(false);
  });
  it.each([-1, 1.5, "1", null, undefined, Number.NaN, true, []])("rechaza version = %j", (version) => {
    expect(ok(S, cuerpo({ version }))).toBe(false);
  });
  it("exige motivo de 1..500 sin controles ni bidi", () => {
    expect(ok(S, cuerpo({ motivo: "a".repeat(500) }))).toBe(true);
    for (const malo of ["", "a".repeat(501), "a\u0000b", "a\tb", "a‮b", "a⁦b", null, undefined, 1]) {
      expect(ok(S, cuerpo({ motivo: malo })), String(malo)).toBe(false);
    }
  });
  it.each(["motivo", "version"])("%s es obligatorio", (clave) => {
    const o: Record<string, unknown> = cuerpo();
    delete o[clave];
    expect(ok(S, o)).toBe(false);
  });
  it.each([
    ["gravadas", { gravadas: "1.00" }],
    ["clienteId", { clienteId: randomUUID() }],
    ["periodo", { periodo: "202610" }],
  ])("es estricto: rechaza la clave extra %s", (_c, extra) => {
    expect(ok(S, cuerpo(extra))).toBe(false);
  });
});

describe("guardarProrrataUsadaSchema (U-9)", () => {
  const S = "guardarProrrataUsadaSchema";
  const cuerpo = (o: Record<string, unknown> = {}) => ({ porcentaje: "87.34", version: 0, ...o });

  it.each(["0", "0.0", "0.00", "0.01", "5", "87.3", "87.34", "99.99", "100", "100.0", "100.00"])("acepta el porcentaje %j", (porcentaje) => {
    expect(datos(S, cuerpo({ porcentaje })).porcentaje).toBe(porcentaje);
  });
  it("acepta null (quitar la prorrata ingresada)", () => {
    expect(datos(S, cuerpo({ porcentaje: null })).porcentaje).toBeNull();
  });
  it.each([
    ["100.01", "100.01"],
    ["100.1", "100.1"],
    ["100.001", "100.001"],
    ["101", "101"],
    ["1000", "1000"],
    ["tres decimales", "87.345"],
    ["negativo", "-1"],
    ["menos cero", "-0"],
    ["menos cero con decimales", "-0.00"],
    ["notación científica", "1e2"],
    ["vacío", ""],
    ["con espacio", " 87.34"],
    ["con espacio al final", "87.34 "],
    ["coma decimal", "87,34"],
    ["con signo de porcentaje", "87.34%"],
    ["texto", "abc"],
    ["punto final", "87."],
    ["número", 87.34],
    ["cero numérico", 0],
    ["NaN", Number.NaN],
    ["undefined", undefined],
    ["lista", ["87.34"]],
    ["objeto", {}],
  ])("rechaza el porcentaje %s", (_c, porcentaje) => {
    expect(ok(S, cuerpo({ porcentaje }))).toBe(false);
  });
  it("porcentaje es obligatorio (null no equivale a ausente)", () => {
    expect(ok(S, { version: 0 })).toBe(false);
  });
  it("version es obligatoria: entero >= 0", () => {
    expect(ok(S, { porcentaje: "87.34" })).toBe(false);
    expect(ok(S, cuerpo({ version: 0 }))).toBe(true);
    expect(ok(S, cuerpo({ version: 7 }))).toBe(true);
    for (const malo of [-1, 1.5, "0", null, Number.NaN, true]) expect(ok(S, cuerpo({ version: malo })), String(malo)).toBe(false);
  });
  it.each([
    ["clienteId", { clienteId: randomUUID() }],
    ["periodo", { periodo: "202610" }],
    ["origen", { origen: "ingresada" }],
    ["motivo", { motivo: "x" }],
  ])("es estricto: rechaza la clave extra %s", (_c, extra) => {
    expect(ok(S, cuerpo(extra))).toBe(false);
  });
  it.each([null, undefined, "87.34", 87.34, [], [cuerpo()]])("rechaza el cuerpo %j", (malo) => {
    expect(ok(S, malo)).toBe(false);
  });
});
