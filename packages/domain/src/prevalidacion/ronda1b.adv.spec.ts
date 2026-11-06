// Spec 012 · T13b · Ronda adversarial 1b (caja blanca). Escenarios que T13a no cubre: divergencia
// entre el error IGV y R-MIX, bloqueo que depende de `reglas`, campos no textuales del formato,
// getters y Proxy, `__proto__` y prototipos contaminados, versiones solapadas, sustitutos sueltos
// y desbordes de NUMERIC(14,2) en el resumen. Las pruebas que fallan son hallazgos H-012-20 y
// siguientes (ver tasks.md, T13b); las que pasan quedan como regresión. Solo API pública.
import { describe, expect, it } from "vitest";
import {
  ArchivoNoPrevalidadoError,
  CaracterNoCodificableError,
  DefinicionFormatoInvalidaError,
  EntradaPrevalidacionInvalidaError,
  FormatoNoVigenteError,
  MontosComprobante,
  RegistroFormatos,
  codificar,
  generarTxt,
  prevalidar,
  resumirCambios,
  seleccionarFormato,
} from "../index";
import type { CabeceraTxt, CampoTxt, FilaReemplazo, FormatoTxt } from "../index";
import {
  CABECERA,
  ctxBase,
  filaReemplazo,
  latin1,
  lineasCrlf,
  montosDe,
  xmlDe,
} from "../../tests/ayudas/filas-reemplazo";

const prev = (filas: readonly FilaReemplazo[], extra: Record<string, unknown> = {}) =>
  prevalidar(filas, { cabecera: CABECERA, ...extra } as Parameters<typeof prevalidar>[1]);
const sinSugerencia = <T extends { sugerencia: unknown }>(es: readonly T[]) =>
  es.map((e) => ({ ...e, sugerencia: null }));

const PROVISIONAL = seleccionarFormato("compras", "202610");

/** Copia plana de los campos del provisional (el patrón de la copia registrada es un getter). */
function camposProvisional(): CampoTxt[] {
  return PROVISIONAL.campos.map((c) => {
    const base = { nombre: c.nombre, obligatorio: c.obligatorio, longitudMax: c.longitudMax, tipo: c.tipo };
    const patron = c.patron;
    return patron === undefined ? base : { ...base, patron };
  });
}

/** Registro con una sola versión «oficial» derivada del provisional, con los campos dados. */
function registroCon(campos: CampoTxt[], over: Partial<FormatoTxt> = {}): RegistroFormatos {
  return RegistroFormatos.desde([{ ...PROVISIONAL, version: "adv-1b", oficial: true, campos, ...over }]);
}

describe("ronda 1b · IGV frente a R-MIX de 011", () => {
  it("cada error IGV de una fila evaluable trae el R-MIX de su destino, y con o sin reglas salen los mismos errores", () => {
    const filas = [
      filaReemplazo({ biDg: "21.48", igvDg: "1.61" }, { id: "mixta", comprobante: { tipo: "01", serie: "F001", numero: "1" } }),
      filaReemplazo(
        { biDg: "-100.00", igvDg: "-15.00" },
        { id: "nc", comprobante: { tipo: "07", serie: "F001", numero: "2" } },
      ),
      filaReemplazo({ igvDgng: "5.00" }, { id: "bicero", comprobante: { tipo: "01", serie: "F001", numero: "3" } }),
      filaReemplazo(
        { biDg: "50.00", igvDg: "3.00", biDng: "100.00", igvDng: "18.00" },
        { id: "dos", comprobante: { tipo: "01", serie: "F001", numero: "4" } },
      ),
      filaReemplazo({ biDg: "100.00", igvDg: "-18.00" }, { id: "signo", comprobante: { tipo: "01", serie: "F001", numero: "5" } }),
    ];
    const sin = prev(filas);
    const con = prev(filas, { reglas: ctxBase() });
    expect(sinSugerencia(con.errores)).toEqual(sinSugerencia(sin.errores));
    const igv = con.errores.filter((e) => e.codigo === "IGV");
    expect(igv.map((e) => `${e.filaId}:${e.destino}`)).toEqual(["bicero:DGNG", "dos:DG", "mixta:DG", "nc:DG", "signo:DG"]);
    for (const e of igv) {
      expect(e.sugerencia).toMatchObject({ regla: "R-MIX", filaId: e.filaId, destino: e.destino });
    }
  });
});

