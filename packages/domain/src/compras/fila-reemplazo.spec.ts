// Spec 014 · T1 (rojo). Mapeo de una compra a FilaReemplazo de 012 (D-10, nota [012b]; CA-14).
// Contrato fijado por estas pruebas (plan 014, Contratos: Dominio), en packages/domain/src/compras/fila-reemplazo.ts,
// exportado por compras/index.ts:
//   interface CompraParaReemplazo {
//     id: string;                                   // id de la compra; pasa tal cual a FilaReemplazo.id
//     origen: "sire" | "agregada";
//     comprobante: IdComprobante;                   // { tipo, serie, numero }
//     proveedor: { tipo: string; numero: string; razonSocial: string | null };
//     fechaEmision: string;                         // AAAA-MM-DD
//     tipoCambio: string | null;                    // lo guardado en la compra
//     version: number;                              // n de la versión que se mapea (1 = tal como vino)
//     excluida: boolean;
//     montos: MontosComprobante;                    // los de esa versión
//   }
//   aFilaReemplazo(compra: CompraParaReemplazo): FilaReemplazo
// Reglas: estado = "excluida" si excluida; si no "agregada" si origen = agregada (aunque tenga más de una
// versión); si no "modificada" si version > 1; si no "original". `tipoCambio` es null en las filas PEN (aunque
// la compra guarde uno) y el guardado en las USD. `origenUsd` siempre null (la forma provisional de 009 no trae
// montos en soles) y no hay `xml`. `razonSocial` solo si es un texto (null → ausente). No lanza por el estado.
import { describe, expect, it } from "vitest";
import { prevalidar, resumirCambios } from "../prevalidacion/index";
import type { FilaReemplazo } from "../prevalidacion/index";
import { DICCIONARIO_GLOSAS_BASE } from "../texto/index";
import type { ContextoReglas } from "../reglas/index";
import { montosDe } from "../../tests/ayudas/filas";
import type { Columnas } from "../../tests/ayudas/filas";
import { CABECERA, filasFixture, filasFixtureCorregidas } from "../../tests/ayudas/filas-reemplazo";
import { aFilaReemplazo } from "./index";
import type { CompraParaReemplazo } from "./index";

const compra = (over: Partial<CompraParaReemplazo> = {}, columnas: Columnas = { biDg: "100.00", igvDg: "18.00" }): CompraParaReemplazo => ({
  id: "c1",
  origen: "sire",
  comprobante: { tipo: "01", serie: "F001", numero: "123" },
  proveedor: { tipo: "6", numero: "20100070970", razonSocial: "PROVEEDOR SAC" },
  fechaEmision: "2026-10-05",
  tipoCambio: null,
  version: 1,
  excluida: false,
  montos: montosDe("PEN", columnas),
  ...over,
});

describe("aFilaReemplazo: estado (D-10)", () => {
  it("versión 1 del SIRE: original", () => {
    expect(aFilaReemplazo(compra()).estado).toBe("original");
  });

  it("versión mayor que 1: modificada, aunque los montos no hayan cambiado", () => {
    expect(aFilaReemplazo(compra({ version: 2 })).estado).toBe("modificada");
    expect(aFilaReemplazo(compra({ version: 7 })).estado).toBe("modificada");
  });

  it("excluida: excluida, sea cual sea la versión", () => {
    expect(aFilaReemplazo(compra({ excluida: true, version: 2 })).estado).toBe("excluida");
    expect(aFilaReemplazo(compra({ excluida: true, version: 1 })).estado).toBe("excluida");
  });

  it("origen agregada: agregada, también si se editó después (versión > 1)", () => {
    expect(aFilaReemplazo(compra({ origen: "agregada" })).estado).toBe("agregada");
    expect(aFilaReemplazo(compra({ origen: "agregada", version: 3 })).estado).toBe("agregada");
  });
});

describe("aFilaReemplazo: campos", () => {
  it("copia id, comprobante, proveedor, fecha y montos", () => {
    const c = compra();
    const f = aFilaReemplazo(c);
    expect(f.id).toBe("c1");
    expect(f.comprobante).toEqual({ tipo: "01", serie: "F001", numero: "123" });
    expect(f.proveedor).toEqual({ tipo: "6", numero: "20100070970", razonSocial: "PROVEEDOR SAC" });
    expect(f.fechaEmision).toBe("2026-10-05");
    expect(f.montos.toJSON()).toEqual(c.montos.toJSON());
  });

  it("razón social null: la propiedad queda ausente (no «null» ni «»)", () => {
    const f = aFilaReemplazo(compra({ proveedor: { tipo: "6", numero: "20100070970", razonSocial: null } }));
    expect(f.proveedor.razonSocial).toBeUndefined();
    expect(f.proveedor).toEqual({ tipo: "6", numero: "20100070970" });
  });

  it("PEN: tipoCambio null", () => {
    expect(aFilaReemplazo(compra()).tipoCambio).toBeNull();
  });

  it("PEN con un tipo de cambio guardado: igual null (la prevalidación lo rechazaría en PEN)", () => {
    expect(aFilaReemplazo(compra({ tipoCambio: "3.300" })).tipoCambio).toBeNull();
  });

  it("USD: pasa en USD con su tipo de cambio, sin origenUsd", () => {
    const f = aFilaReemplazo(compra({ tipoCambio: "3.300", montos: montosDe("USD", { biDg: "0.15", igvDg: "0.03" }) }));
    expect(f.montos.moneda).toBe("USD");
    expect(f.tipoCambio).toBe("3.300");
    expect(f.origenUsd).toBeNull();
  });

  it("nunca trae xml", () => {
    expect(aFilaReemplazo(compra()).xml).toBeUndefined();
  });

  it("no muta la compra recibida", () => {
    const c = Object.freeze(compra());
    expect(() => aFilaReemplazo(c)).not.toThrow();
  });
});

