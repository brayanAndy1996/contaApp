// Spec 021 · T25c (b). `crearEvaluadorReglas` (interno del motor): `evaluarReglas` con el contexto validado UNA vez, al crear.
// Un contexto inválido sigue lanzando, solo que antes; las filas se siguen validando en cada llamada.
import { describe, expect, it, vi } from "vitest";
import * as entrada from "./entrada";
import { crearEvaluadorReglas, evaluarReglas } from "./motor";
import { EntradaReglasInvalidaError } from "./errores";
import type { ContextoReglas, FilaEvaluable } from "./tipos";
import { MontosComprobante } from "../comprobante/index";
import { DICCIONARIO_GLOSAS_BASE } from "../texto/index";

vi.mock("./entrada", async (original) => {
  const real = await original<typeof import("./entrada")>();
  return { ...real, validarContexto: vi.fn(real.validarContexto) };
});
const validarContexto = vi.mocked(entrada.validarContexto);

const CERO = { biDg: "0.00", igvDg: "0.00", biDgng: "0.00", igvDgng: "0.00", biDng: "0.00", igvDng: "0.00", noGravado: "0.00", isc: "0.00", icbper: "0.00", otrosTributos: "0.00", total: "0.00" };
const fila = (id: string, numero: string, m: Record<string, string>): FilaEvaluable => ({
  id,
  proveedor: { tipo: "6", numero },
  comprobante: { tipo: "01", serie: "F001", numero: "77" },
  montos: MontosComprobante.desde("PEN", { ...CERO, ...m }),
});
const contexto = (o: Partial<ContextoReglas> = {}): ContextoReglas => ({
  proveedoresConocidos: [{ tipo: "6", numero: "20100070970" }],
  proveedoresIsc: [{ tipo: "6", numero: "20500000009" }],
  diccionario: DICCIONARIO_GLOSAS_BASE,
  ...o,
});
const FILAS: FilaEvaluable[] = [
  fila("a", "20100070970", { biDg: "100.00", igvDg: "18.00", total: "118.00" }),
  fila("b", "20999999999", { biDg: "21.48", igvDg: "1.61", total: "23.09" }),
  fila("c", "20500000009", { biDgng: "50.00", igvDgng: "0.00", total: "50.00" }),
  fila("d", "20100070970", { biDng: "770.00", igvDng: "138.60", total: "908.60" }),
];

describe("crearEvaluadorReglas: evaluarReglas con el contexto validado al crear (T25c b)", () => {
  it("da exactamente lo mismo que evaluarReglas, fila a fila y en lote", () => {
    const ctx = contexto({ reglasApagadas: ["R-RED"] });
    const evaluar = crearEvaluadorReglas(ctx);
    expect(evaluar(FILAS)).toEqual(evaluarReglas(FILAS, ctx));
    for (const f of FILAS) expect(evaluar([f])).toEqual(evaluarReglas([f], ctx));
    expect(evaluar([])).toEqual(evaluarReglas([], ctx));
  });

  it("valida el contexto al crear y no en cada llamada", () => {
    validarContexto.mockClear();
    const evaluar = crearEvaluadorReglas(contexto());
    for (const f of FILAS) evaluar([f]);
    expect(validarContexto).toHaveBeenCalledTimes(1);
  });

  it("un contexto inválido lanza al crear (clave extra, documento fuera de gramática, diccionario falso, código desconocido)", () => {
    const malos: unknown[] = [
      { ...contexto(), extra: 1 },
      contexto({ proveedoresConocidos: [{ tipo: "6", numero: "no valido!" }] }),
      contexto({ diccionario: { ...DICCIONARIO_GLOSAS_BASE } as never }),
      contexto({ reglasApagadas: ["R-HIZ" as never] }),
      null,
    ];
    for (const m of malos) {
      expect(() => crearEvaluadorReglas(m as ContextoReglas), JSON.stringify(m)?.slice(0, 60)).toThrow(EntradaReglasInvalidaError);
    }
  });

  it("las filas se siguen validando en cada llamada: una fila inválida lanza", () => {
    const evaluar = crearEvaluadorReglas(contexto());
    expect(() => evaluar([{ ...FILAS[0]!, extra: true } as never])).toThrow(EntradaReglasInvalidaError);
    expect(() => evaluar([FILAS[0]!, FILAS[0]!])).toThrow(EntradaReglasInvalidaError);
  });

  it("cambiar el contexto después de crear no cambia lo evaluado (queda la copia validada)", () => {
    const conocidosMutables = [{ tipo: "6", numero: "20100070970" }];
    const ctx = contexto({ proveedoresConocidos: conocidosMutables });
    const evaluar = crearEvaluadorReglas(ctx);
    const antes = evaluar(FILAS);
    conocidosMutables.push({ tipo: "6", numero: "20999999999" }, { tipo: "x", numero: "!!" });
    expect(evaluar(FILAS)).toEqual(antes);
  });
});
