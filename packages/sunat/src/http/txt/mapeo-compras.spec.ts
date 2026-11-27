import { describe, expect, it } from "vitest";
import { generarFilasComprasVolumen } from "../../mock/sire-api-client.mock.js";
import type { FilaPropuestaSire } from "../../puertos.js";
import { capturarSync, esperarError, fixture, sinSecretos } from "../pruebas/ayudas-http.js";
import { MIB, conCelda, conEncabezado, leerTabla, sinColumna, utf8, zipSyncDe } from "../pruebas/ayudas-txt.js";
import { extraerTxtDeZip } from "../zip-seguro.js";
import { leerTxt } from "./leer-txt.js";
import { mapearCompras } from "./mapeo-compras.js";

// Contrato de `txt/mapeo-compras.ts` (plan 041, «Mapeo»; spec CA-3, CA-5, CA-6, CA-7, CA-14):
//  - `mapearCompras(txt: TxtLeido, esperado: { ruc: string; periodo: string }): FilaPropuestaSire[]` es SÍNCRONA y pura.
//    Lee las columnas por NOMBRE de encabezado normalizado (orden, columnas extra y mayúsculas no importan). La columna
//    del proveedor es `Apellidos Nombres/ Razón  Social` (14) y NUNCA la del contribuyente, `Apellidos y Nombres o Razón social` (2).
//  - Campos: `tipo`, `serie`, `numero` (de `Nro CP o Doc. Nro Inicial (Rango)`, sin cambiar), `rucContraparte` = `Nro Doc Identidad`,
//    `tipoDocContraparte` = `Tipo Doc Identidad` (tal cual: "6", "1"…), `razonSocialContraparte`, `fechaEmision` AAAA-MM-DD,
//    `moneda` PEN|USD, `tipoCambio` SOLO si es USD, montos con 2 decimales (`Money`), `noGravado` = `Valor Adq. NG`, `otros` = `Otros Trib/ Cargos`.
//  - Requeridas (ausente o duplicada -> `ErrorPortalSire("encabezado")`): RUC, Periodo, Tipo CP/Doc., Serie del CDP, Nro CP o Doc. Nro Inicial (Rango),
//    Tipo Doc Identidad, Nro Doc Identidad, Apellidos Nombres/ Razón Social, Fecha de emisión, Moneda, Tipo de Cambio, los seis BI/IGV, Valor Adq. NG,
//    ISC, ICBPER, Otros Trib/ Cargos, Total CP, IMB, Nro Final (Rango).
//  - Cada fila: `RUC` = esperado.ruc y `Periodo` = esperado.periodo, o `ErrorDatosSire("respuesta_ajena")` sin devolver filas.
//    Monto fuera de `^-?\d{1,12}(\.\d{1,2})?$` (3 decimales, miles, exponente, vacío, 13 enteros), fecha imposible o fuera de dd/mm/aaaa, moneda
//    distinta de PEN/USD, tipo de cambio fuera de `^\d{1,4}\.\d{1,3}$` en USD, `tipo`/`numero` vacíos -> `ErrorDatosSire("fila_invalida")`.
//    Jamás se redondea. Se valida TODO el archivo antes de devolver filas.
//  - P-2: `IMB` o `Nro Final (Rango)` con valor distinto de vacío/cero -> `ErrorDatosSire("columna_no_soportada")`. `Año`, CAR, vencimiento,
//    documento modificado, detracción y `CLU*` se ignoran.
//  - Los errores tienen mensaje fijo: no copian valores del archivo.
const ESPERADO = { ruc: "20700000002", periodo: "202610" } as const;
const BASE = fixture("compras-propuesta-202610.txt");

function mapear(bytes: Uint8Array, esperado: { ruc: string; periodo: string } = ESPERADO): FilaPropuestaSire[] {
  return mapearCompras(leerTxt(bytes), esperado);
}
function falla(bytes: Uint8Array, esperado: { ruc: string; periodo: string } = ESPERADO): unknown {
  return capturarSync(() => mapear(bytes, esperado));
}

