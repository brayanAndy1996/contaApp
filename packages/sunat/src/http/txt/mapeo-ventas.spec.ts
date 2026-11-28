import { describe, expect, it } from "vitest";
import type { FilaVentaSire } from "../../puertos.js";
import { capturarSync, esperarError, fixture, sinSecretos } from "../pruebas/ayudas-http.js";
import { aBytes, conCelda, conEncabezado, leerTabla, sinColumna } from "../pruebas/ayudas-txt.js";
import { leerTxt } from "./leer-txt.js";
import { mapearVentas } from "./mapeo-ventas.js";

// Contrato de `txt/mapeo-ventas.ts` (plan 041, «Mapeo»; spec CA-4, CA-5, CA-6, CA-7, P-5):
//  - `mapearVentas(txt: TxtLeido, esperado: { ruc: string; periodo: string }): FilaVentaSire[]` es SÍNCRONA y pura. Por nombre de
//    encabezado normalizado (`Ruc`, `Razon Social` sin tilde: el BOM ya lo quitó `leerTxt`).
//  - Campos: `tipo`, `serie`, `numero` (de `Nro CP o Doc. Nro Inicial (Rango)`), `fechaEmision` AAAA-MM-DD, `moneda` PEN|USD,
//    `tipoCambio` SOLO si es USD y la columna trae valor (una venta USD sin tipo de cambio sale sin `tipoCambio`),
//    `baseGravada` = `BI Gravada`, `igv` = `IGV / IPM`, `exonerada` = `Mto Exonerado`, `inafecta` = `Mto Inafecto`, `isc`, `icbper`,
//    `otros` = `Otros Tributos`, `total` = `Total CP`. Montos «sin formato fijo» (`500`, `1837.5`, `0.5`) salen con 2 decimales.
//  - Contraparte (P-5): `Tipo Doc Identidad` + `Nro Doc Identidad` vacíos = consumidor final: `docContraparte` "-" y SIN `tipoDocContraparte`.
//    Con documento: `tipoDocContraparte` tal cual y `docContraparte` = el número.
//  - Requeridas (ausente o duplicada -> `ErrorPortalSire("encabezado")`): Ruc, Periodo, Tipo CP/Doc., Serie del CDP, Nro CP o Doc. Nro Inicial (Rango),
//    Tipo Doc Identidad, Nro Doc Identidad, Fecha de emisión, Moneda, Tipo Cambio, BI Gravada, IGV / IPM, Mto Exonerado, Mto Inafecto, ISC, ICBPER,
//    Otros Tributos, Total CP, y las de P-2: Valor Facturado Exportación, Dscto BI, Dscto IGV / IPM, BI Grav IVAP, IVAP, Nro Final (Rango).
//  - `Ruc` ≠ esperado.ruc o `Periodo` ≠ esperado.periodo -> `ErrorDatosSire("respuesta_ajena")`; monto, fecha, moneda o tipo de cambio inválidos
//    (mismas reglas que compras) -> `ErrorDatosSire("fila_invalida")`; se valida TODO antes de devolver filas.
//  - P-2: exportación, descuentos, IVAP, rango final, `Valor FOB Embarcado` y `Valor OP Gratuitas` (también requeridas en el encabezado) con valor
//    distinto de vacío/cero -> `ErrorDatosSire("columna_no_soportada")`; con formato de monto inválido -> `fila_invalida`.
//    CAR, vencimiento, documento modificado y `CLU` se ignoran.
const ESPERADO = { ruc: "20700000002", periodo: "202610" } as const;
const BASE = fixture("ventas-propuesta-202610.txt");

function mapear(bytes: Uint8Array, esperado: { ruc: string; periodo: string } = ESPERADO): FilaVentaSire[] {
  return mapearVentas(leerTxt(bytes), esperado);
}
function falla(bytes: Uint8Array, esperado: { ruc: string; periodo: string } = ESPERADO): unknown {
  return capturarSync(() => mapear(bytes, esperado));
}

