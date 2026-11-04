// Spec 007b (T12, cobertura de T11) · bordes del lector `.xlsx` y de `zip-seguro`: planillas con la estructura rara que
// un Excel real o un atacante pueden entregar. Todo rechazo es `archivo_invalido` (nunca un error sin tipo ni un 500).
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { CABECERA, comprimir, filaDatos, partesXlsx, rucConPrefijo, xlsx } from "../../../test/soporte-importacion.js";
import { MAX_ENTRADAS } from "./zip-seguro.js";
import { leerXlsx } from "./lector-xlsx.js";

const RUC = rucConPrefijo("20", 4242);
const base = () => [[...CABECERA], filaDatos({ ruc: RUC, razonSocial: "ACME" })];
const T = (s: string) => strToU8(s);
const PRELUDIO = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const hoja = (filas: string) => `${PRELUDIO}<worksheet ${NS}><sheetData>${filas}</sheetData></worksheet>`;
const cab = `<row r="1">${CABECERA.map((c, i) => `<c r="${"ABCDEFG"[i]}1" t="inlineStr"><is><t>${c}</t></is></c>`).join("")}</row>`;

/** `.xlsx` válido con partes sustituidas (clave = ruta; `null` la quita). */
function conPartes(cambios: Record<string, string | Uint8Array | null>): Uint8Array {
  const partes = partesXlsx(base());
  for (const [k, v] of Object.entries(cambios)) {
    if (v === null) delete partes[k];
    else partes[k] = typeof v === "string" ? T(v) : v;
  }
  return comprimir(partes);
}
const conHoja = (filas: string) => conPartes({ "xl/worksheets/sheet1.xml": hoja(filas) });
const invalido = (bytes: Uint8Array) => expect(() => leerXlsx(bytes)).toThrow(expect.objectContaining({ codigo: "archivo_invalido" }));

