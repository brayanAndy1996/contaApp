// Spec 012 · T13a · ronda adversarial 1a (caja negra). Solo la spec, los contratos del plan y la
// API pública de @contapp/domain. Una prueba que falla es un hallazgo H-012-n (ver tasks.md).
// Ataques: spec «Ataques obligatorios» y 04 §2.3 («Dinero / reglas / prevalidación», «Formatos TXT/ZIP»).
import { describe, expect, it } from "vitest";
import {
  ArchivoNoPrevalidadoError,
  CaracterNoCodificableError,
  EntradaPrevalidacionInvalidaError,
  FormatoNoVigenteError,
  FormatosError,
  MontosComprobante,
  Money,
  NombreArchivoInvalidoError,
  PrevalidacionError,
  REGISTRO_FORMATOS,
  RegistroFormatos,
  TASA_IGV_10,
  TASA_IGV_18,
  TipoCambio,
  codificar,
  convertirAPen,
  generarTxt,
  igvCuadra,
  prevalidar,
  resumirCambios,
  seleccionarFormato,
  validarCampo,
  validarNombreArchivo,
} from "../index";
import type { CabeceraTxt, CampoTxt, ErrorPrevalidacion, FilaReemplazo, FormatoTxt } from "../index";
import { CABECERA, filaReemplazo, latin1, lineasCrlf, montosDe } from "../../tests/ayudas/filas-reemplazo";

const PERMITIR = { permitirProvisional: true } as const;
const F = seleccionarFormato("compras", "202610");
const ctx = (cabecera: CabeceraTxt = CABECERA) => ({ cabecera });
const errDe = (errores: readonly ErrorPrevalidacion[], id: string) => errores.filter((e) => e.filaId === id);
const codigosDe = (errores: readonly ErrorPrevalidacion[], id: string) => errDe(errores, id).map((e) => e.codigo);

/** Fila con id y número propios (sin duplicados entre sí). */
const filaN = (i: string | number, over: Parameters<typeof filaReemplazo>[1] = {}, cols?: Parameters<typeof filaReemplazo>[0]) =>
  filaReemplazo(cols, { id: `f${i}`, comprobante: { tipo: "01", serie: "F001", numero: String(i) }, ...over });