const CERO = "0.00";
function fila(p: Partial<FilaVentaSire> & Pick<FilaVentaSire, "serie" | "numero" | "fechaEmision" | "total" | "docContraparte">): FilaVentaSire {
  return {
    tipo: "01",
    moneda: "PEN",
    baseGravada: CERO,
    igv: CERO,
    exonerada: CERO,
    inafecta: CERO,
    isc: CERO,
    icbper: CERO,
    otros: CERO,
    ...p,
  };
}
const ESPERADAS: FilaVentaSire[] = [
  fila({ serie: "F001", numero: "10", tipoDocContraparte: "6", docContraparte: "20700000096", fechaEmision: "2026-10-02", baseGravada: "500.00", igv: "90.00", total: "590.00" }),
  fila({ serie: "F001", numero: "11", tipoDocContraparte: "6", docContraparte: "20700000045", fechaEmision: "2026-10-03", baseGravada: "1837.50", igv: "330.75", total: "2168.25" }),
  fila({ tipo: "03", serie: "B001", numero: "290", docContraparte: "-", fechaEmision: "2026-10-04", baseGravada: "100.00", igv: "18.00", total: "118.00" }),
  fila({ tipo: "03", serie: "B001", numero: "292", docContraparte: "-", fechaEmision: "2026-10-04", baseGravada: "50.00", igv: "9.00", icbper: "0.50", total: "59.50" }),
  fila({ tipo: "07", serie: "F001", numero: "1", tipoDocContraparte: "6", docContraparte: "20700000096", fechaEmision: "2026-10-10", baseGravada: "-50.00", igv: "-9.00", total: "-59.00" }),
  fila({ serie: "F002", numero: "1", tipoDocContraparte: "6", docContraparte: "20700000061", fechaEmision: "2026-10-11", moneda: "USD", tipoCambio: "3.300", baseGravada: "200.00", igv: "36.00", total: "236.00" }),
  fila({ serie: "F001", numero: "12", tipoDocContraparte: "6", docContraparte: "20700000100", fechaEmision: "2026-10-12", exonerada: "150.00", total: "150.00" }),
  fila({ serie: "F001", numero: "13", tipoDocContraparte: "6", docContraparte: "20700000045", fechaEmision: "2026-10-13", inafecta: "80.00", total: "80.00" }),
];

describe("mapearVentas · fixture base con BOM (CA-4)", () => {
  it("las 8 filas esperadas, en orden: facturas, boletas, NC, USD, exonerada e inafecta", () => {
    expect(mapear(BASE)).toEqual(ESPERADAS);
  });

  it("montos sin formato fijo: `500` -> 500.00, `1837.5` -> 1837.50, `0.5` -> 0.50", () => {
    const r = mapear(BASE);
    expect([r[0]!.baseGravada, r[1]!.baseGravada, r[3]!.icbper]).toEqual(["500.00", "1837.50", "0.50"]);
  });

  it("boleta a consumidor final: `-` y sin `tipoDocContraparte` (P-5)", () => {
    for (const i of [2, 3]) {
      const f = mapear(BASE)[i]!;
      expect(f.docContraparte).toBe("-");
      expect(f).not.toHaveProperty("tipoDocContraparte");
    }
  });

  it("`tipoCambio` solo en USD (en PEN el archivo trae 1.000 y no se copia)", () => {
    const r = mapear(BASE);
    expect(r.filter((f) => f.tipoCambio !== undefined).map((f) => f.numero)).toEqual(["1"]);
    expect(r[5]!.tipoCambio).toBe("3.300");
  });

  it("USD sin tipo de cambio en el archivo: la fila sale sin `tipoCambio` (no es error)", () => {
    const f = mapear(conCelda(BASE, 6, "Tipo Cambio", ""))[5]!;
    expect(f.moneda).toBe("USD");
    expect(f).not.toHaveProperty("tipoCambio");
  });

  it("el mismo archivo sin BOM da el mismo resultado", () => {
    const t = leerTabla(BASE);
    t.bom = false;
    expect(mapear(aBytes(t))).toEqual(ESPERADAS);
  });

  it("montos como cadenas: ningún `number`", () => {
    for (const f of mapear(BASE)) {
      for (const [k, v] of Object.entries(f)) expect(typeof v, k).toBe("string");
    }
  });

  it("documento con tipo distinto de RUC (DNI): se conserva tal cual", () => {
    const b = conCelda(conCelda(BASE, 3, "Tipo Doc Identidad", "1"), 3, "Nro Doc Identidad", "70000001");
    const f = mapear(b)[2]!;
    expect([f.tipoDocContraparte, f.docContraparte]).toEqual(["1", "70000001"]);
  });
});

