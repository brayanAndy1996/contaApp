import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as shared from "../index.js";

// Spec 025 · T2 (rojo). Importación del historial: cuerpo de la solicitud y vista de la importación
// (plan 025, Contratos: shared; D-4, D-10, D-11; U-5; CA-5).
// Contrato fijado por estas pruebas (packages/shared/src/reglas/importacion.ts, exportado por reglas/index.ts y por src/index.ts):
//  - solicitarImportacionSchema = {periodos?: entero 1..12} (.strict()); sin `periodos` = 6 (U-5). Los periodos los calcula el backend.
//  - importacionVistaSchema = {id, estado: en_curso|completada|fallida, periodos: AAAAMM[1..12], solicitadaPor: {id, nombre},
//    solicitadaEn: ISO, terminadaEn: ISO|null, resumen: {periodosLeidos, periodosSinDatos: AAAAMM[], candidatas, sinCriterio}|null,
//    motivo: MotivoTrabajo|null, trabajoId: uuid|null}. Solo conteos y periodos: ni montos ni RUC ni razón social (D-11).
//  - CODIGOS_ERROR_REGLA suma `importacion_en_curso` (409): lo cubre `errores.spec.ts` (lista exacta ajustada).
// Los esquemas se piden por nombre: si el export no existe, la prueba falla con «no implementado», no al cargar el archivo.
interface Esquema {
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
  shape?: Record<string, unknown>;
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

describe("exportaciones de @contapp/shared para la importación (025)", () => {
  it.each(["solicitarImportacionSchema", "importacionVistaSchema"])("exporta %s", (nombre) => {
    expect((shared as Record<string, unknown>)[nombre]).toBeDefined();
  });
});

describe("solicitarImportacionSchema (U-5)", () => {
  const S = "solicitarImportacionSchema";

  it("sin periodos queda en 6 (el valor por defecto)", () => {
    expect(datos(S, {}).periodos).toBe(6);
  });
  it.each([1, 2, 6, 11, 12])("acepta %j periodos", (periodos) => {
    expect(datos(S, { periodos }).periodos).toBe(periodos);
  });
  it.each([0, -1, 13, 24, 1.5, 6.0001, "6", "", null, NaN, Infinity, true, [], [6], {}])("rechaza periodos = %j", (periodos) => {
    expect(ok(S, { periodos })).toBe(false);
  });
  it.each([
    ["clienteId", { clienteId: randomUUID() }],
    ["tenantId", { tenantId: randomUUID() }],
    ["ruc", { ruc: "20100070970" }],
    ["periodo", { periodo: "202610" }],
    ["lista de periodos explícita", { lista: ["202610", "202609"] }],
  ])("es estricto: rechaza la clave extra %s (el backend calcula los periodos)", (_c, extra) => {
    expect(ok(S, { periodos: 6, ...extra })).toBe(false);
    expect(ok(S, extra)).toBe(false);
  });
  it.each([null, "6", 6, [], [{}]])("rechaza el cuerpo %j", (cuerpo) => {
    expect(ok(S, cuerpo)).toBe(false);
  });
});

describe("importacionVistaSchema", () => {
  const S = "importacionVistaSchema";
  const importacion = (o: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    estado: "completada",
    periodos: ["202610", "202609", "202608", "202607", "202606", "202605"],
    solicitadaPor: { id: randomUUID(), nombre: "Ana Pérez", activo: true },
    solicitadaEn: "2026-11-21T10:00:00.000Z",
    terminadaEn: "2026-11-21T10:00:20.000Z",
    resumen: { periodosLeidos: 5, periodosSinDatos: ["202605"], candidatas: 14, sinCriterio: 3 },
    motivo: null,
    trabajoId: randomUUID(),
    ...o,
  });

  it("acepta una importación completada con su resumen", () => {
    const d = datos(S, importacion());
    expect(d.estado).toBe("completada");
    expect(d.periodos).toHaveLength(6);
    expect(d.resumen).toEqual({ periodosLeidos: 5, periodosSinDatos: ["202605"], candidatas: 14, sinCriterio: 3 });
    expect(d.solicitadaPor.nombre).toBe("Ana Pérez");
  });
  it("acepta una en curso: sin terminadaEn, sin resumen y sin motivo", () => {
    expect(ok(S, importacion({ estado: "en_curso", terminadaEn: null, resumen: null, motivo: null }))).toBe(true);
  });
  it("acepta una en curso todavía sin trabajo (trabajoId null)", () => {
    expect(ok(S, importacion({ estado: "en_curso", terminadaEn: null, resumen: null, trabajoId: null }))).toBe(true);
  });
  it.each(["credencial_invalida", "sunat_no_responde", "interrumpido", "error_interno"])("acepta una fallida con motivo %s", (motivo) => {
    expect(ok(S, importacion({ estado: "fallida", resumen: null, motivo }))).toBe(true);
  });
  it.each(["no_es_un_motivo", "Credencial invalida", "", 1, undefined])("rechaza el motivo %j", (motivo) => {
    expect(ok(S, importacion({ estado: "fallida", motivo }))).toBe(false);
  });
  it.each(["pendiente", "EN_CURSO", "terminada", "", null, 1])("rechaza el estado %j", (estado) => {
    expect(ok(S, importacion({ estado }))).toBe(false);
  });

  describe("periodos", () => {
    it("de 1 a 12, en formato AAAAMM", () => {
      const doce = Array.from({ length: 12 }, (_, i) => `2025${String(i + 1).padStart(2, "0")}`);
      expect(ok(S, importacion({ periodos: doce }))).toBe(true);
      expect(ok(S, importacion({ periodos: ["202610"] }))).toBe(true);
      expect(ok(S, importacion({ periodos: [] }))).toBe(false);
      expect(ok(S, importacion({ periodos: [...doce, "202601"] }))).toBe(false);
    });
    it.each(["2026-10", "202613", "202600", "20261", "", 202610, null])("rechaza el periodo %j", (p) => {
      expect(ok(S, importacion({ periodos: [p] }))).toBe(false);
    });
  });

  describe("resumen", () => {
    it.each([
      ["periodosLeidos", -1],
      ["periodosLeidos", 1.5],
      ["periodosLeidos", "5"],
      ["periodosLeidos", null],
      ["candidatas", -1],
      ["candidatas", 0.5],
      ["candidatas", "14"],
      ["sinCriterio", -1],
      ["sinCriterio", null],
    ])("rechaza %s = %j (entero >= 0)", (campo, valor) => {
      const resumen = { periodosLeidos: 5, periodosSinDatos: [], candidatas: 14, sinCriterio: 3, [campo]: valor };
      expect(ok(S, importacion({ resumen }))).toBe(false);
    });
    it("periodosSinDatos es una lista de periodos AAAAMM, no un conteo", () => {
      const base = { periodosLeidos: 5, candidatas: 14, sinCriterio: 3 };
      expect(ok(S, importacion({ resumen: { ...base, periodosSinDatos: [] } }))).toBe(true);
      expect(ok(S, importacion({ resumen: { ...base, periodosSinDatos: 1 } }))).toBe(false);
      expect(ok(S, importacion({ resumen: { ...base, periodosSinDatos: ["2026-05"] } }))).toBe(false);
    });
    it("todas las claves del resumen son obligatorias", () => {
      for (const falta of ["periodosLeidos", "periodosSinDatos", "candidatas", "sinCriterio"]) {
        const resumen: Record<string, unknown> = { periodosLeidos: 5, periodosSinDatos: [], candidatas: 14, sinCriterio: 3 };
        delete resumen[falta];
        expect(ok(S, importacion({ resumen })), falta).toBe(false);
      }
    });
    it("el resumen solo lleva conteos y periodos: descarta montos, RUC y razón social (D-11)", () => {
      const d = datos(
        S,
        importacion({ resumen: { periodosLeidos: 5, periodosSinDatos: [], candidatas: 14, sinCriterio: 3, ruc: "20100070970", razonSocial: "PROVEEDOR SAC", total: "118.00" } }),
      );
      expect(Object.keys(d.resumen).sort()).toEqual(["candidatas", "periodosLeidos", "periodosSinDatos", "sinCriterio"]);
    });
  });

  it.each(["id", "estado", "periodos", "solicitadaPor", "solicitadaEn", "terminadaEn", "resumen", "motivo", "trabajoId"])("%s es obligatorio (null no equivale a ausente)", (clave) => {
    const o: Record<string, unknown> = importacion();
    delete o[clave];
    expect(ok(S, o)).toBe(false);
  });
  it.each(["no-es-uuid", "", null, 1])("rechaza id %j", (id) => {
    expect(ok(S, importacion({ id }))).toBe(false);
  });
  it.each(["ayer", "2026-11-21", "", 0])("rechaza solicitadaEn %j", (solicitadaEn) => {
    expect(ok(S, importacion({ solicitadaEn }))).toBe(false);
  });
  it("rechaza un trabajoId que no es uuid", () => {
    expect(ok(S, importacion({ trabajoId: "no-es-uuid" }))).toBe(false);
  });
  it("solicitadaPor exige id uuid y nombre", () => {
    expect(ok(S, importacion({ solicitadaPor: { id: "x", nombre: "Ana", activo: true } }))).toBe(false);
    expect(ok(S, importacion({ solicitadaPor: null }))).toBe(false);
  });
  it("descarta claves ajenas (tenantId, clienteId, ruc, razonSocial, montos)", () => {
    const d = datos(S, importacion({ tenantId: randomUUID(), clienteId: randomUUID(), ruc: "20100070970", razonSocial: "PROVEEDOR SAC", total: "118.00" }));
    for (const k of ["tenantId", "clienteId", "ruc", "razonSocial", "total"]) expect(k in d).toBe(false);
  });
});