describe("ronda 1b · el bloqueo no depende de reglas", () => {
  it("H-012-20 · un R-ISC con ISC del XML que desborda NUMERIC(14,2) no hace lanzar a prevalidar con reglas", () => {
    // Fila que cuadra (100.00 − 999999999999.99 = −999999999899.99), IGV DG 0.00 (D18, sin error) y
    // un XML con la misma identidad cuyo ISC hace que `xml.isc − isc` salga de rango en R-ISC.
    const montos = MontosComprobante.desde("PEN", {
      biDg: "100.00",
      isc: "-999999999999.99",
      total: "-999999999899.99",
    });
    const f = filaReemplazo(undefined, {
      montos,
      xml: xmlDe({ gravado: "100.00", isc: "999999999999.99", total: "100.00" }),
    });
    const sin = prev([f]);
    expect(sin.errores).toEqual([]);
    let con: ReturnType<typeof prev> | undefined;
    expect(() => {
      con = prev([f], { reglas: ctxBase() });
    }).not.toThrow();
    expect(con?.errores).toEqual(sin.errores);
  });

  it("H-012-21 · un registro con un patrón de serie más laxo que la gramática de 011 hace lanzar a prevalidar solo con reglas", () => {
    const campos = camposProvisional().map((c) =>
      c.nombre === "serie" ? { nombre: c.nombre, obligatorio: true, longitudMax: 4, tipo: c.tipo } : c,
    );
    const registro = registroCon(campos);
    const f = filaReemplazo(undefined, { comprobante: { tipo: "01", serie: "F-01", numero: "123" } });
    const sin = prev([f], { registro });
    let con: ReturnType<typeof prev> | undefined;
    expect(() => {
      con = prev([f], { registro, reglas: ctxBase() });
    }).not.toThrow();
    expect(sinSugerencia(con?.errores ?? [])).toEqual(sinSugerencia(sin.errores));
  });

  it("H-012-22 · `reglas: null` es una forma imposible, no un contexto sin reglas que apaga el aviso R-ISC", () => {
    // San Juan (BI 770.00, IGV 0.00) solo avisa con reglas (Ratificación 1): 012b debe pasarlas siempre.
    const sanJuan = filaReemplazo({ biDg: "770.00" });
    expect(prev([sanJuan], { reglas: ctxBase() }).avisos.map((a) => a.codigo)).toEqual(["R-ISC"]);
    expect(() => prev([sanJuan], { reglas: null })).toThrow();
  });
});

describe("ronda 1b · campos no textuales del formato y divergencias con generarTxt", () => {
  it("H-012-23 · un monto que supera la longitudMax del formato es error LONGITUD y generarTxt no lo serializa", () => {
    const campos = camposProvisional().map((c) => (c.nombre === "total" ? { ...c, longitudMax: 4 } : c));
    const registro = registroCon(campos);
    const f = filaReemplazo(); // total "118.00": 6 caracteres
    const r = prev([f], { registro });
    expect(r.errores.map((e) => `${e.codigo}:${e.campo}`)).toContain("LONGITUD:total");
    expect(() => generarTxt([f], CABECERA, { registro })).toThrow(ArchivoNoPrevalidadoError);
  });

  it("H-012-24 · si prevalidar dice apto, generarTxt genera: un campo sin serializador no puede registrarse", () => {
    const campos = [...camposProvisional(), { nombre: "campoNuevo", obligatorio: false, longitudMax: 5, tipo: "texto" as const }];
    let registro: RegistroFormatos;
    try {
      registro = registroCon(campos);
    } catch (e) {
      expect(e).toBeInstanceOf(DefinicionFormatoInvalidaError);
      return;
    }
    const f = filaReemplazo();
    expect(prev([f], { registro }).apto).toBe(true);
    expect(() => generarTxt([f], CABECERA, { registro })).not.toThrow();
  });
});