describe("mapearVentas · encabezado por nombre (CA-5)", () => {
  it("columnas permutadas: mismo resultado que el base", () => {
    expect(mapear(fixture("ventas-propuesta-202610-permutado.txt"))).toEqual(ESPERADAS);
  });

  it("una columna extra se ignora", () => {
    expect(mapear(fixture("ventas-propuesta-202610-columna-extra.txt"))).toEqual(ESPERADAS);
  });

  it("mayúsculas, espacios de más y tildes descompuestas (NFD): mismo resultado", () => {
    expect(mapear(conEncabezado(BASE, (c) => c.map((x) => x.toUpperCase())))).toEqual(ESPERADAS);
    expect(mapear(conEncabezado(BASE, (c) => c.map((x) => `  ${x}  `)))).toEqual(ESPERADAS);
    expect(mapear(conEncabezado(BASE, (c) => c.map((x) => x.normalize("NFD"))))).toEqual(ESPERADAS);
  });

  it("el `Total CP` faltante (fixture) -> ErrorPortalSire encabezado", () => {
    esperarError(falla(fixture("ventas-propuesta-202610-columna-faltante.txt")), "ErrorPortalSire", "encabezado");
  });

  it.each([
    "Ruc",
    "Periodo",
    "Tipo CP/Doc.",
    "Serie del CDP",
    "Nro CP o Doc. Nro Inicial (Rango)",
    "Tipo Doc Identidad",
    "Nro Doc Identidad",
    "Fecha de emisión",
    "Moneda",
    "Tipo Cambio",
    "BI Gravada",
    "IGV / IPM",
    "Mto Exonerado",
    "Mto Inafecto",
    "ISC",
    "ICBPER",
    "Otros Tributos",
    "Total CP",
    "Valor Facturado Exportación",
    "Dscto BI",
    "Dscto IGV / IPM",
    "BI Grav IVAP",
    "IVAP",
    "Nro Final (Rango)",
    "Valor FOB Embarcado",
    "Valor OP Gratuitas",
  ])("columna requerida ausente (%s) -> ErrorPortalSire encabezado", (nombre) => {
    esperarError(falla(sinColumna(BASE, nombre)), "ErrorPortalSire", "encabezado");
  });

  it("columna requerida duplicada -> ErrorPortalSire encabezado", () => {
    const b = conEncabezado(BASE, (c) => c.map((x) => (x === "ISC" ? "total cp" : x)));
    esperarError(falla(b), "ErrorPortalSire", "encabezado");
  });

  it("`Razon Social` (sin tilde) y `Apellidos Nombres/ Razón Social` no son requeridas: sin ellas el resultado es el mismo", () => {
    expect(mapear(sinColumna(sinColumna(BASE, "Razon Social"), "Apellidos Nombres/ Razón Social"))).toEqual(ESPERADAS);
  });
});

describe("mapearVentas · filas ajenas (CA-6)", () => {
  it("fixture con una fila de otro RUC -> ErrorDatosSire respuesta_ajena", () => {
    esperarError(falla(fixture("ventas-propuesta-202610-ruc-ajeno.txt")), "ErrorDatosSire", "respuesta_ajena");
  });

  it("fixture con una fila de otro periodo -> ErrorDatosSire respuesta_ajena", () => {
    esperarError(falla(fixture("ventas-propuesta-202610-periodo-ajeno.txt")), "ErrorDatosSire", "respuesta_ajena");
  });

  it("se pidió otro RUC u otro periodo -> respuesta_ajena", () => {
    esperarError(falla(BASE, { ruc: "20700000011", periodo: "202610" }), "ErrorDatosSire", "respuesta_ajena");
    esperarError(falla(BASE, { ruc: "20700000002", periodo: "202611" }), "ErrorDatosSire", "respuesta_ajena");
  });

  it("la fila ajena puede ser la última y no deja filas a medias", () => {
    esperarError(falla(conCelda(BASE, 8, "Ruc", "20700000011")), "ErrorDatosSire", "respuesta_ajena");
  });

  it("el error no copia el RUC ni el periodo ajenos", () => {
    const e = falla(conCelda(BASE, 2, "Periodo", "209912"));
    esperarError(e, "ErrorDatosSire", "respuesta_ajena");
    sinSecretos(e, ["209912", "20700000002"]);
  });
});

