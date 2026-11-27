import { describe, expect, it } from "vitest";
import { capturarSync, esperarError, fixture, sinSecretos } from "../pruebas/ayudas-http.js";
import { conCelda, utf8 } from "../pruebas/ayudas-txt.js";
import { leerTxt } from "./leer-txt.js";

// Contrato de `txt/leer-txt.ts` (plan 041, Decisiones «Encabezado»; spec CA-4, CA-6, CA-10, P-6):
//  - `leerTxt(bytes: Uint8Array): { encabezado: string[]; filas: string[][] }` es SÍNCRONA y pura.
//  - Decodifica UTF-8 ESTRICTO y quita el BOM; otra codificación (latin1, bytes sueltos) -> `ErrorPortalSire("codificacion")`.
//  - Separa por `\n` (acepta `\r\n`: el `\r` no queda en la última celda) y por `|`; ignora líneas vacías (la última).
//  - `encabezado` = celdas crudas de la primera línea (sin BOM, sin recortar). Sin primera línea -> `ErrorPortalSire("encabezado")`.
//  - Cada fila devuelve exactamente `encabezado.length` celdas: si trae UNA celda vacía de más (el `|` final) se descarta;
//    cualquier otro número de celdas -> `ErrorDatosSire("fila_invalida")`.
//  - Los errores no llevan texto del archivo.
const NOMBRE_COMPRAS = "compras-propuesta-202610.txt";
const NOMBRE_VENTAS = "ventas-propuesta-202610.txt";

describe("leerTxt · compras (sin BOM)", () => {
  const leerR = () => leerTxt(fixture(NOMBRE_COMPRAS));

  it("80 columnas, 9 filas, cada fila con 80 celdas (sin el campo de más del `|` final)", () => {
    const r = leerR();
    expect(r.encabezado).toHaveLength(80);
    expect(r.filas).toHaveLength(9);
    for (const f of r.filas) expect(f).toHaveLength(80);
  });

  it("encabezado crudo: doble espacio en la columna del proveedor y nombres distintos en las columnas 2 y 14", () => {
    const r = leerR();
    expect(r.encabezado[0]).toBe("RUC");
    expect(r.encabezado[1]).toBe("Apellidos y Nombres o Razón social");
    expect(r.encabezado[13]).toBe("Apellidos Nombres/ Razón  Social");
    expect(r.encabezado[79]).toBe("CLU39");
  });

  it("las celdas conservan su texto: vacías como cadena vacía y la razón social del proveedor en la columna 14", () => {
    const r = leerR();
    const f = r.filas[0]!;
    expect(f[0]).toBe("20700000002");
    expect(f[2]).toBe("202610");
    expect(f[5]).toBe("");
    expect(f[13]).toBe("PRUEBA PROVEEDOR ISC S.A.C.");
  });
});

describe("leerTxt · ventas (con BOM)", () => {
  const leerR = () => leerTxt(fixture(NOMBRE_VENTAS));

  it("quita el BOM: la primera columna es `Ruc`, 40 columnas, 8 filas", () => {
    const r = leerR();
    expect(r.encabezado[0]).toBe("Ruc");
    expect(r.encabezado).toHaveLength(40);
    expect(r.filas).toHaveLength(8);
    for (const f of r.filas) expect(f).toHaveLength(40);
  });

  it("la boleta a consumidor final trae tipo y número de documento vacíos", () => {
    const r = leerR();
    const i = r.encabezado.indexOf("Tipo Doc Identidad");
    const j = r.encabezado.indexOf("Nro Doc Identidad");
    const boleta = r.filas[2]!;
    expect(boleta[i]).toBe("");
    expect(boleta[j]).toBe("");
  });
});

describe("leerTxt · codificación (P-6, CA-10)", () => {
  it.each([
    ["byte suelto de latin1 (0xE9)", new Uint8Array([0x52, 0x55, 0x43, 0x7c, 0x52, 0x61, 0x7a, 0xe9, 0x6e, 0x0a])],
    ["secuencia UTF-8 truncada", new Uint8Array([0x52, 0x55, 0x43, 0x0a, 0xc3])],
    ["UTF-8 sobrelargo (C0 80)", new Uint8Array([0x52, 0xc0, 0x80, 0x0a])],
    ["sustituto UTF-16 codificado (ED A0 80)", new Uint8Array([0x52, 0xed, 0xa0, 0x80, 0x0a])],
  ])("%s -> ErrorPortalSire codificacion", (_n, bytes) => {
    esperarError(capturarSync(() => leerTxt(bytes)), "ErrorPortalSire", "codificacion");
  });

  it("el texto en latin1 de un fixture válido se rechaza (no se adivina la codificación)", () => {
    const latin1 = Buffer.from(Buffer.from(fixture(NOMBRE_COMPRAS)).toString("utf8"), "latin1");
    esperarError(capturarSync(() => leerTxt(new Uint8Array(latin1))), "ErrorPortalSire", "codificacion");
  });

  it("UTF-8 válido con tildes y eñes se lee bien", () => {
    const r = leerTxt(utf8("Razón|Año\nPEÑA|2026\n"));
    expect(r.encabezado).toEqual(["Razón", "Año"]);
    expect(r.filas).toEqual([["PEÑA", "2026"]]);
  });
});