describe("ronda 1b · __proto__, prototipos contaminados, getters y Proxy", () => {
  it("`__proto__` propio en la cabecera o en el proveedor lanza; lo heredado de Object.prototype no llega al TXT", () => {
    const cab = JSON.parse(
      '{"rucDeclarante":"20700000002","periodo":"202610","libro":"compras","__proto__":{"libro":"ventas"}}',
    ) as CabeceraTxt;
    expect(() => prevalidar([filaReemplazo()], { cabecera: cab })).toThrow(EntradaPrevalidacionInvalidaError);
    expect(() => generarTxt([filaReemplazo()], cab, { permitirProvisional: true })).toThrow(
      EntradaPrevalidacionInvalidaError,
    );
    const proveedor = JSON.parse('{"tipo":"6","numero":"20100070970","__proto__":{"razonSocial":"A|B"}}') as FilaReemplazo["proveedor"];
    expect(() => prev([filaReemplazo(undefined, { proveedor })])).toThrow(EntradaPrevalidacionInvalidaError);

    const proto = Object.prototype as Record<string, unknown>;
    proto.razonSocial = "A|B\r\nC";
    proto.xml = "basura";
    proto.tipoCambio = "3.500";
    try {
      const r = generarTxt([filaReemplazo()], CABECERA, { permitirProvisional: true });
      const [linea] = lineasCrlf(r.bytes);
      expect(linea?.split("|")).toHaveLength(21);
      expect(linea?.split("|")[7]).toBe("");
      expect(linea?.split("|")[9]).toBe("");
    } finally {
      delete proto.razonSocial;
      delete proto.xml;
      delete proto.tipoCambio;
    }
  });

  it("H-012-25 · un `patron` heredado de Object.prototype no se aplica a los campos registrados sin patrón", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.patron = /^X$/;
    try {
      const f = filaReemplazo(undefined, { proveedor: { tipo: "6", numero: "20100070970", razonSocial: "ACME SAC" } });
      expect(prev([f]).errores).toEqual([]);
    } finally {
      delete proto.patron;
    }
  });

  it("generarTxt lee cada propiedad de la fila, del comprobante, del proveedor y de la cabecera una sola vez (Proxy)", () => {
    const lecturas = new Map<string, number>();
    const contar = <T extends object>(prefijo: string, o: T): T =>
      new Proxy(o, {
        get(t, k, r) {
          if (typeof k === "string") lecturas.set(`${prefijo}.${k}`, (lecturas.get(`${prefijo}.${k}`) ?? 0) + 1);
          return Reflect.get(t, k, r) as unknown;
        },
      });
    const base = filaReemplazo(undefined, { proveedor: { tipo: "6", numero: "20100070970", razonSocial: "ACME" } });
    let periodo = 0;
    const cabecera = contar("cab", {
      rucDeclarante: "20700000002",
      libro: "compras" as const,
      get periodo() {
        periodo++;
        return periodo === 1 ? "202610" : "202611";
      },
    });
    const fila = contar("fila", {
      ...base,
      comprobante: contar("comp", { ...base.comprobante }),
      proveedor: contar("prov", { ...base.proveedor }),
    });
    const r = generarTxt([fila], cabecera, { permitirProvisional: true });
    expect([...lecturas.values()].every((n) => n === 1)).toBe(true);
    expect(lecturas.size).toBe(17); // fila sin xml (8), comprobante (3), proveedor (3), cabecera (3)
    expect(lineasCrlf(r.bytes)[0]?.startsWith("202610|")).toBe(true);
    expect(r.nombreTxt).toBe("CONTAPP-PROVISIONAL-20700000002-202610-RCE.txt");
  });
});

describe("ronda 1b · registros con versiones solapadas", () => {
  const version = (id: string, v: string, desde: string): FormatoTxt => ({
    ...PROVISIONAL,
    id,
    version: v,
    vigenteDesde: desde,
    oficial: true,
    campos: camposProvisional(),
  });

  it("dos versiones del mismo libro desde el mismo periodo se rechazan aunque tengan otro id; la elección no depende del orden", () => {
    expect(() => RegistroFormatos.desde([version("A", "1", "202601"), version("B", "1", "202601")])).toThrow(
      DefinicionFormatoInvalidaError,
    );
    const lista = [version("RCE", "1", "202601"), version("RCE", "2", "202607"), version("RCE", "3", "202701")];
    for (const orden of [lista, [...lista].reverse(), [lista[1], lista[2], lista[0]] as FormatoTxt[]]) {
      const reg = RegistroFormatos.desde(orden);
      const elegida = (p: string) => seleccionarFormato("compras", p, reg).version;
      expect([elegida("202606"), elegida("202607"), elegida("202612"), elegida("202701"), elegida("209912")]).toEqual([
        "1",
        "2",
        "2",
        "3",
        "3",
      ]);
      expect(() => seleccionarFormato("compras", "202512", reg)).toThrow(FormatoNoVigenteError);
    }
  });
});

