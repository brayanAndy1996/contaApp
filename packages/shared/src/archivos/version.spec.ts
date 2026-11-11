import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { versionArchivoSchema } from "./index.js";

// Spec 012b · T2 (rojo). `GET …/archivos` -> VersionArchivoDto[] (plan, Contratos: HTTP; D3, D8; CA-2, CA-6, CA-12).
// Contrato fijado por estas pruebas (versionArchivoSchema, packages/shared/src/archivos/respuestas.ts):
//  { id: uuid, version >= 1, generadoEn: ISO, generadoPor: uuid, formato{id,version}, provisional: boolean,
//    nombreZip, sha256Txt, sha256Zip (64 hex minúscula), bytesZip >= 1, lineas >= 0,
//    resumen (como el del previo), avisos: conteos por código {codigo: entero >= 0} }
//  - NUNCA lleva la ruta del storage: aunque llegue una `ruta` (u otra clave desconocida), el dato parseado no la contiene.
const resumen = {
  modificadas: 1,
  excluidas: 1,
  agregadas: 0,
  impactoIgv: { DG: "8.97", DGNG: "0.00", DNG: "0.00", total: "8.97" },
  filasSinConvertir: [],
};

const generador = randomUUID();
const version = (extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  version: 1,
  generadoEn: "2026-11-10T12:00:00.000Z",
  generadoPor: generador,
  autor: { id: generador, nombre: "Ana Pérez", activo: true },
  formato: { id: "provisional-rce", version: "1" },
  provisional: true,
  nombreZip: "CONTAPP-PROVISIONAL-20123456789-202610.zip",
  sha256Txt: "c".repeat(64),
  sha256Zip: "d".repeat(64),
  bytesZip: 1234,
  lineas: 40,
  resumen,
  avisos: { "R-ISC": 1, SALTO_CORRELATIVIDAD: 1 },
  ...extra,
});

const ok = (v: unknown) => versionArchivoSchema.safeParse(v).success;

describe("versionArchivoSchema", () => {
  it("acepta una versión completa y devuelve los mismos datos", () => {
    const v = version();
    const r = versionArchivoSchema.safeParse(v);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(v);
  });

  it("acepta avisos vacíos y el impacto de ventas con destinos en null", () => {
    expect(ok(version({ avisos: {} }))).toBe(true);
    expect(ok(version({ resumen: { ...resumen, impactoIgv: { DG: null, DGNG: null, DNG: null, total: "1.00" } } }))).toBe(true);
  });

  it("no expone la ruta: una `ruta` de entrada no sale en el dato parseado", () => {
    const r = versionArchivoSchema.safeParse(version({ ruta: "archivos/t/c/x.zip" }));
    expect(r.success).toBe(true);
    expect(JSON.stringify(r.data)).not.toContain("archivos/t/c");
    expect(r.data as Record<string, unknown>).not.toHaveProperty("ruta");
  });

  it("los hashes son 64 hexadecimales en minúscula", () => {
    for (const k of ["sha256Txt", "sha256Zip"]) {
      for (const v of ["c".repeat(63), "c".repeat(65), "C".repeat(64), "x".repeat(64), "", null, undefined]) {
        expect(ok(version({ [k]: v })), `${k}=${String(v)}`).toBe(false);
      }
    }
  });

  it("version >= 1 entera; bytesZip >= 1; lineas >= 0 entero", () => {
    for (const v of [0, -1, 1.5, "1", null]) expect(ok(version({ version: v })), `version=${String(v)}`).toBe(false);
    for (const v of [0, -1, 1.5, "1", null]) expect(ok(version({ bytesZip: v })), `bytesZip=${String(v)}`).toBe(false);
    expect(ok(version({ lineas: 0 }))).toBe(true);
    for (const v of [-1, 0.5, "1", null]) expect(ok(version({ lineas: v })), `lineas=${String(v)}`).toBe(false);
  });

  it("id y generadoPor son uuid; generadoEn es ISO", () => {
    expect(ok(version({ id: "no-uuid" }))).toBe(false);
    expect(ok(version({ generadoPor: "no-uuid" }))).toBe(false);
    expect(ok(version({ generadoEn: "ayer" }))).toBe(false);
    expect(ok(version({ generadoEn: null }))).toBe(false);
  });

  it("provisional es booleano y nombreZip una cadena no vacía", () => {
    expect(ok(version({ provisional: false }))).toBe(true);
    expect(ok(version({ provisional: "true" }))).toBe(false);
    expect(ok(version({ nombreZip: "" }))).toBe(false);
    expect(ok(version({ nombreZip: 5 }))).toBe(false);
  });

  it("el resumen guardado no admite montos number", () => {
    expect(ok(version({ resumen: { ...resumen, impactoIgv: { ...resumen.impactoIgv, total: 8.97 } } }))).toBe(false);
  });

  it("avisos son conteos enteros no negativos por código", () => {
    for (const v of [-1, 1.5, "2", null]) expect(ok(version({ avisos: { "R-ISC": v } })), String(v)).toBe(false);
    expect(ok(version({ avisos: [] }))).toBe(false);
    expect(ok(version({ avisos: null }))).toBe(false);
  });

  it("falta cualquiera de los campos obligatorios -> rechazo", () => {
    for (const k of Object.keys(version())) {
      const resto = Object.fromEntries(Object.entries(version()).filter(([c]) => c !== k));
      expect(ok(resto), `sin ${k}`).toBe(false);
    }
  });
});

// Spec 017 · T1 (rojo). Autor con nombre en las versiones de archivo (D-12, CA-13): `generadoPor` conserva el id y se agrega
// `autor` ({id, nombre, activo}), siempre presente porque quien genera es un usuario.
describe("versionArchivoSchema · autor (017)", () => {
  it("conserva generadoPor y trae el autor con nombre", () => {
    const r = versionArchivoSchema.safeParse(version());
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ generadoPor: generador, autor: { id: generador, nombre: "Ana Pérez", activo: true } });
  });
  it("acepta un generador desactivado o desconocido (nombre null)", () => {
    expect(ok(version({ autor: { id: generador, nombre: "Ana Pérez", activo: false } }))).toBe(true);
    expect(ok(version({ autor: { id: generador, nombre: null, activo: false } }))).toBe(true);
  });
  it("exige autor y lo valida", () => {
    const sin: Record<string, unknown> = version();
    delete sin.autor;
    expect(ok(sin)).toBe(false);
    expect(ok(version({ autor: null }))).toBe(false);
    expect(ok(version({ autor: { id: "x", nombre: "Ana", activo: true } }))).toBe(false);
    expect(ok(version({ autor: generador }))).toBe(false);
  });
});
