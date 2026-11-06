// Spec 012 (T4, rojo): validación estructural de cada fila contra el formato (D13; CA-5).
// Contrato fijado por la prueba: cada error lleva `filaId`, `codigo`, `campo` (el nombre del campo
// del formato provisional: serie, numero, razonSocial, numeroDocProveedor, fechaEmision, …) y una
// explicación que nombra el campo y, si es un carácter, su `U+XXXX`, nunca el carácter crudo.
import { describe, expect, it } from "vitest";
import { prevalidar } from "../index";
import type { FilaReemplazo, ResultadoPrevalidacion } from "../index";
import { CABECERA, filaReemplazo } from "../../tests/ayudas/filas-reemplazo";

const prev = (filas: FilaReemplazo[], periodo = CABECERA.periodo): ResultadoPrevalidacion =>
  prevalidar(filas, { cabecera: { ...CABECERA, periodo } });

function conRazon(razonSocial: string): FilaReemplazo {
  return filaReemplazo(undefined, { proveedor: { tipo: "6", numero: "20100070970", razonSocial } });
}

describe("fila válida", () => {
  it("no tiene errores ni avisos y el resultado nombra el formato provisional", () => {
    const r = prev([filaReemplazo()]);
    expect(r.apto).toBe(true);
    expect(r.errores).toEqual([]);
    expect(r.avisos).toEqual([]);
    expect(r.formato).toEqual({ id: "RCE-REEMPLAZO", version: "0-provisional", oficial: false });
  });
});

describe("campo obligatorio vacío (CA-5)", () => {
  const casos: Array<[string, (f: FilaReemplazo) => FilaReemplazo, string]> = [
    ["serie", (f) => ({ ...f, comprobante: { ...f.comprobante, serie: "" } }), "serie"],
    ["número", (f) => ({ ...f, comprobante: { ...f.comprobante, numero: "" } }), "numero"],
    ["tipo de comprobante", (f) => ({ ...f, comprobante: { ...f.comprobante, tipo: "" } }), "tipoComprobante"],
    ["número de documento del proveedor", (f) => ({ ...f, proveedor: { ...f.proveedor, numero: "" } }), "numeroDocProveedor"],
    ["tipo de documento del proveedor", (f) => ({ ...f, proveedor: { ...f.proveedor, tipo: "" } }), "tipoDocProveedor"],
  ];

  it.each(casos)("%s vacío da CAMPO_OBLIGATORIO con el campo", (_n, mutar, campo) => {
    const r = prev([mutar(filaReemplazo())]);
    expect(r.apto).toBe(false);
    expect(r.errores).toContainEqual(expect.objectContaining({ filaId: "f1", codigo: "CAMPO_OBLIGATORIO", campo }));
  });

  it("fecha de emisión vacía da un error que nombra fechaEmision", () => {
    const r = prev([{ ...filaReemplazo(), fechaEmision: "" }]);
    expect(r.apto).toBe(false);
    expect(r.errores.some((e) => e.campo === "fechaEmision" && ["CAMPO_OBLIGATORIO", "FECHA_INVALIDA"].includes(e.codigo))).toBe(true);
  });

  it("la razón social es opcional: vacía y ausente no dan error", () => {
    expect(prev([conRazon("")]).errores).toEqual([]);
    expect(prev([filaReemplazo()]).errores).toEqual([]);
  });
});

describe("longitud máxima en el borde exacto (CA-5)", () => {
  it("razón social de 100 caracteres pasa y de 101 da LONGITUD", () => {
    expect(prev([conRazon("A".repeat(100))]).errores).toEqual([]);
    const r = prev([conRazon("A".repeat(101))]);
    expect(r.errores).toContainEqual(expect.objectContaining({ filaId: "f1", codigo: "LONGITUD", campo: "razonSocial" }));
  });

  it("100 caracteres con ñ y tildes pasan: la longitud se mide en caracteres", () => {
    expect(prev([conRazon("Ñ".repeat(100))]).errores).toEqual([]);
    expect(prev([conRazon("á".repeat(101))]).errores).toContainEqual(
      expect.objectContaining({ codigo: "LONGITUD", campo: "razonSocial" }),
    );
  });

  it("serie de 4 pasa y de 5 da LONGITUD", () => {
    const f = (serie: string) => filaReemplazo(undefined, { comprobante: { tipo: "01", serie, numero: "123" } });
    expect(prev([f("F001")]).errores).toEqual([]);
    expect(prev([f("F0011")]).errores).toContainEqual(expect.objectContaining({ codigo: "LONGITUD", campo: "serie" }));
  });

  it("número de comprobante de 8 dígitos pasa y de 9 da LONGITUD", () => {
    const f = (numero: string) => filaReemplazo(undefined, { comprobante: { tipo: "01", serie: "F001", numero } });
    expect(prev([f("12345678")]).errores).toEqual([]);
    expect(prev([f("123456789")]).errores).toContainEqual(expect.objectContaining({ codigo: "LONGITUD", campo: "numero" }));
  });

  it("número de documento (no RUC) de 15 pasa y de 16 da LONGITUD", () => {
    const f = (numero: string) => filaReemplazo(undefined, { proveedor: { tipo: "7", numero } });
    expect(prev([f("A".repeat(15))]).errores).toEqual([]);
    expect(prev([f("A".repeat(16))]).errores).toContainEqual(
      expect.objectContaining({ codigo: "LONGITUD", campo: "numeroDocProveedor" }),
    );
  });
});

