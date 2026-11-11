// Spec 012b (T1, rojo): adaptadores de fila y D7 (plan, Contratos: Dominio; CA-11). Contrato que fija la prueba (T7):
//  - `compraLeidaAFila(c) → { fila, avisos }`: `c` es la compra tal como la entrega `packages/db` (cadenas). La fila es la de
//    `aFilaReemplazo` de 014 (estado, montos `MontosComprobante`, `tipoCambio` null en PEN, `origenUsd` null).
//  - D7: una razón social de más de 100 puntos de código se recorta a 100 (sin partir un par sustituto) y da UN aviso
//    `RAZON_SOCIAL_RECORTADA { filaId: c.id }`; con 100 o menos no cambia ni avisa. Lo que quede inválido para el TXT
//    sigue siendo error de `prevalidar` (012 D13): el adaptador no limpia caracteres.
//  - `ventaAFila(v) → FilaReemplazoVenta`: `excluida` → «excluida»; `manual` → «agregada»; `sire` → «original»; la
//    contraparte sin tipo si `tipoDocContraparte` viene vacío; montos `Money` en la moneda de la venta; PEN → `tipoCambio` null.
import { describe, expect, it } from "vitest";
import { compraLeidaAFila, generarTxt, prevalidar, ventaAFila } from "../index";
import type { CompraLeidaPlana } from "../index";
import { CABECERA, lineasCrlf } from "../../tests/ayudas/filas-reemplazo";
import { CABECERA_VENTAS, bienFormado, compraLeida, ventaLeida } from "../../tests/ayudas/filas-venta";

const conRazon = (razonSocial: string | null): CompraLeidaPlana => compraLeida({ razonSocial });
const puntos = (s: string): string[] => Array.from(s);

describe("compraLeidaAFila · mapeo", () => {
  it("una compra del SIRE en su versión 1 es `original` con id, comprobante, proveedor, fecha y montos Money", () => {
    const { fila, avisos } = compraLeidaAFila(compraLeida());
    expect(avisos).toEqual([]);
    expect(fila.id).toBe("c1");
    expect(fila.estado).toBe("original");
    expect(fila.comprobante).toEqual({ tipo: "01", serie: "F001", numero: "123" });
    expect(fila.proveedor).toEqual({ tipo: "6", numero: "20100070970", razonSocial: "PROVEEDOR DE PRUEBA SAC" });
    expect(fila.fechaEmision).toBe("2026-10-05");
    expect(fila.montos.moneda).toBe("PEN");
    expect(fila.montos.obtener("biDg").toString()).toBe("100.00");
    expect(fila.montos.obtener("igvDg").toString()).toBe("18.00");
    expect(fila.montos.total.toString()).toBe("118.00");
    expect(fila.tipoCambio).toBeNull();
    expect(fila.origenUsd).toBeNull();
  });

  it("el estado sale de excluida, origen y versión (como aFilaReemplazo de 014)", () => {
    const estado = (o: Partial<CompraLeidaPlana>) => compraLeidaAFila(compraLeida(o)).fila.estado;
    expect(estado({ version: 2 })).toBe("modificada");
    expect(estado({ origen: "agregada", version: 1 })).toBe("agregada");
    expect(estado({ origen: "agregada", version: 3 })).toBe("agregada");
    expect(estado({ excluida: true })).toBe("excluida");
    expect(estado({ excluida: true, version: 2 })).toBe("excluida");
  });

  it("una compra USD lleva su tipo de cambio; en PEN va null aunque llegue un texto", () => {
    const usd = compraLeidaAFila(compraLeida({ moneda: "USD", tipoCambio: "3.300" })).fila;
    expect(usd.montos.moneda).toBe("USD");
    expect(usd.tipoCambio).toBe("3.300");
    expect(compraLeidaAFila(compraLeida({ moneda: "PEN", tipoCambio: "3.300" })).fila.tipoCambio).toBeNull();
  });

  it("sin razón social la fila no la lleva, sin aviso", () => {
    const { fila, avisos } = compraLeidaAFila(conRazon(null));
    expect(fila.proveedor).toEqual({ tipo: "6", numero: "20100070970" });
    expect(avisos).toEqual([]);
  });

  it("no muta la compra recibida", () => {
    const c = compraLeida({ razonSocial: "X".repeat(150) });
    const copia = JSON.stringify(c);
    compraLeidaAFila(c);
    expect(JSON.stringify(c)).toBe(copia);
  });
});

