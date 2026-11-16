import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CODIGOS_REGLA_MOTOR,
  codigoReglaMotorSchema,
  editarReglaSchema,
  eliminarReglaSchema,
  fijarAporteSchema,
  fijarReglaMotorSchema,
  recordarReglaSchema,
} from "./index.js";

// Spec 021 · T2 (rojo). Cuerpos de las rutas de reglas aprendidas (plan 021, Contratos: HTTP; D-5, P-2, P-8, P-10).
// Contrato fijado por estas pruebas (packages/shared/src/reglas/esquemas.ts, exportado por reglas/index.ts y por src/index.ts):
//  - recordarReglaSchema = {compraIds: uuid[1..5000] sin repetir, destino: DG|DGNG|DNG, versionBase: entero >= 1 | null (obligatorio)}.
//  - editarReglaSchema = {versionBase: entero >= 1, destino?, activa?}; al menos uno de destino/activa.
//  - eliminarReglaSchema = query string de DELETE: {versionBase} llega como texto ("3") o número y sale como number >= 1.
//  - CODIGOS_REGLA_MOTOR = R-ISC, R-MIX, R-RED, R-NEW, R-GP, R-HIS (la prevalidación de 012 no figura, P-8);
//    codigoReglaMotorSchema = z.enum(CODIGOS_REGLA_MOTOR).
//  - fijarReglaMotorSchema = {activa: boolean} (PUT /estudio/reglas-motor/:codigo); fijarAporteSchema = {aportar: boolean} (PUT …/aporte).
// Claves desconocidas descartadas (z.object): clienteId, tenantId, proveedor, ruc no viajan por el cuerpo.
interface Esquema {
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
}
const ok = (s: Esquema, v: unknown) => s.safeParse(v).success;
const datos = (s: Esquema, v: unknown) => {
  const r = s.safeParse(v);
  expect(r.success).toBe(true);
  return r.data as Record<string, unknown>;
};
const ids = (n: number) => Array.from({ length: n }, () => randomUUID());

describe("recordarReglaSchema", () => {
  const base = { compraIds: [randomUUID()], destino: "DNG", versionBase: null };

  it("acepta una compra, destino DNG y versionBase null (crea la regla)", () => {
    expect(datos(recordarReglaSchema, base)).toEqual(base);
  });
  it("acepta versionBase entero >= 1 (actualiza la regla viva)", () => {
    expect(datos(recordarReglaSchema, { ...base, versionBase: 3 }).versionBase).toBe(3);
  });
  it.each(["DG", "DGNG", "DNG"])("acepta el destino %s", (destino) => {
    expect(ok(recordarReglaSchema, { ...base, destino })).toBe(true);
  });
  it.each(["dng", "DN", "ISC", "", null, 1, ["DNG"]])("rechaza el destino %j", (destino) => {
    expect(ok(recordarReglaSchema, { ...base, destino })).toBe(false);
  });

  describe("compraIds", () => {
    it("de 1 a 5000 ids", () => {
      expect(ok(recordarReglaSchema, { ...base, compraIds: ids(5000) })).toBe(true);
      expect(ok(recordarReglaSchema, { ...base, compraIds: ids(5001) })).toBe(false);
      expect(ok(recordarReglaSchema, { ...base, compraIds: [] })).toBe(false);
    });
    it("sin ids repetidos, tampoco por mayúsculas", () => {
      const id = randomUUID();
      expect(ok(recordarReglaSchema, { ...base, compraIds: [id, id] })).toBe(false);
      expect(ok(recordarReglaSchema, { ...base, compraIds: [id, id.toUpperCase()] })).toBe(false);
    });
    it.each([["no-es-uuid"], [123], [null], [""], [{ compraId: randomUUID() }]])("rechaza el elemento %j", (x) => {
      expect(ok(recordarReglaSchema, { ...base, compraIds: [x] })).toBe(false);
    });
    it.each([undefined, null, "a", randomUUID(), {}])("rechaza compraIds = %j", (compraIds) => {
      expect(ok(recordarReglaSchema, { ...base, compraIds })).toBe(false);
    });
  });

  describe("versionBase", () => {
    it.each([0, -1, 1.5, "3", "", NaN, Infinity, true, [], {}])("rechaza %j", (versionBase) => {
      expect(ok(recordarReglaSchema, { ...base, versionBase })).toBe(false);
    });
    it("es obligatorio: ausente no equivale a null", () => {
      expect(ok(recordarReglaSchema, { compraIds: base.compraIds, destino: "DNG" })).toBe(false);
    });
  });

  it("descarta claves ajenas (clienteId, tenantId, proveedor, ruc)", () => {
    const d = datos(recordarReglaSchema, { ...base, clienteId: randomUUID(), tenantId: "x", proveedor: { numero: "20100070970" }, ruc: "20100070970" });
    expect(Object.keys(d).sort()).toEqual(["compraIds", "destino", "versionBase"]);
  });
});