describe("RUC del proveedor y del declarante (CA-5)", () => {
  const prov = (tipo: string, numero: string) => filaReemplazo(undefined, { proveedor: { tipo, numero } });

  it("RUC (tipo 6) válido pasa; con dígito verificador malo da RUC_INVALIDO en numeroDocProveedor", () => {
    expect(prev([prov("6", "20100070970")]).errores).toEqual([]);
    expect(prev([prov("6", "20100070971")]).errores).toContainEqual(
      expect.objectContaining({ filaId: "f1", codigo: "RUC_INVALIDO", campo: "numeroDocProveedor" }),
    );
  });

  it.each([["10 dígitos", "2010007097"], ["12 dígitos", "201000709701"], ["con letra", "2010007097A"], ["prefijo inexistente", "30100070970"]])(
    "RUC del proveedor %s da RUC_INVALIDO",
    (_n, numero) => {
      expect(prev([prov("6", numero)]).errores.map((e) => e.codigo)).toContain("RUC_INVALIDO");
    },
  );

  it("un documento que no es RUC (tipo 1, DNI) no se valida con el dígito verificador", () => {
    expect(prev([prov("1", "12345678")]).errores.map((e) => e.codigo)).not.toContain("RUC_INVALIDO");
  });

  it("RUC del declarante con dígito verificador malo bloquea, sin fila (filaId null) y sin excepción", () => {
    const r = prevalidar([filaReemplazo()], { cabecera: { ...CABECERA, rucDeclarante: "20700000003" } });
    expect(r.apto).toBe(false);
    expect(r.errores).toContainEqual(
      expect.objectContaining({ filaId: null, codigo: "RUC_INVALIDO", campo: "rucDeclarante" }),
    );
  });
});

describe("caracteres que rompen el formato (CA-5, D13)", () => {
  // [nombre, texto, U+XXXX esperado en la explicación, carácter crudo que NO debe aparecer]
  const casos: Array<[string, string, string]> = [
    ["el separador |", "ACME|SAC", "U+007C"],
    ["retorno de carro", "ACME\rSAC", "U+000D"],
    ["salto de línea", "ACME\nSAC", "U+000A"],
    ["tabulación", "ACME\tSAC", "U+0009"],
    ["NUL", "ACME\u0000SAC", "U+0000"],
    ["NEL U+0085", "ACME\u0085SAC", "U+0085"],
    ["NBSP", "ACME\u00a0SAC", "U+00A0"],
    ["marca combinante U+0301", "ACME\u0301", "U+0301"],
    ["emoji", "ACME \u{1F600}", "U+1F600"],
    ["homoglifo cherokee", "\u13aaCME", "U+13AA"],
    ["euro (fuera de latin1)", "ACME \u20ac", "U+20AC"],
    ["DEL", "ACME\u007f", "U+007F"],
    ["separador de línea U+2028", "ACME\u2028SAC", "U+2028"],
  ];

  it.each(casos)("%s da CARACTER_NO_PERMITIDO en razonSocial, con U+XXXX y sin el carácter crudo", (_n, texto, codigoU) => {
    const r = prev([conRazon(texto)]);
    expect(r.apto).toBe(false);
    const e = r.errores.find((x) => x.codigo === "CARACTER_NO_PERMITIDO");
    expect(e).toBeDefined();
    expect(e).toMatchObject({ filaId: "f1", campo: "razonSocial" });
    expect(e?.explicacion).toContain("razonSocial");
    expect(e?.explicacion).toContain(codigoU);
    const crudo = texto.match(/[|\r\n\t\u0000\u0085\u00a0\u0301\u{1F600}\u13aa\u20ac\u007f\u2028]/u)?.[0] as string;
    expect(e?.explicacion).not.toContain(crudo);
  });

  it("también se valida el texto de la serie y del número del proveedor (no solo la razón social)", () => {
    const r = prev([filaReemplazo(undefined, { comprobante: { tipo: "01", serie: "F|01", numero: "123" } })]);
    expect(r.errores.some((e) => e.campo === "serie")).toBe(true);
    const r2 = prev([filaReemplazo(undefined, { proveedor: { tipo: "7", numero: "AB\nCD" } })]);
    expect(r2.errores.some((e) => e.campo === "numeroDocProveedor")).toBe(true);
  });

  it("admite ñ, Ñ, tildes, ¡ ¿ y espacios dentro del texto", () => {
    expect(prev([conRazon("PEÑA ÑÚÑEZ S.A.C. ¡HOLA! ¿QUÉ?")]).errores).toEqual([]);
  });

  it("no recorta: una razón social con espacios al inicio y al final es válida y no se modifica", () => {
    const entrada = conRazon("  ACME SAC  ");
    expect(prev([entrada]).errores).toEqual([]);
    expect(entrada.proveedor.razonSocial).toBe("  ACME SAC  ");
  });
});