/** Céntimos enteros → texto canónico con signo (solo para generar casos; nunca dinero de producción). */
const deCentimos = (c: number): string => {
  const s = c < 0 ? "-" : "";
  const a = Math.abs(c);
  return `${s}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
};

/** PRNG determinista para permutaciones (LCG). */
function barajar<T>(xs: readonly T[], semilla: number): T[] {
  const out = [...xs];
  let x = semilla >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const j = x % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ------------------------------------------------------------------------------------------ dinero
describe("R1a · medio centavo e IGV (D1, D11, D18)", () => {
  it("el error IGV coincide con el oráculo igvCuadra (18 % o 10 %, ±0.01) en bases de medio centavo, signos y base 0", () => {
    const bases = [25, 75, 125, -25, -75, 5, 15, 250, 1005, -1005, 0, 1, -1, 3];
    const discrepancias: string[] = [];
    for (const b of bases) {
      const cand = new Set<number>([0, 1, -1, 2, -2]);
      for (const d of [-3, -2, -1, 0, 1, 2, 3]) {
        cand.add(Math.round((b * 18) / 100) + d);
        cand.add(Math.round((b * 10) / 100) + d);
      }
      const casos = [...cand].map((c, k) => ({ id: `g${k}`, bi: deCentimos(b), igv: deCentimos(c), c }));
      const filas = casos.map((x, k) => filaN(k + 1, { id: x.id }, { biDg: x.bi, igvDg: x.igv }));
      const r = prevalidar(filas, ctx());
      for (const x of casos) {
        const bi = Money.desde(x.bi, "PEN");
        const igv = Money.desde(x.igv, "PEN");
        const cuadra = igvCuadra(bi, igv, TASA_IGV_18) || igvCuadra(bi, igv, TASA_IGV_10);
        const signosDistintos = (bi.esNegativo() && !igv.esNegativo()) || (!bi.esNegativo() && igv.esNegativo());
        const esperado = !igv.esCero() && (bi.esCero() || signosDistintos || !cuadra);
        const obtenido = errDe(r.errores, x.id).some((e) => e.codigo === "IGV" && e.destino === "DG");
        if (esperado !== obtenido) discrepancias.push(`BI ${x.bi} IGV ${x.igv}: esperado ${esperado}, obtenido ${obtenido}`);
      }
    }
    expect(discrepancias).toEqual([]);
  });

  it("base 0.00 con IGV ±0.01 es error IGV (plan T6.1), aunque igvCuadra lo acepte por la tolerancia", () => {
    const filas = [
      filaN(1, {}, { biDg: "0.00", igvDg: "0.01" }),
      filaN(2, {}, { biDg: "0.00", igvDg: "-0.01" }),
      filaN(3, {}, { biDgng: "0.00", igvDgng: "0.01" }),
      filaN(4, {}, { biDng: "0.00", igvDng: "-0.01", noGravado: "5.00" }),
    ];
    const r = prevalidar(filas, ctx());
    expect(codigosDe(r.errores, "f1")).toContain("IGV");
    expect(codigosDe(r.errores, "f2")).toContain("IGV");
    expect(errDe(r.errores, "f3").find((e) => e.codigo === "IGV")?.destino).toBe("DGNG");
    expect(errDe(r.errores, "f4").find((e) => e.codigo === "IGV")?.destino).toBe("DNG");
  });

  it("cuadre con medio centavo: no existe Money de 0.005; ±0.01 bloquea y la diferencia es total − Σ con signo", () => {
    expect(() => Money.desde("0.005", "PEN")).toThrow();
    const mas = filaN(1, { montos: MontosComprobante.desde("PEN", { biDg: "100.00", igvDg: "18.00", total: "118.01" }) });
    const menos = filaN(2, { montos: MontosComprobante.desde("PEN", { biDg: "-100.00", igvDg: "-18.00", total: "-118.01" }) });
    const r = prevalidar([mas, menos], ctx());
    expect(errDe(r.errores, "f1").find((e) => e.codigo === "CUADRE")?.diferencia?.toString()).toBe("0.01");
    expect(errDe(r.errores, "f2").find((e) => e.codigo === "CUADRE")?.diferencia?.toString()).toBe("-0.01");
  });
});

describe("R1a · notas de crédito con todos los tributos", () => {
  const todas = {
    biDg: "-100.00", igvDg: "-18.00", biDgng: "-50.00", igvDgng: "-9.00", biDng: "-20.00",
    igvDng: "-2.00", noGravado: "-10.50", isc: "-5.25", icbper: "-0.50", otrosTributos: "-1.75",
  };

  it("una NC (07) con las 10 columnas negativas, IGV al 18 % y al 10 %, es apta y sale con signo en orden", () => {
    const nc = filaN(1, { comprobante: { tipo: "07", serie: "FC01", numero: "1" } }, todas);
    const r = prevalidar([nc], ctx());
    expect(r.errores).toEqual([]);
    const linea = lineasCrlf(generarTxt([nc], CABECERA, PERMITIR).bytes)[0]!.split("|");
    expect(linea).toHaveLength(21);
    expect(linea.slice(10)).toEqual([...Object.values(todas), "-217.00"]);
  });

  it("NC mixta: el error IGV cita las cifras con signo («-1.61 no es 18 % ni 10 % de -21.48»)", () => {
    const nc = filaN(1, { comprobante: { tipo: "07", serie: "FC01", numero: "2" } }, { biDg: "-21.48", igvDg: "-1.61" });
    const e = errDe(prevalidar([nc], ctx()).errores, "f1").find((x) => x.codigo === "IGV");
    expect(e?.explicacion).toContain("-1.61 no es 18 % ni 10 % de -21.48");
  });
});

describe("R1a · USD con TC de 3 decimales y redondeos acumulados", () => {
  const filasUsd = (n: number, tc: string) =>
    Array.from({ length: n }, (_, i) =>
      filaN(i + 1, { moneda: "USD", tipoCambio: tc, fechaEmision: `2026-10-${String((i % 28) + 1).padStart(2, "0")}` }, {
        biDg: "10.05",
        igvDg: "1.81",
      }),
    );

  it("1.000 filas USD con TC 3.759 generan 1.000 líneas con «3.759», iguales bajo permutación", () => {
    const filas = filasUsd(1000, "3.759");
    const a = generarTxt(filas, CABECERA, PERMITIR);
    expect(a.lineas).toBe(1000);
    const lineas = lineasCrlf(a.bytes);
    expect(lineas).toHaveLength(1000);
    expect(lineas.every((l) => l.split("|")[8] === "USD" && l.split("|")[9] === "3.759")).toBe(true);
    const b = generarTxt(barajar(filas, 7), CABECERA, PERMITIR);
    expect(Array.from(b.bytes)).toEqual(Array.from(a.bytes));
  });

  it("resumirCambios redondea por fila y componente: 500 × 0.099 → 50.00 y 500 × −0.495 → −250.00 (no 49.50 ni −247.50)", () => {
    const orig: FilaReemplazo[] = [];
    for (let i = 1; i <= 1000; i++) {
      const cols = i <= 500 ? { biDg: "0.15", igvDg: "0.03" } : { biDgng: "-0.83", igvDgng: "-0.15" };
      orig.push(filaN(i, { moneda: "USD", tipoCambio: "3.300" }, cols));
    }
    const vig = orig.map((f) => ({ ...f, estado: "excluida" as const }));
    const r = resumirCambios(orig, vig);
    expect(r.excluidas).toBe(1000);
    expect(r.impactoIgv.DG.toString()).toBe("-50.00");
    expect(r.impactoIgv.DGNG.toString()).toBe("250.00");
    expect(r.impactoIgv.DNG.toString()).toBe("0.00");
    expect(r.impactoIgv.total.toString()).toBe("200.00");
    expect(r.filasSinConvertir).toEqual([]);
  });

  it("origenUsd: la conversión exacta de convertirAPen (con medio centavo) es apta; un céntimo menos es CONVERSION_USD", () => {
    const usd = montosDe("USD", { biDg: "0.15", igvDg: "0.03" });
    const pen = convertirAPen(usd, TipoCambio.desde("3.300"));
    expect(pen.obtener("biDg").toString()).toBe("0.50");
    const ok = filaN(1, { montos: pen, origenUsd: { montos: usd, tipoCambio: "3.300" } });
    expect(prevalidar([ok], ctx()).errores).toEqual([]);
    const mal = filaN(2, {
      montos: montosDe("PEN", { biDg: "0.49", igvDg: "0.10" }),
      origenUsd: { montos: usd, tipoCambio: "3.300" },
    });
    const e = errDe(prevalidar([mal], ctx()).errores, "f2").find((x) => x.codigo === "CONVERSION_USD");
    expect(e?.campo).toBe("origenUsd");
  });

  it("TC mal formados en USD dan TC_INVALIDO en tipoCambio; «3.30» sale como «3.300»", () => {
    const malos = ["", "0", "0.000", "-3.300", "3,300", " 3.300", "3.300 ", "3.3001", "１.000", "3.3e0",
      "Infinity", "NaN", "0x3", "03.300", "3.", ".3", "+3.3", "99999.999", "3.300\n"];
    const filas = malos.map((tc, i) => filaN(i + 1, { moneda: "USD", tipoCambio: tc }));
    const r = prevalidar(filas, ctx());
    const sinError = malos.filter((_, i) => !errDe(r.errores, `f${i + 1}`).some((e) => e.codigo === "TC_INVALIDO" && e.campo === "tipoCambio"));
    expect(sinError).toEqual([]);
    const linea = lineasCrlf(generarTxt([filaN(1, { moneda: "USD", tipoCambio: "3.30" })], CABECERA, PERMITIR).bytes)[0]!;
    expect(linea.split("|")[9]).toBe("3.300");
  });
});

// ---------------------------------------------------------------------------------------- excluidas
describe("R1a · filas excluidas que intentan colarse (D4, D14, D17)", () => {
  it("una excluida rota, duplicada y con «|» no bloquea, no sale en el TXT y no hace DUPLICADO con su gemela", () => {
    const valida = filaN(1, { proveedor: { tipo: "6", numero: "20100070970", razonSocial: "VISIBLE" } });
    const gemela = filaN(1, { id: "x1", estado: "excluida", proveedor: { tipo: "6", numero: "20100070970", razonSocial: "OCULTA|1" } });
    const rota = filaN("E999", {
      id: "x2",
      estado: "excluida",
      comprobante: { tipo: "01", serie: "E999", numero: "999" },
      fechaEmision: "2027-01-01",
      montos: MontosComprobante.desde("PEN", { biDg: "1.00", igvDg: "5.00", total: "9.99" }),
    });
    const r = prevalidar([gemela, valida, rota], ctx());
    expect(r.errores).toEqual([]);
    const g = generarTxt([rota, gemela, valida], CABECERA, PERMITIR);
    expect(g.lineas).toBe(1);
    const t = latin1(g.bytes);
    expect(t).not.toContain("E999");
    expect(t).not.toContain("OCULTA");
    expect(t).toContain("VISIBLE");
  });

  it("estados parecidos a «excluida» (mayúsculas, espacios, homoglifo) lanzan, no se tratan como excluida ni como original", () => {
    for (const estado of ["Excluida", "EXCLUIDA", "excluida ", " excluida", "excluída", "еxcluida", "excluded", ""]) {
      const f = { ...filaN(1), estado } as unknown as FilaReemplazo;
      expect(() => prevalidar([f], ctx()), JSON.stringify(estado)).toThrow(EntradaPrevalidacionInvalidaError);
    }
  });

  it("una excluida con el mismo id que una válida lanza (ids repetidos), y con forma imposible también", () => {
    expect(() => prevalidar([filaN(1), filaN(2, { id: "f1", estado: "excluida" })], ctx())).toThrow(EntradaPrevalidacionInvalidaError);
    const sinMarca = { ...filaN(2, { estado: "excluida" }), montos: { total: "1.00" } } as unknown as FilaReemplazo;
    expect(() => prevalidar([filaN(1), sinMarca], ctx())).toThrow(EntradaPrevalidacionInvalidaError);
  });

  it("si solo quedan excluidas tras corregir, SIN_FILAS y generarTxt no da bytes", () => {
    const filas = [filaN(1, { estado: "excluida" }), filaN(2, { estado: "excluida" })];
    const r = prevalidar(filas, ctx());
    expect(r.apto).toBe(false);
    expect(r.errores.map((e) => e.codigo)).toEqual(["SIN_FILAS"]);
    expect(() => generarTxt(filas, CABECERA, PERMITIR)).toThrow(ArchivoNoPrevalidadoError);
  });
});

// ---------------------------------------------------------------------------------------- mutación
describe("R1a · mutación tras prevalidar y resultados congelados", () => {
  it("cambiar una excluida a original después de prevalidar no se cuela: generarTxt vuelve a decidir", () => {
    const rota = filaN(2, { estado: "excluida", montos: MontosComprobante.desde("PEN", { biDg: "1.00", total: "2.00" }) });
    const filas = [filaN(1), rota];
    expect(prevalidar(filas, ctx()).apto).toBe(true);
    (rota as { estado: string }).estado = "original";
    expect(() => generarTxt(filas, CABECERA, PERMITIR)).toThrow(ArchivoNoPrevalidadoError);
  });

  it("el resultado de prevalidar y el de ArchivoNoPrevalidadoError están congelados en profundidad", () => {
    const r = prevalidar([filaN(1, {}, { biDg: "21.48", igvDg: "1.61" })], ctx());
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.errores)).toBe(true);
    expect(Object.isFrozen(r.avisos)).toBe(true);
    expect(Object.isFrozen(r.formato)).toBe(true);
    expect(r.errores.every((e) => Object.isFrozen(e))).toBe(true);
    try {
      generarTxt([filaN(1, {}, { biDg: "21.48", igvDg: "1.61" })], CABECERA, PERMITIR);
      expect.unreachable();
    } catch (e) {
      const res = (e as ArchivoNoPrevalidadoError).resultado;
      expect(Object.isFrozen(res) && Object.isFrozen(res.errores) && Object.isFrozen(res.formato)).toBe(true);
      expect(res.errores.every((x) => Object.isFrozen(x))).toBe(true);
      expect("bytes" in (e as object)).toBe(false);
    }
  });

  it("modificar los bytes devueltos no altera una segunda generación", () => {
    const filas = [filaN(1), filaN(2)];
    const a = generarTxt(filas, CABECERA, PERMITIR);
    const copia = Array.from(a.bytes);
    a.bytes.fill(0x7c);
    expect(Array.from(generarTxt(filas, CABECERA, PERMITIR).bytes)).toEqual(copia);
  });
});

// ------------------------------------------------------------------------------------------ textos
describe("R1a · razón social con caracteres que rompen el formato (D13)", () => {
  const rs = F.campos.find((c) => c.nombre === "razonSocial")!;
  const malos: Array<[string, string, number]> = [
    ["separador", "ACME|SAC", 4],
    ["CRLF", "ACME\r\nSAC", 4],
    ["LF", "ACME\nSAC", 4],
    ["TAB", "ACME\tSAC", 4],
    ["NBSP", "ACME\u00A0SAC", 4],
    ["NEL (C1)", "ACME\u0085", 4],
    ["DEL", "ACME\u007F", 4],
    ["NUL", "\u0000ACME", 0],
    ["homoglifo cirílico А", "\u0410CME", 0],
    ["homoglifo griego Ο", "ACM\u039F", 3],
    ["emoji", "ACME 😀 SAC", 5],
    ["sustituto suelto", "ACME\uD83D", 4],
    ["combinante", "PEN\u0303A", 3],
    ["euro (cp1252 0x80)", "ACME €", 5],
    ["ZWSP", "AC\u200BME", 2],
    ["BOM", "\uFEFFACME", 0],
    ["U+2028", "ACME\u2028", 4],
  ];

  it.each(malos)("%s → CARACTER_NO_PERMITIDO en razonSocial con la posición exacta y sin el texto crudo", (_n, valor, pos) => {
    expect(validarCampo(valor, rs, F)).toEqual({ codigo: "CARACTER_NO_PERMITIDO", posicion: pos });
    const f = filaN(1, { proveedor: { tipo: "6", numero: "20100070970", razonSocial: valor } });
    const errs = errDe(prevalidar([f], ctx()).errores, "f1");
    const e = errs.find((x) => x.codigo === "CARACTER_NO_PERMITIDO" && x.campo === "razonSocial");
    expect(e).toBeDefined();
    expect(e!.explicacion).toMatch(/U\+[0-9A-F]{4}/);
    expect(e!.explicacion).not.toContain("ACME");
  });

  it("tildes, ñ, ü, & y símbolos latin1 pasan sin alterarse y salen en latin1", () => {
    const valor = "JOSÉ ÑÚÑEZ & CÍA. «ÜBER» S.A.C. ¿OK? ¡SÍ! ÿ";
    const f = filaN(1, { proveedor: { tipo: "6", numero: "20100070970", razonSocial: valor } });
    expect(prevalidar([f], ctx()).errores).toEqual([]);
    const bytes = generarTxt([f], CABECERA, PERMITIR).bytes;
    expect(latin1(bytes)).toContain(`|${valor}|`);
    expect(Array.from(bytes)).toContain(0xd1);
    expect(Array.from(bytes)).toContain(0xff);
  });

  it("en un formato ascii con separador «~», «PEÑA» y «A~B» son errores de prevalidación (no CaracterNoCodificableError al serializar)", () => {
    const ascii: FormatoTxt = {
      ...F,
      id: "PRUEBA-ASCII",
      version: "1",
      codificacion: "ascii",
      separador: "~",
      campos: F.campos.map((c) => ({ ...c })),
      nombre: ({ ruc, periodo }) => ({ nombreTxt: `ASCII-${ruc}-${periodo}.txt`, nombreZip: `ASCII-${ruc}-${periodo}.zip` }),
    };
    const registro = RegistroFormatos.desde([ascii]);
    const fa = seleccionarFormato("compras", "202610", registro);
    const rsA = fa.campos.find((c) => c.nombre === "razonSocial")!;
    expect(validarCampo("PEÑA", rsA, fa)).toEqual({ codigo: "CARACTER_NO_PERMITIDO", posicion: 2 });
    expect(validarCampo("A~B", rsA, fa)).toEqual({ codigo: "CARACTER_NO_PERMITIDO", posicion: 1 });
    expect(validarCampo("A|B", rsA, fa)).toBeNull();
    const filas = [
      filaN(1, { proveedor: { tipo: "6", numero: "20100070970", razonSocial: "PEÑA" } }),
      filaN(2, { proveedor: { tipo: "6", numero: "20100070970", razonSocial: "A~B" } }),
    ];
    const r = prevalidar(filas, { cabecera: CABECERA, registro });
    expect(codigosDe(r.errores, "f1")).toContain("CARACTER_NO_PERMITIDO");
    expect(codigosDe(r.errores, "f2")).toContain("CARACTER_NO_PERMITIDO");
    let lanzado: unknown;
    try {
      generarTxt(filas, CABECERA, { ...PERMITIR, registro });
    } catch (e) {
      lanzado = e;
    }
    expect(lanzado).toBeInstanceOf(ArchivoNoPrevalidadoError);
  });

  it("ninguna explicación ni mensaje lleva texto crudo de la fila (serie, número, documento, razón social)", () => {
    const f = filaN(1, {
      comprobante: { tipo: "01", serie: "<b>", numero: "12A" },
      proveedor: { tipo: "6", numero: "SECRETO-99", razonSocial: "CONFIDENCIAL|X" },
    });
    try {
      generarTxt([f], CABECERA, PERMITIR);
      expect.unreachable();
    } catch (e) {
      const err = e as ArchivoNoPrevalidadoError;
      const todo = [err.message, ...err.resultado.errores.map((x) => x.explicacion)].join("\n");
      for (const crudo of ["<b>", "12A", "SECRETO", "CONFIDENCIAL"]) expect(todo).not.toContain(crudo);
    }
  });
});

// ------------------------------------------------------------------------------------- longitudes
describe("R1a · longitudes en el borde exacto", () => {
  const conRs = (i: number, razonSocial: string) => filaN(i, { proveedor: { tipo: "6", numero: "20100070970", razonSocial } });

  it("razón social de 100 caracteres (también 100 «Ñ») pasa; de 101 es LONGITUD", () => {
    const r = prevalidar([conRs(1, "A".repeat(100)), conRs(2, "Ñ".repeat(100)), conRs(3, "A".repeat(101)), conRs(4, "Ñ".repeat(101))], ctx());
    expect(codigosDe(r.errores, "f1")).toEqual([]);
    expect(codigosDe(r.errores, "f2")).toEqual([]);
    expect(codigosDe(r.errores, "f3")).toEqual(["LONGITUD"]);
    expect(codigosDe(r.errores, "f4")).toEqual(["LONGITUD"]);
    const t = generarTxt([conRs(2, "Ñ".repeat(100))], CABECERA, PERMITIR);
    expect(lineasCrlf(t.bytes)[0]!.split("|")[7]).toHaveLength(100);
  });

  it("serie 4/5, número 8/9 y documento 15/16: el borde pasa y el siguiente falla en su campo", () => {
    const ok = [
      filaN(1, { comprobante: { tipo: "01", serie: "FFFF", numero: "99999999" } }),
      filaN(2, { proveedor: { tipo: "0", numero: "A".repeat(15) } }),
    ];
    expect(prevalidar(ok, ctx()).errores).toEqual([]);
    const mal = [
      filaN(3, { comprobante: { tipo: "01", serie: "FFFFF", numero: "3" } }),
      filaN(4, { comprobante: { tipo: "01", serie: "F001", numero: "123456789" } }),
      filaN(5, { proveedor: { tipo: "0", numero: "A".repeat(16) } }),
    ];
    const r = prevalidar(mal, ctx());
    expect(errDe(r.errores, "f3").map((e) => e.campo)).toContain("serie");
    expect(errDe(r.errores, "f4").map((e) => e.campo)).toContain("numero");
    expect(errDe(r.errores, "f5").map((e) => e.campo)).toContain("numeroDocProveedor");
  });

  it("montos en el tope de NUMERIC(14,2), positivo y negativo, salen completos (16 caracteres con el signo)", () => {
    const grande = filaN(1, {}, { biDg: "847457627118.63", igvDg: "152542372881.35" });
    const nc = filaN(2, { comprobante: { tipo: "07", serie: "FC01", numero: "2" } }, { biDg: "-847457627118.63", igvDg: "-152542372881.35" });
    expect(prevalidar([grande, nc], ctx()).errores).toEqual([]);
    const lineas = lineasCrlf(generarTxt([grande, nc], CABECERA, PERMITIR).bytes);
    expect(lineas.map((l) => l.split("|")[20])).toEqual(["999999999999.98", "-999999999999.98"]);
  });
});

// ----------------------------------------------------------------------------------- fechas/periodo
describe("R1a · periodo de otro año y fechas", () => {
  it("fechas de otro año anteriores al periodo son válidas; desde el día siguiente al cierre, FECHA_POSTERIOR_AL_PERIODO", () => {
    const filas = [
      filaN(1, { fechaEmision: "2025-12-31" }),
      filaN(2, { fechaEmision: "2019-01-01" }),
      filaN(3, { fechaEmision: "2026-10-31" }),
      filaN(4, { fechaEmision: "2026-11-01" }),
      filaN(5, { fechaEmision: "2027-01-01" }),
    ];
    const r = prevalidar(filas, ctx());
    expect(codigosDe(r.errores, "f1")).toEqual([]);
    expect(codigosDe(r.errores, "f2")).toEqual([]);
    expect(codigosDe(r.errores, "f3")).toEqual([]);
    expect(codigosDe(r.errores, "f4")).toEqual(["FECHA_POSTERIOR_AL_PERIODO"]);
    expect(codigosDe(r.errores, "f5")).toEqual(["FECHA_POSTERIOR_AL_PERIODO"]);
  });

  it("fechas imposibles o mal escritas son FECHA_INVALIDA; 29/02 solo en bisiesto", () => {
    const malas = ["2026-02-29", "2026-04-31", "2026-10-5", "2026-10-05T00:00", "２０２６-10-05", "2026/10/05", "+02026-10-05", "2026-00-10", "2026-10-00"];
    const filas = malas.map((f, i) => filaN(i + 1, { fechaEmision: f }));
    const r = prevalidar(filas, ctx());
    const sinError = malas.filter((_, i) => !codigosDe(r.errores, `f${i + 1}`).includes("FECHA_INVALIDA"));
    expect(sinError).toEqual([]);
    const bisiesto = prevalidar([filaN(1, { fechaEmision: "2028-02-29" })], ctx({ ...CABECERA, periodo: "202802" }));
    expect(bisiesto.errores).toEqual([]);
  });

  it("el año 0000 no es una fecha de emisión válida (saldría «01/01/0000» en el TXT)", () => {
    const r = prevalidar([filaN(1, { fechaEmision: "0000-01-01" })], ctx());
    expect(codigosDe(r.errores, "f1")).toContain("FECHA_INVALIDA");
  });

  it("el orden del TXT es cronológico a través del cambio de año y de mes (no por el texto DD/MM/AAAA)", () => {
    const filas = [
      filaN(1, { fechaEmision: "2026-10-02" }),
      filaN(2, { fechaEmision: "2026-09-10" }),
      filaN(3, { fechaEmision: "2026-01-01" }),
      filaN(4, { fechaEmision: "2025-12-31" }),
    ];
    const fechas = lineasCrlf(generarTxt(filas, CABECERA, PERMITIR).bytes).map((l) => l.split("|")[4]);
    expect(fechas).toEqual(["31/12/2025", "01/01/2026", "10/09/2026", "02/10/2026"]);
  });

  it("periodo de cabecera: 202512 no tiene versión; «202610\\n», «２０２６１０» y «202613» son forma imposible", () => {
    expect(() => prevalidar([filaN(1, { fechaEmision: "2025-12-01" })], ctx({ ...CABECERA, periodo: "202512" }))).toThrow(FormatoNoVigenteError);
    for (const periodo of ["202610\n", "２０２６１０", "202613", "2026-10", " 202610"]) {
      expect(() => prevalidar([filaN(1)], ctx({ ...CABECERA, periodo })), JSON.stringify(periodo)).toThrow(EntradaPrevalidacionInvalidaError);
    }
  });
});

// ----------------------------------------------------------------------- permutación y duplicados
describe("R1a · determinismo bajo permutación y duplicados", () => {
  it("serie en minúscula/mayúscula, números con ceros y documentos distintos: 20 permutaciones dan los mismos bytes", () => {
    const filas = [
      filaN(1, { comprobante: { tipo: "01", serie: "F001", numero: "10" } }),
      filaN(2, { comprobante: { tipo: "01", serie: "F001", numero: "9" } }),
      filaN(3, { comprobante: { tipo: "01", serie: "F001", numero: "0010" }, proveedor: { tipo: "6", numero: "20700000002" } }),
      filaN(4, { comprobante: { tipo: "01", serie: "f001", numero: "10" }, proveedor: { tipo: "6", numero: "20700000011" } }),
      filaN(5, { comprobante: { tipo: "03", serie: "B001", numero: "1" } }),
      filaN(6, { comprobante: { tipo: "01", serie: "E001", numero: "100" }, fechaEmision: "2025-01-01" }),
      filaN(7, { comprobante: { tipo: "01", serie: "F001", numero: "00000009" }, proveedor: { tipo: "6", numero: "20700000045" } }),
    ];
    expect(prevalidar(filas, ctx()).errores).toEqual([]);
    const base = Array.from(generarTxt(filas, CABECERA, PERMITIR).bytes);
    for (let s = 1; s <= 20; s++) {
      expect(Array.from(generarTxt(barajar(filas, s), CABECERA, PERMITIR).bytes), `semilla ${s}`).toEqual(base);
    }
  });

  it("f001/F001 y 0123/123 del mismo proveedor son DUPLICADO en todas las copias; la copia excluida no cuenta", () => {
    const filas = [
      filaN(1, { comprobante: { tipo: "01", serie: "F001", numero: "123" } }),
      filaN(2, { comprobante: { tipo: "01", serie: "f001", numero: "0123" } }),
      filaN(3, { comprobante: { tipo: "01", serie: "F001", numero: "000123" } }),
      filaN(4, { estado: "excluida", comprobante: { tipo: "01", serie: "F001", numero: "123" } }),
    ];
    const r = prevalidar(filas, ctx());
    for (const id of ["f1", "f2", "f3"]) expect(codigosDe(r.errores, id), id).toContain("DUPLICADO");
    expect(codigosDe(r.errores, "f4")).toEqual([]);
  });

  it("600 copias del mismo comprobante con ids de 64 caracteres: cada explicación DUPLICADO queda acotada (no crece con n²)", () => {
    const filas = Array.from({ length: 600 }, (_, i) => filaN(1, { id: `${String(i).padStart(4, "0")}${"x".repeat(60)}` }));
    const r = prevalidar(filas, ctx());
    const dup = r.errores.filter((e) => e.codigo === "DUPLICADO");
    expect(dup).toHaveLength(600);
    const maximo = Math.max(...dup.map((e) => e.explicacion.length));
    expect(maximo).toBeLessThanOrEqual(2000);
  });
});

// ---------------------------------------------------------------------------------- resumirCambios
describe("R1a · resumirCambios (D12, CA-8)", () => {
  it("modificada y devuelta a sus valores, TC 3.3 = 3.300 y otro xml no cuentan; NC excluida suma IGV positivo", () => {
    const o1 = filaN(1);
    const o2 = filaN(2, { moneda: "USD", tipoCambio: "3.300" });
    const o3 = filaN(3, { comprobante: { tipo: "07", serie: "FC01", numero: "3" } }, { biDg: "-100.00", igvDg: "-18.00" });
    const v1 = { ...o1, estado: "modificada" as const, montos: montosDe("PEN", { biDg: "100.00", igvDg: "18.00" }) };
    const v2 = { ...o2, estado: "modificada" as const, tipoCambio: "3.3" };
    const v3 = { ...o3, estado: "excluida" as const };
    const r = resumirCambios([o1, o2, o3], [v1, v2, v3]);
    expect(r.modificadas).toBe(0);
    expect(r.excluidas).toBe(1);
    expect(r.impactoIgv.DG.toString()).toBe("18.00");
    expect(r.impactoIgv.total.toString()).toBe("18.00");
  });

  it("razón social ausente → «» no cambia la línea del TXT y no cuenta como modificada; cambiar la moneda sí cuenta", () => {
    const o1 = filaN(1);
    const o2 = filaN(2);
    const v1 = { ...o1, estado: "modificada" as const, proveedor: { tipo: "6", numero: "20100070970", razonSocial: "" } };
    const v2 = { ...o2, estado: "modificada" as const, montos: montosDe("USD", { biDg: "100.00", igvDg: "18.00" }), tipoCambio: "3.300" };
    const lineaDe = (f: FilaReemplazo) => latin1(generarTxt([f], CABECERA, PERMITIR).bytes);
    expect(lineaDe(v1)).toBe(lineaDe(o1));
    expect(resumirCambios([o1, o2], [v1, v2]).modificadas).toBe(1);
  });

  it("ids repetidos en el vigente o un original que no es «original» lanzan", () => {
    const o1 = filaN(1);
    expect(() => resumirCambios([o1], [o1, { ...o1 }])).toThrow(EntradaPrevalidacionInvalidaError);
    expect(() => resumirCambios([{ ...o1, estado: "modificada" }], [o1])).toThrow(EntradaPrevalidacionInvalidaError);
    expect(() => resumirCambios([o1, { ...o1 }], [o1])).toThrow(EntradaPrevalidacionInvalidaError);
  });
});

// ------------------------------------------------------------------------------ codificar y campos
describe("R1a · codificar", () => {
  it("nunca sustituye: €, sustitutos sueltos o invertidos y caracteres fuera del rango lanzan", () => {
    expect(() => codificar("€", "latin1")).toThrow(CaracterNoCodificableError);
    expect(() => codificar("Ñ", "ascii")).toThrow(CaracterNoCodificableError);
    expect(() => codificar("\u0100", "latin1")).toThrow(CaracterNoCodificableError);
    expect(() => codificar("\u0080", "ascii")).toThrow(CaracterNoCodificableError);
    for (const c of ["\uD800", "\uDFFF", "\uDC00\uD800", "a\uD83D", "\uDE00b"]) {
      expect(() => codificar(c, "utf8"), JSON.stringify(c)).toThrow(CaracterNoCodificableError);
    }
    for (const cod of ["LATIN1", "utf-8", "iso-8859-1", "", "__proto__", "toString"]) {
      expect(() => codificar("a", cod as "utf8"), cod).toThrow(CaracterNoCodificableError);
    }
    expect(() => codificar(new String("a") as unknown as string, "utf8")).toThrow(CaracterNoCodificableError);
  });

  it("utf8 de 1 a 4 bytes, latin1 de un byte y arreglos nuevos en cada llamada", () => {
    expect(Array.from(codificar("A\u00F1\u20AC😀\u{10FFFF}", "utf8"))).toEqual([
      0x41, 0xc3, 0xb1, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80, 0xf4, 0x8f, 0xbf, 0xbf,
    ]);
    expect(Array.from(codificar("\u00FF\u0000", "latin1"))).toEqual([0xff, 0x00]);
    expect(codificar("", "ascii")).toHaveLength(0);
    const a = codificar("x", "ascii");
    a[0] = 0;
    expect(Array.from(codificar("x", "ascii"))).toEqual([0x78]);
  });
});

describe("R1a · validarCampo y validarNombreArchivo nunca lanzan", () => {
  const rs = F.campos.find((c) => c.nombre === "razonSocial")!;
  const raros: unknown[] = [null, undefined, 123, 12n, true, {}, [], Symbol("s"), { toString: () => "ok" }, new String("ok"), () => "x"];

  it("validarCampo con valores que no son string no lanza", () => {
    for (const v of raros) expect(() => validarCampo(v as unknown as string, rs, F), String(typeof v)).not.toThrow();
  });

  it("validarCampo es determinista con un patrón /g de un campo suelto (lastIndex no arrastra estado)", () => {
    const campo: CampoTxt = { nombre: "c", obligatorio: true, longitudMax: 10, tipo: "codigo", patron: /^[0-9]+$/g };
    const resultados = [1, 2, 3, 4].map(() => validarCampo("123", campo, F));
    expect(resultados).toEqual([null, null, null, null]);
  });

  it("validarNombreArchivo: ../, rutas, NUL, salto final, ancho completo, mayúsculas y no-strings dan false sin lanzar", () => {
    const ok = "CONTAPP-PROVISIONAL-20700000002-202610-RCE.txt";
    expect(validarNombreArchivo(ok)).toBe(true);
    const malos: unknown[] = [
      `../${ok}`, `..\\${ok}`, `/${ok}`, `C:\\${ok}`, `${ok}\n`, `${ok}\u0000`, `${ok}/`, `${ok}.zip`,
      ok.replace("2070", "２０７０"), ok.replace(".txt", ".TXT"), ok.replace("202610", "202613"),
      ok.replace("20700000002", "2070000000"), ok.replace("-RCE", "-RCE/.."), ` ${ok}`,
      ...raros,
    ];
    for (const m of malos) {
      let r: unknown;
      expect(() => (r = validarNombreArchivo(m as unknown as string)), String(m)).not.toThrow();
      expect(r, JSON.stringify(String(m))).toBe(false);
    }
  });
});

// --------------------------------------------------------------------------------------- registro
describe("R1a · registro de formatos y opciones de generarTxt", () => {
  it("permitirProvisional con valores «truthy» que no son true no habilita el provisional", () => {
    for (const v of ["false", "true", 1, {}, [], "0"]) {
      expect(() => generarTxt([filaN(1)], CABECERA, { permitirProvisional: v as unknown as boolean }), JSON.stringify(v)).toThrow();
    }
  });

  it("un registro falso (instancia sin marca, objeto plano) no se acepta en generarTxt ni en prevalidar", () => {
    const falsos: unknown[] = [Object.create(RegistroFormatos.prototype), {}, { formatos: [F] }];
    for (const registro of falsos) {
      let e1: unknown;
      let e2: unknown;
      try {
        generarTxt([filaN(1)], CABECERA, { ...PERMITIR, registro: registro as RegistroFormatos });
      } catch (e) {
        e1 = e;
      }
      try {
        prevalidar([filaN(1)], { cabecera: CABECERA, registro: registro as RegistroFormatos });
      } catch (e) {
        e2 = e;
      }
      for (const e of [e1, e2]) {
        expect(e instanceof FormatosError || e instanceof PrevalidacionError, String(e)).toBe(true);
      }
    }
  });

  it("dos versiones: el borde exacto de vigenteDesde elige la nueva; cambiar el objeto original tras desde() no afecta", () => {
    const v1: FormatoTxt = { ...F, id: "X", version: "1", vigenteDesde: "202601", campos: F.campos.map((c) => ({ ...c })), nombre: F.nombre };
    const campos2 = F.campos.map((c) => ({ ...c }));
    const v2 = { ...F, id: "X", version: "2", vigenteDesde: "202607", oficial: true, campos: campos2, nombre: F.nombre };
    const reg = RegistroFormatos.desde([v2, v1]);
    expect(seleccionarFormato("compras", "202606", reg).version).toBe("1");
    expect(seleccionarFormato("compras", "202607", reg).version).toBe("2");
    expect(seleccionarFormato("compras", "209912", reg).version).toBe("2");
    (v2 as { oficial: boolean }).oficial = false;
    (campos2[7] as { longitudMax: number }).longitudMax = 1;
    const elegido = seleccionarFormato("compras", "202610", reg);
    expect(elegido.oficial).toBe(true);
    expect(elegido.campos[7]!.longitudMax).toBe(100);
    for (const p of [202607, "2026-07", "202607 ", null]) {
      expect(() => seleccionarFormato("compras", p as unknown as string, reg), String(p)).toThrow(FormatoNoVigenteError);
    }
  });

  it("un formato cuyo nombre() devuelve rutas o nombres inseguros hace lanzar NombreArchivoInvalidoError en generarTxt", () => {
    const malos: Array<[string, string]> = [
      ["../x.txt", "../x.zip"],
      ["a/b.txt", "a/b.zip"],
      [".oculto.txt", ".oculto.zip"],
      ["x..txt", "x..zip"],
      ["x.txt", "y.zip"],
      ["x.txt\u0000", "x.zip"],
      ["x.txt", "x.txt.zip"],
      ["x\\y.txt", "x\\y.zip"],
    ];
    for (const [nombreTxt, nombreZip] of malos) {
      const reg = RegistroFormatos.desde([
        { ...F, id: "N", version: "1", oficial: true, campos: F.campos.map((c) => ({ ...c })), nombre: () => ({ nombreTxt, nombreZip }) },
      ]);
      expect(() => generarTxt([filaN(1)], CABECERA, { registro: reg }), nombreTxt).toThrow(NombreArchivoInvalidoError);
    }
  });

  it("REGISTRO_FORMATOS no se puede ampliar ni alterar desde fuera", () => {
    expect(Object.isFrozen(REGISTRO_FORMATOS)).toBe(true);
    expect(() => generarTxt([filaN(1)], CABECERA)).toThrow();
  });
});
