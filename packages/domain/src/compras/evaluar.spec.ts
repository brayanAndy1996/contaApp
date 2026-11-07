// Spec 014 · T16. La evaluación de una compra que comparten el persistidor (worker) y las acciones (backend).
import { describe, expect, it } from "vitest";
import { Money } from "../dinero/index";
import type { Hallazgo } from "../reglas/index";
import { crearEvaluarCompras, hallazgoAJson, proveedoresValidos, type CompraEvaluable } from "./evaluar";

const CERO = { biDg: "0.00", igvDg: "0.00", biDgng: "0.00", igvDgng: "0.00", biDng: "0.00", igvDng: "0.00", noGravado: "0.00", isc: "0.00", icbper: "0.00", otrosTributos: "0.00", total: "0.00" };
const compra = (o: Partial<CompraEvaluable> = {}): CompraEvaluable => ({
  docTipo: "6",
  docNumero: "20100070970",
  tipoDoc: "01",
  serie: "F001",
  numero: "1040",
  moneda: "PEN",
  clasificada: false,
  montos: { ...CERO, biDg: "100.00", igvDg: "18.00", total: "118.00" },
  ...o,
});
const CONOCIDO = [{ tipo: "6", numero: "20100070970" }];

describe("crearEvaluarCompras", () => {
  it("una gravada común de un proveedor conocido no tiene hallazgos", () => {
    expect(crearEvaluarCompras(CONOCIDO)(compra())).toEqual([]);
  });

  it("R-ISC (San Juan): sugerencia y lecturas con los montos como cadenas", () => {
    const h = crearEvaluarCompras(CONOCIDO)(compra({ montos: { ...CERO, biDg: "770.00", total: "770.00" } }));
    const isc = h.find((x) => x.regla === "R-ISC");
    expect(isc).toBeDefined();
    expect(isc!.sugerencia).toMatchObject({ tipo: "mover", origen: "biDg", destino: "isc", monto: "770.00" });
    expect(isc!.requiereConfirmacion).toBe(true);
    expect(Object.values(isc!.lecturas).every((v) => typeof v === "string")).toBe(true);
  });

  it("un proveedor sin historial es R-NEW, y una fila ya clasificada no lo vuelve a tener", () => {
    const evaluar = crearEvaluarCompras([]);
    expect(evaluar(compra()).map((h) => h.regla)).toContain("R-NEW");
    expect(evaluar(compra({ clasificada: true })).map((h) => h.regla)).not.toContain("R-NEW");
  });

  it("una fila que las reglas no aceptan (DUA de 12 dígitos) queda sin hallazgos y no lanza", () => {
    const evaluar = crearEvaluarCompras(CONOCIDO);
    expect(evaluar(compra({ tipoDoc: "50", numero: "123456789012" }))).toEqual([]);
  });

  it("un solo hallazgo por regla aunque la regla marque varios destinos", () => {
    const m = { ...CERO, biDg: "770.00", biDng: "770.00", total: "1540.00" };
    const reglas = crearEvaluarCompras(CONOCIDO)(compra({ montos: m })).map((h) => h.regla);
    expect(new Set(reglas).size).toBe(reglas.length);
  });
});

describe("proveedoresValidos", () => {
  it("normaliza a mayúsculas, quita espacios, omite los fuera de gramática y no repite", () => {
    const r = proveedoresValidos([
      { tipo: "6", numero: "20100070970" },
      { tipo: "6", numero: "20100070970" },
      { tipo: "1", numero: "ab 12" },
      { tipo: "66", numero: "1" },
      { tipo: "6", numero: "con|barra" },
    ]);
    expect(r).toEqual([
      { tipo: "6", numero: "20100070970" },
      { tipo: "1", numero: "AB12" },
    ]);
  });
});

describe("hallazgoAJson", () => {
  const base = { filaId: "fila", regla: "R-RED", destino: null, explicacion: "x", requiereConfirmacion: true, dato: null } as const;
  const pen = (v: string): Money => Money.desde(v, "PEN");

  it("cada tipo de sugerencia sale con los montos como cadenas", () => {
    const h = (sugerencia: Hallazgo["sugerencia"], lecturas = {}): Hallazgo => ({ ...base, sugerencia, lecturas });
    expect(hallazgoAJson(h(null)).sugerencia).toBeNull();
    expect(hallazgoAJson(h({ tipo: "ajustar", valores: { total: pen("118.00") } })).sugerencia).toEqual({ tipo: "ajustar", valores: { total: "118.00" } });
    expect(hallazgoAJson(h({ tipo: "clasificar" })).sugerencia).toEqual({ tipo: "clasificar" });
    expect(hallazgoAJson(h({ tipo: "excluir", palabra: "zapatillas", categoria: "calzado" })).sugerencia).toEqual({ tipo: "excluir", palabra: "zapatillas", categoria: "calzado" });
    expect(hallazgoAJson(h({ tipo: "mover", origen: "biDg", destino: "isc", monto: pen("5.00") }, { biDg: pen("5.00") }))).toMatchObject({
      sugerencia: { monto: "5.00" },
      lecturas: { biDg: "5.00" },
    });
    expect(hallazgoAJson(h({ tipo: "separar", columnaBi: "biDg", min: pen("1.00"), max: pen("2.00"), estimado: pen("1.50"), exacto: null })).sugerencia).toMatchObject({ exacto: null });
  });
});
