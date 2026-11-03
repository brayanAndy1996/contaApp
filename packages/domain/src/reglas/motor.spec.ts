// Motor `evaluarReglas` (spec 011, CA-8, CA-11, entrada estricta, orden). Rojo: sin implementación.
import { describe, expect, it } from "vitest";
import {
  congelarProfundo,
  COMPROBANTE,
  ctx,
  evaluar,
  fila,
  montos,
  pen,
  PROVEEDOR,
  ser,
  tc,
  usd,
  xml,
} from "../../tests/ayudas/filas-motor";
import type { FilaEvaluable } from "./index";
import {
  EntradaReglasInvalidaError,
  evaluarReglas,
  ORDEN_REGLAS,
  ReglasError,
} from "./index";

const DESCONOCIDO = { tipo: "6", numero: "20999999999" };

/** Fila con R-ISC (DG y DGNG), R-MIX (DNG), R-RED y R-NEW a la vez. */
const filaCargada = (id = "f1"): FilaEvaluable =>
  fila({
    id,
    proveedor: DESCONOCIDO,
    montos: montos("PEN", {
      biDg: "100.00",
      biDgng: "50.00",
      biDng: "100.00",
      igvDng: "5.00",
      total: "255.50",
    }),
  });

describe("orden y contrato de salida", () => {
  it("ORDEN_REGLAS es R-ISC, R-MIX, R-RED, R-NEW, R-GP", () => {
    expect(ORDEN_REGLAS).toEqual(["R-ISC", "R-MIX", "R-RED", "R-NEW", "R-GP"]);
  });

  it("sin filas: sin hallazgos ni avisos", () => {
    const r = evaluar([]);
    expect(r.hallazgos).toEqual([]);
    expect(r.avisos).toEqual([]);
  });

  it("una fila que cuadra, conocida y sin XML: sin hallazgos", () => {
    expect(evaluar([fila()]).hallazgos).toEqual([]);
  });

  it("en una fila: por regla (ISC, MIX, RED, NEW) y por destino DG, DGNG, DNG", () => {
    const r = evaluar([filaCargada()]);
    expect(r.hallazgos.map((h) => [h.regla, h.destino])).toEqual([
      ["R-ISC", "DG"],
      ["R-ISC", "DGNG"],
      ["R-MIX", "DNG"],
      ["R-RED", null],
      ["R-NEW", null],
    ]);
  });

  it("filas ordenadas por id con comparación por unidades de código (mayúsculas antes que minúsculas)", () => {
    const filas = ["b", "a", "B", "A", "a1", "_x", "9"].map((id) =>
      fila({ id, proveedor: DESCONOCIDO }),
    );
    const ids = evaluar(filas).hallazgos.map((h) => h.filaId);
    expect(ids).toEqual(["9", "A", "B", "_x", "a", "a1", "b"]);
  });

  it("el resultado está congelado en todos sus niveles", () => {
    const r = evaluar([filaCargada()]);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.hallazgos)).toBe(true);
    expect(Object.isFrozen(r.avisos)).toBe(true);
    for (const h of r.hallazgos) {
      expect(Object.isFrozen(h)).toBe(true);
      expect(Object.isFrozen(h.lecturas)).toBe(true);
      if (h.sugerencia) expect(Object.isFrozen(h.sugerencia)).toBe(true);
    }
  });

  it("R-RED, R-NEW y R-GP no tienen destino", () => {
    const f = fila({
      proveedor: DESCONOCIDO,
      xml: xml({ glosas: ["zapatillas"] }),
    });
    for (const h of evaluar([f]).hallazgos) expect(h.destino).toBeNull();
  });
});