describe("compraLeidaAFila · D7 razón social de más de 100 caracteres (CA-11)", () => {
  it("100 exactos no cambia y no avisa", () => {
    const r = "A".repeat(100);
    const { fila, avisos } = compraLeidaAFila(conRazon(r));
    expect(fila.proveedor.razonSocial).toBe(r);
    expect(avisos).toEqual([]);
  });

  it("101 sale con 100 y el aviso RAZON_SOCIAL_RECORTADA con el id de la fila", () => {
    const { fila, avisos } = compraLeidaAFila(conRazon("A".repeat(100) + "B"));
    expect(fila.proveedor.razonSocial).toBe("A".repeat(100));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ codigo: "RAZON_SOCIAL_RECORTADA", filaId: "c1" });
    expect(typeof avisos[0]?.explicacion).toBe("string");
  });

  it("muy larga (10.000) también se recorta a 100", () => {
    const { fila, avisos } = compraLeidaAFila(conRazon("Ñ".repeat(10_000)));
    expect(puntos(fila.proveedor.razonSocial ?? "")).toHaveLength(100);
    expect(avisos.map((a) => a.codigo)).toEqual(["RAZON_SOCIAL_RECORTADA"]);
  });

  it("emoji en la posición 100: se cuenta por puntos de código, no se parte el par sustituto y queda bien formada", () => {
    const original = "A".repeat(99) + "😀" + "B".repeat(5);
    const { fila, avisos } = compraLeidaAFila(conRazon(original));
    const r = fila.proveedor.razonSocial ?? "";
    expect(bienFormado(r)).toBe(true);
    expect(puntos(r)).toHaveLength(100);
    expect(r).toBe("A".repeat(99) + "😀");
    expect(avisos.map((a) => a.codigo)).toEqual(["RAZON_SOCIAL_RECORTADA"]);
  });

  it("emoji en la posición 101: queda fuera del recorte y la razón queda válida para el TXT", () => {
    const original = "A".repeat(100) + "😀";
    const { fila, avisos } = compraLeidaAFila(conRazon(original));
    expect(fila.proveedor.razonSocial).toBe("A".repeat(100));
    expect(avisos).toHaveLength(1);
    expect(prevalidar([fila], { cabecera: CABECERA }).errores).toEqual([]);
  });

  it("exactamente 100 puntos de código con emojis (200 unidades UTF-16) no se recorta", () => {
    const r = "😀".repeat(100);
    const { fila, avisos } = compraLeidaAFila(conRazon(r));
    expect(fila.proveedor.razonSocial).toBe(r);
    expect(avisos).toEqual([]);
  });

  it("un `|` o un NBSP justo pasado el límite (posición 101) se pierde en el recorte: la fila queda apta y el TXT genera", () => {
    for (const c of ["|", " "]) {
      const { fila, avisos } = compraLeidaAFila(conRazon("A".repeat(100) + c + "B"));
      expect(fila.proveedor.razonSocial).toBe("A".repeat(100));
      expect(avisos.map((a) => a.codigo)).toEqual(["RAZON_SOCIAL_RECORTADA"]);
      expect(prevalidar([fila], { cabecera: CABECERA }).apto).toBe(true);
      const txt = generarTxt([fila], CABECERA, { permitirProvisional: true });
      expect(lineasCrlf(txt.bytes)[0]?.split("|")).toHaveLength(21);
    }
  });

  it("un `|` o un NBSP en la posición 100 se conserva: sigue siendo CARACTER_NO_PERMITIDO en razonSocial (el adaptador no limpia)", () => {
    for (const c of ["|", " "]) {
      const { fila } = compraLeidaAFila(conRazon("A".repeat(99) + c + "B"));
      expect(fila.proveedor.razonSocial).toBe("A".repeat(99) + c);
      const errores = prevalidar([fila], { cabecera: CABECERA }).errores;
      expect(errores).toHaveLength(1);
      expect(errores[0]).toMatchObject({ filaId: "c1", codigo: "CARACTER_NO_PERMITIDO", campo: "razonSocial" });
    }
  });

  it("antes del recorte la razón de 101 con `|` en la posición 5 sigue siendo error: no se arregla lo que no está en el borde", () => {
    const { fila } = compraLeidaAFila(conRazon("ABCD|" + "A".repeat(96)));
    expect(prevalidar([fila], { cabecera: CABECERA }).errores.map((e) => e.codigo)).toEqual(["CARACTER_NO_PERMITIDO"]);
  });
});

