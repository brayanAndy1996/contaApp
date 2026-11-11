// Spec 012b, T21 (rojo): corrección de H-012b-5 (ronda adversarial 2). `prepararSinDesborde` traduce a `fueraDeRango()` SOLO el
// desborde real del impacto en IGV (una suma que no cabe en NUMERIC(14,2) con montos que SÍ son `Money` / `MontosComprobante`).
// Una forma imposible EN los montos (un valor que no es un Money o un MontosComprobante real) es un error de programación:
// se propaga tal cual (500 en el previo y el POST), aunque las demás filas también desborden la suma.
// Hoy (rojo): para decidir «es desborde» se repite el armado con los montos reconstruidos en 0.00, y la forma imposible
// desaparece en esa reconstrucción: se traduce como `resumen_fuera_de_rango`.
// El gemelo del worker es `apps/worker/src/trabajos/procesadores/desborde-resumen-forma.spec.ts` (mismos casos).
import {
  EntradaPrevalidacionInvalidaError,
  Money,
  MontosComprobante,
  type CabeceraTxt,
  type FilaReemplazo,
  type FilaReemplazoVenta,
} from "@contapp/domain";
import { describe, expect, it } from "vitest";
import { prepararSinDesborde } from "./desborde.js";

class FueraDeRango extends Error {}
const fuera = (): Error => new FueraDeRango();

const CAB_VENTAS: CabeceraTxt = {
  rucDeclarante: "20100070970",
  periodo: "202610",
  libro: "ventas",
};
const CAB_COMPRAS: CabeceraTxt = { ...CAB_VENTAS, libro: "compras" };
const m = (v: string) => Money.desde(v, "PEN");

type MontosVenta = FilaReemplazoVenta["montos"];

function montosVenta(base: string, igv: string, total: string): MontosVenta {
  return {
    baseGravada: m(base),
    igv: m(igv),
    exonerada: m("0.00"),
    inafecta: m("0.00"),
    isc: m("0.00"),
    icbper: m("0.00"),
    otros: m("0.00"),
    total: m(total),
  };
}

function venta(n: number, montos: MontosVenta): FilaReemplazoVenta {
  return {
    id: `01-F001-${n}`,
    estado: "agregada",
    comprobante: { tipo: "01", serie: "F001", numero: String(n) },
    contraparte: { tipo: "6", numero: "20100070970" },
    fechaEmision: "2026-10-05",
    montos,
    tipoCambio: null,
  };
}

const ventaBuena = (n: number): FilaReemplazoVenta =>
  venta(n, montosVenta("100.00", "18.00", "118.00"));
const ventaEnorme = (n: number): FilaReemplazoVenta =>
  venta(
    n,
    montosVenta("800000000000.00", "144000000000.00", "944000000000.00"),
  );

/** La misma venta con UN monto reemplazado por algo que no es un Money. */
const ventaCon = (
  n: number,
  campo: keyof MontosVenta,
  valor: unknown,
): FilaReemplazoVenta =>
  venta(n, {
    ...montosVenta("100.00", "18.00", "118.00"),
    [campo]: valor,
  } as MontosVenta);

function compra(
  n: number,
  montos: MontosComprobante,
  origenUsd: FilaReemplazo["origenUsd"] = null,
): FilaReemplazo {
  return {
    id: `c${n}`,
    estado: "agregada",
    comprobante: { tipo: "01", serie: "F001", numero: String(n) },
    proveedor: { tipo: "6", numero: "20100070970" },
    fechaEmision: "2026-10-05",
    montos,
    tipoCambio: null,
    origenUsd,
  };
}

const montosBuenos = (): MontosComprobante =>
  MontosComprobante.desde("PEN", {
    biDg: "100.00",
    igvDg: "18.00",
    total: "118.00",
  });
const montosUsd = (): MontosComprobante =>
  MontosComprobante.desde("USD", {
    biDg: "10.00",
    igvDg: "1.80",
    total: "11.80",
  });
const compraEnorme = (n: number): FilaReemplazo =>
  compra(
    n,
    MontosComprobante.desde("PEN", {
      biDg: "800000000000.00",
      igvDg: "144000000000.00",
      total: "944000000000.00",
    }),
  );
/** Un objeto con la forma visible de MontosComprobante, sin serlo. */
const montosFalsos = (moneda = "PEN"): MontosComprobante =>
  ({ moneda, total: m("118.00") }) as unknown as MontosComprobante;

const ventas = (
  vigente: FilaReemplazoVenta[],
  original: FilaReemplazoVenta[] = [],
) =>
  prepararSinDesborde(
    {
      libro: "ventas",
      cabecera: CAB_VENTAS,
      original,
      vigente,
      permitirProvisional: true,
    },
    fuera,
  );