describe("mapearVentas · filas inválidas (CA-6): nunca se redondea", () => {
  it.each([
    ["3 decimales", "500.001"],
    ["separador de miles", "1,500"],
    ["coma decimal", "500,5"],
    ["exponente", "5E2"],
    ["13 dígitos enteros", "1000000000000"],
    ["texto", "abc"],
    ["vacío", ""],
  ])("monto con %s -> fila_invalida", (_n, valor) => {
    esperarError(falla(conCelda(BASE, 1, "BI Gravada", valor)), "ErrorDatosSire", "fila_invalida");
  });

  it.each(["Total CP", "IGV / IPM", "ICBPER", "Mto Exonerado", "Mto Inafecto", "ISC", "Otros Tributos"])("monto inválido en %s", (col) => {
    esperarError(falla(conCelda(BASE, 2, col, "1.234")), "ErrorDatosSire", "fila_invalida");
  });

  it("el máximo de NUMERIC(14,2) se acepta", () => {
    expect(mapear(conCelda(BASE, 1, "BI Gravada", "999999999999.99"))[0]!.baseGravada).toBe("999999999999.99");
  });

  it.each(["31/02/2026", "29/02/2026", "13/13/2026", "2026-10-02", "02-10-2026", ""])("fecha inválida: «%s»", (valor) => {
    esperarError(falla(conCelda(BASE, 1, "Fecha de emisión", valor)), "ErrorDatosSire", "fila_invalida");
  });

  it.each(["EUR", "US$", ""])("moneda no soportada: «%s»", (valor) => {
    esperarError(falla(conCelda(BASE, 1, "Moneda", valor)), "ErrorDatosSire", "fila_invalida");
  });

  it.each(["3,300", "3.3000000", "abc"])("tipo de cambio inválido en USD: «%s»", (valor) => {
    esperarError(falla(conCelda(BASE, 6, "Tipo Cambio", valor)), "ErrorDatosSire", "fila_invalida");
  });

  it("tipo o número de comprobante vacíos", () => {
    esperarError(falla(conCelda(BASE, 1, "Tipo CP/Doc.", "")), "ErrorDatosSire", "fila_invalida");
    esperarError(falla(conCelda(BASE, 1, "Nro CP o Doc. Nro Inicial (Rango)", "")), "ErrorDatosSire", "fila_invalida");
  });

  it("una sola fila mala (la última) invalida todo el archivo", () => {
    esperarError(falla(conCelda(BASE, 8, "Total CP", "80.005")), "ErrorDatosSire", "fila_invalida");
  });

  it("el error no copia el valor inválido ni datos de la fila", () => {
    const e = falla(conCelda(BASE, 1, "Total CP", "CANARIO-MONTO"));
    esperarError(e, "ErrorDatosSire", "fila_invalida");
    sinSecretos(e, ["CANARIO-MONTO", "20700000096", "PRUEBA PROVEEDOR GENERICO"]);
  });
});

describe("mapearVentas · columnas sin equivalente (CA-7, P-2)", () => {
  it.each([
    ["Valor Facturado Exportación", "100"],
    ["Dscto BI", "10"],
    ["Dscto IGV / IPM", "1.8"],
    ["BI Grav IVAP", "100"],
    ["IVAP", "5"],
    ["Nro Final (Rango)", "300"],
    ["Valor FOB Embarcado", "100"],
    ["Valor OP Gratuitas", "25.50"],
  ])("%s = %s -> columna_no_soportada (no se pierde en silencio)", (col, valor) => {
    esperarError(falla(conCelda(BASE, 2, col, valor)), "ErrorDatosSire", "columna_no_soportada");
  });

  it.each([
    ["Valor FOB Embarcado", "1,5"],
    ["Valor FOB Embarcado", "abc"],
    ["Valor OP Gratuitas", "10.001"],
    ["Valor OP Gratuitas", "5E2"],
  ])("%s con formato inválido «%s» -> fila_invalida", (col, valor) => {
    esperarError(falla(conCelda(BASE, 2, col, valor)), "ErrorDatosSire", "fila_invalida");
  });

  it.each(["", "0", "0.00"])("las columnas de P-2 con «%s» (vacío o cero) no estorban", (valor) => {
    let b = BASE;
    for (const col of ["Valor Facturado Exportación", "Dscto BI", "Dscto IGV / IPM", "BI Grav IVAP", "IVAP", "Nro Final (Rango)", "Valor FOB Embarcado", "Valor OP Gratuitas"]) {
      b = conCelda(b, 1, col, valor);
    }
    expect(mapear(b)).toEqual(ESPERADAS);
  });

  it("las columnas ignoradas (CAR, vencimiento, documento modificado, CLU) no cambian el resultado", () => {
    let b = conCelda(BASE, 1, "CAR SUNAT", "CARPRUEBA-OTRO");
    b = conCelda(b, 2, "Fecha Vcto/Pago", "30/10/2026");
    b = conCelda(b, 5, "Serie CP Modificado", "F009");
    b = conCelda(b, 3, "CLU", "X");
    expect(mapear(b)).toEqual(ESPERADAS);
  });
});
