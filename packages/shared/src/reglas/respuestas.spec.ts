import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reglaVistaSchema, reglasMotorSchema } from "./index.js";

// Spec 021 · T2 (rojo). Respuestas de reglas (plan 021, Contratos: HTTP; CA-7, CA-8, CA-13).
// Contrato fijado por estas pruebas (packages/shared/src/reglas/respuestas.ts):
//  - reglaVistaSchema = {id: uuid, proveedor: {tipo, numero, razonSocial: string|null}, destino: DG|DGNG|DNG, activa, version >= 1,
//    periodoAprendido: AAAAMM, aplicada >= 0, aceptada >= 0 (enteros), creadaPor: autor|null, creadaEn: ISO, actualizadaEn: ISO}.
//    El único dato de RUC viaja dentro de `proveedor`; ninguna otra clave (ruc, docNumero, tenantId, clienteId, eliminadaEn) sale.
//  - reglasMotorSchema = {reglas: [{codigo: R-ISC|R-MIX|R-RED|R-NEW|R-GP|R-HIS, descripcion, activa}], aportarCatalogo: boolean}.
interface Esquema {
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
}
const ok = (s: Esquema, v: unknown) => s.safeParse(v).success;
const regla = (o: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  proveedor: { tipo: "6", numero: "20100070970", razonSocial: "PROVEEDOR SAC" },
  destino: "DNG",
  activa: true,
  version: 1,
  periodoAprendido: "202609",
  aplicada: 0,
  aceptada: 0,
  creadaPor: { id: randomUUID(), nombre: "Ana Pérez", activo: true },
  creadaEn: "2026-11-13T10:00:00.000Z",
  actualizadaEn: "2026-11-13T10:00:00.000Z",
  ...o,
});

describe("reglaVistaSchema", () => {
  it("acepta una regla completa y la devuelve igual", () => {
    const r = regla();
    expect(reglaVistaSchema.parse(r)).toEqual(r);
  });
  it("acepta razón social null y creadaPor null (usuario desconocido)", () => {
    expect(ok(reglaVistaSchema, regla({ proveedor: { tipo: "6", numero: "20100070970", razonSocial: null } }))).toBe(true);
    expect(ok(reglaVistaSchema, regla({ creadaPor: null }))).toBe(true);
  });
  it("acepta un proveedor con documento que no es RUC (tipo 1, DNI)", () => {
    expect(ok(reglaVistaSchema, regla({ proveedor: { tipo: "1", numero: "12345678", razonSocial: null } }))).toBe(true);
  });
  it("acepta contadores grandes (aplicada y aceptada)", () => {
    expect(ok(reglaVistaSchema, regla({ aplicada: 4800, aceptada: 4799, version: 12 }))).toBe(true);
  });

  it.each(["DG", "DGNG", "DNG"])("acepta el destino %s", (destino) => {
    expect(ok(reglaVistaSchema, regla({ destino }))).toBe(true);
  });
  it.each(["XX", "dng", "", null, 1])("rechaza el destino %j", (destino) => {
    expect(ok(reglaVistaSchema, regla({ destino }))).toBe(false);
  });

  it.each([0, -1, 1.5, "1", null, NaN])("rechaza version %j", (version) => {
    expect(ok(reglaVistaSchema, regla({ version }))).toBe(false);
  });
  it.each([
    ["aplicada", -1],
    ["aplicada", 1.5],
    ["aplicada", "2"],
    ["aplicada", null],
    ["aceptada", -1],
    ["aceptada", 0.5],
    ["aceptada", "0"],
    ["aceptada", null],
  ])("rechaza %s = %j (entero >= 0)", (campo, valor) => {
    expect(ok(reglaVistaSchema, regla({ [campo]: valor }))).toBe(false);
  });
  it("aplicada y aceptada son obligatorias", () => {
    const { aplicada, ...sinAplicada } = regla();
    const { aceptada, ...sinAceptada } = regla();
    void aplicada;
    void aceptada;
    expect(ok(reglaVistaSchema, sinAplicada)).toBe(false);
    expect(ok(reglaVistaSchema, sinAceptada)).toBe(false);
  });

  it.each(["2026-09", "202613", "202600", "20269", "", null, 202609])("rechaza periodoAprendido %j", (periodoAprendido) => {
    expect(ok(reglaVistaSchema, regla({ periodoAprendido }))).toBe(false);
  });
  it.each(["no-es-uuid", "", null, 1])("rechaza id %j", (id) => {
    expect(ok(reglaVistaSchema, regla({ id }))).toBe(false);
  });
  it.each(["ayer", "2026-11-13", "", null, 0])("rechaza creadaEn %j", (creadaEn) => {
    expect(ok(reglaVistaSchema, regla({ creadaEn }))).toBe(false);
  });
  it("rechaza activa que no es booleano y un proveedor sin número", () => {
    expect(ok(reglaVistaSchema, regla({ activa: "true" }))).toBe(false);
    expect(ok(reglaVistaSchema, regla({ proveedor: { tipo: "6", razonSocial: null } }))).toBe(false);
    expect(ok(reglaVistaSchema, regla({ proveedor: { tipo: "6", numero: 20100070970, razonSocial: null } }))).toBe(false);
  });

  it("sin campos de RUC fuera de `proveedor`: la forma son exactamente las claves del contrato", () => {
    expect(Object.keys(reglaVistaSchema.shape).sort()).toEqual(
      ["aceptada", "actualizadaEn", "aplicada", "activa", "creadaEn", "creadaPor", "destino", "id", "periodoAprendido", "proveedor", "version"].sort(),
    );
  });
  it("descarta claves ajenas (ruc, docNumero, tenantId, clienteId, eliminadaEn) al analizar", () => {
    const r = reglaVistaSchema.parse(
      regla({ ruc: "20100070970", docNumero: "20100070970", tenantId: randomUUID(), clienteId: randomUUID(), eliminadaEn: "2026-11-13T10:00:00.000Z" }),
    ) as Record<string, unknown>;
    for (const k of ["ruc", "docNumero", "tenantId", "clienteId", "eliminadaEn"]) expect(k in r).toBe(false);
  });
  it("descarta claves ajenas dentro de `proveedor`", () => {
    const r = reglaVistaSchema.parse(regla({ proveedor: { tipo: "6", numero: "20100070970", razonSocial: "X", tenantId: randomUUID() } }));
    expect(Object.keys(r.proveedor).sort()).toEqual(["numero", "razonSocial", "tipo"]);
  });
});

