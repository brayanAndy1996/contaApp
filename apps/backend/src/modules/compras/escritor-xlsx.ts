// Escritor mínimo de `.xlsx` en memoria para el Excel de compras (spec 014, D-17, RF-105). Igual que la plantilla de 007b usa
// `fflate` y celdas de texto en línea (`inlineStr`), pero admite varias hojas con datos, cabecera en negrita y celdas numéricas.
// Pura: sin IO ni logs. Dos garantías de seguridad:
//  - todo texto que una hoja de cálculo pueda leer como fórmula se neutraliza con una comilla simple inicial y se guarda SIEMPRE
//    como texto (`t="inlineStr"`), jamás como `<f>`;
//  - un monto es una celda numérica escrita desde su cadena decimal exacta (`<v>-100.00</v>`): no pasa por `number`.
import { strToU8, zipSync, type Zippable } from "fflate";

/** Una celda: texto (se neutraliza), número exacto (cadena decimal) o vacía. */
export type CeldaXlsx =
  | { tipo: "texto"; valor: string }
  | { tipo: "monto"; valor: string }
  | { tipo: "entero"; valor: number }
  | null;

export interface ColumnaXlsx {
  titulo: string;
  ancho: number;
}

export interface HojaXlsx {
  nombre: string;
  columnas: readonly ColumnaXlsx[];
  filas: readonly (readonly CeldaXlsx[])[];
}

/** Índices de `cellXfs`: 0 normal, 1 negrita (cabecera), 2 número con dos decimales. */
const ESTILO_NORMAL = 0;
const ESTILO_NEGRITA = 1;
const ESTILO_MONTO = 2;

const PRELUDIO = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_HOJA = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_RELACIONES = "http://schemas.openxmlformats.org/package/2006/relationships";
const NS_DOCUMENTO = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/**
 * Texto que una hoja de cálculo podría ejecutar (inyección de fórmulas): empieza, tras espacios Unicode opcionales (los que
 * recorta `trim()`: NBSP, BOM, U+3000…), con `=`, `+`, `-` o `@`; o empieza con tabulación o retorno (H-007b-2, D-17).
 */
const PELIGROSO = /^[\s﻿]*[=+\-@]|^[\t\r]/u;

/** Caracteres que XML 1.0 no admite (controles salvo tab, LF y CR; U+FFFE/U+FFFF; sustitutos sueltos). */
const INVALIDOS_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Neutraliza un texto de celda: quita lo que XML no admite y antepone `'` si pudiera leerse como fórmula. */
export function neutralizarTexto(texto: string): string {
  const limpio = texto.replace(INVALIDOS_XML, "");
  return PELIGROSO.test(limpio) ? `'${limpio}` : limpio;
}

/** Texto a contenido XML. El retorno (CR) va como entidad: un lector XML conforme normaliza un CR literal a salto de línea. */
const xml = (texto: string): string =>
  texto.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\r", "&#13;");

/** Letra de columna: 0 → A, 25 → Z, 26 → AA. */
export function letraDeColumna(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const resto = (n - 1) % 26;
    s = String.fromCharCode(65 + resto) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const MONTO_EXACTO = /^-?\d{1,14}(\.\d{1,2})?$/;

function celdaXml(ref: string, c: CeldaXlsx, estiloTexto: number): string {
  if (c === null) return "";
  if (c.tipo === "texto") {
    const t = neutralizarTexto(c.valor);
    if (t === "") return "";
    return `<c r="${ref}" s="${estiloTexto}" t="inlineStr"><is><t xml:space="preserve">${xml(t)}</t></is></c>`;
  }
  if (c.tipo === "monto") {
    if (!MONTO_EXACTO.test(c.valor)) throw new TypeError("Monto con formato inválido.");
    return `<c r="${ref}" s="${ESTILO_MONTO}"><v>${c.valor}</v></c>`;
  }
  if (!Number.isSafeInteger(c.valor)) throw new TypeError("Entero inválido.");
  return `<c r="${ref}" s="${ESTILO_NORMAL}"><v>${c.valor}</v></c>`;
}

function hojaXml(h: HojaXlsx): string {
  const cols = h.columnas
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.ancho}" customWidth="1"/>`)
    .join("");
  const cabecera = h.columnas
    .map((c, i) => celdaXml(`${letraDeColumna(i)}1`, { tipo: "texto", valor: c.titulo }, ESTILO_NEGRITA))
    .join("");
  const partes: string[] = [`<row r="1">${cabecera}</row>`];
  h.filas.forEach((fila, k) => {
    const r = k + 2;
    partes.push(`<row r="${r}">${fila.map((c, i) => celdaXml(`${letraDeColumna(i)}${r}`, c, ESTILO_NORMAL)).join("")}</row>`);
  });
  return (
    `${PRELUDIO}<worksheet xmlns="${NS_HOJA}">` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${cols}</cols><sheetData>${partes.join("")}</sheetData></worksheet>`
  );
}

const ESTILOS =
  `${PRELUDIO}<styleSheet xmlns="${NS_HOJA}">` +
  '<fonts count="2">' +
  '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  "</fonts>" +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  "</cellXfs>" +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

/** Fecha fija de las entradas del ZIP (mismo criterio que la plantilla de 007b): el archivo es reproducible. */
const FECHA_FIJA = new Date(1980, 0, 1);
const entrada = (texto: string): [Uint8Array, { mtime: Date }] => [strToU8(texto), { mtime: FECHA_FIJA }];

const nombreHoja = (n: string): string => xml(n.replace(/[\\/?*[\]:]/g, " ").slice(0, 31));

/** Libro `.xlsx` con las hojas dadas (al menos una). */
export function generarLibro(hojas: readonly HojaXlsx[]): Uint8Array {
  if (hojas.length === 0) throw new TypeError("Un libro necesita al menos una hoja.");
  const contentTypes =
    `${PRELUDIO}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    hojas
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join("") +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    "</Types>";
  const raizRels =
    `${PRELUDIO}<Relationships xmlns="${NS_RELACIONES}">` +
    `<Relationship Id="rId1" Type="${NS_DOCUMENTO}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const libro =
    `${PRELUDIO}<workbook xmlns="${NS_HOJA}" xmlns:r="${NS_DOCUMENTO}"><sheets>` +
    hojas.map((h, i) => `<sheet name="${nombreHoja(h.nombre)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
    "</sheets></workbook>";
  const libroRels =
    `${PRELUDIO}<Relationships xmlns="${NS_RELACIONES}">` +
    hojas
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_DOCUMENTO}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join("") +
    `<Relationship Id="rId${hojas.length + 1}" Type="${NS_DOCUMENTO}/styles" Target="styles.xml"/></Relationships>`;
  const partes: Zippable = {
    "[Content_Types].xml": entrada(contentTypes),
    "_rels/.rels": entrada(raizRels),
    "xl/workbook.xml": entrada(libro),
    "xl/_rels/workbook.xml.rels": entrada(libroRels),
    "xl/styles.xml": entrada(ESTILOS),
  };
  hojas.forEach((h, i) => {
    partes[`xl/worksheets/sheet${i + 1}.xml`] = entrada(hojaXml(h));
  });
  return zipSync(partes, { level: 6 });
}
