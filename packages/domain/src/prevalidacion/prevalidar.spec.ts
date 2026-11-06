// Spec 012 (T4, rojo): prevalidar de punta a punta (D1, D3, D4, D11, D13, D16, D17; CA-1 a CA-7).
// Contrato fijado por la prueba:
//  - `prevalidar(filas, { cabecera, reglas?, registro? })` devuelve un resultado congelado
//    `{ apto, errores, avisos, formato }` con `apto <=> errores = []`.
//  - Errores y avisos salen ordenados por fila (unidades de código UTF-16, no por locale), código y campo.
//  - Una forma imposible lanza EntradaPrevalidacionInvalidaError (codigo ENTRADA_INVALIDA, mensaje fijo).
//  - Un periodo anterior a toda versión propaga FormatoNoVigenteError.
//  - Cada campo de la entrada se lee una sola vez (contra getters y mutación posterior).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  EntradaPrevalidacionInvalidaError,
  FormatoNoVigenteError,
  RegistroFormatos,
  prevalidar,
  seleccionarFormato,
} from "../index";
import type { ErrorPrevalidacion, FilaReemplazo, ResultadoPrevalidacion } from "../index";
import { NUM_RUNS, SEMILLA } from "../../tests/ayudas/comprobante";
import { DICCIONARIO_GLOSAS_BASE, MontosComprobante } from "../index";
import {
  CABECERA,
  ctxBase,
  filaReemplazo,
  filaSanJuan,
  filasFixture,
  xmlDe,
} from "../../tests/ayudas/filas-reemplazo";

const prev = (filas: readonly FilaReemplazo[], extra: Record<string, unknown> = {}): ResultadoPrevalidacion =>
  prevalidar(filas, { cabecera: CABECERA, ...extra } as Parameters<typeof prevalidar>[1]);
const mala = (id: string, over: Partial<FilaReemplazo> = {}): FilaReemplazo =>
  filaReemplazo({ biDg: "100.00", igvDg: "20.00" }, { id, comprobante: { tipo: "01", serie: "F001", numero: id }, ...over });
const buena = (id: string): FilaReemplazo =>
  filaReemplazo(undefined, { id, comprobante: { tipo: "01", serie: "F001", numero: id.replace(/\D/g, "") || "1" } });

describe("forma del resultado", () => {
  it("está congelado (resultado, errores, avisos y cada error) y apto <=> sin errores", () => {
    const r = prev([mala("1")]);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.errores)).toBe(true);
    expect(Object.isFrozen(r.avisos)).toBe(true);
    expect(r.errores.every((e) => Object.isFrozen(e))).toBe(true);
    expect(r.apto).toBe(false);
    expect(prev([buena("1")]).apto).toBe(true);
  });

  it("cada error tiene exactamente estas claves", () => {
    const [e] = prev([mala("1")]).errores;
    expect(Object.keys(e as object).sort()).toEqual(
      ["campo", "codigo", "destino", "diferencia", "explicacion", "filaId", "sugerencia"].sort(),
    );
  });

  it("es determinista: dos llamadas dan resultados iguales", () => {
    const filas = [mala("2"), buena("1"), mala("3")];
    expect(prev(filas)).toEqual(prev(filas));
  });
});

describe("D17 · SIN_FILAS", () => {
  const sinFilas = (r: ResultadoPrevalidacion) => {
    expect(r.apto).toBe(false);
    expect(r.errores).toEqual([
      expect.objectContaining({
        filaId: null,
        codigo: "SIN_FILAS",
        campo: null,
        destino: null,
        diferencia: null,
        sugerencia: null,
      }),
    ]);
    expect(r.errores[0]?.explicacion.length).toBeGreaterThan(0);
  };

  it("una lista vacía", () => sinFilas(prev([])));
  it("todas las filas excluidas", () => sinFilas(prev([filaReemplazo(undefined, { id: "a", estado: "excluida" }), filaReemplazo(undefined, { id: "b", estado: "excluida", comprobante: { tipo: "01", serie: "F001", numero: "2" } })])));

  it("una excluida y una válida: no hay SIN_FILAS", () => {
    const r = prev([filaReemplazo(undefined, { id: "a", estado: "excluida" }), buena("2")]);
    expect(r.errores).toEqual([]);
    expect(r.apto).toBe(true);
  });

  it("filas no excluidas pero con errores no son SIN_FILAS: se informan sus errores", () => {
    const codigos = prev([mala("1")]).errores.map((e) => e.codigo);
    expect(codigos).toEqual(["IGV"]);
  });
});