describe("reglasMotorSchema (RF-089)", () => {
  const reglas = [
    { codigo: "R-ISC", descripcion: "Detecta ISC dentro de la base gravada", activa: true },
    { codigo: "R-MIX", descripcion: "Separa compras mixtas", activa: true },
    { codigo: "R-RED", descripcion: "Detecta redondeos", activa: false },
    { codigo: "R-NEW", descripcion: "Avisa de proveedores nuevos", activa: true },
    { codigo: "R-GP", descripcion: "Detecta gastos personales", activa: true },
    { codigo: "R-HIS", descripcion: "Aplica lo aprendido del cliente", activa: true },
  ];
  const motor = (o: Record<string, unknown> = {}) => ({ reglas, aportarCatalogo: true, ...o });

  it("acepta los seis códigos con su descripción y estado", () => {
    expect(reglasMotorSchema.parse(motor())).toEqual(motor());
  });
  it("acepta el aporte apagado", () => {
    expect(ok(reglasMotorSchema, motor({ aportarCatalogo: false }))).toBe(true);
  });
  it("la prevalidación no figura: un código fuera de las seis se rechaza", () => {
    for (const codigo of ["prevalidacion", "PREVALIDACION", "R-PRE", "R-XML"]) {
      expect(ok(reglasMotorSchema, motor({ reglas: [...reglas, { codigo, descripcion: "x", activa: true }] }))).toBe(false);
    }
  });
  it("cada regla exige codigo, descripcion y activa", () => {
    expect(ok(reglasMotorSchema, motor({ reglas: [{ codigo: "R-ISC", activa: true }] }))).toBe(false);
    expect(ok(reglasMotorSchema, motor({ reglas: [{ descripcion: "x", activa: true }] }))).toBe(false);
    expect(ok(reglasMotorSchema, motor({ reglas: [{ codigo: "R-ISC", descripcion: "x" }] }))).toBe(false);
  });
  it.each(["true", 1, null])("rechaza activa %j", (activa) => {
    expect(ok(reglasMotorSchema, motor({ reglas: [{ codigo: "R-ISC", descripcion: "x", activa }] }))).toBe(false);
  });
  it("aportarCatalogo y reglas son obligatorios; aportarCatalogo es booleano", () => {
    expect(ok(reglasMotorSchema, { reglas })).toBe(false);
    expect(ok(reglasMotorSchema, { aportarCatalogo: true })).toBe(false);
    expect(ok(reglasMotorSchema, motor({ aportarCatalogo: "true" }))).toBe(false);
    expect(ok(reglasMotorSchema, motor({ reglas: "R-ISC" }))).toBe(false);
  });
  it("descarta claves ajenas (tenantId, actualizadaPor)", () => {
    const r = reglasMotorSchema.parse(
      motor({ tenantId: randomUUID(), reglas: [{ codigo: "R-ISC", descripcion: "x", activa: true, actualizadaPor: randomUUID() }] }),
    ) as Record<string, unknown>;
    expect("tenantId" in r).toBe(false);
    expect(Object.keys((r.reglas as Record<string, unknown>[])[0]!).sort()).toEqual(["activa", "codigo", "descripcion"]);
  });
});
