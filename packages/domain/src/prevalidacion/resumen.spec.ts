// Spec 012 (T5, rojo): resumirCambios (D12, D14; CA-8).
// Contrato fijado por la prueba:
//  - `resumirCambios(original, vigente)` empareja por `id` y devuelve un ResumenCambios congelado
//    `{ modificadas, excluidas, agregadas, impactoIgv: { DG, DGNG, DNG, total }, filasSinConvertir }`.
//  - Cuenta por el `estado` de la fila VIGENTE: `excluida` gana a `modificada`; una `modificada` solo
//    cuenta si cambió la identidad (comprobante, documento del proveedor, fecha), el TC, `origenUsd`
//    o algún monto (Money.igual); `agregada` cuenta siempre.
//  - impactoIgv = Σ IGV de las vigentes no excluidas - Σ IGV de las originales, por destino, en PEN
//    (convertirAPen por componente para las USD); `total` = DG + DGNG + DNG. Todo Money PEN.
//  - Una fila USD sin TC válido no suma (ni en original ni en vigente) y su id va a
//    `filasSinConvertir` (sin repetir, en orden de unidades de código).
//  - Un id original ausente en el vigente, o una `agregada` con id del original, lanza
//    EntradaPrevalidacionInvalidaError.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EntradaPrevalidacionInvalidaError, MontosComprobante, resumirCambios } from "../index";
import type { FilaReemplazo, ResumenCambios } from "../index";
import { NUM_RUNS, SEMILLA, centavosAString } from "../../tests/ayudas/comprobante";
import { filaReemplazo } from "../../tests/ayudas/filas-reemplazo";
import type { Columnas } from "../../tests/ayudas/filas-reemplazo";

const num = (n: number) => ({ tipo: "01", serie: "F001", numero: String(n) });
const fila = (id: string, columnas: Columnas, over: Partial<FilaReemplazo> & { moneda?: "PEN" | "USD" } = {}): FilaReemplazo =>
  filaReemplazo(columnas, { id, comprobante: num(Number(id.replace(/\D/g, "")) || 1), ...over });
const impacto = (r: ResumenCambios) => ({
  DG: r.impactoIgv.DG.toString(),
  DGNG: r.impactoIgv.DGNG.toString(),
  DNG: r.impactoIgv.DNG.toString(),
  total: r.impactoIgv.total.toString(),
});
const CERO = { DG: "0.00", DGNG: "0.00", DNG: "0.00", total: "0.00" };