const CERO = "0.00";
function fila(p: Partial<FilaPropuestaSire> & Pick<FilaPropuestaSire, "serie" | "numero" | "rucContraparte" | "razonSocialContraparte" | "fechaEmision" | "total">): FilaPropuestaSire {
  return {
    tipo: "01",
    tipoDocContraparte: "6",
    moneda: "PEN",
    biDg: CERO,
    igvDg: CERO,
    biDgng: CERO,
    igvDgng: CERO,
    biDng: CERO,
    igvDng: CERO,
    noGravado: CERO,
    isc: CERO,
    icbper: CERO,
    otros: CERO,
    ...p,
  };
}
const ESPERADAS: FilaPropuestaSire[] = [
  fila({ serie: "F001", numero: "1040", rucContraparte: "20700000011", razonSocialContraparte: "PRUEBA PROVEEDOR ISC S.A.C.", fechaEmision: "2026-10-05", biDg: "770.00", total: "770.00" }),
  fila({ serie: "F001", numero: "2056", rucContraparte: "20700000045", razonSocialContraparte: "PRUEBA PROVEEDOR MIXTO S.A.C.", fechaEmision: "2026-10-06", biDg: "21.48", igvDg: "1.61", total: "23.09" }),
  fila({ serie: "F001", numero: "3064", rucContraparte: "20700000053", razonSocialContraparte: "PRUEBA PROVEEDOR BOLSAS S.A.C.", fechaEmision: "2026-10-07", biDg: "100.00", igvDg: "18.00", icbper: "1.50", total: "119.50" }),
  fila({ serie: "F001", numero: "4062", rucContraparte: "20700000061", razonSocialContraparte: "PRUEBA PROVEEDOR USD S.A.C.", fechaEmision: "2026-10-08", moneda: "USD", tipoCambio: "3.300", biDg: "0.15", igvDg: "0.03", total: "0.18" }),
  fila({ serie: "F001", numero: "5070", rucContraparte: "20700000070", razonSocialContraparte: "PRUEBA PROVEEDOR CALZADO S.A.C.", fechaEmision: "2026-10-09", biDg: "150.00", igvDg: "27.00", total: "177.00" }),
  fila({ tipo: "07", serie: "F001", numero: "6", rucContraparte: "20700000096", razonSocialContraparte: "PRUEBA PROVEEDOR GENERICO S.A.C.", fechaEmision: "2026-10-12", biDg: "-50.00", igvDg: "-9.00", total: "-59.00" }),
  fila({ serie: "F003", numero: "20", rucContraparte: "20700000045", razonSocialContraparte: "PRUEBA PROVEEDOR MIXTO S.A.C.", fechaEmision: "2026-10-13", biDg: "100.00", igvDg: "18.00", biDgng: "50.00", igvDgng: "9.00", total: "177.00" }),
  fila({ serie: "F002", numero: "10", rucContraparte: "20700000096", razonSocialContraparte: "PRUEBA PROVEEDOR GENERICO S.A.C.", fechaEmision: "2026-10-14", noGravado: "120.00", total: "120.00" }),
  fila({ serie: "F002", numero: "11", rucContraparte: "20700000096", razonSocialContraparte: "PRUEBA PROVEEDOR GENERICO S.A.C.", fechaEmision: "2026-10-15", noGravado: "80.00", total: "80.00" }),
];

describe("mapearCompras · fixture base (CA-3)", () => {
  it("las 9 filas esperadas, en orden: San Juan, mixta, ICBPER, USD, zapatilla, NC, DG+DGNG, exonerada e inafecta", () => {
    expect(mapear(BASE)).toEqual(ESPERADAS);
  });

  it("la razón social es la del proveedor (columna 14), nunca la del contribuyente (columna 2, que varía por fila)", () => {
    const r = mapear(BASE);
    for (const f of r) {
      expect(f.razonSocialContraparte).toMatch(/^PRUEBA PROVEEDOR /);
      expect(f.razonSocialContraparte).not.toContain("CONTRIBUYENTE");
    }
  });

  it("`tipoCambio` solo en USD (en PEN el archivo trae 1.000 y no se copia)", () => {
    const r = mapear(BASE);
    expect(r.filter((f) => "tipoCambio" in f && f.tipoCambio !== undefined).map((f) => f.numero)).toEqual(["4062"]);
    expect(r.every((f) => f.moneda === "PEN" || f.tipoCambio === "3.300")).toBe(true);
  });

  it("montos como cadenas de 2 decimales: ningún `number` en la fila", () => {
    for (const f of mapear(BASE)) {
      for (const [k, v] of Object.entries(f)) expect(typeof v, k).toBe("string");
    }
  });

  it("montos con un decimal o enteros se normalizan a 2 decimales, sin redondear", () => {
    const b = conCelda(conCelda(BASE, 1, "BI Gravado DG", "770.5"), 1, "Total CP", "771");
    const f = mapear(b)[0]!;
    expect([f.biDg, f.total]).toEqual(["770.50", "771.00"]);
  });

  it("el máximo de NUMERIC(14,2) (999999999999.99) se acepta", () => {
    expect(mapear(conCelda(BASE, 1, "BI Gravado DG", "999999999999.99"))[0]!.biDg).toBe("999999999999.99");
  });

  it("documento DNI: `tipoDocContraparte` 1 y el número en `rucContraparte`", () => {
    const b = conCelda(conCelda(BASE, 1, "Tipo Doc Identidad", "1"), 1, "Nro Doc Identidad", "70000001");
    const f = mapear(b)[0]!;
    expect([f.tipoDocContraparte, f.rucContraparte]).toEqual(["1", "70000001"]);
  });

  it("fecha bisiesta válida", () => {
    expect(mapear(conCelda(BASE, 1, "Fecha de emisión", "29/02/2028"))[0]!.fechaEmision).toBe("2028-02-29");
  });
});

