// Spec 012 (T3, rojo): validación de un valor contra un CampoTxt (D13, CA-5).
// Contrato fijado por la prueba (T6 lo ratifica):
//   validarCampo(valor: string, campo: CampoTxt, formato: FormatoTxt):
//     { codigo: "CAMPO_OBLIGATORIO" | "LONGITUD" | "PATRON" | "CARACTER_NO_PERMITIDO" | "RUC_INVALIDO";
//       posicion: Entero | null } | null
//   `null` = el valor es válido. No lanza. `posicion` es el índice (unidades de código UTF-16,
//   desde 0) del primer carácter ofensor; `null` si el error no es de un carácter. Sin recorte,
//   normalización ni transliteración: " A " mide 3.
// Texto admitido: U+0020-U+007E y U+00A1-U+00FF (latin1), menos el separador del formato.
import { describe, expect, it } from "vitest";
import { RegistroFormatos, seleccionarFormato, validarCampo } from "../index";
import { campoDePrueba, formatoDePrueba } from "../../tests/ayudas/formatos";

const PROV = seleccionarFormato("compras", "202610"); // separador "|", latin1
const texto = (over = {}) => campoDePrueba({ nombre: "razonSocial", obligatorio: false, longitudMax: 10, ...over });
const val = (v: string, c = texto(), f = PROV) => validarCampo(v, c, f);

describe("validarCampo · obligatoriedad y longitud", () => {
  it("un valor válido devuelve null", () => {
    expect(val("ACME SAC")).toBeNull();
    expect(val("")).toBeNull(); // opcional y vacío
  });

  it("obligatorio vacío es CAMPO_OBLIGATORIO sin posición", () => {
    expect(val("", texto({ obligatorio: true }))).toEqual({ codigo: "CAMPO_OBLIGATORIO", posicion: null });
  });

  it("la longitud máxima exacta pasa y máxima + 1 es LONGITUD", () => {
    expect(val("A".repeat(10))).toBeNull();
    expect(val("A".repeat(11))).toMatchObject({ codigo: "LONGITUD" });
  });

  it("no recorta: los espacios cuentan para la longitud", () => {
    expect(val(" A ", texto({ longitudMax: 3 }))).toBeNull();
    expect(val(" A ", texto({ longitudMax: 2 }))).toMatchObject({ codigo: "LONGITUD" });
  });
});

describe("validarCampo · caracteres (CA-5, D13)", () => {
  it.each([
    ["el separador |", "A|B", 1],
    ["retorno de carro", "A\rB", 1],
    ["salto de línea", "A\nB", 1],
    ["tabulación", "A\tB", 1],
    ["NUL", "A\u0000B", 1],
    ["control C0 U+001F", "A\u001fB", 1],
    ["DEL U+007F", "A\u007fB", 1],
    ["control C1 U+0080", "A\u0080B", 1],
    ["control C1 U+0085 (NEL)", "A\u0085B", 1],
    ["control C1 U+009F", "A\u009fB", 1],
    ["NBSP U+00A0", "A\u00a0B", 1],
    ["marca combinante U+0301", "Ae\u0301", 2],
    ["euro (fuera de latin1)", "A\u20acB", 1],
    ["U+0100 (fuera de latin1)", "A\u0100", 1],
    ["homoglifo cherokee U+13AA", "\u13aa", 0],
    ["emoji (par sustituto)", "a\u{1F600}", 1],
    ["sustituto suelto", "ab\ud800", 2],
    ["separador de línea U+2028", "A\u2028B", 1],
  ])("rechaza %s con CARACTER_NO_PERMITIDO y la posición", (_n, v, pos) => {
    expect(val(v)).toEqual({ codigo: "CARACTER_NO_PERMITIDO", posicion: pos });
  });

  it("informa el primer carácter ofensor (el de más a la izquierda)", () => {
    expect(val("ab|c\n")).toEqual({ codigo: "CARACTER_NO_PERMITIDO", posicion: 2 });
  });

  it.each([
    ["espacio U+0020", " "],
    ["tilde ~ U+007E", "~"],
    ["¡ U+00A1", "¡"],
    ["ñ y Ñ", "ñÑ"],
    ["vocales con tilde", "áéíóúü"],
    ["ÿ U+00FF", "ÿ"],
    ["signos de ascii", "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{}"],
  ])("admite %s", (_n, v) => {
    expect(val(v, texto({ longitudMax: 40 }))).toBeNull();
  });

  it("el separador depende del formato: con ';' el '|' se admite y el ';' no", () => {
    const f = RegistroFormatos.desde([formatoDePrueba({ separador: ";" })]);
    const formato = seleccionarFormato("compras", "202610", f);
    expect(val("A|B", texto(), formato)).toBeNull();
    expect(val("A;B", texto(), formato)).toEqual({ codigo: "CARACTER_NO_PERMITIDO", posicion: 1 });
  });

  it("la explicación nunca lleva el carácter crudo: el resultado solo trae código y posición", () => {
    const r = val("A\u20acB");
    expect(Object.keys(r ?? {}).sort()).toEqual(["codigo", "posicion"]);
  });
});

describe("validarCampo · patrón y tipos", () => {
  it("un valor que no cumple el patrón es PATRON", () => {
    const c = campoDePrueba({ nombre: "tipoComprobante", longitudMax: 2, tipo: "codigo", patron: /^[0-9]{2}$/ });
    expect(val("01", c)).toBeNull();
    expect(val("1", c)).toMatchObject({ codigo: "PATRON" });
    expect(val("AB", c)).toMatchObject({ codigo: "PATRON" });
  });

  it("tipo ruc: 11 dígitos con dígito verificador válido", () => {
    const c = campoDePrueba({ nombre: "numeroDocProveedor", longitudMax: 11, tipo: "ruc" });
    expect(val("20700000002", c)).toBeNull();
    expect(val("20100070970", c)).toBeNull();
  });

  it.each([
    ["dígito verificador malo", "20700000003"],
    ["10 dígitos", "2070000000"],
    ["letras", "2070000000A"],
    ["prefijo inexistente", "30700000002"],
    ["dígitos no ASCII", "\u0662\u0660\u0667\u0660\u0660\u0660\u0660\u0660\u0660\u0660\u0662"],
  ])("tipo ruc rechaza %s con RUC_INVALIDO", (_n, v) => {
    const c = campoDePrueba({ nombre: "numeroDocProveedor", longitudMax: 11, tipo: "ruc" });
    expect(val(v, c)).toMatchObject({ codigo: "RUC_INVALIDO" });
  });

  it("no lanza con ninguna cadena (devuelve un resultado)", () => {
    for (const v of ["", "\u0000", "\ud800", "\u{1F600}".repeat(50), "|".repeat(1000)]) {
      expect(() => val(v)).not.toThrow();
    }
  });
});
