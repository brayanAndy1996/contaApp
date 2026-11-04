// Soporte de las pruebas de importación de 007b (T3; también lo usa T4). Genera `.xlsx` y `.csv` en memoria con
// `fflate`, incluidos los archivos maliciosos (bomba de descompresión, XXE, rutas con `..`, miles de entradas).
// No toca disco ni red, y no usa ninguna clave real: las claves son canarios sintéticos.
import { strToU8, unzipSync, zipSync } from "fflate";

/** Cabecera de la plantilla (contrato de D7; P1 a: «Responsable» es el correo del miembro). */
export const CABECERA = [
  "RUC",
  "Razón social",
  "Usuario SOL",
  "Clave SOL",
  "client_id",
  "client_secret",
  "Responsable",
] as const;

export interface DatosFila {
  ruc?: string;
  razonSocial?: string;
  usuarioSol?: string;
  claveSol?: string;
  clientId?: string;
  clientSecret?: string;
  responsable?: string;
}

/** Una fila de datos en el orden de `CABECERA`. */
export function filaDatos(d: DatosFila): string[] {
  return [
    d.ruc ?? "",
    d.razonSocial ?? "",
    d.usuarioSol ?? "",
    d.claveSol ?? "",
    d.clientId ?? "",
    d.clientSecret ?? "",
    d.responsable ?? "",
  ];
}

const PESOS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
/**
 * RUC de 11 dígitos con prefijo dado y dígito verificador módulo 11 calculado aquí (independiente de `validarRuc`).
 * Con prefijo 10/15/16/17/20 es válido; con 11, 12 o 30 tiene el dígito correcto pero prefijo no permitido.
 */
export function rucConPrefijo(prefijo: string, serie: number): string {
  const cuerpo = `${prefijo}${String(10_000_000 + serie).padStart(8, "0")}`;
  const suma = [...cuerpo].reduce(
    (s, c, i) => s + Number(c) * (PESOS[i] as number),
    0,
  );
  return `${cuerpo}${(11 - (suma % 11)) % 10}`;
}

// --- CSV ----------------------------------------------------------------------------------------------------------