describe("ventaAFila · mapeo", () => {
  it("una venta del SIRE sin exclusión es `original`; manual, `agregada`; excluida, `excluida`", () => {
    expect(ventaAFila(ventaLeida()).estado).toBe("original");
    expect(ventaAFila(ventaLeida({ origen: "manual" })).estado).toBe("agregada");
    expect(ventaAFila(ventaLeida({ excluida: true })).estado).toBe("excluida");
  });

  it("copia id, comprobante, fecha y montos como Money; el consumidor final no lleva tipo de documento", () => {
    const f = ventaAFila(ventaLeida());
    expect(f.id).toBe("v1");
    expect(f.comprobante).toEqual({ tipo: "03", serie: "B001", numero: "290" });
    expect(f.fechaEmision).toBe("2026-10-03");
    expect(f.contraparte).toEqual({ numero: "-" });
    expect(f.tipoCambio).toBeNull();
    for (const c of ["baseGravada", "igv", "exonerada", "inafecta", "isc", "icbper", "otros", "total"] as const) {
      expect(f.montos[c].moneda, c).toBe("PEN");
    }
    expect(f.montos.total.toString()).toBe("118.00");
    expect(f.montos.igv.toString()).toBe("18.00");
  });

  it("con documento, la contraparte lleva su tipo", () => {
    const f = ventaAFila(ventaLeida({ tipoDocContraparte: "6", docContraparte: "20700000011" }));
    expect(f.contraparte).toEqual({ tipo: "6", numero: "20700000011" });
  });

  it("una venta USD conserva el tipo de cambio y sus montos en USD; en PEN va null", () => {
    const usd = ventaAFila(ventaLeida({ moneda: "USD", tipoCambio: "3.300" }));
    expect(usd.tipoCambio).toBe("3.300");
    expect(usd.montos.total.moneda).toBe("USD");
    expect(ventaAFila(ventaLeida({ moneda: "PEN", tipoCambio: "3.300" })).tipoCambio).toBeNull();
  });

  it("negativos de una nota de crédito pasan tal cual", () => {
    const f = ventaAFila(ventaLeida({ tipo: "07", baseGravada: "-50.00", igv: "-9.00", total: "-59.00" }));
    expect(f.montos.total.toString()).toBe("-59.00");
  });

  it("la fila mapeada pasa por prevalidar de ventas: una cuadrada es apta, una descuadrada trae CUADRE con su id", () => {
    const ok = ventaAFila(ventaLeida());
    expect(prevalidar([ok], { cabecera: CABECERA_VENTAS }).apto).toBe(true);
    const mala = ventaAFila(ventaLeida({ id: "v2", numero: "291", total: "120.00" }));
    const r = prevalidar([mala], { cabecera: CABECERA_VENTAS });
    expect(r.errores.map((e) => [e.filaId, e.codigo])).toEqual([["v2", "CUADRE"]]);
  });

  it("no muta la venta recibida", () => {
    const v = ventaLeida();
    const copia = JSON.stringify(v);
    ventaAFila(v);
    expect(JSON.stringify(v)).toBe(copia);
  });
});
