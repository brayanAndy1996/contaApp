// Spec 012 · T15a · Ronda adversarial 2a (caja negra). Regresión y caminos nuevos de las
// correcciones de T14 y T14a: aislamiento de evaluarReglas (D19), signos del IGV (H-012-1),
// explicación DUPLICADO acotada (H-012-2), validación de todos los campos con el valor escrito
// (H-012-23), mayúsculas en la clave de duplicados (D20), campos sin serializador (D21) y rango del
// impacto (D22). Solo spec, plan y API pública. Una prueba que falla es un hallazgo H-012-40 y
// siguientes (ver tasks.md, T15a); las que pasan quedan como regresión.
import { describe, expect, it } from "vitest";
import {
  ArchivoNoPrevalidadoError,
  DefinicionFormatoInvalidaError,
  EntradaPrevalidacionInvalidaError,
  EntradaReglasInvalidaError,
  MontosComprobante,
  Money,
  RegistroFormatos,
  TASA_IGV_10,
  TASA_IGV_18,
  generarTxt,
  igvCuadra,
  prevalidar,
  resumirCambios,
  seleccionarFormato,
} from "../index";
import type { CampoTxt, ErrorPrevalidacion, FilaReemplazo, FormatoTxt, ResultadoPrevalidacion } from "../index";
import {
  CABECERA,
  ctxBase,
  filaReemplazo,
  filasFixture,
  filaSanJuan,
  lineasCrlf,
  montosDe,
} from "../../tests/ayudas/filas-reemplazo";

const prev = (filas: readonly FilaReemplazo[], extra: Record<string, unknown> = {}): ResultadoPrevalidacion =>
  prevalidar(filas, { cabecera: CABECERA, ...extra } as Parameters<typeof prevalidar>[1]);
const errDe = (es: readonly ErrorPrevalidacion[], id: string | null) => es.filter((e) => e.filaId === id);
const claves = (es: readonly ErrorPrevalidacion[]) => es.map((e) => `${e.filaId}:${e.codigo}:${e.campo}`);

const PROVISIONAL = seleccionarFormato("compras", "202610");

/** Copia plana de los campos del provisional, con cambios por nombre. */
function campos(cambios: Record<string, Partial<CampoTxt> | "sin-patron"> = {}): CampoTxt[] {
  return PROVISIONAL.campos.map((c) => {
    const base: CampoTxt = { nombre: c.nombre, obligatorio: c.obligatorio, longitudMax: c.longitudMax, tipo: c.tipo };
    const patron = c.patron;
    const conPatron = patron === undefined ? base : { ...base, patron };
    const cambio = cambios[c.nombre];
    if (cambio === undefined) return conPatron;
    if (cambio === "sin-patron") return base;
    return { ...conPatron, ...cambio };
  });
}

/** Registro con una sola versión «oficial» derivada del provisional. */
function registroCon(cs: CampoTxt[], over: Partial<FormatoTxt> = {}): RegistroFormatos {
  return RegistroFormatos.desde([{ ...PROVISIONAL, version: "adv-2a", oficial: true, campos: cs, ...over }]);
}

const filaN = (i: string | number, over: Parameters<typeof filaReemplazo>[1] = {}, cols?: Parameters<typeof filaReemplazo>[0]) =>
  filaReemplazo(cols, { id: `f${i}`, comprobante: { tipo: "01", serie: "F001", numero: String(i) }, ...over });