export interface OpcionesCsv {
  sep?: "," | ";";
  bom?: boolean;
  eol?: "\n" | "\r\n";
}
export function csv(
  filas: string[][],
  { sep = ",", bom = false, eol = "\r\n" }: OpcionesCsv = {},
): Uint8Array {
  const campo = (v: string) =>
    /[",;\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
  const texto = filas.map((f) => f.map(campo).join(sep)).join(eol) + eol;
  return strToU8((bom ? "﻿" : "") + texto);
}

// --- XLSX ---------------------------------------------------------------------------------------------------------

/**
 * Celda de una hoja: `string` (cadena compartida), `{ en }` (cadena en línea), `number` (numérica),
 * `{ f, v }` (fórmula real `<f>` con valor en caché) o `null` (celda ausente).
 */
export type Celda =
  string | number | { en: string } | { f: string; v?: string } | null;

const xml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const PRELUDIO = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const columna = (i: number) => String.fromCharCode(65 + i);

function hojaXml(filas: Celda[][], cadenas: string[], doctype = ""): string {
  const indice = (s: string) => {
    let i = cadenas.indexOf(s);
    if (i < 0) i = cadenas.push(s) - 1;
    return i;
  };
  const filasXml = filas.map((celdas, r) => {
    const cs = celdas.map((c, i) => {
      if (c === null || c === "") return "";
      const ref = `${columna(i)}${r + 1}`;
      if (typeof c === "number") return `<c r="${ref}"><v>${c}</v></c>`;
      if (typeof c === "string")
        return `<c r="${ref}" t="s"><v>${indice(c)}</v></c>`;
      if ("en" in c)
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(c.en)}</t></is></c>`;
      return `<c r="${ref}" t="str"><f>${xml(c.f)}</f><v>${xml(c.v ?? "")}</v></c>`;
    });
    return `<row r="${r + 1}">${cs.join("")}</row>`;
  });
  return `${PRELUDIO}${doctype}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${filasXml.join("")}</sheetData></worksheet>`;
}

export interface OpcionesXlsx {
  /** Texto insertado entre la declaración XML y la raíz de la primera hoja (p. ej. un `<!DOCTYPE …>`). */
  doctypeHoja?: string;
  /** Ídem para `sharedStrings.xml`. */
  doctypeCadenas?: string;
  /** Hojas adicionales (la primera es la que se lee). */
  hojasExtra?: Celda[][][];
}

/** Las partes de un `.xlsx` mínimo y válido, para que una prueba agregue o cambie entradas antes de comprimir. */
export function partesXlsx(
  filas: Celda[][],
  opc: OpcionesXlsx = {},
): Record<string, Uint8Array> {
  const cadenas: string[] = [];
  const hojas = [filas, ...(opc.hojasExtra ?? [])];
  const xmlHojas = hojas.map((h, i) =>
    hojaXml(h, cadenas, i === 0 ? opc.doctypeHoja : ""),
  );
  const partes: Record<string, string> = {
    "[Content_Types].xml": `${PRELUDIO}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    "_rels/.rels": `${PRELUDIO}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `${PRELUDIO}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${hojas
      .map(
        (_, i) =>
          `<sheet name="Hoja${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
      )
      .join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `${PRELUDIO}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${hojas
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join(
        "",
      )}<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `${PRELUDIO}${opc.doctypeCadenas ?? ""}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${cadenas.length}" uniqueCount="${cadenas.length}">${cadenas
      .map((s) => `<si><t xml:space="preserve">${xml(s)}</t></si>`)
      .join("")}</sst>`,
  };
  xmlHojas.forEach((h, i) => (partes[`xl/worksheets/sheet${i + 1}.xml`] = h));
  return Object.fromEntries(
    Object.entries(partes).map(([k, v]) => [k, strToU8(v)]),
  );
}

export function comprimir(partes: Record<string, Uint8Array>): Uint8Array {
  return zipSync(partes, { level: 6 });
}

/** `.xlsx` mínimo y válido. `filas[0]` es la cabecera. */
export function xlsx(filas: Celda[][], opc: OpcionesXlsx = {}): Uint8Array {
  return comprimir(partesXlsx(filas, opc));
}

/** Cabecera + filas de datos (cada una en el orden de `CABECERA`). */
export function xlsxConDatos(
  datos: DatosFila[],
  opc: OpcionesXlsx = {},
): Uint8Array {
  return xlsx([[...CABECERA], ...datos.map(filaDatos)], opc);
}

/** Descomprime un `.xlsx` generado aquí (para inspeccionar la plantilla, etc.). */
export function entradasDe(datos: Uint8Array): Record<string, string> {
  return Object.fromEntries(
    Object.entries(unzipSync(datos)).map(([nombre, bytes]) => [
      nombre,
      new TextDecoder().decode(bytes),
    ]),
  );
}

// --- Archivos maliciosos ------------------------------------------------------------------------------------------

const FILA_OK = filaDatos({
  ruc: rucConPrefijo("20", 1),
  razonSocial: "ACME S.A.C.",
});
const base = (): Celda[][] => [[...CABECERA], FILA_OK];

/**
 * Bomba de descompresión: una entrada de `bytes` ceros (comprime a ~KB) y, si `declararPoco`, con el tamaño
 * descomprimido de las cabeceras local y central falsificado a 100 B (lo que un lector ingenuo creería).
 */
export function xlsxBomba(bytes: number, declararPoco: boolean): Uint8Array {
  const partes = partesXlsx(base());
  partes["xl/media/relleno.bin"] = new Uint8Array(bytes);
  const zip = comprimir(partes);
  if (!declararPoco) return zip;
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const dec = new TextDecoder();
  for (let i = 0; i + 46 < zip.length; i++) {
    if (dv.getUint32(i, true) !== 0x02014b50) continue; // cabecera del directorio central
    const largoNombre = dv.getUint16(i + 28, true);
    const nombre = dec.decode(zip.subarray(i + 46, i + 46 + largoNombre));
    if (nombre !== "xl/media/relleno.bin") continue;
    dv.setUint32(i + 24, 100, true);
    const local = dv.getUint32(i + 42, true);
    dv.setUint32(local + 22, 100, true);
  }
  return zip;
}

/** Miles de entradas diminutas (supera cualquier tope razonable de entradas de un `.xlsx`). */
export function xlsxMilesDeEntradas(n = 5000): Uint8Array {
  const partes = partesXlsx(base());
  for (let i = 0; i < n; i++) partes[`xl/extra/e${i}.xml`] = strToU8("<a/>");
  return comprimir(partes);
}

/** Un `.xlsx` válido con una entrada de ruta peligrosa (`..` o absoluta). */
export function xlsxConRuta(ruta: string): Uint8Array {
  const partes = partesXlsx(base());
  partes[ruta] = strToU8("x");
  return comprimir(partes);
}

export const DOCTYPE_XXE =
  '<!DOCTYPE hoja [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>';
export const DOCTYPE_LOLS =
  '<!DOCTYPE lolz [<!ENTITY a "AAAAAAAAAA"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>';
export const DOCTYPE_SIMPLE = "<!DOCTYPE html>";