describe("CA-8: no muta, determinismo, permutación", () => {
  const filas = (): FilaEvaluable[] => [
    filaCargada("c"),
    fila({
      id: "a",
      montos: montos("PEN", { biDg: "770.00", total: "770.00" }),
    }),
    fila({
      id: "b",
      montos: montos("PEN", { biDg: "21.48", igvDg: "1.61", total: "23.09" }),
    }),
    fila({ id: "d", xml: xml({ glosas: ["zapat. dep."] }) }),
  ];

  it("acepta entradas congeladas y no las cambia (igualdad antes y después)", () => {
    const f = congelarProfundo(filas());
    const c = congelarProfundo(
      ctx({ proveedoresConocidos: [{ ...PROVEEDOR }] }),
    );
    const antes = ser({ f, c: { ...c, diccionario: null } });
    const r = evaluarReglas(f, c);
    expect(r.hallazgos.length).toBeGreaterThan(0);
    expect(ser({ f, c: { ...c, diccionario: null } })).toBe(antes);
  });

  it("no congela ni modifica lo que recibe (entradas mutables siguen mutables e iguales)", () => {
    const f = filas();
    const c = ctx();
    const antes = ser(f);
    evaluar(f, c);
    expect(ser(f)).toBe(antes);
    expect(Object.isFrozen(f)).toBe(false);
    expect(Object.isFrozen(f[0])).toBe(false);
    expect(Object.isFrozen(c)).toBe(false);
  });

  it("dos llamadas con la misma entrada dan resultados idénticos", () => {
    const f = filas();
    expect(ser(evaluar(f))).toBe(ser(evaluar(f)));
  });

  it("cualquier permutación de las filas da el mismo resultado", () => {
    const base = ser(evaluar(filas()));
    const f = filas();
    const permutaciones = [
      [3, 2, 1, 0],
      [1, 0, 3, 2],
      [2, 3, 0, 1],
      [0, 2, 1, 3],
    ];
    for (const p of permutaciones)
      expect(ser(evaluar(p.map((i) => f[i]!)))).toBe(base);
  });

  it("un hallazgo de una fila no depende de las otras filas", () => {
    const f = filas();
    const sola = evaluar([f[1]!]).hallazgos;
    const juntas = evaluar(f).hallazgos.filter((h) => h.filaId === "a");
    expect(ser(juntas)).toBe(ser(sola));
  });
});

describe("CA-11: XML ajeno o de otra moneda", () => {
  const sanJuan = (x?: ReturnType<typeof xml>) =>
    fila({
      montos: montos("PEN", { biDg: "770.00", total: "770.00" }),
      ...(x ? { xml: x } : {}),
    });
  const xmlIsc = (over: Parameters<typeof xml>[0] = {}) =>
    xml({
      gravado: pen("0.00"),
      igv: pen("0.00"),
      isc: pen("770.00"),
      total: pen("770.00"),
      ...over,
    });

  it("otro RUC: aviso XML_AJENO con el texto fijo y la fila se evalúa como sin XML", () => {
    const x = xmlIsc({ proveedor: { tipo: "6", numero: "20555555555" } });
    const r = evaluar([sanJuan(x)]);
    expect(r.avisos).toHaveLength(1);
    expect(r.avisos[0]).toMatchObject({ filaId: "f1", codigo: "XML_AJENO" });
    expect(r.avisos[0]!.explicacion).toContain(
      "El XML no corresponde a este comprobante",
    );
    expect(ser(r.hallazgos)).toBe(ser(evaluar([sanJuan()]).hallazgos));
  });

  it("serie distinta, número distinto o tipo de comprobante distinto: XML_AJENO", () => {
    for (const comprobante of [
      { ...COMPROBANTE, serie: "F002" },
      { ...COMPROBANTE, numero: "124" },
      { ...COMPROBANTE, tipo: "03" },
    ]) {
      const r = evaluar([sanJuan(xmlIsc({ comprobante }))]);
      expect(r.avisos.map((a) => a.codigo)).toEqual(["XML_AJENO"]);
      expect(ser(r.hallazgos)).toBe(ser(evaluar([sanJuan()]).hallazgos));
    }
  });

  it("el XML ajeno no produce sugerencia exacta ni dice que el XML indica ISC", () => {
    const x = xmlIsc({ proveedor: { tipo: "6", numero: "20555555555" } });
    const h = evaluar([sanJuan(x)]).hallazgos.find((g) => g.regla === "R-ISC")!;
    expect(h.requiereConfirmacion).toBe(true);
    expect(h.explicacion).not.toContain("el XML indica ISC");
  });

  it("ceros a la izquierda del número y espacios en el documento no cuentan: sin aviso", () => {
    const x = xmlIsc({
      comprobante: { ...COMPROBANTE, numero: "00123" },
      proveedor: { tipo: "6", numero: "2010 0000 001" },
    });
    const r = evaluar([sanJuan(x)]);
    expect(r.avisos).toEqual([]);
    expect(
      r.hallazgos.find((h) => h.regla === "R-ISC")!.requiereConfirmacion,
    ).toBe(false);
  });

  it("moneda del XML distinta de la de la fila: aviso XML_MONEDA y se evalúa como sin XML", () => {
    const x = xmlIsc({
      moneda: "USD",
      isc: usd("770.00"),
      gravado: usd("0.00"),
      igv: usd("0.00"),
      total: usd("770.00"),
    });
    const r = evaluar([sanJuan(x)]);
    expect(r.avisos.map((a) => a.codigo)).toEqual(["XML_MONEDA"]);
    expect(ser(r.hallazgos)).toBe(ser(evaluar([sanJuan()]).hallazgos));
  });

  it("un XML correcto no genera avisos", () => {
    expect(evaluar([sanJuan(xmlIsc())]).avisos).toEqual([]);
  });

  it("los avisos salen ordenados por id de fila", () => {
    const ajeno = xmlIsc({ proveedor: { tipo: "6", numero: "20555555555" } });
    const r = evaluar([
      { ...sanJuan(ajeno), id: "z" },
      { ...sanJuan(ajeno), id: "a" },
    ]);
    expect(r.avisos.map((a) => a.filaId)).toEqual(["a", "z"]);
  });
});

