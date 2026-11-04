// Plantilla de importación de clientes (spec 007b, D7; plan: Contratos HTTP). El `.xlsx` se genera en memoria con
// `fflate`: una hoja «Clientes» con la cabecera y una hoja «Instrucciones». No trae filas de datos ni fórmulas, así
// que subirla intacta no crea nada, y no contiene datos de ningún estudio. Pura: sin IO, sin disco, sin logs.
import { strToU8, zipSync, type Zippable } from "fflate";

/** Columnas de la hoja de datos (contrato de D7; P1 a: «Responsable» es el correo del miembro). */
const COLUMNAS = [
  { nombre: "RUC", ancho: 14, texto: false },
  { nombre: "Razón social", ancho: 40, texto: false },
  // Las credenciales van en formato texto: un «00123» no pierde los ceros al abrirse en Excel.
  { nombre: "Usuario SOL", ancho: 18, texto: true },
  { nombre: "Clave SOL", ancho: 18, texto: true },
  { nombre: "client_id", ancho: 40, texto: true },
  { nombre: "client_secret", ancho: 40, texto: true },
  { nombre: "Responsable", ancho: 34, texto: false },
] as const;

/** Índices de `cellXfs` en `styles.xml`: 0 normal, 1 negrita (cabeceras), 2 texto (columnas de credencial). */
const ESTILO_NORMAL = 0;
const ESTILO_NEGRITA = 1;
const ESTILO_TEXTO = 2;

interface Linea {
  texto: string;
  negrita?: boolean;
}

const INSTRUCCIONES: readonly Linea[] = [
  { texto: "Instrucciones para importar clientes", negrita: true },
  { texto: "" },
  { texto: "Escriba un cliente por fila en la hoja «Clientes», que es la única que se lee." },
  { texto: "No cambie ni quite las columnas de la cabecera: si falta una, el archivo se rechaza." },
  { texto: "Máximo 1.000 filas y 2 MB por archivo. Las filas en blanco se ignoran." },
  { texto: "" },
  { texto: "Columnas", negrita: true },
  { texto: "RUC: obligatorio. Son 11 dígitos, con prefijo 10, 15, 16, 17 o 20 y dígito verificador válido." },
  { texto: "Razón social: opcional. Si la deja vacía, se usa «RUC» con el número como nombre provisional hasta consultar el RUC en SUNAT." },
  { texto: "Usuario SOL y Clave SOL: llene los dos o ninguno. La clave se guarda cifrada y no se vuelve a mostrar." },
  { texto: "client_id y client_secret: credencial SIRE. Llene los dos o ninguno. El secreto se guarda cifrado y no se vuelve a mostrar." },
  { texto: "Responsable: opcional. Escriba el correo de un miembro activo del estudio. Si ese miembro no puede ser responsable (por ejemplo, de solo lectura), la fila se rechaza." },
  { texto: "" },
  { texto: "Reglas", negrita: true },
  { texto: "Si un RUC aparece varias veces, vale la primera fila y las demás se informan como duplicadas." },
  { texto: "Un RUC que ya existe en el estudio no se vuelve a crear." },
  { texto: "No escriba fórmulas: la fila se rechaza." },
  { texto: "Razón social, usuario SOL, client_id y responsable no pueden empezar con =, +, - ni @: la fila se rechaza." },
  { texto: "Clave SOL y client_secret se aceptan tal cual, cualquiera sea su primer carácter." },
];

const PRELUDIO = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_HOJA = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_RELACIONES = "http://schemas.openxmlformats.org/package/2006/relationships";
const NS_DOCUMENTO = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const xml = (texto: string): string =>
  texto.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const letra = (i: number): string => String.fromCharCode(65 + i);

/** Celda de texto en línea (`inlineStr`): no necesita tabla de cadenas compartidas. */
const celda = (ref: string, texto: string, estilo: number): string =>
  `<c r="${ref}" s="${estilo}" t="inlineStr"><is><t>${xml(texto)}</t></is></c>`;

function hojaDeDatos(): string {
  const cols = COLUMNAS.map(
    (c, i) =>
      `<col min="${i + 1}" max="${i + 1}" width="${c.ancho}" customWidth="1"${c.texto ? ` style="${ESTILO_TEXTO}"` : ""}/>`,
  ).join("");
  const cabecera = COLUMNAS.map((c, i) =>
    celda(`${letra(i)}1`, c.nombre, ESTILO_NEGRITA),
  ).join("");
  return `${PRELUDIO}<worksheet xmlns="${NS_HOJA}"><cols>${cols}</cols><sheetData><row r="1">${cabecera}</row></sheetData></worksheet>`;
}

function hojaDeInstrucciones(): string {
  const filas = INSTRUCCIONES.map((linea, i) => {
    const r = i + 1;
    if (linea.texto === "") return `<row r="${r}"/>`;
    const estilo = linea.negrita === true ? ESTILO_NEGRITA : ESTILO_NORMAL;
    return `<row r="${r}">${celda(`A${r}`, linea.texto, estilo)}</row>`;
  }).join("");
  return `${PRELUDIO}<worksheet xmlns="${NS_HOJA}"><cols><col min="1" max="1" width="120" customWidth="1"/></cols><sheetData>${filas}</sheetData></worksheet>`;
}

const CONTENT_TYPES =
  `${PRELUDIO}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  "</Types>";

const RAIZ_RELS =
  `${PRELUDIO}<Relationships xmlns="${NS_RELACIONES}">` +
  `<Relationship Id="rId1" Type="${NS_DOCUMENTO}/officeDocument" Target="xl/workbook.xml"/>` +
  "</Relationships>";

const LIBRO =
  `${PRELUDIO}<workbook xmlns="${NS_HOJA}" xmlns:r="${NS_DOCUMENTO}"><sheets>` +
  '<sheet name="Clientes" sheetId="1" r:id="rId1"/>' +
  '<sheet name="Instrucciones" sheetId="2" r:id="rId2"/>' +
  "</sheets></workbook>";

const LIBRO_RELS =
  `${PRELUDIO}<Relationships xmlns="${NS_RELACIONES}">` +
  `<Relationship Id="rId1" Type="${NS_DOCUMENTO}/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="${NS_DOCUMENTO}/worksheet" Target="worksheets/sheet2.xml"/>` +
  `<Relationship Id="rId3" Type="${NS_DOCUMENTO}/styles" Target="styles.xml"/>` +
  "</Relationships>";

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
  '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  "</cellXfs>" +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

/**
 * Fecha fija de las entradas del ZIP. 1980-01-01 es el origen de DOS y, al ser local, da los mismos campos en
 * cualquier zona horaria: la plantilla sale idéntica byte a byte entre llamadas.
 */
const FECHA_FIJA = new Date(1980, 0, 1);
const entrada = (texto: string): [Uint8Array, { mtime: Date }] => [
  strToU8(texto),
  { mtime: FECHA_FIJA },
];

/** Plantilla `.xlsx` en memoria: no depende de ningún estudio y no trae filas de datos. */
export function generarPlantilla(): Uint8Array {
  const partes: Zippable = {
    "[Content_Types].xml": entrada(CONTENT_TYPES),
    "_rels/.rels": entrada(RAIZ_RELS),
    "xl/workbook.xml": entrada(LIBRO),
    "xl/_rels/workbook.xml.rels": entrada(LIBRO_RELS),
    "xl/styles.xml": entrada(ESTILOS),
    "xl/worksheets/sheet1.xml": entrada(hojaDeDatos()),
    "xl/worksheets/sheet2.xml": entrada(hojaDeInstrucciones()),
  };
  return zipSync(partes, { level: 6 });
}