// ------------------------------------------------------------------------------- D19 · aislamiento
describe("ronda 2a · aislamiento de evaluarReglas (D19)", () => {
  // Serie sin patrón: «F-01» no es error de estructura, pero 011 lo rechaza (H-012-21).
  const registro = registroCon(campos({ serie: "sin-patron" }));
  const mala = (id: string, numero: string) =>
    filaReemplazo({ biDg: "21.48", igvDg: "1.61" }, { id, comprobante: { tipo: "01", serie: "F-01", numero } });
  /** El fixture más dos filas del mismo proveedor nuevo (R-NEW puede depender del lote). */
  const base = (): FilaReemplazo[] => [
    ...filasFixture(),
    filaReemplazo(undefined, { id: "P2", comprobante: { tipo: "01", serie: "F002", numero: "1" }, proveedor: { tipo: "6", numero: "20700000053" } }),
    filaReemplazo(undefined, { id: "P3", comprobante: { tipo: "01", serie: "F002", numero: "2" }, proveedor: { tipo: "6", numero: "20700000053" } }),
  ];

  it("una fila que hace fallar a 011 no cambia los errores, sugerencias ni avisos de las demás", () => {
    const limpio = prev(base(), { registro, reglas: ctxBase() });
    const sucio = prev([mala("0-primera", "1"), ...base(), mala("zz-ultima", "2")], { registro, reglas: ctxBase() });
    for (const f of base()) {
      expect(errDe(sucio.errores, f.id), f.id).toEqual(errDe(limpio.errores, f.id));
      expect(sucio.avisos.filter((a) => a.filaId === f.id), f.id).toEqual(limpio.avisos.filter((a) => a.filaId === f.id));
    }
    // La fila aislada conserva sus errores (IGV de la mixta) sin sugerencia ni avisos.
    const sinReglas = prev([mala("zz-ultima", "2")], { registro });
    expect(errDe(sucio.errores, "zz-ultima")).toEqual(errDe(sinReglas.errores, "zz-ultima"));
    expect(errDe(sucio.errores, "zz-ultima").map((e) => e.codigo)).toContain("IGV");
    expect(sucio.avisos.filter((a) => a.filaId === "zz-ultima")).toEqual([]);
  });

  it("un contexto `reglas` con getters que cambian tras validarse no apaga en silencio los avisos de todo el lote", () => {
    expect(prev([filaSanJuan()], { reglas: ctxBase() }).avisos.map((a) => a.codigo)).toContain("R-ISC");
    let lecturas = 0;
    const ctx = {
      ...ctxBase(),
      get proveedoresIsc() {
        lecturas++;
        return lecturas === 1 ? [] : ("basura" as unknown as []);
      },
    };
    let r: ResultadoPrevalidacion | undefined;
    try {
      r = prev([filaSanJuan()], { reglas: ctx });
    } catch (e) {
      expect(e).toBeInstanceOf(EntradaReglasInvalidaError);
      return;
    }
    // Si no lanza, debe haber evaluado lo que validó: San Juan conserva su aviso R-ISC (CA-1).
    expect(r.avisos.map((a) => a.codigo)).toContain("R-ISC");
  });

  it("un contexto `reglas` malformado lanza aunque ninguna fila llegue a evaluarReglas", () => {
    const rota = filaReemplazo(undefined, { proveedor: { tipo: "6", numero: "20100070970", razonSocial: "A|B" } });
    const excluida = filaReemplazo(undefined, { id: "x", estado: "excluida" });
    for (const filas of [[rota], [excluida], [rota, excluida]]) {
      expect(() => prev(filas, { reglas: { proveedoresConocidos: "x" } })).toThrow(EntradaReglasInvalidaError);
    }
  });
});

