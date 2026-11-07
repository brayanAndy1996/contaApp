import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACCIONES_VERSION,
  accionCompraRespuestaSchema,
  calcularRespuestaSchema,
  detalleCompraSchema,
  deshacerRespuestaSchema,
  errorDuplicadoSchema,
  errorFilaCambiadaSchema,
  errorRequiereDatoSchema,
  errorVersionObsoletaSchema,
  filaCompraVistaSchema,
  hallazgoVistaSchema,
  informeDescargaSchema,
  informeMasivaSchema,
  listadoComprasSchema,
  resumenComprasSchema,
  sugerenciaVistaSchema,
  versionCompraVistaSchema,
} from "./index.js";

// Spec 014 · T4. Formas de las respuestas (plan 014, Contratos: HTTP). Un caso feliz y uno de error por
// esquema; en todos, un monto como `number` se rechaza.
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
const cuadre = { cuadra: false, celdas: [{ columna: "igvDg", cuadra: false, explicacion: "1.61 no es 18 % ni 10 % de 21.48" }] };
const hallazgo = {
  regla: "R-ISC",
  destino: null,
  explicacion: "texto",
  sugerencia: { tipo: "mover", origen: "biDg", destino: "isc", monto: "770.00" },
  requiereConfirmacion: true,
  dato: null,
  masiva: false,
};
const fila = {
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
  montos: montos({ biDg: "100.00", igvDg: "18.00", total: "118.00" }),
  excluida: false,
  motivo: null,
  clasificada: true,
  proveedorNuevo: false,
  hallazgos: [hallazgo],
};
const version = {
  n: 1,
  accion: "original",
  operacionId: null,
  usuarioId: null,
  creadaEn: "2026-11-06T12:00:00.000Z",
  excluida: false,
  motivo: null,
  clasificada: false,
  montos: montos(),
};
const ok = (s: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => s.safeParse(v).success;

describe("filaCompraVistaSchema", () => {
  it("acepta una fila con razón social, hallazgos y montos como cadenas", () => {
    expect(ok(filaCompraVistaSchema, fila)).toBe(true);
    expect(ok(filaCompraVistaSchema, { ...fila, proveedor: { ...fila.proveedor, razonSocial: null }, tipoCambio: "3.300", moneda: "USD" })).toBe(true);
  });
  it("rechaza un monto number, una moneda desconocida y una versión 0", () => {
    expect(ok(filaCompraVistaSchema, { ...fila, montos: montos({ total: 118 as never }) })).toBe(false);
    expect(ok(filaCompraVistaSchema, { ...fila, moneda: "EUR" })).toBe(false);
    expect(ok(filaCompraVistaSchema, { ...fila, version: 0 })).toBe(false);
  });
  it("no deja salir claves ajenas (tenantId)", () => {
    const r = filaCompraVistaSchema.safeParse({ ...fila, tenantId: randomUUID() });
    expect(r.success && "tenantId" in r.data).toBe(false);
  });
});

describe("hallazgoVistaSchema y sugerenciaVistaSchema", () => {
  it.each([
    { tipo: "mover", origen: "biDg", destino: "isc", monto: "770.00" },
    { tipo: "separar", columnaBi: "biDg", min: "8.00", max: "9.00", estimado: "8.50", exacto: null },
    { tipo: "ajustar", valores: { total: "118.00" } },
    { tipo: "clasificar" },
    { tipo: "excluir", palabra: "ZAPATILLAS", categoria: "personal" },
  ])("acepta la sugerencia %j", (s) => {
    expect(ok(sugerenciaVistaSchema, s)).toBe(true);
  });
  it("rechaza un tipo desconocido y un monto number", () => {
    expect(ok(sugerenciaVistaSchema, { tipo: "borrar" })).toBe(false);
    expect(ok(sugerenciaVistaSchema, { tipo: "mover", origen: "biDg", destino: "isc", monto: 770 })).toBe(false);
  });
  it("el hallazgo admite sugerencia null (solo aviso) y rechaza una regla desconocida", () => {
    expect(ok(hallazgoVistaSchema, { ...hallazgo, sugerencia: null })).toBe(true);
    expect(ok(hallazgoVistaSchema, { ...hallazgo, regla: "R-XX" })).toBe(false);
  });
});

describe("listado, detalle, acción y calcular", () => {
  it("el listado lleva filas y el cursor siguiente (o null)", () => {
    expect(ok(listadoComprasSchema, { filas: [fila], siguiente: null })).toBe(true);
    expect(ok(listadoComprasSchema, { filas: [fila] })).toBe(false);
  });
  it("el detalle separa la versión 1 de la vigente", () => {
    expect(ok(detalleCompraSchema, { original: version, vigente: fila, versiones: [version], hallazgos: [hallazgo] })).toBe(true);
    expect(ok(detalleCompraSchema, { vigente: fila, versiones: [], hallazgos: [] })).toBe(false);
  });
  it("T17a: las acciones de la versión 1 son las que guardan el persistidor y agregarCompra", () => {
    expect(ACCIONES_VERSION).toEqual(expect.arrayContaining(["original", "agregada"]));
    expect(ACCIONES_VERSION).not.toContain("descarga");
    expect(ACCIONES_VERSION).not.toContain("agregar");
  });
  it("una versión rechaza una acción desconocida", () => {
    expect(ok(versionCompraVistaSchema, version)).toBe(true);
    expect(ok(versionCompraVistaSchema, { ...version, accion: "borrar" })).toBe(false);
  });
  it("la respuesta de una acción trae la fila y el cuadre por celda", () => {
    expect(ok(accionCompraRespuestaSchema, { fila, cuadre })).toBe(true);
    expect(ok(accionCompraRespuestaSchema, { fila })).toBe(false);
  });
  it("calcular devuelve total y cuadre; el total no es number", () => {
    expect(ok(calcularRespuestaSchema, { total: "23.09", cuadre })).toBe(true);
    expect(ok(calcularRespuestaSchema, { total: 23.09, cuadre })).toBe(false);
  });
  it("una celda de cuadre acepta solo una columna conocida", () => {
    expect(ok(calcularRespuestaSchema, { total: "1.00", cuadre: { cuadra: true, celdas: [{ columna: "total", cuadra: true, explicacion: null }] } })).toBe(false);
  });
});

describe("resumenComprasSchema", () => {
  const resumen = {
    estado: "abierto",
    casilleros: { original: montos(), vigente: montos(), diferencia: montos({ biDg: "-770.00", isc: "770.00" }) },
    conIgv: { n: 2, casilleros: montos() },
    sinIgv: { n: 1, casilleros: montos() },
    filasSinConvertir: ["a"],
  };
  it("acepta original, vigente y diferencia, con y sin IGV con su cantidad", () => {
    expect(ok(resumenComprasSchema, resumen)).toBe(true);
  });
  it("rechaza una cantidad negativa o un estado desconocido", () => {
    expect(ok(resumenComprasSchema, { ...resumen, conIgv: { n: -1, casilleros: montos() } })).toBe(false);
    expect(ok(resumenComprasSchema, { ...resumen, estado: "cerrado" })).toBe(false);
  });
});

describe("masivas, deshacer, descarga y errores con datos", () => {
  it("el informe de una masiva sin ninguna aplicada trae operacionId null", () => {
    const rechazada = { compraId: randomUUID(), codigo: "no_masiva" };
    expect(ok(informeMasivaSchema, { operacionId: null, aplicadas: 0, rechazadas: [rechazada] })).toBe(true);
    expect(ok(informeMasivaSchema, { operacionId: randomUUID(), aplicadas: 8, rechazadas: [{ ...rechazada, codigo: "otro" }] })).toBe(false);
  });
  it("deshacer devuelve la operación y los ids que cambiaron", () => {
    expect(ok(deshacerRespuestaSchema, { operacionId: randomUUID(), filas: [randomUUID()] })).toBe(true);
    expect(ok(deshacerRespuestaSchema, { operacionId: randomUUID(), filas: 8 })).toBe(false);
  });
  // Spec 014 · T8 (rojo hasta T13): el `resultado` real del trabajo de descarga es el de 013, `{ propuestaId, recibidas,
  // nuevas, iguales, distintas, claves (≤ 40), truncado }` (plan 014, Contrato real de 013, punto 5). Reemplaza al
  // `{ agregadas, existentes, difieren, difierenTotal }` de T4.
  describe("informe de descarga (forma real del resultado de 013)", () => {
    const claves = (n: number) => Array.from({ length: n }, (_, i) => `01|F001|${i + 1}|6|20100070970`);
    const informe = (o: Record<string, unknown> = {}) => ({
      propuestaId: randomUUID(),
      recibidas: 6,
      nuevas: 1,
      iguales: 4,
      distintas: 1,
      claves: claves(1),
      truncado: false,
      ...o,
    });
    it("acepta el resultado de CA-1 (5 nuevas, sin diferencias) y el de CA-17", () => {
      expect(ok(informeDescargaSchema, informe({ recibidas: 5, nuevas: 5, iguales: 0, distintas: 0, claves: [] }))).toBe(true);
      expect(ok(informeDescargaSchema, informe())).toBe(true);
    });
    it("tiene como máximo 40 claves", () => {
      expect(ok(informeDescargaSchema, informe({ claves: claves(40), distintas: 90, truncado: true }))).toBe(true);
      expect(ok(informeDescargaSchema, informe({ claves: claves(41), truncado: true }))).toBe(false);
    });
    it("rechaza la forma anterior de T4 (agregadas, existentes, difieren)", () => {
      expect(ok(informeDescargaSchema, { agregadas: 1, existentes: 4, difieren: claves(1) })).toBe(false);
    });
    it.each([
      ["sin propuestaId", { propuestaId: undefined }],
      ["propuestaId que no es uuid", { propuestaId: "p-1" }],
      ["sin truncado", { truncado: undefined }],
      ["truncado que no es booleano", { truncado: "si" }],
      ["recibidas negativas", { recibidas: -1 }],
      ["nuevas con decimales", { nuevas: 1.5 }],
      ["iguales como cadena", { iguales: "4" }],
      ["distintas sin definir", { distintas: undefined }],
      ["claves que no son cadenas", { claves: [1, 2] }],
    ])("rechaza: %s", (_nombre, cambio) => {
      expect(ok(informeDescargaSchema, informe(cambio))).toBe(false);
    });
  });
  it("los errores con datos exigen su dato", () => {
    expect(ok(errorVersionObsoletaSchema, { codigo: "version_obsoleta", versionVigente: 3 })).toBe(true);
    expect(ok(errorVersionObsoletaSchema, { codigo: "version_obsoleta" })).toBe(false);
    expect(ok(errorRequiereDatoSchema, { codigo: "requiere_dato", dato: "gravado" })).toBe(true);
    expect(ok(errorRequiereDatoSchema, { codigo: "requiere_dato", dato: "otro" })).toBe(false);
    expect(ok(errorFilaCambiadaSchema, { codigo: "fila_cambiada", ids: [randomUUID()] })).toBe(true);
    expect(ok(errorFilaCambiadaSchema, { codigo: "fila_cambiada", ids: ["x"] })).toBe(false);
    expect(ok(errorDuplicadoSchema, { codigo: "duplicado", id: randomUUID() })).toBe(true);
    expect(ok(errorDuplicadoSchema, { codigo: "duplicado" })).toBe(false);
  });
});
