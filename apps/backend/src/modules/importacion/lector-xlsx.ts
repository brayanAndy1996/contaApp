// Lector de `.xlsx` de importación (spec 007b, D7; plan: Decisiones "Lector propio mínimo").
// `fflate` con topes (zip-seguro.ts) y `fast-xml-parser` sin DOCTYPE ni entidades propias. Lee solo la primera
// hoja; no evalúa fórmulas: marca la columna. Pura: todo en memoria, sin disco ni logs.
import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  construirFilas,
  construirTabla,
  type FilaTabla,
  type PerfilTabla,
  type Registro,
} from "./tabla.js";
import { ErrorArchivo, LIMITES, type ArchivoLeido, type Limites } from "./tipos.js";
import { abrirZip } from "./zip-seguro.js";

/** Columnas de una hoja de Excel (A..XFD). */
const MAX_COLUMNAS = 16_384;
const MAX_FILA = 1_048_576;

type Nodo = Record<string, unknown>;

const invalido = (): never => {
  throw new ErrorArchivo("archivo_invalido");
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  // Solo las cinco entidades predefinidas y las referencias numéricas: un DOCTYPE se rechaza antes de llegar aquí.
  processEntities: true,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  isArray: (nombre, _ruta, _hoja, atributo) =>
    !atributo &&
    ["sheet", "Relationship", "row", "c", "si", "r"].includes(nombre),
});