describe("leerTxt · formato", () => {
  it("fin de línea CRLF: el `\\r` no queda en la última celda", () => {
    const r = leerTxt(utf8("A|B|C\r\n1|2|3\r\n4|5|6\r\n"));
    expect(r.encabezado).toEqual(["A", "B", "C"]);
    expect(r.filas).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("sin salto de línea al final, o con líneas vacías de más", () => {
    expect(leerTxt(utf8("A|B\n1|2")).filas).toEqual([["1", "2"]]);
    expect(leerTxt(utf8("A|B\n1|2\n\n")).filas).toEqual([["1", "2"]]);
  });

  it("solo encabezado: sin filas", () => {
    expect(leerTxt(utf8("A|B|C\n")).filas).toEqual([]);
  });

  it("el `|` final de las filas se acepta y el del encabezado no es obligatorio", () => {
    const r = leerTxt(utf8("A|B\n1|2|\n3|4\n"));
    expect(r.filas).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("archivo vacío o solo BOM -> ErrorPortalSire encabezado", () => {
    esperarError(capturarSync(() => leerTxt(new Uint8Array(0))), "ErrorPortalSire", "encabezado");
    esperarError(capturarSync(() => leerTxt(new Uint8Array([0xef, 0xbb, 0xbf]))), "ErrorPortalSire", "encabezado");
  });

  it("los valores con tilde del encabezado real se leen sin cambiar", () => {
    const r = leerTxt(fixture(NOMBRE_VENTAS));
    expect(r.encabezado).toContain("Fecha de emisión");
    expect(r.encabezado).toContain("Razon Social");
  });
});

describe("leerTxt · filas con otro número de campos (CA-6)", () => {
  it("una fila con una celda menos -> ErrorDatosSire fila_invalida", () => {
    const base = fixture(NOMBRE_COMPRAS);
    const texto = Buffer.from(base).toString("utf8").split("\n");
    texto[3] = texto[3]!.replace("|PEN|", "|"); // una celda menos
    esperarError(capturarSync(() => leerTxt(utf8(texto.join("\n")))), "ErrorDatosSire", "fila_invalida");
  });

  it("una fila con dos celdas de más -> ErrorDatosSire fila_invalida", () => {
    const texto = Buffer.from(fixture(NOMBRE_VENTAS)).toString("utf8").split("\n");
    texto[2] = texto[2] + "x|y|";
    esperarError(capturarSync(() => leerTxt(utf8(texto.join("\n")))), "ErrorDatosSire", "fila_invalida");
  });

  it("una fila con una celda de más CON valor (no es el `|` final) -> fila_invalida", () => {
    const texto = Buffer.from(fixture(NOMBRE_COMPRAS)).toString("utf8").split("\n");
    texto[1] = texto[1]!.replace(/\|$/, "|extra");
    esperarError(capturarSync(() => leerTxt(utf8(texto.join("\n")))), "ErrorDatosSire", "fila_invalida");
  });

  it("el error no copia el contenido de la fila", () => {
    const texto = Buffer.from(fixture(NOMBRE_COMPRAS)).toString("utf8").split("\n");
    texto[1] = "20700000002|PRUEBA-CANARIO-FILA";
    const e = capturarSync(() => leerTxt(utf8(texto.join("\n"))));
    esperarError(e, "ErrorDatosSire", "fila_invalida");
    sinSecretos(e, ["PRUEBA-CANARIO-FILA", "20700000002"]);
  });

  it("conCelda no altera el número de celdas (control de las ayudas)", () => {
    const r = leerTxt(conCelda(fixture(NOMBRE_COMPRAS), 1, "Total CP", "1.00"));
    expect(r.filas[0]).toHaveLength(80);
  });
});