describe("fecha de emisión (CA-5)", () => {
  const conFecha = (fechaEmision: string) => filaReemplazo(undefined, { fechaEmision });

  it.each([
    ["día imposible", "2026-02-30"],
    ["29 de febrero de un año no bisiesto", "2026-02-29"],
    ["mes 13", "2026-13-01"],
    ["mes 00", "2026-00-10"],
    ["día 00", "2026-10-00"],
    ["sin ceros", "2026-10-5"],
    ["formato DD/MM/AAAA", "05/10/2026"],
    ["con espacio final", "2026-10-05 "],
    ["con hora", "2026-10-05T00:00:00"],
    ["con dígitos no ASCII", "\u0662\u0660\u0662\u0666-10-05"],
  ])("%s da FECHA_INVALIDA en fechaEmision", (_n, f) => {
    expect(prev([conFecha(f)]).errores).toContainEqual(
      expect.objectContaining({ filaId: "f1", codigo: "FECHA_INVALIDA", campo: "fechaEmision" }),
    );
  });

  it("el último día del periodo pasa y el día siguiente da FECHA_POSTERIOR_AL_PERIODO", () => {
    expect(prev([conFecha("2026-10-31")]).errores).toEqual([]);
    expect(prev([conFecha("2026-11-01")]).errores).toContainEqual(
      expect.objectContaining({ filaId: "f1", codigo: "FECHA_POSTERIOR_AL_PERIODO", campo: "fechaEmision" }),
    );
    expect(prev([conFecha("2027-01-01")]).errores.map((e) => e.codigo)).toEqual(["FECHA_POSTERIOR_AL_PERIODO"]);
  });

  it("una fecha de un periodo anterior (otro mes u otro año) es válida", () => {
    expect(prev([conFecha("2026-09-30")]).errores).toEqual([]);
    expect(prev([conFecha("2025-01-15")]).errores).toEqual([]);
  });

  it("el último día de febrero depende del año: 2028 es bisiesto y 2026 no", () => {
    expect(prev([conFecha("2028-02-29")], "202802").errores).toEqual([]);
    expect(prev([conFecha("2028-03-01")], "202802").errores.map((e) => e.codigo)).toEqual(["FECHA_POSTERIOR_AL_PERIODO"]);
    expect(prev([conFecha("2026-02-28")], "202602").errores).toEqual([]);
    expect(prev([conFecha("2026-03-01")], "202602").errores.map((e) => e.codigo)).toEqual(["FECHA_POSTERIOR_AL_PERIODO"]);
  });
});

describe("las filas excluidas no se validan (D4, CA-7)", () => {
  it("una excluida con serie vacía, RUC malo, fecha imposible y carácter prohibido no bloquea", () => {
    const mala = filaReemplazo(undefined, {
      id: "mala",
      estado: "excluida",
      comprobante: { tipo: "01", serie: "", numero: "9" },
      proveedor: { tipo: "6", numero: "20100070971", razonSocial: "A|B" },
      fechaEmision: "2026-02-30",
    });
    const r = prev([filaReemplazo(), mala]);
    expect(r.apto).toBe(true);
    expect(r.errores).toEqual([]);
  });
});