describe("lector-xlsx · estructura del libro", () => {
  it("un libro cuyo XML no es UTF-8 válido o está mal formado se rechaza", () => {
    invalido(conPartes({ "xl/workbook.xml": Uint8Array.from([0xff, 0xfe, 0x00, 0x3c]) }));
    invalido(conPartes({ "xl/workbook.xml": `${PRELUDIO}<workbook><sheets>` }));
  });

  it("sin hojas, sin relación de la hoja o sin libro: archivo_invalido", () => {
    invalido(conPartes({ "xl/workbook.xml": `${PRELUDIO}<workbook ${NS}><sheets></sheets></workbook>` }));
    invalido(conPartes({ "xl/_rels/workbook.xml.rels": null }));
    invalido(conPartes({ "xl/workbook.xml": null }));
    invalido(conPartes({ "xl/worksheets/sheet1.xml": null }));
  });

  it("los destinos de las relaciones no pueden salirse del paquete ('..'), pero sí ser absolutos dentro de él", () => {
    const rels = (destino: string) =>
      `${PRELUDIO}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${destino}"/><Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
    invalido(conPartes({ "xl/_rels/workbook.xml.rels": rels("../../etc/hoja.xml") }));
    expect(leerXlsx(conPartes({ "xl/_rels/workbook.xml.rels": rels("/xl/worksheets/sheet1.xml") })).filas).toHaveLength(1);
  });

  it("una relación sin Type usa el libro por defecto (xl/workbook.xml)", () => {
    const sinTipo = `${PRELUDIO}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="xl/otro.xml"/></Relationships>`;
    expect(leerXlsx(conPartes({ "_rels/.rels": sinTipo })).filas).toHaveLength(1);
  });

  it("las cadenas compartidas con texto enriquecido (<r><t>) se concatenan; un índice fuera de rango se rechaza", () => {
    const cadenas = `${PRELUDIO}<sst ${NS}><si><r><t>20</t></r><r><t>0000</t></r></si><si><r><t>x</t></r></si></sst>`;
    const filas = `${cab}<row r="2"><c r="A2" t="s"><v>0</v></c></row>`;
    const r = leerXlsx(conPartes({ "xl/sharedStrings.xml": cadenas, "xl/worksheets/sheet1.xml": hoja(filas) }));
    expect(r.filas[0]?.ruc).toBe("200000");
    invalido(conPartes({ "xl/worksheets/sheet1.xml": hoja(`${cab}<row r="2"><c r="A2" t="s"><v>9</v></c></row>`) }));
    invalido(conPartes({ "xl/worksheets/sheet1.xml": hoja(`${cab}<row r="2"><c r="A2" t="s"><v>abc</v></c></row>`) }));
  });

  it("sin sharedStrings.xml la hoja con celdas de texto en línea se lee igual", () => {
    expect(leerXlsx(conPartes({ "xl/sharedStrings.xml": null, "xl/worksheets/sheet1.xml": hoja(cab) })).filas).toEqual([]);
  });
});

describe("lector-xlsx · hoja", () => {
  const fila = (celdas: string, r = 'r="2"') => `${cab}<row ${r}>${celdas}</row>`;

  it("un RUC en notación científica vuelve a sus dígitos; otras formas quedan tal cual", () => {
    const sci = (v: string) => leerXlsx(conHoja(fila(`<c r="A2"><v>${v}</v></c>`))).filas[0]?.ruc;
    expect(sci("2.0104540261E+10")).toBe("20104540261");
    expect(sci("2.0104E+2")).toBe("2.0104E+2"); // exponente menor que los decimales: no es un entero
    expect(sci("2.0E+40")).toBe("2.0E+40"); // exponente absurdo
    expect(sci("20104540261")).toBe("20104540261");
  });

  it("celdas sin referencia, filas sin número y celdas vacías siguen el orden natural", () => {
    const r = leerXlsx(conHoja(`${cab}<row><c><v>${RUC}</v></c><c t="str"><v>X</v></c><c r="D2"><v></v></c></row>`));
    expect(r.filas[0]).toMatchObject({ n: 2, ruc: RUC, razonSocial: "X", claveSol: "" });
  });

  it("referencias de celda o de fila imposibles se rechazan", () => {
    invalido(conHoja(fila('<c r="??"><v>1</v></c>')));
    invalido(conHoja(fila('<c r="XFE2"><v>1</v></c>'))); // más allá de la columna XFD
    invalido(conHoja(fila("", 'r="abc"')));
    invalido(conHoja(`${cab}<row r="1"></row>`)); // una fila no puede repetir o retroceder
    invalido(conHoja(fila("", 'r="9999999"')));
  });

  it("una celda vacía (<c/>) o un elemento sin forma de planilla es archivo_invalido, nunca un error sin tipo", () => {
    invalido(conHoja(fila("<c/>")));
  });

  it("los tipos de celda distintos de número, texto compartido y texto en línea se leen como texto", () => {
    const r = leerXlsx(conHoja(fila(`<c r="A2" t="str"><v>${RUC}</v></c><c r="B2" t="b"><v>1</v></c>`)));
    expect(r.filas[0]).toMatchObject({ ruc: RUC, razonSocial: "1" });
  });

  it("una planilla de 10 hojas de cálculo con nombres de partes extra se acepta y solo cuenta la primera hoja", () => {
    const r = leerXlsx(xlsx(base(), { hojasExtra: Array.from({ length: 3 }, () => base()) }));
    expect(r.filas).toHaveLength(1);
  });
});

/* ------------------------------------ zip-seguro ------------------------------------ */
const ZIP_BASE = () => partesXlsx(base());

interface Central {
  p: number;
  nombre: string;
}
const vista = (z: Uint8Array) => new DataView(z.buffer, z.byteOffset, z.byteLength);
const fin = (z: Uint8Array): number => {
  const dv = vista(z);
  for (let i = z.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) return i;
  throw new Error("sin EOCD");
};
/** Cabeceras del directorio central con su posición, para parchear campos de una planilla válida. */
function centrales(z: Uint8Array): Central[] {
  const dv = vista(z);
  const f = fin(z);
  let p = dv.getUint32(f + 16, true);
  const total = dv.getUint16(f + 10, true);
  const salida: Central[] = [];
  for (let k = 0; k < total; k++) {
    const n = dv.getUint16(p + 28, true);
    salida.push({ p, nombre: new TextDecoder().decode(z.subarray(p + 46, p + 46 + n)) });
    p += 46 + n + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return salida;
}
function parchar(cambio: (dv: DataView, z: Uint8Array, c: Central[], f: number) => void, z: Uint8Array = comprimir(ZIP_BASE())): Uint8Array {
  const copia = Uint8Array.from(z);
  cambio(vista(copia), copia, centrales(copia), fin(copia));
  return copia;
}
const de = (c: Central[], nombre: string) => c.find((x) => x.nombre === nombre) as Central;

describe("zip-seguro · directorio central", () => {
  it("menos de 22 bytes, sin fin de directorio, sin entradas o con más de MAX_ENTRADAS: archivo_invalido", () => {
    invalido(Uint8Array.from([0x50, 0x4b]));
    invalido(new Uint8Array(64));
    invalido(zipSync({}));
    const muchas: Record<string, Uint8Array> = {};
    for (let i = 0; i <= MAX_ENTRADAS; i++) muchas[`e${i}.xml`] = T("<a/>");
    invalido(zipSync(muchas));
  });

  it("ZIP64, multivolumen y un directorio que apunta fuera del archivo se rechazan", () => {
    invalido(parchar((dv, _z, _c, f) => dv.setUint16(f + 10, 0xffff, true)));
    invalido(parchar((dv, _z, _c, f) => dv.setUint32(f + 16, 0xffffffff, true)));
    invalido(parchar((dv, _z, _c, f) => dv.setUint16(f + 4, 1, true)));
    invalido(parchar((dv, _z, _c, f) => dv.setUint32(f + 16, dv.getUint32(f + 16, true) + 5000, true)));
  });

  it("firma de entrada central rota, nombre que se sale del directorio o con bytes no UTF-8: archivo_invalido", () => {
    invalido(parchar((dv, _z, c) => dv.setUint32(c[1]!.p, 0, true)));
    invalido(parchar((dv, _z, c) => dv.setUint16(c[0]!.p + 28, 0xffff, true)));
    invalido(parchar((_dv, z, c) => (z[c[0]!.p + 46] = 0xff)));
  });

  it("entrada cifrada, método desconocido, nombre duplicado o ruta con '.', '//' o más de 260 caracteres: archivo_invalido", () => {
    invalido(parchar((dv, _z, c) => dv.setUint16(c[0]!.p + 8, 1, true)));
    invalido(parchar((dv, _z, c) => dv.setUint16(c[0]!.p + 10, 99, true)));
    const dos = { ...ZIP_BASE(), "xl/a.xml": T("<a/>"), "xl/b.xml": T("<b/>") };
    invalido(
      parchar((_dv, z, c) => {
        const a = de(c, "xl/a.xml");
        const b = de(c, "xl/b.xml");
        for (let i = 0; i < a.nombre.length; i++) z[b.p + 46 + i] = z[a.p + 46 + i] as number;
      }, comprimir(dos)),
    );
    const raros = (ruta: string) => invalido(zipSync({ ...ZIP_BASE(), [ruta]: T("x") }));
    raros("xl/./a.xml");
    raros("xl//a.xml");
    raros(`xl/${"a".repeat(300)}.xml`);
  });

  it("tamaños declarados que suman más de 20 MB, o una entrada almacenada con tamaños distintos: archivo_invalido", () => {
    invalido(
      parchar((dv, _z, c) => {
        dv.setUint32(c[0]!.p + 24, 15 * 1024 * 1024, true);
        dv.setUint32(c[1]!.p + 24, 15 * 1024 * 1024, true);
      }),
    );
    const almacenado = zipSync({ ...Object.fromEntries(Object.entries(ZIP_BASE()).map(([k, v]) => [k, [v, { level: 0 }] as [Uint8Array, { level: 0 }]])) });
    invalido(parchar((dv, _z, c) => dv.setUint32(c[0]!.p + 24, 7, true), almacenado));
  });
});

describe("zip-seguro · descompresión", () => {
  it("las entradas almacenadas (sin compresión) se leen", () => {
    const almacenado = zipSync(Object.fromEntries(Object.entries(ZIP_BASE()).map(([k, v]) => [k, [v, { level: 0 }] as [Uint8Array, { level: 0 }]])));
    expect(leerXlsx(almacenado).filas).toHaveLength(1);
  });

  it("firma local rota, cuerpo que se sale del archivo, tamaño declarado distinto del real o cuerpo vacío: archivo_invalido", () => {
    invalido(parchar((dv, _z, c) => dv.setUint32(dv.getUint32(c[0]!.p + 42, true), 0, true)));
    invalido(parchar((dv, _z, c) => dv.setUint32(c[0]!.p + 20, 0x7fffffff, true)));
    invalido(parchar((dv, _z, c) => dv.setUint32(c[0]!.p + 24, dv.getUint32(c[0]!.p + 24, true) + 5, true)));
    invalido(parchar((dv, _z, c) => dv.setUint32(c[0]!.p + 24, 1, true)));
  });

  it("una entrada sin ningún byte comprimido (y tamaño 0) no impide leer las demás", () => {
    const vacia = parchar((dv, _z, c) => {
      dv.setUint32(c[0]!.p + 20, 0, true);
      dv.setUint32(c[0]!.p + 24, 0, true);
    });
    expect(() => leerXlsx(vacia)).not.toThrow();
  });

  it("un cuerpo comprimido corrupto es archivo_invalido", () => {
    invalido(
      parchar((_dv, z, c) => {
        const dv = vista(z);
        const o = dv.getUint32(c[0]!.p + 42, true);
        const inicio = o + 30 + dv.getUint16(o + 26, true) + dv.getUint16(o + 28, true);
        for (let i = 0; i < 8; i++) z[inicio + i] = 0xff;
      }),
    );
  });
});