describe("integración con 012 (CA-14): fixture 009 sin corregir y corregido", () => {
  const REGLAS: ContextoReglas = {
    proveedoresConocidos: filasFixture().map((f) => ({ tipo: f.proveedor.tipo, numero: f.proveedor.numero })),
    proveedoresIsc: [],
    diccionario: DICCIONARIO_GLOSAS_BASE,
  };
  const desdeFixture = (f: FilaReemplazo, over: Partial<CompraParaReemplazo> = {}): CompraParaReemplazo => ({
    id: f.id,
    origen: "sire",
    comprobante: { ...f.comprobante },
    proveedor: { tipo: f.proveedor.tipo, numero: f.proveedor.numero, razonSocial: null },
    fechaEmision: f.fechaEmision,
    tipoCambio: f.tipoCambio,
    version: 1,
    excluida: false,
    montos: f.montos,
    ...over,
  });
  const original = filasFixture().map((f) => aFilaReemplazo(desdeFixture(f)));
  const corregidas = filasFixtureCorregidas();
  const vigente = filasFixture().map((f, i) => {
    const c = corregidas[i] as FilaReemplazo;
    return aFilaReemplazo(desdeFixture(f, c.estado === "modificada" ? { version: 2, montos: c.montos } : {}));
  });

  it("las cinco filas del original coinciden con las de 012 (mismo id, estado, TC y montos)", () => {
    const esperadas = filasFixture();
    expect(original).toHaveLength(5);
    original.forEach((f, i) => {
      const e = esperadas[i] as FilaReemplazo;
      expect([f.id, f.estado, f.tipoCambio, f.origenUsd]).toEqual([e.id, e.estado, e.tipoCambio, e.origenUsd]);
      expect(f.montos.toJSON()).toEqual(e.montos.toJSON());
    });
  });

  it("las filas PEN llevan tipoCambio null y la USD (F001-4062) lleva 3.300", () => {
    expect(original.filter((f) => f.montos.moneda === "PEN").every((f) => f.tipoCambio === null)).toBe(true);
    expect(original.find((f) => f.id === "F001-4062")?.tipoCambio).toBe("3.300");
  });

  it("sin corregir: prevalidar no es apto y el error de IGV es el de F001-2056", () => {
    const r = prevalidar(original, { cabecera: CABECERA, reglas: REGLAS });
    expect(r.apto).toBe(false);
    expect(r.errores.map((e) => [e.filaId, e.codigo])).toEqual([["F001-2056", "IGV"]]);
  });

  it("corregido (San Juan con ISC, mixta separada): apto, sin errores", () => {
    const r = prevalidar(vigente, { cabecera: CABECERA, reglas: REGLAS });
    expect(r.apto).toBe(true);
    expect(r.errores).toEqual([]);
  });

  it("las dos filas corregidas salen «modificada»; resumirCambios cuenta 2 modificadas, 0 excluidas y 0 agregadas", () => {
    expect(vigente.filter((f) => f.estado === "modificada").map((f) => f.id)).toEqual(["F001-1040", "F001-2056"]);
    const r = resumirCambios(original, vigente);
    expect([r.modificadas, r.excluidas, r.agregadas]).toEqual([2, 0, 0]);
    expect(r.filasSinConvertir).toEqual([]);
  });

  it("excluir una fila y agregar otra se refleja en el resumen de 012", () => {
    const sinSimple = filasFixture().map((f, i) => {
      const c = corregidas[i] as FilaReemplazo;
      const base = c.estado === "modificada" ? { version: 2, montos: c.montos } : {};
      return aFilaReemplazo(desdeFixture(f, f.id === "F001-5070" ? { version: 2, excluida: true } : base));
    });
    const nueva = aFilaReemplazo(
      desdeFixture(filasFixture()[4] as FilaReemplazo, {
        id: "nueva-1",
        origen: "agregada",
        comprobante: { tipo: "01", serie: "F001", numero: "9999" },
      }),
    );
    const r = resumirCambios(original, [...sinSimple, nueva]);
    expect([r.modificadas, r.excluidas, r.agregadas]).toEqual([2, 1, 1]);
  });
});
