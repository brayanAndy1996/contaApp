// Spec 021 · T25c (b). El contexto de reglas se valida UNA vez, al crear el evaluador, y no por fila: con 300 reglas en el
// contexto la validación por fila era el 25 % de la descarga (T25b). Un contexto inválido sigue lanzando, solo que antes.
// El evaluador del motor (`crearEvaluadorReglas`) se prueba en src/reglas/evaluador-t25c.spec.ts.
import { describe, expect, it, vi } from "vitest";
import * as entrada from "../reglas/entrada";
import { EntradaReglasInvalidaError } from "../reglas/index";
import { crearEvaluarCompras, type CompraEvaluable } from "./evaluar";

vi.mock("../reglas/entrada", async (original) => {
  const real = await original<typeof import("../reglas/entrada")>();
  return { ...real, validarContexto: vi.fn(real.validarContexto) };
});
const validarContexto = vi.mocked(entrada.validarContexto);

const CERO = { biDg: "0.00", igvDg: "0.00", biDgng: "0.00", igvDgng: "0.00", biDng: "0.00", igvDng: "0.00", noGravado: "0.00", isc: "0.00", icbper: "0.00", otrosTributos: "0.00", total: "0.00" };
const compra = (i: number, o: Partial<CompraEvaluable> = {}): CompraEvaluable => ({
  docTipo: "6",
  docNumero: `20${String(100000000 + i)}`,
  tipoDoc: "01",
  serie: "F001",
  numero: String(1000 + i),
  moneda: "PEN",
  clasificada: false,
  montos: { ...CERO, biDg: "100.00", igvDg: "18.00", total: "118.00" },
  ...o,
});
const conocidos = (n: number) => Array.from({ length: n }, (_, i) => ({ tipo: "6", numero: `20${String(200000000 + i)}` }));

describe("crearEvaluarCompras valida el contexto una sola vez (T25c b)", () => {
  it("50 compras con 300 proveedores y reglas en el contexto: validarContexto se llama una vez, al crear", () => {
    validarContexto.mockClear();
    const evaluar = crearEvaluarCompras(conocidos(150), { xmlSimuladoEnReglas: false, proveedoresConRegla: conocidos(300).slice(150) });
    expect(validarContexto).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 50; i++) evaluar(compra(i));
    expect(validarContexto).toHaveBeenCalledTimes(1);
  });

  it("un contexto inválido (código apagado desconocido) lanza al crear, antes de evaluar ninguna fila", () => {
    expect(() =>
      crearEvaluarCompras([], { xmlSimuladoEnReglas: false, reglasApagadas: ["R-XXX" as never] }),
    ).toThrow(EntradaReglasInvalidaError);
  });

  it("el resultado no cambia: mismos hallazgos que evaluar con el contexto en cada fila", () => {
    const evaluar = crearEvaluarCompras([{ tipo: "6", numero: "20100000003" }], { xmlSimuladoEnReglas: false, reglasApagadas: ["R-GP"] });
    const r = [0, 1, 2, 3].map((i) => evaluar(compra(i)).map((h) => h.regla));
    expect(r).toEqual([["R-NEW"], ["R-NEW"], ["R-NEW"], []]);
  });
});