describe("editarReglaSchema", () => {
  it("acepta versionBase con destino", () => {
    expect(datos(editarReglaSchema, { versionBase: 1, destino: "DGNG" })).toEqual({ versionBase: 1, destino: "DGNG" });
  });
  it("acepta versionBase con activa (true y false)", () => {
    expect(datos(editarReglaSchema, { versionBase: 2, activa: false })).toEqual({ versionBase: 2, activa: false });
    expect(datos(editarReglaSchema, { versionBase: 2, activa: true }).activa).toBe(true);
  });
  it("acepta los dos a la vez", () => {
    expect(datos(editarReglaSchema, { versionBase: 4, destino: "DG", activa: true })).toEqual({ versionBase: 4, destino: "DG", activa: true });
  });
  it("rechaza si no trae ni destino ni activa", () => {
    expect(ok(editarReglaSchema, { versionBase: 1 })).toBe(false);
  });
  it("las claves ajenas no cuentan como cambio: { versionBase, proveedor } se rechaza", () => {
    expect(ok(editarReglaSchema, { versionBase: 1, proveedor: "x", periodoAprendido: "202609" })).toBe(false);
  });
  it("versionBase es obligatorio y no admite null", () => {
    expect(ok(editarReglaSchema, { destino: "DNG" })).toBe(false);
    expect(ok(editarReglaSchema, { versionBase: null, destino: "DNG" })).toBe(false);
  });
  it.each([0, -1, 1.5, "1", NaN, true])("rechaza versionBase %j", (versionBase) => {
    expect(ok(editarReglaSchema, { versionBase, destino: "DNG" })).toBe(false);
  });
  it.each(["XX", "dng", "", null, 1])("rechaza destino %j", (destino) => {
    expect(ok(editarReglaSchema, { versionBase: 1, destino })).toBe(false);
  });
  it.each(["true", "false", 1, 0, null, "", []])("rechaza activa %j (sin coerce)", (activa) => {
    expect(ok(editarReglaSchema, { versionBase: 1, activa })).toBe(false);
  });
  it("descarta claves ajenas (id, clienteId, eliminadaEn, version)", () => {
    const d = datos(editarReglaSchema, { versionBase: 1, destino: "DNG", id: randomUUID(), clienteId: randomUUID(), eliminadaEn: "x", version: 9 });
    expect(Object.keys(d).sort()).toEqual(["destino", "versionBase"]);
  });
});

describe("eliminarReglaSchema (query string de DELETE)", () => {
  it.each([
    ["3", 3],
    [3, 3],
    ["1", 1],
    [1, 1],
  ])("versionBase %j → %j", (entrada, esperado) => {
    expect(datos(eliminarReglaSchema, { versionBase: entrada }).versionBase).toBe(esperado);
  });
  it.each(["0", 0, "-1", "1.5", 1.5, "abc", "", " ", null, undefined, NaN, [], {}])("rechaza %j", (versionBase) => {
    expect(ok(eliminarReglaSchema, { versionBase })).toBe(false);
  });
  it("es obligatorio", () => {
    expect(ok(eliminarReglaSchema, {})).toBe(false);
  });
  it("descarta claves ajenas", () => {
    expect(Object.keys(datos(eliminarReglaSchema, { versionBase: "2", clienteId: "x" }))).toEqual(["versionBase"]);
  });
});

describe("CODIGOS_REGLA_MOTOR y codigoReglaMotorSchema (RF-089, P-8)", () => {
  it("son los seis códigos, en este orden", () => {
    expect([...CODIGOS_REGLA_MOTOR]).toEqual(["R-ISC", "R-MIX", "R-RED", "R-NEW", "R-GP", "R-HIS"]);
  });
  it.each(["R-ISC", "R-MIX", "R-RED", "R-NEW", "R-GP", "R-HIS"])("acepta %s", (c) => {
    expect(codigoReglaMotorSchema.safeParse(c).success).toBe(true);
  });
  it.each(["prevalidacion", "PREVALIDACION", "R-PRE", "R-XML", "r-his", "R-HIS ", "", null, 1, undefined])("rechaza %j (la prevalidación no se apaga)", (c) => {
    expect(codigoReglaMotorSchema.safeParse(c).success).toBe(false);
  });
});

describe("fijarReglaMotorSchema y fijarAporteSchema", () => {
  it("fijarReglaMotor: {activa} booleano", () => {
    expect(datos(fijarReglaMotorSchema, { activa: false })).toEqual({ activa: false });
    expect(datos(fijarReglaMotorSchema, { activa: true })).toEqual({ activa: true });
  });
  it.each([{}, { activa: "true" }, { activa: 1 }, { activa: null }, { aportar: true }])("fijarReglaMotor rechaza %j", (v) => {
    expect(ok(fijarReglaMotorSchema, v)).toBe(false);
  });
  it("fijarAporte: {aportar} booleano", () => {
    expect(datos(fijarAporteSchema, { aportar: false })).toEqual({ aportar: false });
    expect(datos(fijarAporteSchema, { aportar: true })).toEqual({ aportar: true });
  });
  it.each([{}, { aportar: "false" }, { aportar: 0 }, { aportar: null }, { activa: true }])("fijarAporte rechaza %j", (v) => {
    expect(ok(fijarAporteSchema, v)).toBe(false);
  });
});
