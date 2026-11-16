import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACCIONES_VERSION,
  detalleCompraSchema,
  filaCompraVistaSchema,
  listadoComprasSchema,
  listarComprasSchema,
  versionCompraVistaSchema,
} from "./index.js";

// Spec 021 · T2 (rojo). Cambios de `shared/compras` por «Según historial» (plan 021, Contratos: HTTP; CA-2, CA-3, CA-13).
// Contrato fijado por estas pruebas (compras/respuestas.ts y compras/filtros.ts):
//  - ACCIONES_VERSION suma "historial" (la versión 2 que escribe el worker); las demás siguen.
//  - filaCompraVistaSchema suma `segunHistorial: {reglaId: uuid} | null` (versión vigente con accion = historial). Es compatible hacia
//    atrás: si la clave falta se completa con null (las pruebas y fixtures de 014/015/016 siguen válidos). La fila y el detalle
//    (`vigente`) usan el mismo esquema. Solo viaja el id de la regla, ninguna otra clave de la regla.
//  - listarComprasSchema suma el filtro `segunHistorial` (booleano; "true"/"false" sin coerce), como `alertas` y `proveedorNuevo`.
const CERO = "0.00";
const montos = (o: Record<string, string> = {}) => ({
  biDg: CERO,
  igvDg: CERO,
  biDgng: CERO,
  igvDgng: CERO,
  biDng: CERO,
  igvDng: CERO,
  noGravado: CERO,
  isc: CERO,
  icbper: CERO,
  otrosTributos: CERO,
  total: CERO,
  ...o,
});
const fila = (o: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  origen: "sire",
  tipo: "01",
  serie: "F001",
  numero: "123",
  proveedor: { tipo: "6", numero: "20100070970", razonSocial: "PROVEEDOR SAC" },
  fecha: "2026-10-05",
  moneda: "PEN",
  tipoCambio: null,
  version: 2,
  montos: montos({ biDng: "100.00", total: "100.00" }),
  excluida: false,
  motivo: null,
  clasificada: true,
  proveedorNuevo: false,
  hallazgos: [],
  ...o,
});
const version = (o: Record<string, unknown> = {}) => ({
  n: 1,
  accion: "original",
  operacionId: null,
  usuarioId: null,
  autor: null,
  creadaEn: "2026-11-06T12:00:00.000Z",
  excluida: false,
  motivo: null,
  clasificada: false,
  montos: montos(),
  ...o,
});
interface Esquema {
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
}
const ok = (s: Esquema, v: unknown) => s.safeParse(v).success;

describe("ACCIONES_VERSION con «historial»", () => {
  it("incluye historial y conserva las demás", () => {
    expect(ACCIONES_VERSION).toContain("historial");
    expect(ACCIONES_VERSION).toEqual(
      expect.arrayContaining(["original", "agregada", "clasificar", "editar", "sugerencia", "excluir", "restaurar", "deshacer", "rehacer"]),
    );
  });
  it("una versión con accion historial es válida (sin operación ni usuario: la escribe el sistema)", () => {
    expect(ok(versionCompraVistaSchema, version({ n: 2, accion: "historial", operacionId: null, usuarioId: null, autor: null, clasificada: true }))).toBe(true);
  });
  it("una acción desconocida sigue rechazada", () => {
    expect(ok(versionCompraVistaSchema, version({ accion: "Historial" }))).toBe(false);
    expect(ok(versionCompraVistaSchema, version({ accion: "aprendida" }))).toBe(false);
  });
});

describe("segunHistorial en la fila", () => {
  it("acepta {reglaId} cuando la versión vigente viene del historial", () => {
    const reglaId = randomUUID();
    const r = filaCompraVistaSchema.parse(fila({ segunHistorial: { reglaId } }));
    expect(r.segunHistorial).toEqual({ reglaId });
  });
  it("acepta null", () => {
    expect(filaCompraVistaSchema.parse(fila({ segunHistorial: null })).segunHistorial).toBeNull();
  });
  it("si la clave falta se completa con null (filas de antes de 021)", () => {
    expect(filaCompraVistaSchema.parse(fila()).segunHistorial).toBeNull();
  });
  it.each([true, false, "regla", "", 1, {}, { reglaId: "no-es-uuid" }, { reglaId: null }, { reglaId: 5 }, []])("rechaza segunHistorial = %j", (segunHistorial) => {
    expect(ok(filaCompraVistaSchema, fila({ segunHistorial }))).toBe(false);
  });
  it("solo viaja el id de la regla: descarta destino, version, ruc, tenantId", () => {
    const reglaId = randomUUID();
    const r = filaCompraVistaSchema.parse(
      fila({ segunHistorial: { reglaId, destino: "DNG", version: 3, ruc: "20100070970", tenantId: randomUUID() } }),
    );
    expect(r.segunHistorial).toEqual({ reglaId });
    expect(Object.keys(r.segunHistorial ?? {})).toEqual(["reglaId"]);
  });
});

describe("segunHistorial en el listado y el detalle", () => {
  it("el listado conserva segunHistorial de cada fila", () => {
    const reglaId = randomUUID();
    const l = listadoComprasSchema.parse({ filas: [fila({ segunHistorial: { reglaId } }), fila({ segunHistorial: null })], siguiente: null });
    expect(l.filas.map((f) => f.segunHistorial)).toEqual([{ reglaId }, null]);
  });
  it("el detalle lo trae en la versión vigente y acepta la versión 2 accion historial", () => {
    const reglaId = randomUUID();
    const d = detalleCompraSchema.parse({
      original: version(),
      vigente: fila({ segunHistorial: { reglaId } }),
      versiones: [version(), version({ n: 2, accion: "historial", clasificada: true })],
      hallazgos: [],
    });
    expect(d.vigente.segunHistorial).toEqual({ reglaId });
    expect(d.versiones[1]?.accion).toBe("historial");
  });
  it("el detalle rechaza un segunHistorial mal formado en la vigente", () => {
    expect(ok(detalleCompraSchema, { original: version(), vigente: fila({ segunHistorial: { reglaId: "x" } }), versiones: [], hallazgos: [] })).toBe(false);
  });
});

describe("filtro segunHistorial de listarComprasSchema", () => {
  const datos = (v: unknown) => {
    const r = (listarComprasSchema as Esquema).safeParse(v);
    expect(r.success).toBe(true);
    return r.data as Record<string, unknown>;
  };
  it.each([
    [true, true],
    [false, false],
    ["true", true],
    ["false", false],
  ])("%j → %j (sin coerce)", (entrada, esperado) => {
    expect(datos({ segunHistorial: entrada }).segunHistorial).toBe(esperado);
  });
  it.each(["maybe", "yes", "1", "0", "", "TRUE", 1, 0, null, []])("rechaza %j", (v) => {
    expect(ok(listarComprasSchema, { segunHistorial: v })).toBe(false);
  });
  it("es opcional: sin él no aparece la clave", () => {
    expect("segunHistorial" in datos({})).toBe(false);
  });
  it("se combina con vista, alertas y proveedorNuevo (masiva por filtro, CA-3)", () => {
    const d = datos({ vista: "con_igv", alertas: "false", proveedorNuevo: "true", segunHistorial: "true", limite: "50" });
    expect(d).toEqual({ vista: "con_igv", alertas: false, proveedorNuevo: true, segunHistorial: true, limite: 50 });
  });
});