describe("entrada estricta (EntradaReglasInvalidaError)", () => {
  it("ids repetidos", () => {
    expect(() =>
      evaluar([fila({ id: "dup-secreto" }), fila({ id: "dup-secreto" })]),
    ).toThrow(EntradaReglasInvalidaError);
  });

  it("el mensaje del error no contiene valores de la entrada", () => {
    try {
      evaluar([fila({ id: "dup-secreto" }), fila({ id: "dup-secreto" })]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ReglasError);
      expect((e as Error).message).not.toContain("dup-secreto");
    }
  });

  it("id fuera de la gramática: vacío, con espacio, con tilde, de 65 caracteres", () => {
    for (const id of ["", "a b", "ñu", "x".repeat(65)]) {
      expect(() => evaluar([fila({ id })])).toThrow(EntradaReglasInvalidaError);
    }
  });

  it("id de 64 caracteres es válido", () => {
    expect(() => evaluar([fila({ id: "x".repeat(64) })])).not.toThrow();
  });

  it("montos que no es un MontosComprobante real (objeto falso)", () => {
    const real = montos("PEN", {
      biDg: "100.00",
      igvDg: "18.00",
      total: "118.00",
    });
    const falso = {
      moneda: "PEN",
      total: real.total,
      obtener: (c: string) => real.obtener(c as "biDg"),
      componentes: () => real.componentes(),
    } as unknown as FilaEvaluable["montos"];
    expect(() => evaluar([fila({ montos: falso })])).toThrow(
      EntradaReglasInvalidaError,
    );
    expect(() =>
      evaluar([fila({ montos: JSON.parse(JSON.stringify(real)) })]),
    ).toThrow(EntradaReglasInvalidaError);
  });

  it("campos de dinero del XML que no son Money reales", () => {
    const x = {
      ...xml(),
      total: { toString: () => "118.00" },
    } as unknown as ReturnType<typeof xml>;
    expect(() => evaluar([fila({ xml: x })])).toThrow(
      EntradaReglasInvalidaError,
    );
  });

  it("claves extra en la fila, en el proveedor, en el comprobante y en el XML", () => {
    const f = fila();
    expect(() =>
      evaluar([{ ...f, extra: 1 } as unknown as FilaEvaluable]),
    ).toThrow(EntradaReglasInvalidaError);
    expect(() =>
      evaluar([
        {
          ...f,
          proveedor: { ...f.proveedor, x: 1 },
        } as unknown as FilaEvaluable,
      ]),
    ).toThrow(EntradaReglasInvalidaError);
    expect(() =>
      evaluar([
        {
          ...f,
          comprobante: { ...f.comprobante, x: 1 },
        } as unknown as FilaEvaluable,
      ]),
    ).toThrow(EntradaReglasInvalidaError);
    expect(() =>
      evaluar([
        { ...f, xml: { ...xml(), extra: 1 } } as unknown as FilaEvaluable,
      ]),
    ).toThrow(EntradaReglasInvalidaError);
  });

  it("clave extra en el contexto", () => {
    const c = { ...ctx(), extra: [] } as unknown as ReturnType<typeof ctx>;
    expect(() => evaluar([fila()], c)).toThrow(EntradaReglasInvalidaError);
  });

  it("__proto__ como clave propia en el contexto o en la fila", () => {
    const c = ctx();
    Object.defineProperty(c, "__proto__", {
      value: { proveedoresConocidos: [] },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(() => evaluar([fila()], c)).toThrow(EntradaReglasInvalidaError);
    const f = fila();
    Object.defineProperty(f, "__proto__", {
      value: {},
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(() => evaluar([f])).toThrow(EntradaReglasInvalidaError);
  });

  it("documento con '__proto__' (fuera de la gramática) en la fila o en los conocidos", () => {
    expect(() =>
      evaluar([fila({ proveedor: { tipo: "6", numero: "__proto__" } })]),
    ).toThrow(EntradaReglasInvalidaError);
    const c = ctx({
      proveedoresConocidos: [{ tipo: "6", numero: "__proto__" }],
    });
    expect(() => evaluar([fila()], c)).toThrow(EntradaReglasInvalidaError);
  });

  it("gramáticas de documento y comprobante", () => {
    const malos: Partial<FilaEvaluable>[] = [
      { proveedor: { tipo: "66", numero: "1" } },
      { proveedor: { tipo: "6", numero: "" } },
      { proveedor: { tipo: "6", numero: "1".repeat(16) } },
      { proveedor: { tipo: "6", numero: "20100 ñ" } },
      { comprobante: { ...COMPROBANTE, tipo: "1" } },
      { comprobante: { ...COMPROBANTE, serie: "" } },
      { comprobante: { ...COMPROBANTE, serie: "ABCDE" } },
      { comprobante: { ...COMPROBANTE, numero: "123456789" } },
      { comprobante: { ...COMPROBANTE, numero: "12a" } },
    ];
    for (const m of malos)
      expect(() => evaluar([fila(m)])).toThrow(EntradaReglasInvalidaError);
  });

  it("filas que no es arreglo, contexto ausente o diccionario que no es DiccionarioGlosas", () => {
    expect(() =>
      evaluarReglas(null as unknown as FilaEvaluable[], ctx()),
    ).toThrow(EntradaReglasInvalidaError);
    expect(() =>
      evaluarReglas([fila()], undefined as unknown as ReturnType<typeof ctx>),
    ).toThrow(EntradaReglasInvalidaError);
    const c = {
      ...ctx(),
      diccionario: { buscar: () => null },
    } as unknown as ReturnType<typeof ctx>;
    expect(() => evaluar([fila()], c)).toThrow(EntradaReglasInvalidaError);
  });

  it("glosas del XML que no son un arreglo de strings", () => {
    const x = { ...xml(), glosas: [1, 2] } as unknown as ReturnType<typeof xml>;
    expect(() => evaluar([fila({ xml: x })])).toThrow(
      EntradaReglasInvalidaError,
    );
  });

  it("origenUsd con tipo de cambio que no es TipoCambio real", () => {
    const origen = montos("USD", {
      biDg: "100.00",
      igvDg: "18.00",
      total: "118.00",
    });
    const pensados = montos("PEN", {
      biDg: "375.00",
      igvDg: "67.50",
      total: "442.50",
    });
    const falso = {
      montos: origen,
      tipoCambio: "3.750",
    } as unknown as FilaEvaluable["origenUsd"];
    expect(() =>
      evaluar([fila({ montos: pensados, origenUsd: falso })]),
    ).toThrow(EntradaReglasInvalidaError);
    // Control: con TipoCambio real no lanza.
    expect(() =>
      evaluar([
        fila({
          montos: pensados,
          origenUsd: { montos: origen, tipoCambio: tc("3.750") },
        }),
      ]),
    ).not.toThrow();
  });

  it("filas de un lote con una inválida no devuelven resultados parciales (lanza)", () => {
    expect(() => evaluar([fila({ id: "ok" }), fila({ id: "mal id" })])).toThrow(
      EntradaReglasInvalidaError,
    );
  });
});
