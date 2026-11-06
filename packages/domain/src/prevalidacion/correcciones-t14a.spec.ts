// Spec 012 · T14a: casos de las decisiones D21 (H-012-24) y D22 (H-012-28). Las variantes
// adversariales están en ronda1b; aquí, el caso feliz y el de error de cada comportamiento. Solo
// API pública.
import { describe, expect, it } from "vitest";
import {
  DefinicionFormatoInvalidaError,
  EntradaPrevalidacionInvalidaError,
  MontosComprobante,
  RegistroFormatos,
  generarTxt,
  prevalidar,
  resumirCambios,
  seleccionarFormato,
} from "../index";
import type { CampoTxt } from "../index";
import { CABECERA, filaReemplazo, lineasCrlf } from "../../tests/ayudas/filas-reemplazo";

const PROVISIONAL = seleccionarFormato("compras", "202610");
const registroCon = (campos: readonly CampoTxt[]) =>
  RegistroFormatos.desde([{ ...PROVISIONAL, version: "t14a", oficial: true, campos }]);

describe("D21 · RegistroFormatos.desde solo admite campos que generarTxt sabe escribir", () => {
  it("un subconjunto de campos conocidos se registra, prevalida apto y genera la línea con esos campos", () => {
    const campos = PROVISIONAL.campos.filter((c) => ["serie", "numero", "total"].includes(c.nombre));
    const registro = registroCon(campos);
    const f = filaReemplazo();
    expect(prevalidar([f], { cabecera: CABECERA, registro }).apto).toBe(true);
    expect(lineasCrlf(generarTxt([f], CABECERA, { registro }).bytes)).toEqual(["F001|123|118.00"]);
  });

  it.each(["campoNuevo", "Serie", "toString", "__proto__", "constructor"])(
    "un campo «%s» sin serializador lanza DefinicionFormatoInvalidaError al registrar",
    (nombre) => {
      const campos = [...PROVISIONAL.campos, { nombre, obligatorio: false, longitudMax: 5, tipo: "texto" as const }];
      expect(() => registroCon(campos)).toThrow(DefinicionFormatoInvalidaError);
    },
  );
});

describe("D22 · un impacto en IGV fuera de NUMERIC(14,2) es entrada inválida", () => {
  const original = filaReemplazo(undefined, { id: "o1" });
  const agregada = (igvDg: string, igvDgng: string) =>
    filaReemplazo(undefined, {
      id: "nueva",
      estado: "agregada",
      montos: MontosComprobante.desde("PEN", { igvDg, igvDgng, total: "0.00" }),
    });

  it("en el borde exacto (DG + DGNG = 999999999999.99) devuelve el total sin lanzar", () => {
    const r = resumirCambios([original], [original, agregada("999999999999.98", "0.01")]);
    expect(r.impactoIgv.total.toString()).toBe("999999999999.99");
    expect(r.impactoIgv.DG.toString()).toBe("999999999999.98");
  });

  it("un destino cuya suma sale de rango también lanza EntradaPrevalidacionInvalidaError", () => {
    const igvDg = (id: string, estado: "original" | "modificada", monto: string) =>
      filaReemplazo(undefined, { id, estado, montos: MontosComprobante.desde("PEN", { igvDg: monto, total: "0.00" }) });
    // DG = 600000000000.00 − (−600000000000.00) = 1200000000000.00: cada monto cabe, la suma no.
    expect(() =>
      resumirCambios([igvDg("o2", "original", "-600000000000.00")], [igvDg("o2", "modificada", "600000000000.00")]),
    ).toThrow(EntradaPrevalidacionInvalidaError);
  });
});