describe("CA-8 · conteos de modificadas, excluidas y agregadas", () => {
  const A = fila("a1", { biDg: "100.00", igvDg: "18.00" });
  const B = fila("b2", { biDg: "200.00", igvDg: "36.00" });
  const C = fila("c3", { biDgng: "50.00", igvDgng: "9.00" });
  const D = fila("d4", { biDg: "-100.00", igvDg: "-18.00" });
  const original = [A, B, C, D];

  it("sin cambios todo es cero", () => {
    const r = resumirCambios(original, original);
    expect([r.modificadas, r.excluidas, r.agregadas]).toEqual([0, 0, 0]);
    expect(impacto(r)).toEqual(CERO);
    expect(r.filasSinConvertir).toEqual([]);
  });

  it("listas vacías dan ceros", () => {
    const r = resumirCambios([], []);
    expect([r.modificadas, r.excluidas, r.agregadas]).toEqual([0, 0, 0]);
    expect(impacto(r)).toEqual(CERO);
  });

  it("N modificadas, M excluidas y K agregadas, con el impacto exacto por destino", () => {
    // A: IGV DG 18.00 -> 9.00 (mixta separada, -9.00). B: excluida (-36.00 en DG).
    // C: IGV DGNG 9.00 -> 0.00 y IGV DNG 0.00 -> 9.00 (se mueve de destino). D igual. E y F agregadas (+1.80 DG, +0.90 DNG).
    const vigente = [
      fila("a1", { biDg: "50.00", igvDg: "9.00", noGravado: "50.00" }, { estado: "modificada" }),
      { ...B, estado: "excluida" as const },
      fila("c3", { biDng: "50.00", igvDng: "9.00" }, { estado: "modificada" }),
      D,
      fila("e5", { biDg: "10.00", igvDg: "1.80" }, { estado: "agregada" }),
      fila("f6", { biDng: "5.00", igvDng: "0.90" }, { estado: "agregada" }),
    ];
    const r = resumirCambios(original, vigente);
    expect(r.modificadas).toBe(2);
    expect(r.excluidas).toBe(1);
    expect(r.agregadas).toBe(2);
    expect(impacto(r)).toEqual({ DG: "-43.20", DGNG: "-9.00", DNG: "9.90", total: "-42.30" });
    expect(r.impactoIgv.DG.moneda).toBe("PEN");
    expect(r.impactoIgv.total.moneda).toBe("PEN");
  });

  it("el total es exactamente DG + DGNG + DNG", () => {
    const vigente = [fila("a1", { biDg: "10.00", igvDg: "1.80" }, { estado: "modificada" }), B, C, D];
    const r = resumirCambios(original, vigente);
    expect(r.impactoIgv.DG.sumar(r.impactoIgv.DGNG).sumar(r.impactoIgv.DNG).igual(r.impactoIgv.total)).toBe(true);
    expect(r.impactoIgv.total.toString()).toBe("-16.20");
  });

  it("excluir una nota de crédito sube el IGV (se quita un IGV negativo)", () => {
    const r = resumirCambios(original, [A, B, C, { ...D, estado: "excluida" }]);
    expect(r.excluidas).toBe(1);
    expect(impacto(r)).toEqual({ DG: "18.00", DGNG: "0.00", DNG: "0.00", total: "18.00" });
  });

  it("agregar una nota de crédito baja el IGV", () => {
    const r = resumirCambios(original, [...original, fila("g7", { biDg: "-10.00", igvDg: "-1.80" }, { estado: "agregada" })]);
    expect(r.agregadas).toBe(1);
    expect(impacto(r)).toEqual({ DG: "-1.80", DGNG: "0.00", DNG: "0.00", total: "-1.80" });
  });

  it("el resultado está congelado (y sus montos y la lista de filas sin convertir)", () => {
    const r = resumirCambios(original, original);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.impactoIgv)).toBe(true);
    expect(Object.isFrozen(r.filasSinConvertir)).toBe(true);
  });

  it("no muta ni reordena las entradas", () => {
    const o = [...original];
    const v = [fila("a1", { biDg: "50.00", igvDg: "9.00", noGravado: "50.00" }, { estado: "modificada" }), B, C, D];
    const idsV = v.map((f) => f.id);
    resumirCambios(o, v);
    expect(o).toEqual(original);
    expect(v.map((f) => f.id)).toEqual(idsV);
  });

  it("el orden de las filas del vigente no cambia el resultado", () => {
    const vigente = [
      fila("a1", { biDg: "50.00", igvDg: "9.00", noGravado: "50.00" }, { estado: "modificada" }),
      { ...B, estado: "excluida" as const },
      C,
      D,
      fila("e5", { biDg: "10.00", igvDg: "1.80" }, { estado: "agregada" }),
    ];
    expect(resumirCambios(original, [...vigente].reverse())).toEqual(resumirCambios(original, vigente));
    expect(resumirCambios([...original].reverse(), vigente)).toEqual(resumirCambios(original, vigente));
  });
});

