// Spec 016 (D-1, D-2, plan «Parser seguro»): `leerUbl(bytes) → DetalleXml`. Orden fijo, sin parsear nada antes de 1–3:
// (1–2) `escanear` sobre los bytes (tope, DOCTYPE/ENTITY, NUL, profundidad, ítems), (3) `decodificar` (UTF-8 o
// ISO-8859-1), (4) `XMLValidator` y `fast-xml-parser` sin entidades ni conversión de valores, (5) mapeo D-2 con `Money`.
// Cualquier fallo es `UblError` con un mensaje fijo: nunca repite la entrada ni lleva la causa.
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Money } from "../dinero/index";
import type { Moneda } from "../dinero/index";
import type { Entero } from "../texto/index";
import { decodificar } from "./decodificar";
import { escanear } from "./escaneo";
import { exacto, importe, sumar, texto } from "./montos";
import { UblError, incompleto, invalido } from "./tipos";
import type { AfectacionXml, DetalleXml, IdentidadXml, ItemXml, RaizUbl, TotalesXml } from "./tipos";

type Nodo = Readonly<Record<string, unknown>>;

const OPCIONES = {
  processEntities: false,
  htmlEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  removeNSPrefix: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  alwaysCreateTextNode: true,
  cdataPropName: "__cdata",
  commentPropName: false,
  trimValues: true,
  // Todo elemento como arreglo (los atributos no): la forma no depende de cuántas veces se repita.
  isArray: (_nombre: string, _ruta: unknown, _hoja: boolean, esAtributo: boolean) => !esAtributo,
} as const;

const RAICES: readonly RaizUbl[] = ["Invoice", "CreditNote", "DebitNote"];
const CANTIDAD: Readonly<Record<RaizUbl, string>> = {
  Invoice: "InvoicedQuantity",
  CreditNote: "CreditedQuantity",
  DebitNote: "DebitedQuantity",
};
const TIPO_NOTA: Readonly<Record<RaizUbl, string | null>> = { Invoice: null, CreditNote: "07", DebitNote: "08" };
/** Tipos que admite un `Invoice` (factura y boleta): una nota va siempre en su propia raíz (H-016-3). */
const TIPOS_FACTURA: readonly string[] = ["01", "03"];
const AFECTACION_DE_ESQUEMA: readonly (readonly [string, AfectacionXml])[] = [
  ["1000", "gravado"],
  ["9997", "exonerado"],
  ["9998", "inafecto"],
  ["9995", "exportacion"],
  ["9996", "gratuito"],
];

const LARGO_GLOSA: Entero = 500;
const ID_COMPROBANTE = /^([A-Za-z0-9]{1,4})-([0-9]{1,8})$/;
const TIPO_COMPROBANTE = /^[0-9]{2}$/;
const FECHA = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const RUC = /^[0-9]{11}$/;
const TIPO_DOC = /^[0-9A-Za-z-]{0,2}$/;
const NUMERO_DOC = /^[0-9A-Za-z-]{1,20}$/;
const UNIDAD = /^[0-9A-Za-z-]{0,10}$/;
const MONEDAS: readonly string[] = ["PEN", "USD"];
const CEROS_IZQUIERDA = /^0+(?=[0-9])/;
const ENTIDAD = /&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g;
const PREDEFINIDAS: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const HEX = "0123456789abcdef";

// ------------------------------------------------------------------ navegación del árbol
const esNodo = (v: unknown): v is Nodo => typeof v === "object" && v !== null && !Array.isArray(v);

/** Cuántas veces aparece el elemento `nombre` en `n`, sea nodo, texto o vacío (`<a/>`). */
function cuantos(n: Nodo | null, nombre: string): Entero {
  if (n === null || !Object.hasOwn(n, nombre)) return 0;
  return [n[nombre]].flat().length;
}

/** `xml_invalido` si alguno de `nombres` aparece, entre todos, más de una vez en `n`: un total repetido es ambiguo. */
function aLoSumoUno(n: Nodo | null, ...nombres: readonly string[]): void {
  if (nombres.reduce((suma, nombre) => suma + cuantos(n, nombre), 0) > 1) invalido();
}