describe("las filas excluidas no bloquean (D4, CA-7)", () => {
  it("una excluida con todos los defectos juntos no aporta errores", () => {
    const peor = filaReemplazo({ biDg: "100.00", igvDg: "20.00" }, {
      id: "x",
      estado: "excluida",
      comprobante: { tipo: "01", serie: "F001", numero: "123" },
      proveedor: { tipo: "6", numero: "20100070971", razonSocial: "A|B" },
      fechaEmision: "2030-01-01",
    });
    const r = prev([buena("123"), peor]);
    expect(r.errores).toEqual([]);
    expect(r.avisos).toEqual([]);
    expect(r.apto).toBe(true);
  });

  it("una excluida USD sin TC no bloquea", () => {
    const usd = filaReemplazo(undefined, { id: "u", estado: "excluida", montos: filaReemplazo(undefined, { moneda: "USD" }).montos, comprobante: { tipo: "01", serie: "F002", numero: "9" } });
    expect(prev([buena("1"), usd]).apto).toBe(true);
  });

  it("pero una excluida con forma imposible sigue lanzando (la entrada se valida completa)", () => {
    const f = { ...filaReemplazo(undefined, { id: "x", estado: "excluida" }), comprobante: { tipo: "01", serie: 123, numero: "1" } };
    expect(() => prev([buena("1"), f as unknown as FilaReemplazo])).toThrow(EntradaPrevalidacionInvalidaError);
  });
});

