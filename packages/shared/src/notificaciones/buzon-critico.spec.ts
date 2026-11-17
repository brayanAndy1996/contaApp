import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { notificacionSchema, paginaNotificacionesSchema, TIPOS_NOTIFICACION } from "./esquemas.js";

// Spec 023 · T2 (rojo). Notificación `buzon_critico` (plan 023, 0056; D-7, D-10; CA-6, CA-10).
// Contrato fijado por estas pruebas (packages/shared/src/notificaciones/esquemas.ts):
//  - TIPOS_NOTIFICACION incluye `buzon_critico` (los tres de 017 siguen).
//  - notificacionSchema acepta tipo `buzon_critico` con params ESTRICTOS {categoria: una de las CUATRO críticas (nunca «otro»), mensajeId: uuid}.
//    Cualquier otra clave (asunto, ruc, remitente, contenido, idSunat, nombre de adjunto) se rechaza: en `params` solo viajan códigos e ids.
//  - Los params de los otros tipos no valen para `buzon_critico` y viceversa; el cliente puede ir (id y razón social), como en 017.
const buzon = (params: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  tipo: "buzon_critico",
  creadaEn: "2026-11-17T08:00:00.000Z",
  leidaEn: null,
  cliente: { id: randomUUID(), razonSocial: "SAN JUAN SAC" },
  trabajoId: randomUUID(),
  params,
  ...extra,
});
const valido = () => buzon({ categoria: "coactiva", mensajeId: randomUUID() });
const ok = (v: unknown) => notificacionSchema.safeParse(v).success;

describe("notificacionSchema: buzon_critico", () => {
  it("TIPOS_NOTIFICACION incluye buzon_critico y conserva los tres de 017", () => {
    for (const t of ["buzon_critico", "credencial_invalida", "trabajo_terminado", "plan_limite"]) {
      expect(TIPOS_NOTIFICACION as readonly string[]).toContain(t);
    }
  });

  it("acepta la notificación y devuelve los mismos datos", () => {
    const n = valido();
    const r = notificacionSchema.safeParse(n);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(n);
  });

  it.each(["coactiva", "resolucion_determinacion", "resolucion_multa", "requerimiento_fiscalizacion"])(
    "acepta la categoría crítica %s",
    (categoria) => {
      expect(ok(buzon({ categoria, mensajeId: randomUUID() }))).toBe(true);
    },
  );

  it.each(["otro", "Coactiva", "embargo", "", null, 1, undefined])("rechaza la categoría %j", (categoria) => {
    expect(ok(buzon({ categoria, mensajeId: randomUUID() }))).toBe(false);
  });

  it.each(["no-es-uuid", "", null, 5, undefined, "../../x", `${randomUUID()}x`])("rechaza mensajeId %j", (mensajeId) => {
    expect(ok(buzon({ categoria: "coactiva", mensajeId }))).toBe(false);
  });

  it("exige categoria y mensajeId", () => {
    expect(ok(buzon({ categoria: "coactiva" }))).toBe(false);
    expect(ok(buzon({ mensajeId: randomUUID() }))).toBe(false);
    expect(ok(buzon({}))).toBe(false);
  });

  it.each([
    ["asunto", "RESOLUCIÓN COACTIVA N° 123"],
    ["ruc", "20100070970"],
    ["numeroRuc", "20100070970"],
    ["remitente", "SUNAT"],
    ["contenido", "Se le notifica…"],
    ["idSunat", "9988776655"],
    ["adjunto", "resolucion.pdf"],
    ["clienteId", randomUUID()],
    ["razonSocial", "SAN JUAN SAC"],
    ["usuarioSol", "CANARIO"],
    ["claveSol", "CANARIO"],
  ])("rechaza un params con la clave extra %s (D-10: solo códigos e ids)", (clave, valor) => {
    expect(ok(buzon({ categoria: "coactiva", mensajeId: randomUUID(), [clave]: valor }))).toBe(false);
  });

  it("params de otro tipo no valen como buzon_critico", () => {
    expect(ok(buzon({ credencial: "sol" }))).toBe(false);
    expect(ok(buzon({ tipoTrabajo: "sol.buzon.revisar", estado: "completado", motivo: null }))).toBe(false);
    expect(ok(buzon({ recurso: "rucs", umbral: 90, usado: 9, limite: 10 }))).toBe(false);
  });

  it("params de buzon_critico no valen para los otros tipos", () => {
    const params = { categoria: "coactiva", mensajeId: randomUUID() };
    for (const tipo of ["credencial_invalida", "trabajo_terminado", "plan_limite"]) expect(ok(buzon(params, { tipo }))).toBe(false);
  });

  it("params no puede ser null, texto ni lista", () => {
    for (const p of [null, "coactiva", [], undefined]) expect(ok({ ...valido(), params: p })).toBe(false);
  });

  it("acepta cliente null y leída; rechaza tipo vecino", () => {
    expect(ok({ ...valido(), cliente: null })).toBe(true);
    expect(ok({ ...valido(), leidaEn: "2026-11-17T09:00:00.000Z" })).toBe(true);
    for (const tipo of ["buzon", "buzon_critico ", "BUZON_CRITICO", "buzon_comun"]) expect(ok({ ...valido(), tipo })).toBe(false);
  });

  it("una página puede mezclar buzon_critico con los tipos de 017", () => {
    const otra = {
      id: randomUUID(),
      tipo: "credencial_invalida",
      creadaEn: "2026-11-17T07:00:00.000Z",
      leidaEn: null,
      cliente: null,
      trabajoId: null,
      params: { credencial: "sol" },
    };
    expect(paginaNotificacionesSchema.safeParse({ items: [valido(), otra], siguiente: null }).success).toBe(true);
  });
});