describe("mapearCompras · encabezado por nombre (CA-5)", () => {
  it("columnas permutadas: mismo resultado que el base", () => {
    expect(mapear(fixture("compras-propuesta-202610-permutado.txt"))).toEqual(ESPERADAS);
  });

  it("una columna extra se ignora", () => {
    expect(mapear(fixture("compras-propuesta-202610-columna-extra.txt"))).toEqual(ESPERADAS);
  });

  it("mayúsculas, espacios de más y tildes descompuestas (NFD) en el encabezado: mismo resultado", () => {
    expect(mapear(conEncabezado(BASE, (c) => c.map((x) => x.toUpperCase())))).toEqual(ESPERADAS);
    expect(mapear(conEncabezado(BASE, (c) => c.map((x) => `  ${x}   `)))).toEqual(ESPERADAS);
    expect(mapear(conEncabezado(BASE, (c) => c.map((x) => x.normalize("NFD"))))).toEqual(ESPERADAS);
  });

  it("el `Total CP` faltante (fixture) -> ErrorPortalSire encabezado", () => {
    esperarError(falla(fixture("compras-propuesta-202610-columna-faltante.txt")), "ErrorPortalSire", "encabezado");
  });

  it.each([
    "RUC",
    "Periodo",
    "Tipo CP/Doc.",
    "Serie del CDP",
    "Nro CP o Doc. Nro Inicial (Rango)",
    "Tipo Doc Identidad",
    "Nro Doc Identidad",
    "Apellidos Nombres/ Razón  Social",
    "Fecha de emisión",
    "Moneda",
    "Tipo de Cambio",
    "BI Gravado DG",
    "IGV / IPM DGNG",
    "BI Gravado DNG",
    "Valor Adq. NG",
    "ISC",
    "ICBPER",
    "Otros Trib/ Cargos",
    "Total CP",
    "IMB",
    "Nro Final (Rango)",
  ])("columna requerida ausente (%s) -> ErrorPortalSire encabezado", (nombre) => {
    esperarError(falla(sinColumna(BASE, nombre)), "ErrorPortalSire", "encabezado");
  });

  it("columna requerida duplicada -> ErrorPortalSire encabezado", () => {
    const b = conEncabezado(BASE, (c) => c.map((x) => (x === "ISC" ? "total  cp" : x)));
    esperarError(falla(b), "ErrorPortalSire", "encabezado");
  });

  it("si la columna 2 se llamara como la 14, el proveedor sería ambiguo -> ErrorPortalSire encabezado (P-1)", () => {
    const b = conEncabezado(BASE, (c) => c.map((x, i) => (i === 1 ? "Apellidos Nombres/ Razón  Social" : x)));
    esperarError(falla(b), "ErrorPortalSire", "encabezado");
  });

  it("una columna extra repetida (no requerida) no estorba", () => {
    const b = conEncabezado(BASE, (c) => c.map((x) => (x === "CLU2" ? "CLU1" : x)));
    expect(mapear(b)).toEqual(ESPERADAS);
  });
});