describe("CA-8 · cuándo una fila modificada cuenta", () => {
  const base = fila("a1", { biDg: "100.00", igvDg: "18.00" });
  const mod = (over: Partial<FilaReemplazo>) => resumirCambios([base], [{ ...base, estado: "modificada", ...over }]);

  it("vuelta a sus montos originales (otro objeto con los mismos montos) no cuenta", () => {
    const r = mod({ montos: MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.00" }) });
    expect(r.modificadas).toBe(0);
    expect(impacto(r)).toEqual(CERO);
  });

  it("estado modificada con todo igual (misma referencia) tampoco cuenta", () => {
    expect(mod({}).modificadas).toBe(0);
  });

  it("cambia un solo monto, aunque el total no cambie (mover entre columnas)", () => {
    expect(mod({ montos: MontosComprobante.desde("PEN", { biDg: "118.00", total: "118.00" }) }).modificadas).toBe(1);
  });

  it("cambia solo el total", () => {
    expect(mod({ montos: MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.01" }) }).modificadas).toBe(1);
  });

  it.each([
    ["la serie", { comprobante: { tipo: "01", serie: "F002", numero: "1" } }],
    ["el número", { comprobante: { tipo: "01", serie: "F001", numero: "2" } }],
    ["el tipo de comprobante", { comprobante: { tipo: "03", serie: "F001", numero: "1" } }],
    ["el documento del proveedor", { proveedor: { tipo: "6", numero: "20700000011" } }],
    ["la fecha de emisión", { fechaEmision: "2026-10-06" }],
  ])("cambia %s (identidad)", (_n, over) => {
    expect(mod(over as Partial<FilaReemplazo>).modificadas).toBe(1);
  });

  it("cambia solo el TC o solo origenUsd (en filas USD y PEN)", () => {
    const usd = fila("u1", { biDg: "100.00", igvDg: "18.00" }, { moneda: "USD", tipoCambio: "3.300" });
    expect(resumirCambios([usd], [{ ...usd, estado: "modificada", tipoCambio: "3.350" }]).modificadas).toBe(1);
    const penOrigen = fila("p1", { biDg: "330.00", igvDg: "59.40" }, {
      origenUsd: { montos: MontosComprobante.desde("USD", { biDg: "100.00", igvDg: "18.00", total: "118.00" }), tipoCambio: "3.300" },
    });
    const sinOrigen = { ...penOrigen, estado: "modificada" as const, origenUsd: null };
    expect(resumirCambios([penOrigen], [sinOrigen]).modificadas).toBe(1);
    const otroTc = { ...penOrigen, estado: "modificada" as const, origenUsd: { ...penOrigen.origenUsd!, tipoCambio: "3.301" } };
    expect(resumirCambios([penOrigen], [otroTc]).modificadas).toBe(1);
  });

  it("excluida gana a modificada: una fila excluida con cambios cuenta solo como excluida", () => {
    const r = resumirCambios([base], [{ ...fila("a1", { biDg: "50.00", igvDg: "9.00", noGravado: "50.00" }), estado: "excluida" }]);
    expect([r.modificadas, r.excluidas, r.agregadas]).toEqual([0, 1, 0]);
    expect(impacto(r)).toEqual({ DG: "-18.00", DGNG: "0.00", DNG: "0.00", total: "-18.00" });
  });

  it("una excluida sin cambios también cuenta como excluida", () => {
    const r = resumirCambios([base], [{ ...base, estado: "excluida" }]);
    expect([r.modificadas, r.excluidas]).toEqual([0, 1]);
  });
});

describe("CA-8 · impacto con USD (conversión por componente de 010)", () => {
  const usd = (id: string, columnas: Columnas, tipoCambio: string | null, estado: FilaReemplazo["estado"] = "original") =>
    fila(id, columnas, { moneda: "USD", tipoCambio, estado });

  it("convierte el IGV de las USD a PEN con el TC de cada fila, redondeando por componente", () => {
    // 18.00 x 3.350 = 60.30; 18.00 x 3.300 = 59.40.
    const o = usd("u1", { biDg: "100.00", igvDg: "18.00" }, "3.300");
    const v = usd("u1", { biDg: "100.00", igvDg: "18.00" }, "3.350", "modificada");
    expect(impacto(resumirCambios([o], [v]))).toEqual({ DG: "0.90", DGNG: "0.00", DNG: "0.00", total: "0.90" });
  });

  it("redondeo SUNAT half-up por componente: 0.03 USD x 3.300 = 0.099 -> 0.10 en PEN", () => {
    const o = usd("u1", { biDg: "0.15", igvDg: "0.03" }, "3.300");
    const r = resumirCambios([], [{ ...o, estado: "agregada" }]);
    expect(impacto(r)).toEqual({ DG: "0.10", DGNG: "0.00", DNG: "0.00", total: "0.10" });
  });

  it("una USD y una PEN suman en PEN", () => {
    const r = resumirCambios(
      [],
      [
        { ...usd("u1", { biDg: "100.00", igvDg: "18.00" }, "3.300"), estado: "agregada" },
        fila("p2", { biDg: "100.00", igvDg: "18.00" }, { estado: "agregada" }),
      ],
    );
    expect(impacto(r)).toEqual({ DG: "77.40", DGNG: "0.00", DNG: "0.00", total: "77.40" });
  });

  it("una fila PEN con origenUsd usa sus montos en PEN (no reconvierte)", () => {
    const f = fila("p1", { biDg: "330.00", igvDg: "59.40" }, {
      estado: "agregada",
      origenUsd: { montos: MontosComprobante.desde("USD", { biDg: "100.00", igvDg: "18.00", total: "118.00" }), tipoCambio: "3.300" },
    });
    expect(impacto(resumirCambios([], [f])).DG).toBe("59.40");
  });

  it.each([
    ["sin TC (null)", null],
    ["con TC de más de 3 decimales", "3.3001"],
    ["con TC en cero", "0.000"],
    ["con TC negativo", "-3.300"],
  ])("una USD %s no suma y va a filasSinConvertir", (_n, tc) => {
    const r = resumirCambios([], [{ ...usd("u9", { biDg: "100.00", igvDg: "18.00" }, tc), estado: "agregada" }]);
    expect(impacto(r)).toEqual(CERO);
    expect(r.filasSinConvertir).toEqual(["u9"]);
    expect(r.agregadas).toBe(1);
  });

  it("una USD sin TC en el original y en el vigente se informa una sola vez, ordenada con las demás", () => {
    const u = usd("u9", { biDg: "100.00", igvDg: "18.00" }, null);
    const w = usd("B1", { biDg: "100.00", igvDg: "18.00" }, null);
    const r = resumirCambios([u, w], [w, { ...u, estado: "modificada", fechaEmision: "2026-10-06" }]);
    expect(r.filasSinConvertir).toEqual(["B1", "u9"]);
    expect(impacto(r)).toEqual(CERO);
  });

  it("una USD que pierde el TC al modificarse deja su id en filasSinConvertir", () => {
    const o = usd("u1", { biDg: "100.00", igvDg: "18.00" }, "3.300");
    const r = resumirCambios([o], [{ ...o, estado: "modificada", tipoCambio: null }]);
    expect(r.filasSinConvertir).toEqual(["u1"]);
    expect(r.modificadas).toBe(1);
  });
});

describe("CA-8 · entradas inválidas (EntradaPrevalidacionInvalidaError)", () => {
  const A = fila("a1", { biDg: "100.00", igvDg: "18.00" });
  const B = fila("b2", { biDg: "200.00", igvDg: "36.00" });
  const lanza = (o: unknown, v: unknown) => {
    expect(typeof EntradaPrevalidacionInvalidaError).toBe("function");
    expect(() => resumirCambios(o as FilaReemplazo[], v as FilaReemplazo[])).toThrow(EntradaPrevalidacionInvalidaError);
  };

  it("un id del original que falta en el vigente", () => {
    lanza([A, B], [A]);
  });

  it("una agregada con un id que ya está en el original", () => {
    lanza([A], [{ ...A, estado: "agregada" }]);
  });

  it("ids repetidos en el original o en el vigente", () => {
    lanza([A, { ...B, id: "a1" }], [A, B]);
    lanza([A], [A, { ...A, estado: "agregada", id: "x9" }, { ...B, id: "x9", estado: "agregada" }]);
  });

  it("filas que no son arreglo, o con forma imposible (montos falsos, estado desconocido)", () => {
    lanza(null, []);
    lanza([], undefined);
    lanza([{ ...A, montos: { total: "118.00" } }], [A]);
    lanza([A], [{ ...A, estado: "borrada" }]);
  });
});

describe("CA-8 · propiedad con oráculo en centavos enteros (filas PEN)", () => {
  type Cent = [number, number, number]; // IGV DG, DGNG, DNG en centavos
  const arbCent = fc.tuple(
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
  ) as fc.Arbitrary<Cent>;
  const filaCent = (id: string, c: Cent, estado: FilaReemplazo["estado"]): FilaReemplazo => {
    const columnas = { igvDg: centavosAString(c[0]), igvDgng: centavosAString(c[1]), igvDng: centavosAString(c[2]) };
    return fila(id, columnas, { estado });
  };
  const suma = (l: Cent[]): Cent => l.reduce<Cent>((s, c) => [s[0] + c[0], s[1] + c[1], s[2] + c[2]], [0, 0, 0]);

  it("conteos e impacto coinciden con el cálculo en enteros", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(arbCent, fc.constantFrom("igual", "cambia", "excluye"), arbCent), { minLength: 1, maxLength: 6 }),
        fc.array(arbCent, { maxLength: 3 }),
        (planes, nuevas) => {
          const original = planes.map(([c], i) => filaCent(`o${i}`, c, "original"));
          const vigente: FilaReemplazo[] = [];
          const vig: Cent[] = [];
          let modificadas = 0;
          let excluidas = 0;
          planes.forEach(([c, accion, nuevo], i) => {
            if (accion === "igual") {
              vigente.push(filaCent(`o${i}`, c, "original"));
              vig.push(c);
            } else if (accion === "cambia") {
              vigente.push(filaCent(`o${i}`, nuevo, "modificada"));
              vig.push(nuevo);
              if (nuevo.some((x, k) => x !== c[k])) modificadas++;
            } else {
              vigente.push(filaCent(`o${i}`, nuevo, "excluida"));
              excluidas++;
            }
          });
          nuevas.forEach((c, i) => {
            vigente.push(filaCent(`n${i}`, c, "agregada"));
            vig.push(c);
          });
          const r = resumirCambios(original, vigente);
          const o = suma(planes.map(([c]) => c));
          const v = suma(vig);
          const esperado = [v[0] - o[0], v[1] - o[1], v[2] - o[2]];
          expect(r.modificadas).toBe(modificadas);
          expect(r.excluidas).toBe(excluidas);
          expect(r.agregadas).toBe(nuevas.length);
          expect(impacto(r)).toEqual({
            DG: centavosAString(esperado[0]!),
            DGNG: centavosAString(esperado[1]!),
            DNG: centavosAString(esperado[2]!),
            total: centavosAString(esperado[0]! + esperado[1]! + esperado[2]!),
          });
        },
      ),
      { seed: SEMILLA, numRuns: NUM_RUNS },
    );
  });
});
