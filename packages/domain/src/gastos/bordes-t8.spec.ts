// Spec 027 · T8: bordes de la implementación (duplicados deterministas, entradas inválidas) que las pruebas de T1 no fijan.
import { describe, expect, it } from "vitest";
import { PROV, contextoGastos, entrada } from "../../tests/ayudas/gastos";
import { EntradaReglasInvalidaError } from "../reglas/errores";
import { categoriasPermitidas, crearDiccionarioEfectivo, puntuarGastoPersonal, validarContextoGastos } from "../index";

const palabra = (p: string, extra: Record<string, unknown> = {}) => ({ palabra: p, categoria: "juguetes", excepciones: [], activa: true, ...extra });

describe("crearDiccionarioEfectivo · bordes", () => {
  it("una desactivada que no es una palabra válida no desactiva nada", () => {
    const d = crearDiccionarioEfectivo({ globales: [palabra("pelota")], desactivadas: ["no es palabra", 7 as never], propias: [] });
    expect(d.coincidenciasPorItem(["pelota"]).map((c) => c.palabra)).toEqual(["pelota"]);
  });

  it("`activa` que no es booleano lanza RangeError", () => {
    expect(() => crearDiccionarioEfectivo({ globales: [palabra("pelota", { activa: "si" }) as never], desactivadas: [], propias: [] })).toThrow(
      RangeError,
    );
  });
});

describe("contexto · filas repetidas de un proveedor (deterministas)", () => {
  it("varias filas de CIIU: cuenta la menor no nula; el historial se suma", () => {
    const ctx = contextoGastos({
      ciiuProveedores: [
        { proveedor: { ...PROV }, ciiu: null },
        { proveedor: { ...PROV }, ciiu: "5610" },
        { proveedor: { ...PROV }, ciiu: "9602" },
      ],
      historial: [
        { proveedor: { ...PROV }, aceptadas6: 0, excluidas6: 0, excluidas12: 1 },
        { proveedor: { ...PROV, numero: " 20700000070 " }, aceptadas6: 0, excluidas6: 0, excluidas12: 1 },
      ],
    });
    const r = puntuarGastoPersonal(entrada({ glosas: ["servicio"] }), ctx);
    // 5610 (restaurante) frente a 4752: S2; 1 + 1 excluidas en 12 periodos: S6.
    expect(r.senales.map((s) => s.codigo)).toEqual(["S2", "S6"]);
  });

  it("una categoría fuera de las 6 en el ajuste se rechaza", () => {
    expect(() => validarContextoGastos({ ...contextoGastos(), categoriasCliente: { permitidas: ["ferreteria"], quitadas: [] } })).toThrow(
      EntradaReglasInvalidaError,
    );
  });
});

describe("categoriasPermitidas · clase sin sección", () => {
  it("un CIIU de una división sin sección no tiene base: solo el ajuste", () => {
    expect([...categoriasPermitidas("0400", { permitidas: ["juguetes"], quitadas: [] })]).toEqual(["juguetes"]);
  });
});

describe("puntuarGastoPersonal · entrada inválida", () => {
  it.each([
    ["glosa no texto", { glosas: [1] }],
    ["fecha no válida", { fechaEmision: "2026-02-30" }],
    ["fecha no texto", { fechaEmision: 20260311 }],
    ["esNuevo no booleano", { esNuevo: "no" }],
    ["proveedor fuera de gramática", { proveedor: { tipo: "RUC", numero: "1" } }],
  ])("%s → EntradaReglasInvalidaError", (_n, over) => {
    expect(() => puntuarGastoPersonal({ ...entrada(), ...over } as never, contextoGastos())).toThrow(EntradaReglasInvalidaError);
  });

  it("una entrada válida con fecha nula puntúa", () => {
    expect(puntuarGastoPersonal(entrada({ fechaEmision: null }), contextoGastos()).puntaje).toBe(8);
  });
});