describe("errores frente a excepciones (D3, plan)", () => {
  const lanza = (filas: unknown, extra: Record<string, unknown> = {}) =>
    expect(() => prev(filas as FilaReemplazo[], extra)).toThrow(EntradaPrevalidacionInvalidaError);
  const base = () => filaReemplazo();

  it("filas que no es un arreglo, o con elementos que no son objetos", () => {
    lanza(null);
    lanza({});
    lanza("filas");
    lanza([null]);
    lanza([42]);
    lanza([[]]);
  });

  it("un campo de texto que no es string", () => {
    lanza([{ ...base(), fechaEmision: 20261005 }]);
    lanza([{ ...base(), id: 7 }]);
    lanza([{ ...base(), comprobante: { tipo: "01", serie: 123, numero: "1" } }]);
    lanza([{ ...base(), comprobante: { tipo: "01", serie: "F001", numero: 1 } }]);
    lanza([{ ...base(), proveedor: { tipo: "6", numero: 20100070970 } }]);
    lanza([{ ...base(), proveedor: { tipo: "6", numero: "20100070970", razonSocial: 5 } }]);
    lanza([{ ...base(), tipoCambio: 3.3 }]);
  });

  it("montos falsos: objeto plano, JSON de un MontosComprobante o ausentes", () => {
    lanza([{ ...base(), montos: { moneda: "PEN", total: "118.00", columnas: {} } }]);
    lanza([{ ...base(), montos: JSON.parse(JSON.stringify(base().montos)) }]);
    lanza([{ ...base(), montos: Object.create(Object.getPrototypeOf(base().montos)) }]);
    lanza([{ ...base(), montos: null }]);
    const { montos: _omitido, ...sinMontos } = base();
    void _omitido;
    lanza([sinMontos]);
  });

  it("claves extra o ausentes en la fila, el comprobante o el proveedor", () => {
    lanza([{ ...base(), extra: 1 }]);
    lanza([{ ...base(), comprobante: { tipo: "01", serie: "F001", numero: "1", x: 1 } }]);
    lanza([{ ...base(), proveedor: { tipo: "6", numero: "20100070970", x: 1 } }]);
    lanza([{ ...base(), proveedor: { tipo: "6" } }]);
    const { comprobante: _c, ...sinComprobante } = base();
    void _c;
    lanza([sinComprobante]);
  });

  it("__proto__ como clave propia, en la fila o en el proveedor", () => {
    lanza([JSON.parse(`{"__proto__": {"polluted": true}, "id": "f1"}`)]);
    const conProto = { ...base(), proveedor: JSON.parse(`{"tipo":"6","numero":"20100070970","__proto__":{"x":1}}`) };
    lanza([conProto]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("ids repetidos, vacíos, demasiado largos o con caracteres fuera de [A-Za-z0-9_-]", () => {
    lanza([buena("1"), { ...buena("2"), id: "1" }]);
    lanza([{ ...base(), id: "" }]);
    lanza([{ ...base(), id: "x".repeat(65) }]);
    lanza([{ ...base(), id: "a b" }]);
    lanza([{ ...base(), id: "a\n" }]);
    expect(() => prev([{ ...base(), id: "x".repeat(64) }])).not.toThrow();
  });

  it("estado desconocido o con otra capitalización", () => {
    lanza([{ ...base(), estado: "borrada" }]);
    lanza([{ ...base(), estado: "Original" }]);
    lanza([{ ...base(), estado: undefined }]);
  });

  it("origenUsd en una fila USD, o con una moneda que no corresponde", () => {
    const usd = filaReemplazo(undefined, { moneda: "USD", tipoCambio: "3.300" });
    lanza([{ ...usd, origenUsd: { montos: usd.montos, tipoCambio: "3.300" } }]);
    // origenUsd debe traer montos en USD
    lanza([{ ...base(), origenUsd: { montos: base().montos, tipoCambio: "3.300" } }]);
  });

  it("cabecera mala: no es objeto, clave extra, periodo o RUC que no son string, periodo mal formado", () => {
    const f = [buena("1")];
    const c = (cabecera: unknown) => expect(() => prevalidar(f, { cabecera } as never)).toThrow(EntradaPrevalidacionInvalidaError);
    c(null);
    c({ ...CABECERA, extra: 1 });
    c({ ...CABECERA, periodo: 202610 });
    c({ ...CABECERA, periodo: "2026-10" });
    c({ ...CABECERA, periodo: "202613" });
    c({ ...CABECERA, rucDeclarante: 20700000002 });
    c({ ...CABECERA, libro: undefined });
    c(JSON.parse(`{"__proto__": {"x": 1}, "rucDeclarante": "20700000002", "periodo": "202610", "libro": "compras"}`));
  });

  it("el error tiene código ENTRADA_INVALIDA y un mensaje fijo sin datos de la entrada", () => {
    let e: unknown;
    try {
      prev([{ ...filaReemplazo(), id: "SECRETO-9\n" }] as FilaReemplazo[]);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(EntradaPrevalidacionInvalidaError);
    expect((e as { codigo: string }).codigo).toBe("ENTRADA_INVALIDA");
    expect((e as Error).message).not.toContain("SECRETO");
  });

  it("los datos corregibles NO lanzan: texto, serie, RUC, fecha, montos y TC malos son errores", () => {
    const f = filaReemplazo({ biDg: "100.00", igvDg: "20.00" }, {
      comprobante: { tipo: "01", serie: "f|1", numero: "1" },
      proveedor: { tipo: "6", numero: "20100070971", razonSocial: "A\nB" },
      fechaEmision: "2026-02-30",
      tipoCambio: "no-es-un-tc",
    });
    expect(() => prev([f])).not.toThrow();
    expect(prev([f]).errores.length).toBeGreaterThan(2);
  });
});

describe("formato (D5, CA-9)", () => {
  const provisional = seleccionarFormato("compras", "202610");

  it("un periodo anterior a toda versión propaga FormatoNoVigenteError", () => {
    expect(() => prevalidar([buena("1")], { cabecera: { ...CABECERA, periodo: "202512" } })).toThrow(FormatoNoVigenteError);
  });

  it("usa el registro del contexto y nombra la versión elegida y su marca de oficial", () => {
    const v2 = { ...provisional, version: "2", vigenteDesde: "202701", oficial: true };
    const registro = RegistroFormatos.desde([provisional, v2]);
    const a = prevalidar([buena("1")], { cabecera: { ...CABECERA, periodo: "202610" }, registro });
    expect(a.formato).toEqual({ id: "RCE-REEMPLAZO", version: "0-provisional", oficial: false });
    const b = prevalidar([filaReemplazo(undefined, { fechaEmision: "2027-01-05" })], { cabecera: { ...CABECERA, periodo: "202701" }, registro });
    expect(b.formato).toEqual({ id: "RCE-REEMPLAZO", version: "2", oficial: true });
  });
});

describe("D11 y D16 · qué bloquea y qué no", () => {
  it("el fixture de 009 sin corregir: no apto por IGV de la mixta; San Juan y las otras tres sin errores", () => {
    const r = prev(filasFixture());
    expect(r.apto).toBe(false);
    expect(r.errores.map((e) => [e.filaId, e.codigo])).toEqual([["F001-2056", "IGV"]]);
  });

  it("D16 · no hay forma de forzar: mientras haya un error, apto es false", () => {
    for (const f of [mala("1"), filaReemplazo({ biDg: "100.00", igvDg: "18.00" }, { moneda: "USD", tipoCambio: null })]) {
      const r = prev([buena("9"), f]);
      expect(r.errores.length).toBeGreaterThan(0);
      expect(r.apto).toBe(false);
    }
  });
});

describe("avisos R-ISC, R-NEW y R-GP: no bloquean (D11)", () => {
  const conReglas = (filas: FilaReemplazo[], extra = {}) => prev(filas, { reglas: ctxBase(extra) });

  it("sin reglas no hay avisos", () => {
    expect(prev([filaSanJuan()]).avisos).toEqual([]);
  });

  it("San Juan (BI 770.00, IGV 0.00): aviso R-ISC con su hallazgo (mover 770.00 de biDg a isc) y apto", () => {
    const r = conReglas([filaSanJuan({ proveedor: { tipo: "6", numero: "20700000011" } })], {
      proveedoresConocidos: [{ tipo: "6", numero: "20700000011" }],
    });
    expect(r.apto).toBe(true);
    expect(r.errores).toEqual([]);
    expect(r.avisos).toHaveLength(1);
    const [a] = r.avisos;
    expect(a).toMatchObject({ filaId: "F001-1040", codigo: "R-ISC" });
    expect(Object.keys(a as object).sort()).toEqual(["codigo", "explicacion", "filaId", "hallazgo"]);
    expect(typeof a?.explicacion).toBe("string");
    expect(a?.hallazgo.regla).toBe("R-ISC");
    expect(a?.hallazgo.sugerencia).toMatchObject({ tipo: "mover", origen: "biDg", destino: "isc" });
  });

  it("proveedor desconocido: aviso R-NEW y apto", () => {
    const r = conReglas([buena("1")], { proveedoresConocidos: [] });
    expect(r.apto).toBe(true);
    expect(r.avisos.map((a) => a.codigo)).toEqual(["R-NEW"]);
  });

  it("glosa de gasto personal (zapatilla): aviso R-GP y apto, nunca bloquea", () => {
    const f = filaReemplazo({ biDg: "100.00", igvDg: "18.00" }, {
      xml: xmlDe({ gravado: "100.00", igv: "18.00", total: "118.00", glosas: ["ZAPATILLAS URBANAS T-42"] }),
    });
    const r = conReglas([f]);
    expect(r.apto).toBe(true);
    expect(r.errores).toEqual([]);
    expect(r.avisos.map((a) => a.codigo)).toEqual(["R-GP"]);
    expect(r.avisos[0]?.explicacion.toLowerCase()).toContain("zapatilla");
  });

  it("R-MIX y R-RED nunca salen como avisos: van como sugerencia del error", () => {
    const r = conReglas([filaReemplazo({ biDg: "21.48", igvDg: "1.61" }, { id: "m" }), buena("2")]);
    for (const a of r.avisos) expect(["R-ISC", "R-NEW", "R-GP"]).toContain(a.codigo);
    expect(r.errores.find((e) => e.filaId === "m")?.sugerencia?.regla).toBe("R-MIX");
  });

  it("las reglas no se evalúan en filas con error de estructura y no lanzan por su gramática", () => {
    const f = filaReemplazo(undefined, { comprobante: { tipo: "01", serie: "F0011", numero: "1" } });
    expect(() => conReglas([f], { proveedoresConocidos: [] })).not.toThrow();
    const r = conReglas([f], { proveedoresConocidos: [] });
    expect(r.errores.map((e) => e.codigo)).toContain("LONGITUD");
    expect(r.avisos).toEqual([]);
  });

  it("las reglas no se evalúan en filas excluidas", () => {
    const r = conReglas([buena("1"), filaSanJuan({ estado: "excluida", comprobante: { tipo: "01", serie: "F009", numero: "9" } })], {
      proveedoresConocidos: [{ tipo: "6", numero: "20100070970" }],
    });
    expect(r.avisos).toEqual([]);
  });
});

describe("propiedad: mismos errores con o sin reglas", () => {
  // Cada fábrica produce una fila (id único) con distintos defectos; las reglas solo pueden añadir
  // sugerencias y avisos, nunca cambiar qué bloquea (D4, plan: «El bloqueo nunca depende de reglas»).
  const fabricas: Array<(id: string, n: string) => FilaReemplazo> = [
    (id, n) => filaReemplazo(undefined, { id, comprobante: { tipo: "01", serie: "F001", numero: n } }),
    (id, n) => filaReemplazo({ biDg: "21.48", igvDg: "1.61" }, { id, comprobante: { tipo: "01", serie: "F001", numero: n } }),
    (id, n) => filaReemplazo({ biDg: "770.00", igvDg: "0.00" }, { id, comprobante: { tipo: "01", serie: "F001", numero: n } }),
    (id, n) => filaReemplazo(undefined, { id, comprobante: { tipo: "01", serie: "F0011", numero: n } }),
    (id, n) => filaReemplazo({ biDg: "100.00", igvDg: "18.00" }, { id, moneda: "USD", tipoCambio: null, comprobante: { tipo: "01", serie: "F001", numero: n } }),
    (id, n) => filaReemplazo(undefined, { id, comprobante: { tipo: "01", serie: "F001", numero: n }, proveedor: { tipo: "6", numero: "20100070971", razonSocial: "A|B" } }),
    (id, n) => filaReemplazo(undefined, { id, estado: "excluida", comprobante: { tipo: "01", serie: "F001", numero: n } }),
    (id, n) => filaReemplazo({ biDg: "100.00", igvDg: "18.00", icbper: "1.50" }, { id, comprobante: { tipo: "01", serie: "F001", numero: n }, fechaEmision: "2026-11-02" }),
  ];

  it("para cualquier combinación de filas, errores (sin la sugerencia) y apto no cambian", () => {
    const sinSugerencia = (e: readonly ErrorPrevalidacion[]) => e.map((x) => ({ ...x, sugerencia: null }));
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: fabricas.length - 1 }), { minLength: 0, maxLength: 8 }), fc.boolean(), (idx, desconocidos) => {
        const filas = idx.map((k, i) => fabricas[k]!(`f${i}`, String(i % 5 === 4 ? 1 : i + 1)));
        const sin = prev(filas);
        const con = prev(filas, { reglas: ctxBase({ proveedoresConocidos: desconocidos ? [] : [{ tipo: "6", numero: "20100070970" }] }) });
        expect(sinSugerencia(con.errores)).toEqual(sinSugerencia(sin.errores));
        expect(con.apto).toBe(sin.apto);
        expect(sin.avisos).toEqual([]);
      }),
      { seed: SEMILLA, numRuns: NUM_RUNS },
    );
  });

  it("con un diccionario vacío y sin proveedores ISC tampoco cambia qué bloquea", () => {
    const filas = [filaSanJuan(), filaReemplazo({ biDg: "21.48", igvDg: "1.61" }, { id: "m", comprobante: { tipo: "01", serie: "F001", numero: "2" } })];
    const con = prev(filas, { reglas: { proveedoresConocidos: [], proveedoresIsc: [{ tipo: "6", numero: "20100070970" }], diccionario: DICCIONARIO_GLOSAS_BASE } });
    expect(con.errores.map((e) => e.codigo)).toEqual(prev(filas).errores.map((e) => e.codigo));
  });
});