describe("mapearCompras · filas ajenas (CA-6)", () => {
  it("fixture con una fila de otro RUC -> ErrorDatosSire respuesta_ajena", () => {
    esperarError(falla(fixture("compras-propuesta-202610-ruc-ajeno.txt")), "ErrorDatosSire", "respuesta_ajena");
  });

  it("fixture con una fila de otro periodo -> ErrorDatosSire respuesta_ajena", () => {
    esperarError(falla(fixture("compras-propuesta-202610-periodo-ajeno.txt")), "ErrorDatosSire", "respuesta_ajena");
  });

  it("el archivo es del contribuyente pero se pidió otro RUC u otro periodo -> respuesta_ajena", () => {
    esperarError(falla(BASE, { ruc: "20700000011", periodo: "202610" }), "ErrorDatosSire", "respuesta_ajena");
    esperarError(falla(BASE, { ruc: "20700000002", periodo: "202609" }), "ErrorDatosSire", "respuesta_ajena");
  });

  it("la fila ajena puede ser la última y no deja filas a medias", () => {
    const e = falla(conCelda(BASE, 9, "Periodo", "202609"));
    esperarError(e, "ErrorDatosSire", "respuesta_ajena");
  });

  it("el error no copia el RUC ni el periodo ajenos", () => {
    const e = falla(conCelda(BASE, 3, "RUC", "20700000011"));
    esperarError(e, "ErrorDatosSire", "respuesta_ajena");
    sinSecretos(e, ["20700000011", "20700000002"]);
  });
});

describe("mapearCompras · filas inválidas (CA-6): nunca se redondea ni se adivina", () => {
  it.each([
    ["3 decimales", "770.001"],
    ["separador de miles", "1,770.00"],
    ["coma decimal", "770,00"],
    ["exponente", "7.7e2"],
    ["13 dígitos enteros (fuera de NUMERIC(14,2))", "1000000000000.00"],
    ["texto", "abc"],
    ["vacío", ""],
    ["signo doble", "--5.00"],
    ["punto sin decimales", "770."],
  ])("monto con %s -> fila_invalida", (_n, valor) => {
    esperarError(falla(conCelda(BASE, 1, "BI Gravado DG", valor)), "ErrorDatosSire", "fila_invalida");
  });

  it.each(["Total CP", "IGV / IPM DG", "ICBPER", "Valor Adq. NG", "Otros Trib/ Cargos"])("monto inválido en %s", (col) => {
    esperarError(falla(conCelda(BASE, 2, col, "1.234")), "ErrorDatosSire", "fila_invalida");
  });

  it.each(["31/02/2026", "29/02/2026", "05/13/2026", "2026-10-05", "05-10-2026", "05/10/26", ""])("fecha inválida: «%s»", (valor) => {
    esperarError(falla(conCelda(BASE, 1, "Fecha de emisión", valor)), "ErrorDatosSire", "fila_invalida");
  });

  it.each(["EUR", "US$", "", "peso"])("moneda no soportada: «%s»", (valor) => {
    esperarError(falla(conCelda(BASE, 1, "Moneda", valor)), "ErrorDatosSire", "fila_invalida");
  });

  it.each(["3,300", "3.3000000", "abc", ""])("tipo de cambio inválido en USD: «%s»", (valor) => {
    esperarError(falla(conCelda(BASE, 4, "Tipo de Cambio", valor)), "ErrorDatosSire", "fila_invalida");
  });

  it("tipo o número de comprobante vacíos", () => {
    esperarError(falla(conCelda(BASE, 1, "Tipo CP/Doc.", "")), "ErrorDatosSire", "fila_invalida");
    esperarError(falla(conCelda(BASE, 1, "Nro CP o Doc. Nro Inicial (Rango)", "")), "ErrorDatosSire", "fila_invalida");
  });

  it("una sola fila mala (la última) invalida todo el archivo: no se devuelven filas a medias", () => {
    const e = falla(conCelda(BASE, 9, "Total CP", "80.005"));
    esperarError(e, "ErrorDatosSire", "fila_invalida");
  });

  it("el error no copia el valor inválido ni datos de la fila", () => {
    const e = falla(conCelda(BASE, 1, "Total CP", "CANARIO-MONTO"));
    esperarError(e, "ErrorDatosSire", "fila_invalida");
    sinSecretos(e, ["CANARIO-MONTO", "PRUEBA PROVEEDOR ISC", "20700000011", "1040"]);
  });
});

