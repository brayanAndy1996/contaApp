import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as shared from "../index.js";

// Spec 028 · T2 (rojo). Vista de respuesta y códigos de error de correo (spec 028 R-9, R-13, R-15; plan 028, Contratos: shared; HTTP).
// Contrato fijado por estas pruebas (packages/shared/src/correo/{vistas,errores}.ts, exportado por correo/index.ts y src/index.ts):
//  - preferenciasCorreoVistaSchema `.strict()` = {buzonCritico, credencialInvalida, planLimite, resumen, todosClientes, todosDisponible,
//    todosIgnorado, invitacionResumen: boolean, ultimoEnvioFallido: ISO-8601 con zona (z.iso.datetime) | null}: las NUEVE obligatorias.
//    Ninguna otra clave: ni correo, ni nombre del estudio, ni usuarioId ni tenantId ni el motivo del fallo (R-8).
//  - CODIGOS_ERROR_CORREO = ["todos_clientes_no_disponible"] (409); errorCorreoSchema = {codigo} estricto. Se reutilizan solicitud_invalida,
//    permiso_denegado y demasiados_intentos (no se redefinen aquí).
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

type Json = Record<string, unknown>;
const AHORA = "2026-11-24T14:30:00.000Z";
const vista = (o: Json = {}): Json => ({
  buzonCritico: true,
  credencialInvalida: true,
  planLimite: false,
  resumen: false,
  todosClientes: false,
  todosDisponible: true,
  todosIgnorado: false,
  invitacionResumen: true,
  ultimoEnvioFallido: null,
  ...o,
});
const BOOLEANAS = ["buzonCritico", "credencialInvalida", "planLimite", "resumen", "todosClientes", "todosDisponible", "todosIgnorado", "invitacionResumen"];

describe("exportaciones de @contapp/shared para vistas de correo (028)", () => {
  it.each(["preferenciasCorreoVistaSchema", "errorCorreoSchema"])("exporta %s", (nombre) => {
    expect((shared as Record<string, unknown>)[nombre]).toBeDefined();
  });
  it("CODIGOS_ERROR_CORREO es exactamente todos_clientes_no_disponible", () => {
    expect((shared as Record<string, unknown>).CODIGOS_ERROR_CORREO).toEqual(["todos_clientes_no_disponible"]);
  });
});

describe("preferenciasCorreoVistaSchema", () => {
  const S = "preferenciasCorreoVistaSchema";
  it("acepta la vista con ultimoEnvioFallido null y la devuelve tal cual", () => {
    const r = esquema(S).safeParse(vista());
    expect(r.success).toBe(true);
    expect(r.data).toEqual(vista());
  });
  it("acepta ultimoEnvioFallido ISO", () => {
    expect(ok(S, vista({ ultimoEnvioFallido: AHORA }))).toBe(true);
    expect(ok(S, vista({ ultimoEnvioFallido: "2026-11-24T09:30:00-05:00" }))).toBe(true);
  });
  it.each(["ayer", "2026-11-24", "24/11/2026 09:30", "", 1_764_000_000, true, {}, []])("rechaza ultimoEnvioFallido %j", (v) => {
    expect(ok(S, vista({ ultimoEnvioFallido: v }))).toBe(false);
  });
  it("exige ultimoEnvioFallido (null explícito)", () => {
    const { ultimoEnvioFallido: _q, ...resto } = vista();
    expect(ok(S, resto)).toBe(false);
  });
  it.each(BOOLEANAS)("exige %s booleano", (clave) => {
    const { [clave]: _q, ...resto } = vista();
    expect(ok(S, resto)).toBe(false);
    for (const malo of ["true", 1, null, undefined, {}]) expect(ok(S, vista({ [clave]: malo }))).toBe(false);
  });
  it.each([
    ["usuarioId", { usuarioId: randomUUID() }],
    ["tenantId", { tenantId: randomUUID() }],
    ["correo", { correo: "ana@estudio.pe" }],
    ["estudio", { estudio: "Estudio Sol" }],
    ["motivo", { motivo: "transporte" }],
    ["horaResumen", { horaResumen: "07:00" }],
    ["constructor", { constructor: 1 }],
  ])("es estricto: rechaza la clave extra %s", (_c, extra) => {
    expect(ok(S, vista(extra))).toBe(false);
  });
  it("exige un objeto", () => {
    for (const malo of [null, undefined, [], "x", 1, [vista()]]) expect(ok(S, malo)).toBe(false);
  });
});

describe("errorCorreoSchema", () => {
  const S = "errorCorreoSchema";
  it("acepta todos_clientes_no_disponible", () => {
    expect(ok(S, { codigo: "todos_clientes_no_disponible" })).toBe(true);
  });
  it.each(["solicitud_invalida", "permiso_denegado", "todos_clientes", "Todos_clientes_no_disponible", "", null, 409, undefined])("rechaza el código %j (los reutilizados no se redefinen aquí)", (codigo) => {
    expect(ok(S, { codigo })).toBe(false);
  });
  it("el cuerpo es solo {codigo}", () => {
    expect(ok(S, { codigo: "todos_clientes_no_disponible", mensaje: "x" })).toBe(false);
    expect(ok(S, { codigo: "todos_clientes_no_disponible", correo: "ana@estudio.pe" })).toBe(false);
    expect(ok(S, {})).toBe(false);
  });
});
