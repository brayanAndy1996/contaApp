// Spec 012b (T1, rojo): `resumirCambios` con ventas (D12, RF-102; CA-5, CA-15). Contrato que fija la prueba (T7):
//  - `resumirCambios(original, vigente, cabecera)` con `cabecera.libro = "ventas"` y `FilaReemplazoVenta[]` devuelve
//    `ResumenCambiosVentas { modificadas: 0, excluidas, agregadas, impactoIgv: { total }, filasSinConvertir }` (solo `total`).
//  - Cuenta por el `estado` de la fila vigente (`excluida`, `agregada`); `modificadas` es siempre 0 (ventas no se edita).
//  - impactoIgv.total = Σ IGV de las vigentes no excluidas − Σ IGV de las originales, en PEN. Una excluida resta su IGV
//    (el de la descuadrada cuenta; la USD sin tipo de cambio va a `filasSinConvertir`). Las USD se convierten por
//    columna con `redondearSunat(columna × tc)` (010 D7), como `resumirVentas` (013).
//  - Sin el tercer argumento se resumen compras: filas de ventas ahí, o de compras con la cabecera de ventas, lanzan.
import { describe, expect, it } from "vitest";
import { EntradaPrevalidacionInvalidaError, resumirCambios } from "../index";
import type { FilaReemplazoVenta, ResumenCambiosVentas } from "../index";
import { filaReemplazo } from "../../tests/ayudas/filas-reemplazo";
import { CABECERA_VENTAS, comoExcluida, filaVenta, ventaNum } from "../../tests/ayudas/filas-venta";

const resumir = (o: FilaReemplazoVenta[], v: FilaReemplazoVenta[]): ResumenCambiosVentas => resumirCambios(o, v, CABECERA_VENTAS);
const venta = (n: number, igv = "18.00", base = "100.00", over: Parameters<typeof ventaNum>[3] = {}) =>
  ventaNum("01", "F001", String(n), { montos: { baseGravada: base, igv }, ...over });

describe("resumirCambios de ventas · conteos", () => {
  const A = venta(1);
  const B = venta(2, "36.00", "200.00");
  const C = venta(3, "9.00", "50.00");

  it("sin cambios todo es cero y el impacto es 0.00", () => {
    const r = resumir([A, B, C], [A, B, C]);
    expect([r.modificadas, r.excluidas, r.agregadas]).toEqual([0, 0, 0]);
    expect(r.impactoIgv.total.toString()).toBe("0.00");
    expect(r.filasSinConvertir).toEqual([]);
  });

  it("listas vacías dan ceros", () => {
    const r = resumir([], []);
    expect([r.modificadas, r.excluidas, r.agregadas]).toEqual([0, 0, 0]);
    expect(r.impactoIgv.total.toString()).toBe("0.00");
    expect(Object.keys(r.impactoIgv)).toEqual(["total"]);
  });

  it("agregadas a mano: cuenta K y suma su IGV; no hay modificadas", () => {
    const e = venta(4, "1.80", "10.00", { estado: "agregada" });
    const f = venta(5, "0.90", "5.00", { estado: "agregada" });
    const r = resumir([A, B, C], [A, B, C, e, f]);
    expect(r.agregadas).toBe(2);
    expect(r.modificadas).toBe(0);
    expect(r.excluidas).toBe(0);
    expect(r.impactoIgv.total.toString()).toBe("2.70");
  });

  it("excluidas: cuenta M y resta su IGV del impacto", () => {
    const r = resumir([A, B, C], [A, comoExcluida(B), C]);
    expect(r.excluidas).toBe(1);
    expect(r.impactoIgv.total.toString()).toBe("-36.00");
  });

  it("el resultado tiene solo las claves del contrato y el impacto solo `total`", () => {
    const r = resumir([A], [A]);
    expect(Object.keys(r).sort()).toEqual(["agregadas", "excluidas", "filasSinConvertir", "impactoIgv", "modificadas"]);
    expect(Object.keys(r.impactoIgv)).toEqual(["total"]);
  });

  it("no cambia el orden de entrada", () => {
    const e = venta(4, "1.80", "10.00", { estado: "agregada" });
    const a = resumir([A, B, C], [A, comoExcluida(B), C, e]);
    const b = resumir([C, B, A], [e, C, comoExcluida(B), A]);
    expect(b.impactoIgv.total.toString()).toBe(a.impactoIgv.total.toString());
    expect([b.excluidas, b.agregadas]).toEqual([a.excluidas, a.agregadas]);
  });
});