describe("orden estable de errores y avisos", () => {
  it("por fila en unidades de código (mayúsculas antes que minúsculas), no por locale", () => {
    const filas = [mala("a1"), mala("B1"), mala("a0")].map((f, i) =>
      ({ ...f, comprobante: { tipo: "01", serie: "F001", numero: String(i + 1) } }));
    expect(prev(filas).errores.map((e) => e.filaId)).toEqual(["B1", "a0", "a1"]);
  });

  it("dentro de una fila: por código y luego por campo (CUADRE antes que IGV; igvDg antes que igvDgng)", () => {
    const columnas = { biDg: "100.00", igvDg: "20.00", biDgng: "100.00", igvDgng: "20.00" };
    const f = filaReemplazo(columnas, { montos: MontosComprobante.desde("PEN", { ...columnas, total: "241.00" }) });
    expect(prev([f]).errores.map((x) => [x.codigo, x.campo])).toEqual([
      ["CUADRE", "total"],
      ["IGV", "igvDg"],
      ["IGV", "igvDgng"],
    ]);
  });

  it("permutar la entrada da exactamente el mismo resultado", () => {
    const filas = [mala("3"), buena("1"), mala("2"), filaSanJuan(), buena("5"), filaReemplazo(undefined, { id: "z9", comprobante: { tipo: "01", serie: "F9", numero: "9" }, fechaEmision: "2027-01-01" })];
    const ref = prev(filas, { reglas: ctxBase() });
    fc.assert(
      fc.property(fc.shuffledSubarray(filas, { minLength: filas.length, maxLength: filas.length }), (perm) => {
        expect(prev(perm, { reglas: ctxBase() })).toEqual(ref);
      }),
      { seed: SEMILLA, numRuns: 200 },
    );
  });
});