function xml(bytes: Uint8Array | undefined): Nodo {
  if (bytes === undefined) return invalido();
  let texto = "";
  try {
    texto = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalido();
  }
  // XXE y expansión de entidades: ningún `<!` salvo comentarios y CDATA (el texto de una celda llega escapado).
  if (/<!(?!--|\[CDATA\[)/.test(texto)) invalido();
  if (XMLValidator.validate(texto) !== true) invalido();
  try {
    return parser.parse(texto) as Nodo;
  } catch {
    return invalido();
  }
}

const hijo = (n: unknown, clave: string): unknown =>
  n !== null && typeof n === "object" ? (n as Nodo)[clave] : undefined;
const lista = (n: unknown, clave: string): Nodo[] => {
  const v = hijo(n, clave);
  return Array.isArray(v) ? (v as Nodo[]) : [];
};
const atributo = (n: unknown, nombre: string): string | undefined => {
  const v = hijo(n, `@_${nombre}`);
  return typeof v === "string" ? v : undefined;
};

/** Texto de un nodo hoja (`<t>`, `<v>`): con o sin atributos (el analizador no convierte tipos: todo es cadena). */
function texto(n: unknown): string {
  if (typeof n === "string") return n;
  if (n !== null && typeof n === "object") return texto((n as Nodo)["#text"]);
  return "";
}

/** `<si>`/`<is>`: un `<t>` o varios `<r><t>` (texto enriquecido); las guías fonéticas `<rPh>` se ignoran. */
function textoEnriquecido(n: unknown): string {
  const t = hijo(n, "t");
  if (t !== undefined) return texto(t);
  return lista(n, "r")
    .map((r) => texto(r["t"]))
    .join("");
}

/** Un número entero en notación científica (`2.01E+10`) vuelve a sus dígitos; lo demás queda tal cual. */
function numeroATexto(v: string): string {
  const m = /^(\d)\.(\d+)E\+(\d+)$/i.exec(v.trim());
  if (m === null) return v;
  const [, entero, decimales, exponente] = m as unknown as [
    string,
    string,
    string,
    string,
  ];
  const exp = Number(exponente);
  if (exp < decimales.length || exp > 30) return v;
  return `${entero}${decimales}${"0".repeat(exp - decimales.length)}`;
}

function resolver(base: string, destino: string): string {
  const ruta = destino.startsWith("/") ? destino.slice(1) : `${base}${destino}`;
  const segmentos = ruta.split("/").filter((s) => s !== ".");
  if (segmentos.some((s) => s === ".." || s === "")) invalido();
  return segmentos.join("/");
}

const directorio = (ruta: string) => ruta.slice(0, ruta.lastIndexOf("/") + 1);
const relsDe = (ruta: string) =>
  `${directorio(ruta)}_rels/${ruta.slice(ruta.lastIndexOf("/") + 1)}.rels`;

function relaciones(partes: Map<string, Uint8Array>, ruta: string): Nodo[] {
  const bytes = partes.get(relsDe(ruta));
  return bytes === undefined
    ? []
    : lista(hijo(xml(bytes), "Relationships"), "Relationship");
}

function columnaDe(ref: string | undefined, porDefecto: number): number {
  if (ref === undefined) return porDefecto;
  const m = /^([A-Z]{1,3})\d+$/.exec(ref);
  if (m === null) return invalido();
  let i = 0;
  for (const c of m[1] as string) i = i * 26 + (c.charCodeAt(0) - 64);
  if (i > MAX_COLUMNAS) invalido();
  return i - 1;
}

function* registrosHoja(
  hoja: Nodo,
  cadenas: string[],
  limites: Limites,
): Generator<Registro> {
  const filas = lista(hijo(hijo(hoja, "worksheet"), "sheetData"), "row");
  let anterior = 0;
  for (const fila of filas) {
    const r = atributo(fila, "r");
    const n = r === undefined ? anterior + 1 : Number(r);
    if (!Number.isInteger(n) || n <= anterior || n > MAX_FILA) invalido();
    anterior = n;
    const celdas: string[] = [];
    const formulas = new Set<number>();
    let siguiente = 0;
    for (const c of lista(fila, "c")) {
      const i = columnaDe(atributo(c, "r"), siguiente);
      siguiente = i + 1;
      // Más allá de las columnas que se leen, la celda se ignora: no se rellena hasta ella (H-007b-1).
      if (i >= limites.maxColumnas) continue;
      if ("f" in c) formulas.add(i);
      const tipo = atributo(c, "t") ?? "n";
      let valor: string;
      if (tipo === "s") {
        const k = Number(texto(c["v"]));
        if (!Number.isInteger(k) || k < 0 || k >= cadenas.length) invalido();
        valor = cadenas[k] as string;
      } else if (tipo === "inlineStr") valor = textoEnriquecido(c["is"]);
      else if (tipo === "n") valor = numeroATexto(texto(c["v"]));
      else valor = texto(c["v"]);
      while (celdas.length < i) celdas.push("");
      celdas[i] = valor;
    }
    yield { n, celdas, formulas };
  }
}

/**
 * Lee la primera hoja de un `.xlsx` con los topes dados y entrega sus registros ya construidos con `construir`; lanza
 * `ErrorArchivo`. Los topes de bytes, entradas y descompresión se comprueban antes de reservar memoria.
 */
function leerHoja<T>(
  datos: Uint8Array,
  limites: Limites,
  construir: (registros: Iterable<Registro>) => T,
): T {
  if (datos.length > limites.maxBytes)
    throw new ErrorArchivo("archivo_demasiado_grande");
  try {
    const partes = abrirZip(
      datos,
      (n) => n.endsWith(".xml") || n.endsWith(".rels"),
      limites,
    );

    const oficial = relaciones(partes, "").find((r) =>
      (atributo(r, "Type") ?? "").endsWith("/officeDocument"),
    );
    const libroRuta = resolver(
      "",
      atributo(oficial, "Target") ?? "xl/workbook.xml",
    );
    const libro = xml(partes.get(libroRuta));
    const primera = lista(hijo(hijo(libro, "workbook"), "sheets"), "sheet")[0];
    const id = atributo(primera, "id");
    if (id === undefined) invalido();

    const rels = relaciones(partes, libroRuta);
    const relHoja = rels.find((r) => atributo(r, "Id") === id);
    const destinoHoja = atributo(relHoja, "Target");
    if (destinoHoja === undefined) invalido();
    const hoja = xml(
      partes.get(resolver(directorio(libroRuta), destinoHoja as string)),
    );

    const relCadenas = rels.find((r) =>
      (atributo(r, "Type") ?? "").endsWith("/sharedStrings"),
    );
    const destinoCadenas = atributo(relCadenas, "Target");
    const rutaCadenas =
      destinoCadenas === undefined
        ? undefined
        : resolver(directorio(libroRuta), destinoCadenas);
    const cadenas =
      rutaCadenas !== undefined && partes.has(rutaCadenas)
        ? lista(hijo(xml(partes.get(rutaCadenas)), "sst"), "si").map(
            textoEnriquecido,
          )
        : [];

    return construir(registrosHoja(hoja, cadenas, limites));
  } catch (e) {
    if (e instanceof ErrorArchivo) throw e;
    throw new ErrorArchivo("archivo_invalido");
  }
}

/** Lee un `.xlsx` con el perfil de otro uso (ventas, 013): sus topes y sus columnas; lanza `ErrorArchivo`. */
export function leerXlsxTabla<C extends string>(
  datos: Uint8Array,
  perfil: PerfilTabla<C>,
): FilaTabla<C>[] {
  return leerHoja(datos, perfil.limites, (r) => construirTabla(r, perfil));
}

/** Lee la primera hoja de un `.xlsx` de clientes (007b); lanza `ErrorArchivo`. */
export function leerXlsx(datos: Uint8Array): ArchivoLeido {
  return leerHoja(datos, LIMITES, construirFilas);
}
