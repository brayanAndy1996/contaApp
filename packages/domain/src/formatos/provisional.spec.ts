// Spec 012 (T3, rojo): formato provisional RCE de compras (D10, D14; plan, «Formato provisional RCE»).
// Es una herramienta de prueba del motor, no la estructura de SUNAT: oficial=false, congelado,
// con nombres inconfundibles con uno oficial.
import { describe, expect, it } from "vitest";
import { COLUMNAS_COMPRA, REGISTRO_FORMATOS, seleccionarFormato, validarNombreArchivo } from "../index";

const F = seleccionarFormato("compras", "202610");

describe("formato provisional RCE", () => {
  it("identidad: id, versión, libro, vigencia y marca de no oficial", () => {
    expect(F.id).toBe("RCE-REEMPLAZO");
    expect(F.version).toBe("0-provisional");
    expect(F.libro).toBe("compras");
    expect(F.vigenteDesde).toBe("202601");
    expect(F.oficial).toBe(false);
  });

  it("codificación latin1, separador |, fin de línea CRLF y sin excluidas (D14)", () => {
    expect(F.codificacion).toBe("latin1");
    expect(F.separador).toBe("|");
    expect(F.finDeLinea).toBe("\r\n");
    expect(F.incluyeExcluidas).toBe(false);
  });

  it("es el único formato del registro por defecto: todos los periodos desde 202601 lo eligen", () => {
    for (const p of ["202601", "202612", "203001", "209912"]) {
      expect(seleccionarFormato("compras", p, REGISTRO_FORMATOS)).toBe(F);
    }
  });

  it("está congelado: formato, campos y cada campo", () => {
    expect(Object.isFrozen(F)).toBe(true);
    expect(Object.isFrozen(F.campos)).toBe(true);
    expect(F.campos.every((c) => Object.isFrozen(c))).toBe(true);
    expect(() => {
      (F as { oficial: boolean }).oficial = true;
    }).toThrow(TypeError);
    expect(() => {
      (F.campos as unknown as unknown[]).push({});
    }).toThrow(TypeError);
    expect(() => {
      (F.campos[0] as { obligatorio: boolean }).obligatorio = false;
    }).toThrow(TypeError);
    expect(F.oficial).toBe(false);
  });

  it("campos, en orden: periodo, comprobante, fecha, proveedor, moneda, TC, las 10 columnas y total", () => {
    expect(F.campos.map((c) => c.nombre)).toEqual([
      "periodo",
      "tipoComprobante",
      "serie",
      "numero",
      "fechaEmision",
      "tipoDocProveedor",
      "numeroDocProveedor",
      "razonSocial",
      "moneda",
      "tipoCambio",
      ...COLUMNAS_COMPRA,
      "total",
    ]);
    expect(F.campos).toHaveLength(21);
  });

  it("la razón social y el TC son opcionales; todo lo demás es obligatorio", () => {
    const opcionales = F.campos.filter((c) => !c.obligatorio).map((c) => c.nombre);
    expect(opcionales).toEqual(["razonSocial", "tipoCambio"]);
  });

  it("longitudes máximas del comprobante, el proveedor y la razón social (plan; IdComprobante, DocProveedor)", () => {
    const largo = (n: string) => F.campos.find((c) => c.nombre === n)?.longitudMax;
    expect(largo("periodo")).toBe(6);
    expect(largo("tipoComprobante")).toBe(2);
    expect(largo("serie")).toBe(4);
    expect(largo("numero")).toBe(8);
    expect(largo("fechaEmision")).toBe(10);
    expect(largo("tipoDocProveedor")).toBe(1);
    expect(largo("numeroDocProveedor")).toBe(15);
    expect(largo("razonSocial")).toBe(100);
    expect(largo("moneda")).toBe(3);
  });

  it("tipos de campo: fecha, tc y monto en las columnas y el total", () => {
    const tipo = (n: string) => F.campos.find((c) => c.nombre === n)?.tipo;
    expect(tipo("fechaEmision")).toBe("fecha");
    expect(tipo("tipoCambio")).toBe("tc");
    expect(tipo("total")).toBe("monto");
    for (const col of COLUMNAS_COMPRA) expect(tipo(col)).toBe("monto");
  });

  it("los nombres son exactos y se distinguen de un oficial", () => {
    expect(F.nombre({ ruc: "20700000002", periodo: "202610" })).toEqual({
      nombreTxt: "CONTAPP-PROVISIONAL-20700000002-202610-RCE.txt",
      nombreZip: "CONTAPP-PROVISIONAL-20700000002-202610-RCE.zip",
    });
    expect(F.nombre({ ruc: "20100070970", periodo: "202601" })).toEqual({
      nombreTxt: "CONTAPP-PROVISIONAL-20100070970-202601-RCE.txt",
      nombreZip: "CONTAPP-PROVISIONAL-20100070970-202601-RCE.zip",
    });
  });

  it("nombre() es puro y su resultado congelado; ambos nombres pasan validarNombreArchivo y comparten la base", () => {
    const a = F.nombre({ ruc: "20700000002", periodo: "202610" });
    const b = F.nombre({ ruc: "20700000002", periodo: "202610" });
    expect(a).toEqual(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(validarNombreArchivo(a.nombreTxt)).toBe(true);
    expect(validarNombreArchivo(a.nombreZip)).toBe(true);
    expect(a.nombreZip).toBe(a.nombreTxt.replace(/\.txt$/, ".zip"));
  });
});