// ------------------------------------------------------------------------------ H-012-1 · signos
describe("ronda 2a · signos del IGV en DGNG y DNG (H-012-1)", () => {
  const deCentimos = (c: number): string => {
    const s = c < 0 ? "-" : "";
    const a = Math.abs(c);
    return `${s}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
  };

  it("en DGNG y DNG, IGV 0.00 nunca es error, y uno distinto de cero con base 0.00 o signo contrario siempre lo es; con o sin reglas", () => {
    const casos: { id: string; destino: "DGNG" | "DNG"; bi: string; igv: string }[] = [];
    let k = 0;
    for (const destino of ["DGNG", "DNG"] as const) {
      for (const b of [0, 1, -1, 5, -5, 10, -10, 100, -100, 1000, -1000, 10000, -10000]) {
        for (const c of new Set([0, 1, -1, 2, -2, Math.round(b * 0.18), -Math.round(b * 0.18), Math.round(b * 0.1), -Math.round(b * 0.1)])) {
          casos.push({ id: `g${String(k++).padStart(3, "0")}`, destino, bi: deCentimos(b), igv: deCentimos(c) });
        }
      }
    }
    const filas = casos.map((x, i) => {
      const cols = x.destino === "DGNG" ? { biDgng: x.bi, igvDgng: x.igv } : { biDng: x.bi, igvDng: x.igv };
      return filaN(i + 1, { id: x.id }, cols);
    });
    const sin = prev(filas);
    const con = prev(filas, { reglas: ctxBase() });
    expect(con.errores.map((e) => ({ ...e, sugerencia: null }))).toEqual(sin.errores.map((e) => ({ ...e, sugerencia: null })));
    const discrepancias: string[] = [];
    for (const x of casos) {
      const bi = Money.desde(x.bi, "PEN");
      const igv = Money.desde(x.igv, "PEN");
      const cuadra = igvCuadra(bi, igv, TASA_IGV_18) || igvCuadra(bi, igv, TASA_IGV_10);
      const signos = bi.esNegativo() !== igv.esNegativo();
      const esperado = !igv.esCero() && (bi.esCero() || signos || !cuadra);
      const obtenido = errDe(sin.errores, x.id).some((e) => e.codigo === "IGV" && e.destino === x.destino);
      if (esperado !== obtenido) discrepancias.push(`${x.destino} BI ${x.bi} IGV ${x.igv}: esperado ${esperado}`);
    }
    expect(discrepancias).toEqual([]);
  });

  it("una fila con DG correcto y DNG de signo contrario da IGV solo en DNG, con cifras canónicas", () => {
    const f = filaN(1, {}, { biDg: "100.00", igvDg: "18.00", biDng: "50.00", igvDng: "-5.00" });
    const igv = prev([f]).errores.filter((e) => e.codigo === "IGV");
    expect(igv.map((e) => e.destino)).toEqual(["DNG"]);
    expect(igv[0]?.explicacion).toContain("-5.00 no es 18 % ni 10 % de 50.00");
  });
});

// -------------------------------------------------------------------------- H-012-2 · DUPLICADO
describe("ronda 2a · explicación DUPLICADO acotada (H-012-2)", () => {
  const copias = (n: number) =>
    Array.from({ length: n }, (_, i) => filaN(1, { id: `dup-${String(i).padStart(3, "0")}` }));

  it("con 21 copias nombra las 20 otras sin «más»; con 22 nombra 20 y dice «1 más»; nunca se nombra a sí misma", () => {
    for (const n of [21, 22]) {
      const dup = prev(copias(n)).errores.filter((e) => e.codigo === "DUPLICADO");
      expect(dup).toHaveLength(n);
      for (const e of dup) {
        const id = e.filaId as string;
        expect(e.explicacion.includes(id), `${n}:${id}`).toBe(false);
        const nombradas = copias(n).filter((f) => f.id !== id && e.explicacion.includes(f.id));
        expect(nombradas.length, `${n}:${id}`).toBe(20);
        if (n === 21) expect(e.explicacion).not.toMatch(/más/);
        else expect(e.explicacion).toMatch(/\b1 más/);
      }
    }
  });

  it("las copias nombradas no dependen del orden de entrada (mismas explicaciones bajo permutación)", () => {
    const filas = copias(30);
    const a = prev(filas).errores;
    const b = prev([...filas].reverse()).errores;
    const c = prev([...filas.slice(15), ...filas.slice(0, 15)]).errores;
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});

// ----------------------------------------------------------------------- D20 · clave de duplicados
describe("ronda 2a · mayúsculas ASCII en la clave de duplicados (D20)", () => {
  const dupDe = (filas: FilaReemplazo[]) =>
    prev(filas).errores.filter((e) => e.codigo === "DUPLICADO").map((e) => e.filaId);

  it("solo pliega a-z: ı, ſ y ﬀ no colisionan con I, S y FF; ab-12 y AB-12 sí", () => {
    // Las filas con caracteres no ASCII ya tienen error de estructura, pero los duplicados se buscan
    // en todas las no excluidas: la fila válida no debe recibir un DUPLICADO falso.
    expect(dupDe([
      filaReemplazo(undefined, { id: "valida", proveedor: { tipo: "7", numero: "ID12" } }),
      filaReemplazo(undefined, { id: "rara", proveedor: { tipo: "7", numero: "ıd12" } }),
    ])).toEqual([]);
    expect(dupDe([
      filaReemplazo(undefined, { id: "valida", comprobante: { tipo: "01", serie: "S001", numero: "5" } }),
      filaReemplazo(undefined, { id: "rara", comprobante: { tipo: "01", serie: "ſ001", numero: "5" } }),
    ])).toEqual([]);
    expect(dupDe([
      filaReemplazo(undefined, { id: "valida", proveedor: { tipo: "7", numero: "FF9" } }),
      filaReemplazo(undefined, { id: "rara", proveedor: { tipo: "7", numero: "ﬀ9" } }),
    ])).toEqual([]);
    expect(dupDe([
      filaReemplazo(undefined, { id: "a", proveedor: { tipo: "7", numero: "ab-12" } }),
      filaReemplazo(undefined, { id: "b", proveedor: { tipo: "7", numero: "AB-12" } }),
    ])).toEqual(["a", "b"]);
  });

  it("el número «0» y el número vacío no son el mismo comprobante: la fila válida no recibe un DUPLICADO falso", () => {
    // Quitar los ceros a la izquierda de «0» no puede dar la misma clave que «» (CAMPO_OBLIGATORIO).
    const r = prev([
      filaReemplazo(undefined, { id: "valida", comprobante: { tipo: "01", serie: "F001", numero: "0" } }),
      filaReemplazo(undefined, { id: "vacia", comprobante: { tipo: "01", serie: "F001", numero: "" } }),
    ]);
    expect(claves(r.errores)).toEqual(["vacia:CAMPO_OBLIGATORIO:numero"]);
  });
});

// ------------------------------------------------------------------ H-012-23 · valor escrito
describe("ronda 2a · cada campo se valida con el valor que se escribe (H-012-23)", () => {
  it("el TC USD «3.3» se escribe «3.300»: con longitudMax 3 es LONGITUD; con 5, apto y sale «3.300»", () => {
    const usd = filaReemplazo(undefined, { moneda: "USD", tipoCambio: "3.3" });
    const corto = registroCon(campos({ tipoCambio: { longitudMax: 3 } }));
    expect(claves(prev([usd], { registro: corto }).errores)).toEqual(["f1:LONGITUD:tipoCambio"]);
    expect(() => generarTxt([usd], CABECERA, { registro: corto })).toThrow(ArchivoNoPrevalidadoError);
    const justo = registroCon(campos({ tipoCambio: { longitudMax: 5 } }));
    expect(prev([usd], { registro: justo }).errores).toEqual([]);
    expect(lineasCrlf(generarTxt([usd], CABECERA, { registro: justo }).bytes)[0]?.split("|")[9]).toBe("3.300");
  });

  it("la fecha se valida como DD/MM/AAAA; una fecha inválida solo da FECHA_INVALIDA, sin errores extra del campo", () => {
    const iso = registroCon(campos({ fechaEmision: { patron: /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/ } }));
    const dmy = registroCon(campos({ fechaEmision: { patron: /^[0-9]{2}\/[0-9]{2}\/[0-9]{4}$/, longitudMax: 10 } }));
    const ok = filaN(1);
    expect(claves(prev([ok], { registro: iso }).errores)).toEqual(["f1:PATRON:fechaEmision"]);
    expect(prev([ok], { registro: dmy }).errores).toEqual([]);
    const mala = filaN(2, { fechaEmision: "2026-02-30" });
    expect(prev([mala], { registro: dmy }).errores.map((e) => e.codigo)).toEqual(["FECHA_INVALIDA"]);
    const nueve = registroCon(campos({ fechaEmision: { longitudMax: 9 } }));
    expect(claves(prev([ok], { registro: nueve }).errores)).toEqual(["f1:LONGITUD:fechaEmision"]);
  });

  it("un TC obligatorio en el formato no duplica el error propio del TC USD (USD_SIN_TC, TC_INVALIDO)", () => {
    const registro = registroCon(campos({ tipoCambio: { obligatorio: true, patron: /^[0-9]\.[0-9]{3}$/ } }));
    const sinTc = filaN(1, { moneda: "USD", tipoCambio: null });
    const tcMalo = filaN(2, { moneda: "USD", tipoCambio: "3.1234" });
    const r = prev([sinTc, tcMalo], { registro });
    expect(claves(r.errores)).toEqual(["f1:USD_SIN_TC:tipoCambio", "f2:TC_INVALIDO:tipoCambio"]);
  });

  it("el periodo da un solo error con filaId null, primero, aunque haya varias filas", () => {
    const registro = registroCon(campos({ periodo: { longitudMax: 5 } }));
    const filas = [filaN(1), filaN(2), filaN(3)];
    const r = prev(filas, { registro });
    expect(claves(r.errores)).toEqual(["null:LONGITUD:periodo"]);
    expect(r.apto).toBe(false);
    expect(() => generarTxt(filas, CABECERA, { registro })).toThrow(ArchivoNoPrevalidadoError);
  });

  it("razón social obligatoria ausente, moneda con patrón y montos de NC con patrón sin signo se validan como se escriben", () => {
    const registro = registroCon(
      campos({
        razonSocial: { obligatorio: true },
        moneda: { patron: /^PEN$/ },
        biDg: { patron: /^[0-9]+\.[0-9]{2}$/ },
      }),
    );
    const sinRazon = filaN(1);
    const usd = filaN(2, { moneda: "USD", tipoCambio: "3.500", proveedor: { tipo: "6", numero: "20100070970", razonSocial: "ACME" } });
    const nc = filaN(3, { comprobante: { tipo: "07", serie: "F001", numero: "3" }, proveedor: { tipo: "6", numero: "20100070970", razonSocial: "ACME" } }, { biDg: "-100.00", igvDg: "-18.00" });
    const r = prev([sinRazon, usd, nc], { registro });
    expect(claves(r.errores)).toEqual(["f1:CAMPO_OBLIGATORIO:razonSocial", "f2:PATRON:moneda", "f3:PATRON:biDg"]);
  });
});

// ------------------------------------------------------------------ D21 · campos sin serializador
describe("ronda 2a · campos sin serializador (D21)", () => {
  const conCampo = (nombre: unknown) => [
    ...campos(),
    { nombre, obligatorio: false, longitudMax: 5, tipo: "texto" } as unknown as CampoTxt,
  ];

  it("nombres de Object.prototype, casi iguales a uno conocido o que no son string se rechazan con DefinicionFormatoInvalidaError", () => {
    const nombres: unknown[] = [
      "hasOwnProperty", "valueOf", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString",
      "__defineGetter__", "__lookupGetter__", "__lookupSetter__", "__defineSetter__",
      "SERIE", "serie ", " total", "total\u0000", "total​", "Total",
      1, null, undefined, Symbol("serie"), new String("serie"), ["serie"], { toString: () => "serie" },
    ];
    const aceptados: string[] = [];
    for (const n of nombres) {
      try {
        // Un nombre casi igual a uno conocido entra como campo extra; el conocido real sigue en la lista.
        registroCon(conCampo(n));
        aceptados.push(String(typeof n === "symbol" ? "Symbol" : JSON.stringify(n)));
      } catch (e) {
        if (!(e instanceof DefinicionFormatoInvalidaError)) aceptados.push(`${String(n === null ? "null" : typeof n)} lanzó ${String(e)}`);
      }
    }
    expect(aceptados).toEqual([]);
  });

  it("contaminar Object.prototype con el nombre de un campo no lo vuelve serializable", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.campoNuevo = () => "X";
    proto.campoOtro = "X";
    try {
      expect(() => registroCon(conCampo("campoNuevo"))).toThrow(DefinicionFormatoInvalidaError);
      expect(() => registroCon(conCampo("campoOtro"))).toThrow(DefinicionFormatoInvalidaError);
    } finally {
      delete proto.campoNuevo;
      delete proto.campoOtro;
    }
  });
});

// ---------------------------------------------------------------------- D22 · rango del impacto
describe("ronda 2a · rango del impacto en IGV (D22)", () => {
  const agregada = (id: string, igvDg: string, moneda: "PEN" | "USD" = "PEN") =>
    filaReemplazo(undefined, {
      id,
      estado: "agregada",
      comprobante: { tipo: "01", serie: "F001", numero: String(id.charCodeAt(0)) },
      moneda,
      ...(moneda === "USD" ? { tipoCambio: "3.000" } : {}),
      montos: montosDe(moneda, { igvDg }),
    });

  it("el resultado no depende del orden de suma: +600 mil millones, +600, −600 da 600 mil millones en cualquier disposición", () => {
    const g = "600000000000.00";
    const disposiciones = [
      [agregada("a", g), agregada("b", g), agregada("c", `-${g}`)],
      [agregada("a", g), agregada("b", `-${g}`), agregada("c", g)],
      [agregada("a", `-${g}`), agregada("b", g), agregada("c", g)],
    ];
    const salidas = disposiciones.map((v) => {
      try {
        return resumirCambios([], v).impactoIgv.DG.toString();
      } catch (e) {
        return e instanceof Error ? e.constructor.name : "?";
      }
    });
    expect(salidas).toEqual([g, g, g]);
  });

  it("el borde negativo exacto −999999999999.99 no lanza y un centavo más allá lanza EntradaPrevalidacionInvalidaError", () => {
    const borde = [agregada("a", "-600000000000.00"), agregada("b", "-399999999999.99")];
    expect(resumirCambios([], borde).impactoIgv.total.toString()).toBe("-999999999999.99");
    expect(() => resumirCambios([], [...borde, agregada("c", "-0.01")])).toThrow(EntradaPrevalidacionInvalidaError);
  });

  it("filas enormes que no cambian dan impacto 0.00: el impacto es la diferencia, no la suma de cada lado", () => {
    const o1 = filaN(1, {}, { igvDg: "600000000000.00" });
    const o2 = filaN(2, {}, { igvDg: "600000000000.00" });
    let r: ReturnType<typeof resumirCambios> | undefined;
    expect(() => {
      r = resumirCambios([o1, o2], [o1, o2]);
    }).not.toThrow();
    expect(r?.impactoIgv.total.toString()).toBe("0.00");
  });

  it("una USD cuyo IGV en PEN desborda NUMERIC(14,2) no escapa con un error de dinero", () => {
    const usd = agregada("u", "400000000000.00", "USD"); // × 3.000 = 1.2 billones
    let r: ReturnType<typeof resumirCambios>;
    try {
      r = resumirCambios([], [usd]);
    } catch (e) {
      expect(e).toBeInstanceOf(EntradaPrevalidacionInvalidaError);
      return;
    }
    expect(r.filasSinConvertir).toEqual(["u"]);
  });

  it("prevalidar: un origenUsd cuya conversión desborda NUMERIC(14,2) es CONVERSION_USD, no una excepción (con o sin reglas)", () => {
    const f = filaN(1, {
      origenUsd: { montos: montosDe("USD", { igvDg: "400000000000.00" }), tipoCambio: "3.000" },
      montos: MontosComprobante.desde("PEN", { igvDg: "999999999999.99", total: "999999999999.99" }),
    });
    for (const extra of [{}, { reglas: ctxBase() }]) {
      let r: ResultadoPrevalidacion | undefined;
      expect(() => {
        r = prev([f], extra);
      }).not.toThrow();
      expect(claves(r?.errores ?? [])).toContain("f1:CONVERSION_USD:origenUsd");
    }
  });
});