describe("mapearCompras · columnas sin equivalente (CA-7, P-2)", () => {
  it.each([
    ["IMB", "5.00"],
    ["IMB", "1"],
    ["Nro Final (Rango)", "1045"],
  ])("%s = %s -> columna_no_soportada (no se pierde en silencio)", (col, valor) => {
    esperarError(falla(conCelda(BASE, 2, col, valor)), "ErrorDatosSire", "columna_no_soportada");
  });

  it.each(["", "0", "0.00"])("IMB y rango final con «%s» (vacío o cero) no estorban", (valor) => {
    const b = conCelda(conCelda(BASE, 2, "IMB", valor), 3, "Nro Final (Rango)", valor);
    expect(mapear(b)).toEqual(ESPERADAS);
  });

  it("las columnas ignoradas (Año, CAR, vencimiento, detracción, CLU*) no cambian el resultado", () => {
    let b = conCelda(BASE, 1, "Año", "2026");
    b = conCelda(b, 1, "CAR SUNAT", "CARPRUEBA-OTRO");
    b = conCelda(b, 2, "Fecha Vcto/Pago", "30/10/2026");
    b = conCelda(b, 2, "Detracción", "SI");
    b = conCelda(b, 3, "CLU1", "X");
    b = conCelda(b, 3, "CLU39", "Y");
    expect(mapear(b)).toEqual(ESPERADAS);
  });
});

// ── CA-14: volumen ──────────────────────────────────────────────────────────────────────────────────────────
const NOMBRES_TXT = {
  contribuyente: "Apellidos y Nombres o Razón social",
  proveedor: "Apellidos Nombres/ Razón  Social",
} as const;

/** Serializa filas del mock con el encabezado real del fixture (las celdas que no existen en el modelo van vacías). */
function aTxtCompras(filas: readonly FilaPropuestaSire[]): Uint8Array {
  const cab = leerTabla(BASE).lineas[0]!;
  const col = new Map(cab.map((n, i) => [n, i] as const));
  const lineas: string[] = [cab.join("|")];
  for (const [n, f] of filas.entries()) {
    const c = new Array<string>(cab.length).fill("");
    const poner = (nombre: string, v: string): void => {
      c[col.get(nombre)!] = v;
    };
    const [a, m, d] = f.fechaEmision.split("-");
    poner("RUC", "20700000002");
    poner(NOMBRES_TXT.contribuyente, "PRUEBA CONTRIBUYENTE S.A.C.");
    poner("Periodo", "202610");
    poner("CAR SUNAT", `CARPRUEBA${n}`);
    poner("Fecha de emisión", `${d}/${m}/${a}`);
    poner("Tipo CP/Doc.", f.tipo);
    poner("Serie del CDP", f.serie);
    poner("Nro CP o Doc. Nro Inicial (Rango)", f.numero);
    poner("Tipo Doc Identidad", "6");
    poner("Nro Doc Identidad", f.rucContraparte);
    poner(NOMBRES_TXT.proveedor, f.razonSocialContraparte ?? "");
    poner("BI Gravado DG", f.biDg);
    poner("IGV / IPM DG", f.igvDg);
    poner("BI Gravado DGNG", f.biDgng);
    poner("IGV / IPM DGNG", f.igvDgng);
    poner("BI Gravado DNG", f.biDng);
    poner("IGV / IPM DNG", f.igvDng);
    poner("Valor Adq. NG", f.noGravado);
    poner("ISC", f.isc);
    poner("ICBPER", f.icbper);
    poner("Otros Trib/ Cargos", f.otros);
    poner("Total CP", f.total);
    poner("Moneda", f.moneda);
    poner("Tipo de Cambio", f.tipoCambio ?? "1.000");
    lineas.push(c.join("|") + "|");
  }
  return utf8(lineas.join("\n") + "\n");
}

describe("mapearCompras · volumen (CA-14)", () => {
  const N = 20_000;
  const filas = generarFilasComprasVolumen(N, "202610");
  const txt = aTxtCompras(filas);

  it("20.000 filas: el TXT sintético ocupa bastante menos de 64 MiB y cada fila se mapea igual que el original", () => {
    expect(txt.length).toBeLessThan(64 * MIB);
    const r = mapear(txt);
    expect(r).toHaveLength(N);
    expect(r).toEqual(filas.map((f) => ({ ...f, tipoDocContraparte: "6" })));
  });

  it("parseo y mapeo en menos de 3 s (mediana de 5)", () => {
    const tiempos: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      mapear(txt);
      tiempos.push(performance.now() - t0);
    }
    tiempos.sort((a, b) => a - b);
    expect(tiempos[2]!, `tiempos (ms): ${tiempos.map((t) => t.toFixed(0)).join(", ")}`).toBeLessThan(3_000);
  });

  it("extremo a extremo: ZIP -> TXT -> filas con 20.000 filas", () => {
    const r = mapear(extraerTxtDeZip(zipSyncDe("20700000002-20261101-1030-propuesta.txt", txt)));
    expect(r).toHaveLength(N);
  });
});