describe("ronda 1b · codificar: sustitutos sueltos, caracteres combinados y C1", () => {
  it("UTF-8 estricto, latin1 sin sustituir, y validarCampo rechaza lo que codificar dejaría pasar", () => {
    for (const malo of ["a\uD83D", "\uDE00a", "\uD83D😀", "\uDE00\uD83D", "\uDBFF"]) {
      expect(() => codificar(malo, "utf8")).toThrow(CaracterNoCodificableError);
    }
    expect([...codificar("😀", "utf8")]).toEqual([0xf0, 0x9f, 0x98, 0x80]);
    expect([...codificar("􏿿", "utf8")]).toEqual([0xf4, 0x8f, 0xbf, 0xbf]);
    expect([...codificar("é", "utf8")]).toEqual([0x65, 0xcc, 0x81]);
    expect(() => codificar("é", "latin1")).toThrow(CaracterNoCodificableError);
    expect(() => codificar("Ā", "latin1")).toThrow(CaracterNoCodificableError);
    expect(() => codificar("\u0080", "ascii")).toThrow(CaracterNoCodificableError);
    // codificar acepta C1 y NBSP en latin1; la barrera es validarCampo (D13).
    expect([...codificar("\u0085 ", "latin1")]).toEqual([0x85, 0xa0]);
    for (const [razon, punto] of [
      ["ACME\u0085SAC", "U+0085"],
      ["ACME SAC", "U+00A0"],
      ["ACME SAC", "U+2028"],
      ["ACME\u007FSAC", "U+007F"],
      ["José SAC", "U+0301"],
      ["ACME\uDE00", "U+DE00"],
    ] as const) {
      const f = filaReemplazo(undefined, { proveedor: { tipo: "6", numero: "20100070970", razonSocial: razon } });
      const [e, ...resto] = prev([f]).errores;
      expect(resto).toEqual([]);
      expect(e).toMatchObject({ codigo: "CARACTER_NO_PERMITIDO", campo: "razonSocial" });
      expect(e?.explicacion).toContain(punto);
      expect(e?.explicacion).not.toContain(razon);
    }
    const ok = filaReemplazo(undefined, {
      proveedor: { tipo: "6", numero: "20100070970", razonSocial: "ÑANDÚ ¡¿ÿ ÁÉÍÓÚ" },
    });
    const bytes = generarTxt([ok], CABECERA, { permitirProvisional: true }).bytes;
    expect(latin1(bytes)).toContain("|ÑANDÚ ¡¿ÿ ÁÉÍÓÚ|");
  });
});

describe("ronda 1b · duplicados y resumen", () => {
  it("H-012-26 · el mismo comprobante con el documento del proveedor en otra caja es DUPLICADO (011 lo normaliza a mayúsculas)", () => {
    const a = filaReemplazo(undefined, { id: "a", proveedor: { tipo: "7", numero: "ab12345" } });
    const b = filaReemplazo(undefined, { id: "b", proveedor: { tipo: "7", numero: "AB12345" } });
    const dup = prev([a, b]).errores.filter((e) => e.codigo === "DUPLICADO");
    expect(dup.map((e) => e.filaId)).toEqual(["a", "b"]);
  });

  it("H-012-27 · razón social ausente y razón social vacía dan la misma línea: la fila no cuenta como modificada", () => {
    const original = filaReemplazo();
    const vigente = filaReemplazo(undefined, {
      estado: "modificada",
      proveedor: { tipo: "6", numero: "20100070970", razonSocial: "" },
    });
    const lineaO = lineasCrlf(generarTxt([original], CABECERA, { permitirProvisional: true }).bytes);
    const lineaV = lineasCrlf(generarTxt([vigente], CABECERA, { permitirProvisional: true }).bytes);
    expect(lineaV).toEqual(lineaO);
    expect(resumirCambios([original], [vigente]).modificadas).toBe(0);
  });

  it("H-012-28 · el impacto total en IGV que excede NUMERIC(14,2) no hace lanzar un error de dinero a resumirCambios", () => {
    const agregada = filaReemplazo(undefined, {
      id: "nueva",
      estado: "agregada",
      montos: MontosComprobante.desde("PEN", {
        igvDg: "600000000000.00",
        igvDgng: "600000000000.00",
        total: "0.00",
      }),
    });
    const original = filaReemplazo(undefined, { id: "o1", montos: montosDe("PEN", { biDg: "100.00", igvDg: "18.00" }) });
    expect(() => resumirCambios([original], [original, agregada])).not.toThrow();
  });
});