const compras = (vigente: FilaReemplazo[]) =>
  prepararSinDesborde(
    {
      libro: "compras",
      cabecera: CAB_COMPRAS,
      original: [],
      vigente,
      permitirProvisional: true,
    },
    fuera,
  );

function capturar(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  return undefined;
}

/** La forma imposible se propaga como el error de dominio de la entrada, NO como el de fuera de rango. */
function esForma(f: () => unknown): void {
  const error = capturar(f);
  expect(error, "debía lanzar").toBeDefined();
  expect(
    error,
    "una forma imposible no es un desborde (se tradujo a fuera de rango)",
  ).not.toBeInstanceOf(FueraDeRango);
  expect(error).toBeInstanceOf(EntradaPrevalidacionInvalidaError);
}

function esDesborde(f: () => unknown): void {
  expect(
    capturar(f),
    "el desborde real debía traducirse a fuera de rango",
  ).toBeInstanceOf(FueraDeRango);
}

describe("H-012b-5 · lo que SÍ es desborde (se traduce)", () => {
  it("ventas: Σ IGV de montos Money reales fuera de NUMERIC(14,2) (7 facturas que cuadran al 18 %)", () => {
    esDesborde(() =>
      ventas(Array.from({ length: 7 }, (_, i) => ventaEnorme(i + 1))),
    );
  });

  it("ventas: el desborde también lo es con una fila buena mezclada y con filas originales", () => {
    const original = [ventaBuena(100)].map((f) => ({
      ...f,
      estado: "original" as const,
    }));
    esDesborde(() =>
      ventas(
        [
          ...original,
          ventaBuena(101),
          ...Array.from({ length: 7 }, (_, i) => ventaEnorme(i + 1)),
        ],
        original,
      ),
    );
  });

  it("compras: Σ IGV de MontosComprobante reales fuera de rango", () => {
    esDesborde(() =>
      compras(Array.from({ length: 7 }, (_, i) => compraEnorme(i + 1))),
    );
  });

  it("compras: el desborde por filas con origen USD también lo es", () => {
    esDesborde(() =>
      compras([
        ...Array.from({ length: 7 }, (_, i) => compraEnorme(i + 1)),
        compra(8, montosBuenos(), { montos: montosUsd(), tipoCambio: "3.500" }),
      ]),
    );
  });

  it("sin desborde ni forma imposible: devuelve el archivo preparado", () => {
    expect(ventas([ventaBuena(1)]).resumen.impactoIgv.total.toString()).toBe(
      "18.00",
    );
    expect(compras([compra(1, montosBuenos())]).resumen.agregadas).toBe(1);
  });
});

describe("H-012b-5 · lo que NO es desborde (se propaga la forma imposible en los montos)", () => {
  it("ventas: un monto que imita a Money sin serlo (misma forma visible)", () => {
    const falso = { moneda: "PEN", toString: () => "18.00" };
    esForma(() => ventas([ventaCon(1, "igv", falso)]));
  });

  it("ventas: un monto faltante (undefined) y uno nulo", () => {
    esForma(() => ventas([ventaCon(1, "igv", undefined)]));
    esForma(() => ventas([ventaCon(1, "otros", null)]));
  });

  it("ventas: un monto como `number` o como cadena (dinero que no pasó por Money)", () => {
    esForma(() => ventas([ventaCon(1, "baseGravada", 100)]));
    esForma(() => ventas([ventaCon(1, "total", "118.00")]));
  });

  it("ventas: la forma imposible en una fila y desborde en las demás: gana la forma", () => {
    esForma(() =>
      ventas([
        ventaCon(1, "igv", { moneda: "PEN" }),
        ...Array.from({ length: 7 }, (_, i) => ventaEnorme(i + 2)),
      ]),
    );
  });

  it("compras: montos que no son MontosComprobante", () => {
    esForma(() => compras([compra(1, montosFalsos())]));
  });

  it("compras: montos faltantes (undefined)", () => {
    esForma(() =>
      compras([compra(1, undefined as unknown as MontosComprobante)]),
    );
  });

  it("compras: el origen USD con montos que no son MontosComprobante (en USD, como un origen real)", () => {
    esForma(() =>
      compras([
        compra(1, montosBuenos(), {
          montos: montosFalsos("USD"),
          tipoCambio: "3.500",
        }),
      ]),
    );
  });

  it("compras: la forma imposible en una fila y desborde en las demás: gana la forma", () => {
    esForma(() =>
      compras([
        compra(1, montosFalsos()),
        ...Array.from({ length: 7 }, (_, i) => compraEnorme(i + 2)),
      ]),
    );
  });
});