/** Hijos `nombre` de `n` (con `isArray`, todo elemento llega como arreglo). */
function hijos(n: Nodo | null, nombre: string): Nodo[] {
  if (n === null || !Object.hasOwn(n, nombre)) return [];
  return [n[nombre]].flat().filter(esNodo);
}

function primero(n: Nodo | null, ...ruta: readonly string[]): Nodo | null {
  let actual = n;
  for (const nombre of ruta) actual = hijos(actual, nombre)[0] ?? null;
  return actual;
}

function atributo(n: Nodo | null, nombre: string): string | null {
  const clave = `@_${nombre}`;
  if (n === null || !Object.hasOwn(n, clave)) return null;
  return String(n[clave]).trim();
}

/** Valor de un punto de código de una referencia numérica; `null` si no es un carácter XML. */
function caracter(ref: string): string | null {
  const hex = ref.startsWith("#x");
  let punto: Entero = 0;
  for (const c of ref.slice(hex ? 2 : 1).toLowerCase()) punto = punto * (hex ? 16 : 10) + HEX.indexOf(c);
  const valido =
    punto === 0x9 ||
    punto === 0xa ||
    punto === 0xd ||
    (punto >= 0x20 && punto <= 0xd7ff) ||
    (punto >= 0xe000 && punto <= 0xfffd) ||
    (punto >= 0x10000 && punto <= 0x10ffff);
  return valido ? String.fromCodePoint(punto) : null;
}

/** Las 5 entidades predefinidas y las referencias numéricas (nunca entidades declaradas: no hay DOCTYPE). */
function sinEntidades(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(ENTIDAD, (todo, ref: string) => (ref.startsWith("#") ? (caracter(ref) ?? todo) : PREDEFINIDAS[ref]!));
}

/** `#text` de un nodo ("" si solo trae CDATA o nada). */
const cadena = (v: unknown): string => (typeof v === "string" ? v : "");

/** Texto de un elemento: su texto (con entidades) seguido del de sus secciones CDATA (literal); `null` si no está. */
function textoDe(n: Nodo | null): string | null {
  if (n === null) return null;
  const propio = sinEntidades(cadena(n["#text"]));
  const cdata = hijos(n, "__cdata")
    .map((c) => cadena(c["#text"]))
    .join("");
  return `${propio}${cdata}`.trim();
}

const textoEn = (n: Nodo | null, ...ruta: readonly string[]): string | null => textoDe(primero(n, ...ruta));

/** Recorta a `largo` unidades sin dejar medio par sustituto al final. */
function recortar(s: string, largo: Entero): string {
  if (s.length <= largo) return s;
  const r = s.slice(0, largo);
  const ultimo = r.charCodeAt(largo - 1);
  return ultimo >= 0xd800 && ultimo <= 0xdbff ? r.slice(0, largo - 1) : r;
}

const conGramatica = (v: string, gramatica: RegExp): string => (gramatica.test(v) ? v : invalido());
const requerido = (v: string | null): string => (v === null || v === "" ? incompleto() : v);

// ------------------------------------------------------------------ montos con su moneda
class LectorMontos {
  unica = true;

  constructor(readonly moneda: Moneda) {}

  /** Importe de un elemento (`null` si no vino); un `currencyID` distinto del documento marca `monedaUnica = false`. */
  leer(n: Nodo | null): Money | null {
    if (n === null) return null;
    this.marcar(n);
    return importe(textoDe(n), this.moneda);
  }

  marcar(n: Nodo): void {
    const c = atributo(n, "currencyID");
    if (c !== null && c !== this.moneda) this.unica = false;
  }
}

interface Subtotal {
  readonly esquema: string;
  readonly base: Money | null;
  readonly impuesto: Money;
}

function subtotales(n: Nodo, lector: LectorMontos): Subtotal[] {
  return hijos(n, "TaxTotal")
    .flatMap((t) => hijos(t, "TaxSubtotal"))
    .map((s) => ({
      esquema: textoEn(s, "TaxCategory", "TaxScheme", "ID") ?? "",
      base: lector.leer(primero(s, "TaxableAmount")),
      impuesto: lector.leer(primero(s, "TaxAmount")) ?? importe(null, lector.moneda),
    }));
}