describe("sin mutación y lectura única de la entrada", () => {
  it("acepta filas, arreglo, comprobante y proveedor profundamente congelados", () => {
    const filas = [buena("1"), mala("2")].map((f) =>
      Object.freeze({ ...f, comprobante: Object.freeze({ ...f.comprobante }), proveedor: Object.freeze({ ...f.proveedor }) }),
    );
    Object.freeze(filas);
    expect(() => prev(filas, { reglas: ctxBase() })).not.toThrow();
    expect(filas).toHaveLength(2);
    expect(filas[0]?.comprobante.serie).toBe("F001");
  });

  it("no cambia el orden ni el contenido del arreglo recibido", () => {
    const filas = [mala("3"), buena("1"), mala("2")];
    const ids = filas.map((f) => f.id);
    prev(filas);
    expect(filas.map((f) => f.id)).toEqual(ids);
  });

  it("lee cada campo una sola vez: un getter que cambia de valor no se cuela", () => {
    const lecturas = { fecha: 0, estado: 0, serie: 0, razon: 0 };
    const base = filaReemplazo();
    const fila = { ...base } as Record<string, unknown>;
    Object.defineProperty(fila, "fechaEmision", {
      enumerable: true,
      get: () => (++lecturas.fecha === 1 ? "2026-10-05" : "2030-01-01"),
    });
    Object.defineProperty(fila, "estado", {
      enumerable: true,
      get: () => (++lecturas.estado === 1 ? "original" : "excluida"),
    });
    const comprobante = {} as Record<string, unknown>;
    Object.defineProperty(comprobante, "tipo", { enumerable: true, value: "01" });
    Object.defineProperty(comprobante, "numero", { enumerable: true, value: "123" });
    Object.defineProperty(comprobante, "serie", { enumerable: true, get: () => (++lecturas.serie === 1 ? "F001" : "F|01") });
    fila.comprobante = comprobante;
    const proveedor = { tipo: "6", numero: "20100070970" } as Record<string, unknown>;
    Object.defineProperty(proveedor, "razonSocial", { enumerable: true, get: () => (++lecturas.razon === 1 ? "ACME" : "A|B") });
    fila.proveedor = proveedor;
    const r = prev([fila as unknown as FilaReemplazo]);
    expect(r.apto).toBe(true);
    expect(lecturas).toEqual({ fecha: 1, estado: 1, serie: 1, razon: 1 });
  });
});
