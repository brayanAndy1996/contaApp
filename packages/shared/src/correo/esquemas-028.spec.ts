import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as shared from "../index.js";

// Spec 028 · T2 (rojo). Cuerpos de las solicitudes de correo (spec 028 R-7, R-10, R-15; D-4, U-18; plan 028, Contratos: shared).
// Contrato fijado por estas pruebas (packages/shared/src/correo/esquemas.ts, exportado por correo/index.ts y por src/index.ts):
//  - TIPOS_CORREO = ["buzon_critico", "credencial_invalida", "plan_limite", "resumen"], en ese orden; tipoCorreoSchema = z.enum(TIPOS_CORREO).
//  - preferenciasCorreoSchema `.strict()` = {buzonCritico, credencialInvalida, planLimite, resumen, todosClientes}: LAS CINCO obligatorias y booleanas
//    estrictas (ni "true", ni 1, ni null). Ni `usuarioId` ni `tenantId` ni nada más en el cuerpo: el usuario y el estudio salen de la sesión (R-4).
//  - bajaSchema `.strict()` = {token}: cadena base64url de EXACTAMENTE 43 caracteres [A-Za-z0-9_-] (32 bytes sin relleno). No transforma ni recorta.
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

const PREFS = { buzonCritico: true, credencialInvalida: true, planLimite: false, resumen: false, todosClientes: false };
const TOKEN = "Zm9vYmFyLWJhc2U2NHVybC10b2tlbi0xMjM0NTY3ODk"; // 43 caracteres
const CLAVES = Object.keys(PREFS);

describe("exportaciones de @contapp/shared para correo (028)", () => {
  it.each(["tipoCorreoSchema", "preferenciasCorreoSchema", "bajaSchema"])("exporta %s", (nombre) => {
    expect((shared as Record<string, unknown>)[nombre]).toBeDefined();
  });
  it("TIPOS_CORREO son los 4 tipos, en orden", () => {
    expect((shared as Record<string, unknown>).TIPOS_CORREO).toEqual(["buzon_critico", "credencial_invalida", "plan_limite", "resumen"]);
  });
  it("el token de ejemplo mide 43 caracteres", () => {
    expect(TOKEN).toHaveLength(43);
  });
});

describe("tipoCorreoSchema", () => {
  it.each(["buzon_critico", "credencial_invalida", "plan_limite", "resumen"])("acepta %s", (t) => {
    expect(ok("tipoCorreoSchema", t)).toBe(true);
  });
  it.each(["trabajo_terminado", "Resumen", "resumen ", "", "buzon", null, 1, undefined, "constructor"])("rechaza %j", (t) => {
    expect(ok("tipoCorreoSchema", t)).toBe(false);
  });
});

describe("preferenciasCorreoSchema", () => {
  const S = "preferenciasCorreoSchema";
  it("acepta las cinco y las devuelve tal cual", () => {
    const r = esquema(S).safeParse(PREFS);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(PREFS);
  });
  it("acepta todo apagado y todo encendido", () => {
    expect(ok(S, { buzonCritico: false, credencialInvalida: false, planLimite: false, resumen: false, todosClientes: false })).toBe(true);
    expect(ok(S, { buzonCritico: true, credencialInvalida: true, planLimite: true, resumen: true, todosClientes: true })).toBe(true);
  });
  it.each(CLAVES)("exige %s", (clave) => {
    const { [clave]: _quitada, ...resto } = PREFS as Record<string, boolean>;
    expect(ok(S, resto)).toBe(false);
  });
  it.each(CLAVES)("rechaza %s que no sea booleano", (clave) => {
    for (const malo of ["true", "false", 1, 0, null, undefined, [], {}, "on", "si"]) expect(ok(S, { ...PREFS, [clave]: malo })).toBe(false);
  });
  it.each([
    ["usuarioId", { usuarioId: randomUUID() }],
    ["tenantId", { tenantId: randomUUID() }],
    ["tipo", { tipo: "resumen" }],
    ["horaResumen", { horaResumen: "07:00" }],
    ["correo", { correo: "ana@estudio.pe" }],
    ["todosDisponible", { todosDisponible: true }],
    ["constructor", { constructor: 1 }],
  ])("es estricto: rechaza la clave extra %s", (_c, extra) => {
    expect(ok(S, { ...PREFS, ...extra })).toBe(false);
  });
  it("exige un objeto", () => {
    for (const malo of [null, undefined, [], "x", 1, true, [PREFS]]) expect(ok(S, malo)).toBe(false);
  });
});

describe("bajaSchema", () => {
  const S = "bajaSchema";
  it("acepta un token base64url de 43 caracteres y lo devuelve igual", () => {
    const r = esquema(S).safeParse({ token: TOKEN });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ token: TOKEN });
  });
  it("acepta guion y guion bajo (alfabeto base64url)", () => {
    expect(ok(S, { token: `${"a-_".repeat(14)}ab` })).toBe(true);
  });
  it.each([
    ["42 caracteres", TOKEN.slice(0, 42)],
    ["44 caracteres", `${TOKEN}A`],
    ["con relleno =", `${TOKEN.slice(0, 42)}=`],
    ["con +", `${TOKEN.slice(0, 42)}+`],
    ["con /", `${TOKEN.slice(0, 42)}/`],
    ["con espacio", `${TOKEN.slice(0, 42)} `],
    ["con espacio al inicio", ` ${TOKEN.slice(0, 42)}`],
    ["con salto de línea", `${TOKEN.slice(0, 42)}\n`],
    ["con punto", `${TOKEN.slice(0, 42)}.`],
    ["con tilde", `${TOKEN.slice(0, 42)}ñ`],
    ["con NUL", `${TOKEN.slice(0, 42)}\u0000`],
    ["vacío", ""],
    ["hex de 64", "ab".repeat(32)],
    ["número", 1234567890123456789012345678901234567890123],
    ["null", null],
    ["lista", [TOKEN]],
    ["objeto", { valor: TOKEN }],
  ])("rechaza el token %s", (_c, token) => {
    expect(ok(S, { token })).toBe(false);
  });
  it("exige token y un objeto", () => {
    expect(ok(S, {})).toBe(false);
    for (const malo of [null, undefined, TOKEN, [], [{ token: TOKEN }], 1]) expect(ok(S, malo)).toBe(false);
  });
  it.each([
    ["usuarioId", { usuarioId: randomUUID() }],
    ["tenantId", { tenantId: randomUUID() }],
    ["tipo", { tipo: "resumen" }],
    ["activo", { activo: true }],
    ["constructor", { constructor: 1 }],
  ])("es estricto: rechaza la clave extra %s (la baja solo desactiva lo que dice el token)", (_c, extra) => {
    expect(ok(S, { token: TOKEN, ...extra })).toBe(false);
  });
});
