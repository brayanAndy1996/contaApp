// Escritor xlsx del Excel de compras (spec 014, D-17): neutralización de fórmulas, montos exactos y libro válido.
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { generarLibro, letraDeColumna, neutralizarTexto, type HojaXlsx } from "./escritor-xlsx.js";

const hoja = (filas: HojaXlsx["filas"]): HojaXlsx => ({ nombre: "Compras", columnas: [{ titulo: "A", ancho: 10 }], filas });
const sheet1 = (b: Uint8Array): string => strFromU8(unzipSync(b)["xl/worksheets/sheet1.xml"]!);

describe("neutralizarTexto", () => {
  it.each(["=1+1", "+1", "-2+3", "@SUM(A1)", "\t=1", "\rx", "  =1", " =HYPERLINK(1)", "﻿@x"])(
    "antepone comilla a %j",
    (t) => {
      expect(neutralizarTexto(t)).toBe(`'${t}`);
    },
  );

  it.each(["PROVEEDOR SAC", "A=B", "1-2", "x+y", "", "'ya con comilla"])("deja igual %j", (t) => {
    expect(neutralizarTexto(t)).toBe(t);
  });

  it("quita lo que XML 1.0 no admite, sin tocar tab, salto de línea ni retorno", () => {
    expect(neutralizarTexto("a\u0000b\u0008c￾d")).toBe("abcd");
    expect(neutralizarTexto("a\ud800b")).toBe("ab");
    expect(neutralizarTexto("a\nb")).toBe("a\nb");
  });
});

describe("letraDeColumna", () => {
  it("A, Z, AA, AZ, BA", () => {
    expect([0, 25, 26, 51, 52].map(letraDeColumna)).toEqual(["A", "Z", "AA", "AZ", "BA"]);
  });
});

describe("generarLibro", () => {
  it("escribe el texto neutralizado como inlineStr (nunca <f>) y el monto como número exacto", () => {
    const b = generarLibro([hoja([[{ tipo: "texto", valor: "=1+1" }, { tipo: "monto", valor: "-100.00" }, { tipo: "entero", valor: 3 }]])]);
    const x = sheet1(b);
    expect(x).toContain('t="inlineStr"');
    expect(x).toContain("'=1+1");
    expect(x).not.toContain("<f>");
    expect(x).toContain("<v>-100.00</v>");
    expect(x).toContain("<v>3</v>");
  });

  it("escapa &, < y > y el retorno como entidad", () => {
    const x = sheet1(generarLibro([hoja([[{ tipo: "texto", valor: "A&B <b>\rz" }]])]));
    expect(x).toContain("A&amp;B &lt;b&gt;&#13;z");
  });

  it("rechaza un monto con formato inválido o un entero no seguro, y un libro sin hojas", () => {
    expect(() => generarLibro([hoja([[{ tipo: "monto", valor: "1e3" }]])])).toThrow(TypeError);
    expect(() => generarLibro([hoja([[{ tipo: "monto", valor: "1.234" }]])])).toThrow(TypeError);
    expect(() => generarLibro([hoja([[{ tipo: "entero", valor: 1.5 }]])])).toThrow(TypeError);
    expect(() => generarLibro([])).toThrow(TypeError);
  });

  it("es reproducible byte a byte y trae una hoja por cada una pedida", () => {
    const hojas = [hoja([]), { ...hoja([]), nombre: "Excluidas" }];
    const a = generarLibro(hojas);
    expect(Buffer.from(a).equals(Buffer.from(generarLibro(hojas)))).toBe(true);
    const partes = unzipSync(a);
    expect(Object.keys(partes)).toEqual(expect.arrayContaining(["xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]));
  });
});