describe("resumirCambios de ventas · CA-15: la descuadrada y la USD sin tipo de cambio excluidas", () => {
  const ok = venta(1);
  const descuadrada = ventaNum("01", "F001", "9", { id: "v-desc", montos: { baseGravada: "100.00", igv: "18.00", total: "120.00" } });
  const usdSinTc = ventaNum("01", "F002", "2", { id: "v-usd", moneda: "USD", montos: { baseGravada: "100.00", igv: "18.00" } });
  const original = [ok, descuadrada, usdSinTc];

  it("excluidas = 2; el impacto resta el IGV de la descuadrada (18.00) y la USD queda en filasSinConvertir", () => {
    const r = resumir(original, [ok, comoExcluida(descuadrada), comoExcluida(usdSinTc)]);
    expect(r.excluidas).toBe(2);
    expect(r.impactoIgv.total.toString()).toBe("-18.00");
    expect(r.filasSinConvertir).toEqual(["v-usd"]);
  });

  it("sin excluir, la USD sin tipo de cambio también va a filasSinConvertir (no suma en ningún lado) y el impacto es 0.00", () => {
    const r = resumir(original, original);
    expect(r.filasSinConvertir).toEqual(["v-usd"]);
    expect(r.impactoIgv.total.toString()).toBe("0.00");
    expect(r.excluidas).toBe(0);
  });

  it("restaurar la descuadrada (vuelve a su estado) quita su efecto: excluidas = 1 y el impacto, 0.00", () => {
    const r = resumir(original, [ok, descuadrada, comoExcluida(usdSinTc)]);
    expect(r.excluidas).toBe(1);
    expect(r.impactoIgv.total.toString()).toBe("0.00");
  });
});

describe("resumirCambios de ventas · USD convertidas (010 D7)", () => {
  const usd = (n: number, igv: string, tc: string | null, over: Parameters<typeof ventaNum>[3] = {}) =>
    ventaNum("01", "F002", String(n), { moneda: "USD", tipoCambio: tc, montos: { baseGravada: "200.00", igv }, ...over });

  it("una agregada USD de IGV 36.00 con TC 3.300 suma 118.80 en soles; junto a una PEN de 9.00, 127.80", () => {
    const r = resumir([], [usd(1, "36.00", "3.300", { estado: "agregada" }), venta(2, "9.00", "50.00", { estado: "agregada" })]);
    expect(r.impactoIgv.total.toString()).toBe("127.80");
    expect(r.filasSinConvertir).toEqual([]);
  });

  it("redondeo: IGV USD 0.03 × 3.300 = 0.099 se redondea a 0.10 (sintético, como 012 CA-4)", () => {
    const r = resumir([], [usd(1, "0.03", "3.300", { estado: "agregada", montos: { baseGravada: "0.15", igv: "0.03" } })]);
    expect(r.impactoIgv.total.toString()).toBe("0.10");
  });

  it("una USD sin tipo de cambio no suma y su id va a filasSinConvertir, sin repetirse, en orden", () => {
    const r = resumir([], [usd(3, "36.00", null, { estado: "agregada" }), usd(2, "36.00", null, { estado: "agregada" })]);
    expect(r.impactoIgv.total.toString()).toBe("0.00");
    expect(r.filasSinConvertir).toEqual(["01-F002-2", "01-F002-3"]);
  });

  it("una excluida USD con tipo de cambio resta su IGV convertido", () => {
    const u = usd(1, "36.00", "3.300");
    const r = resumir([u], [comoExcluida(u)]);
    expect(r.impactoIgv.total.toString()).toBe("-118.80");
  });
});

describe("resumirCambios de ventas · forma imposible lanza", () => {
  const A = venta(1);

  it("una original que no está `original`, un id original ausente en la vigente o una agregada con id original lanzan", () => {
    expect(resumir([A], [A]).agregadas).toBe(0);
    expect(() => resumir([comoExcluida(A)], [A])).toThrow(EntradaPrevalidacionInvalidaError);
    expect(() => resumir([A], [])).toThrow(EntradaPrevalidacionInvalidaError);
    expect(() => resumir([A], [{ ...A, estado: "agregada" }])).toThrow(EntradaPrevalidacionInvalidaError);
    expect(() => resumir([], [{ ...A, estado: "original" }])).toThrow(EntradaPrevalidacionInvalidaError);
  });

  it("un impacto que excede NUMERIC(14,2) lanza (no un error de dinero)", () => {
    expect(resumir([A], [A]).agregadas).toBe(0);
    const grande = (n: number) => venta(n, "600000000000.00", "1.00", { estado: "agregada", montos: { baseGravada: "1.00", igv: "600000000000.00" } });
    expect(() => resumir([], [grande(1), grande(2)])).toThrow(EntradaPrevalidacionInvalidaError);
  });

  it("filas de ventas sin la cabecera (se resumen como compras) o filas de compras con la cabecera de ventas lanzan", () => {
    expect(resumir([A], [A]).agregadas).toBe(0);
    expect(() => resumirCambios([A] as never, [A] as never)).toThrow(EntradaPrevalidacionInvalidaError);
    expect(() => resumirCambios([filaReemplazo()] as never, [filaReemplazo()] as never, CABECERA_VENTAS)).toThrow(
      EntradaPrevalidacionInvalidaError,
    );
  });

  it("no se pueden mezclar libros entre original y vigente", () => {
    expect(resumir([A], [A]).agregadas).toBe(0);
    expect(() => resumirCambios([A], [filaReemplazo(undefined, { id: A.id })] as never, CABECERA_VENTAS)).toThrow(EntradaPrevalidacionInvalidaError);
  });
});

describe("resumirCambios de ventas · no valida", () => {
  it("una fila descuadrada no lanza: el resumen cuenta, no valida", () => {
    const desc = filaVenta({ montos: { baseGravada: "100.00", igv: "18.00", total: "120.00" } });
    expect(resumir([desc], [desc]).impactoIgv.total.toString()).toBe("0.00");
  });
});
