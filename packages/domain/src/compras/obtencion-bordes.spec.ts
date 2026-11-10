// Spec 016 · T8 (backend). Bordes de `planificarObtencionXml` y de `crearEvaluarCompras` con XML que no cubren las pruebas
// de T2: tamaño de lote no válido y un `detalle` guardado ilegible (se evalúa como sin XML, no deja la fila sin hallazgos).
import { describe, expect, it } from "vitest";
import { detalleMixta } from "../../tests/ayudas/ubl";
import { crearEvaluarCompras } from "./evaluar";
import type { CompraEvaluable } from "./evaluar";
import { planificarObtencionXml } from "./obtencion";

describe("planificarObtencionXml · tamaño de lote", () => {
  it.each([0, -1, 1.5, Number.NaN])("tamLote %s lanza RangeError", (tam) => {
    expect(() => planificarObtencionXml([{ compraId: "a", conHallazgos: false, tieneXml: false, obtencion: null }], tam)).toThrow(RangeError);
  });
});

describe("crearEvaluarCompras · detalle ilegible", () => {
  const CERO = { biDg: "0.00", igvDg: "0.00", biDgng: "0.00", igvDgng: "0.00", biDng: "0.00", igvDng: "0.00", noGravado: "0.00", isc: "0.00", icbper: "0.00", otrosTributos: "0.00", total: "0.00" };
  const compra: CompraEvaluable = {
    docTipo: "6",
    docNumero: "20700000045",
    tipoDoc: "01",
    serie: "F001",
    numero: "2056",
    moneda: "PEN",
    clasificada: false,
    montos: { ...CERO, biDg: "21.48", igvDg: "1.61", total: "23.09" },
  };

  it("un detalle con un monto que no es decimal se ignora: mismos hallazgos que sin XML", () => {
    const evaluar = crearEvaluarCompras([{ tipo: "6", numero: "20700000045" }]);
    const roto = detalleMixta({ totales: { ...detalleMixta().totales, total: "no-es-monto" } });
    const sinXml = evaluar(compra);
    expect(sinXml.length).toBeGreaterThan(0);
    expect(evaluar({ ...compra, xml: { origen: "subido", detalle: roto } })).toEqual(sinXml);
  });
});
