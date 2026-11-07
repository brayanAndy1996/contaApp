// Spec 014 (T16): el cálculo de la versión nueva de cada acción, sin BD. La integración con HTTP y BD la cubren los
// `*.int.spec.ts` de este módulo; aquí los rechazos y las ramas que solo se alcanzan con una fila armada a mano.
import { describe, expect, it, vi } from "vitest";
import type { CompraLeida, HallazgoGuardadoCompra } from "@contapp/db";
import {
  montosACadenas,
  montosDeDominio,
  transformarClasificar,
  transformarEditar,
  transformarExcluir,
  transformarRestaurar,
  transformarSugerencia,
} from "./transformar.js";

const CERO = { biDg: "0.00", igvDg: "0.00", biDgng: "0.00", igvDgng: "0.00", biDng: "0.00", igvDng: "0.00", noGravado: "0.00", isc: "0.00", icbper: "0.00", otrosTributos: "0.00", total: "0.00" };
const ID = "0190a000-0000-7000-8000-0000000000a1";
const compra = (o: Partial<CompraLeida> = {}): CompraLeida => ({
  id: ID,
  clienteId: "c",
  periodo: "202610",
  propuestaId: null,
  origen: "sire",
  clave: "k",
  tipoDoc: "01",
  serie: "F001",
  numero: "1",
  docTipo: "6",
  docNumero: "20100070970",
  razonSocial: null,
  fecha: "2026-10-01",
  moneda: "PEN",
  tipoCambio: null,
  version: 1,
  excluida: false,
  motivo: null,
  clasificada: false,
  montos: { ...CERO, biDg: "100.00", igvDg: "18.00", total: "118.00" },
  ...o,
});

describe("clasificar y editar", () => {
  it("clasificar mueve al destino y marca clasificada; un destino inventado es solicitud_invalida", () => {
    const r = transformarClasificar(compra(), { destino: "DNG" });
    expect(r).toMatchObject({ clasificada: true, montos: { biDng: "100.00", igvDng: "18.00", biDg: "0.00", total: "118.00" } });
    expect(transformarClasificar(compra(), { destino: "XX" })).toEqual({ rechazo: "solicitud_invalida" });
  });

  it("un defecto que no es de dinero se propaga", () => {
    expect(() => transformarClasificar(null as never, { destino: "DNG" })).toThrow(TypeError);
  });

  it("editar recalcula el total y conserva la clasificación; un monto fuera de rango es solicitud_invalida", () => {
    const r = transformarEditar(compra({ clasificada: true }), { cambios: { biDg: "200.00" } });
    expect(r).toMatchObject({ clasificada: true, montos: { biDg: "200.00", total: "218.00" } });
    expect(transformarEditar(compra(), { cambios: { biDg: "999999999999.99", igvDg: "999999999999.99" } })).toEqual({ rechazo: "solicitud_invalida" });
  });
});

describe("excluir y restaurar", () => {
  it("excluir deja los montos y guarda el motivo (o null)", () => {
    expect(transformarExcluir(compra(), { motivo: "uso personal" })).toMatchObject({ excluida: true, motivo: "uso personal" });
    expect(transformarExcluir(compra(), {})).toMatchObject({ excluida: true, motivo: null });
  });

  it("restaurar exige una excluida", () => {
    expect(transformarRestaurar(compra({ excluida: true, motivo: "x" }), {})).toMatchObject({ excluida: false, motivo: null });
    expect(transformarRestaurar(compra(), {})).toEqual({ rechazo: "no_excluida" });
  });
});

describe("montosDeDominio y montosACadenas", () => {
  it("ida y vuelta sin pasar por number", () => {
    expect(montosACadenas(montosDeDominio(compra()))).toEqual(compra().montos);
  });
});

describe("transformarSugerencia", () => {
  const iscXml: HallazgoGuardadoCompra = {
    compraId: ID,
    regla: "R-ISC",
    sugerencia: { tipo: "mover", origen: "biDg", destino: "isc", monto: "500.00" },
    lecturas: { biDg: "500.00", igvDg: "0.00" },
    requiereConfirmacion: false,
  };
  const gp: HallazgoGuardadoCompra = {
    compraId: ID,
    regla: "R-GP",
    sugerencia: { tipo: "excluir", palabra: "zapatillas", categoria: "calzado" },
    lecturas: {},
    requiereConfirmacion: false,
  };
  const base = { conocidos: [], enMasa: false, confirmar: false, dato: undefined };
  const FILA = compra({ montos: { ...CERO, biDg: "500.00", total: "500.00" } });

  it("aplica la sugerencia guardada y pide los hallazgos una sola vez", async () => {
    const cargar = vi.fn(async () => new Map([[ID, [iscXml]]]));
    const t = transformarSugerencia({ ...base, regla: "R-ISC", cargarHallazgos: cargar });
    const r = await t(FILA, {});
    expect(r).toMatchObject({ excluida: false, clasificada: false, montos: { biDg: "0.00", isc: "500.00" } });
    await t(FILA, {});
    expect(cargar).toHaveBeenCalledTimes(1);
  });

  it("R-GP excluye la fila", async () => {
    const t = transformarSugerencia({ ...base, regla: "R-GP", cargarHallazgos: async () => new Map([[ID, [gp]]]) });
    expect(await t(FILA, {})).toMatchObject({ excluida: true, motivo: null });
  });

  it("sin hallazgo: revisar_de_nuevo; el dato pedido se avisa solo si hay quien lo escuche", async () => {
    const mix: HallazgoGuardadoCompra = {
      compraId: ID,
      regla: "R-MIX",
      sugerencia: { tipo: "separar", columnaBi: "biDg", min: "8.97", max: "8.98", estimado: "8.97", exacto: null },
      lecturas: { biDg: "21.48", igvDg: "1.61" },
      requiereConfirmacion: true,
    };
    const fila = compra({ montos: { ...CERO, biDg: "21.48", igvDg: "1.61", total: "23.09" } });
    const vacio = transformarSugerencia({ ...base, regla: "R-ISC", cargarHallazgos: async () => new Map() });
    expect(await vacio(fila, {})).toEqual({ rechazo: "revisar_de_nuevo" });

    const alPedirDato = vi.fn();
    const conOyente = transformarSugerencia({ ...base, regla: "R-MIX", confirmar: true, alPedirDato, cargarHallazgos: async () => new Map([[ID, [mix]]]) });
    expect(await conOyente(fila, {})).toEqual({ rechazo: "requiere_dato" });
    expect(alPedirDato).toHaveBeenCalledWith("gravado");
    const sinOyente = transformarSugerencia({ ...base, regla: "R-MIX", confirmar: true, cargarHallazgos: async () => new Map([[ID, [mix]]]) });
    expect(await sinOyente(fila, {})).toEqual({ rechazo: "requiere_dato" });
  });
});