const deEsquema = (lista: readonly Subtotal[], esquema: string, moneda: Moneda): Money =>
  sumar(
    lista.filter((s) => s.esquema === esquema).map((s) => s.impuesto),
    moneda,
  );

// ------------------------------------------------------------------ partes del documento
/** La única raíz del documento: `Invoice`, `CreditNote` o `DebitNote` (el validador ya exige una sola). */
function raizDe(arbol: Nodo): { raiz: RaizUbl; nodo: Nodo } {
  const raiz = RAICES.find((r) => Object.hasOwn(arbol, r)) ?? invalido();
  return { raiz, nodo: primero(arbol, raiz)! };
}

function identidadDe(raiz: RaizUbl, n: Nodo): IdentidadXml {
  const id = ID_COMPROBANTE.exec(requerido(textoEn(n, "ID"))) ?? invalido();
  const tipo = TIPO_NOTA[raiz] ?? conGramatica(requerido(textoEn(n, "InvoiceTypeCode")), TIPO_COMPROBANTE);
  if (raiz === "Invoice" && !TIPOS_FACTURA.includes(tipo)) invalido();
  const proveedor = primero(n, "AccountingSupplierParty", "Party");
  const ruc = conGramatica(requerido(textoEn(proveedor, "PartyIdentification", "ID")), RUC);
  const razonSocial = textoEn(proveedor, "PartyLegalEntity", "RegistrationName") ?? textoEn(proveedor, "PartyName", "Name") ?? "";
  const cliente = primero(n, "AccountingCustomerParty");
  const idCliente = primero(cliente, "Party", "PartyIdentification", "ID");
  const numeroCliente = conGramatica(requerido(textoDe(idCliente)), NUMERO_DOC);
  const tipoCliente = conGramatica(atributo(idCliente, "schemeID") ?? textoEn(cliente, "AdditionalAccountID") ?? "", TIPO_DOC);
  return {
    tipo,
    serie: id[1]!.toUpperCase(),
    numero: id[2]!.replace(CEROS_IZQUIERDA, ""),
    emisor: { ruc, razonSocial: recortar(razonSocial, LARGO_GLOSA) },
    receptor: { tipoDoc: tipoCliente, numero: numeroCliente },
  };
}

interface Linea {
  readonly item: ItemXml;
  readonly valor: Money;
}

function lineaDe(raiz: RaizUbl, n: Nodo, lector: LectorMontos, negativo: boolean): Linea {
  const moneda = lector.moneda;
  const impuestos = subtotales(n, lector);
  const esquemas = new Set(impuestos.map((s) => s.esquema));
  const afectacion = AFECTACION_DE_ESQUEMA.find(([e]) => esquemas.has(e))?.[1] ?? "otro";
  const valor = lector.leer(primero(n, "LineExtensionAmount")) ?? importe(null, moneda);
  const cantidad = primero(n, CANTIDAD[raiz]);
  const precio = primero(n, "Price", "PriceAmount");
  if (precio !== null) lector.marcar(precio);
  const descripcion = hijos(primero(n, "Item"), "Description")
    .map((d) => textoDe(d) ?? "")
    .join(" ");
  return {
    valor,
    item: {
      descripcion: recortar(descripcion, LARGO_GLOSA),
      cantidad: exacto(textoDe(cantidad)),
      unidad: conGramatica(atributo(cantidad, "unitCode") ?? "", UNIDAD),
      precioUnitario: exacto(textoDe(precio)),
      valor: texto(valor, negativo),
      afectacion,
      igv: texto(deEsquema(impuestos, "1000", moneda), negativo),
      isc: texto(deEsquema(impuestos, "2000", moneda), negativo),
      icbper: texto(deEsquema(impuestos, "7152", moneda), negativo),
    },
  };
}

function totalesDe(n: Nodo, lineas: readonly Linea[], lector: LectorMontos, negativo: boolean): TotalesXml {
  const moneda = lector.moneda;
  const columnas = { gravado: [] as Money[], igv: [] as Money[], noGravado: [] as Money[], isc: [] as Money[], icbper: [] as Money[], otros: [] as Money[] };
  // Base de un subtotal sin `TaxableAmount`: la suma de las líneas de esa afectación (0.00 si no hay).
  const deLineas = (a: AfectacionXml): Money =>
    sumar(
      lineas.filter((l) => l.item.afectacion === a).map((l) => l.valor),
      moneda,
    );
  for (const s of subtotales(n, lector)) {
    switch (s.esquema) {
      case "1000":
        columnas.gravado.push(s.base ?? deLineas("gravado"));
        columnas.igv.push(s.impuesto);
        break;
      case "9997":
        columnas.noGravado.push(s.base ?? deLineas("exonerado"));
        break;
      case "9998":
        columnas.noGravado.push(s.base ?? deLineas("inafecto"));
        break;
      case "2000":
        columnas.isc.push(s.impuesto);
        break;
      case "7152":
        columnas.icbper.push(s.impuesto);
        break;
      case "9999":
        columnas.otros.push(s.impuesto);
        break;
      // 9995 y 9996 (gratuitas) y los esquemas desconocidos no suman.
    }
  }
  // Un solo total por documento (H-016-2, H-016-5): un segundo TaxTotal, total monetario o importe es ambiguo.
  aLoSumoUno(n, "TaxTotal");
  aLoSumoUno(n, "LegalMonetaryTotal", "RequestedMonetaryTotal");
  const monetario = primero(n, "LegalMonetaryTotal") ?? primero(n, "RequestedMonetaryTotal");
  aLoSumoUno(monetario, "PayableAmount");
  aLoSumoUno(monetario, "TaxInclusiveAmount");
  // Los dos se leen siempre (también se valida el que no se usa): un importe negativo nunca pasa desapercibido (H-016-4).
  const pagable = lector.leer(primero(monetario, "PayableAmount"));
  const incluyeImpuestos = lector.leer(primero(monetario, "TaxInclusiveAmount"));
  const total = pagable ?? incluyeImpuestos ?? incompleto();
  const t = (lista: readonly Money[]): string => texto(sumar(lista, moneda), negativo);
  return {
    gravado: t(columnas.gravado),
    igv: t(columnas.igv),
    noGravado: t(columnas.noGravado),
    isc: t(columnas.isc),
    icbper: t(columnas.icbper),
    otros: t(columnas.otros),
    total: texto(total, negativo),
  };
}

function mapear(arbol: Nodo): DetalleXml {
  const { raiz, nodo } = raizDe(arbol);
  const identidad = identidadDe(raiz, nodo);
  const fecha = conGramatica(requerido(textoEn(nodo, "IssueDate")), FECHA);
  const codigoMoneda = requerido(textoEn(nodo, "DocumentCurrencyCode"));
  const moneda = (MONEDAS.includes(codigoMoneda) ? codigoMoneda : invalido()) as Moneda;
  const negativo = raiz === "CreditNote";
  const lector = new LectorMontos(moneda);
  const lineas = hijos(nodo, `${raiz}Line`).map((l) => lineaDe(raiz, l, lector, negativo));
  const totales = totalesDe(nodo, lineas, lector, negativo);
  return {
    raiz,
    identidad,
    fecha,
    moneda,
    monedaUnica: lector.unica,
    totales,
    items: lineas.map((l) => l.item),
  };
}

/**
 * Bytes de un comprobante UBL 2.1 (`Invoice`, `CreditNote` o `DebitNote`, con cualquier prefijo) → `DetalleXml`.
 * Lanza `UblError` (`xml_invalido` | `xml_incompleto`) sin contenido de la entrada.
 */
export function leerUbl(bytes: Uint8Array): DetalleXml {
  try {
    if (!(bytes instanceof Uint8Array)) invalido();
    escanear(bytes);
    const xml = decodificar(bytes);
    if (XMLValidator.validate(xml) !== true) invalido();
    return mapear(new XMLParser(OPCIONES).parse(xml) as Nodo);
  } catch (e) {
    // Un error ajeno (p. ej. el del parser) puede citar la entrada: se descarta entero. El propio se re-crea sin pila previa.
    throw new UblError(e instanceof UblError ? e.codigo : "xml_invalido");
  }
}
