import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { igvEsperado, Money, TASA_IGV_18 } from "@contapp/domain";
import { validarRuc } from "@contapp/shared";
import { clasificarError, ErrorSunat } from "./errores.js";
import type { FilaPropuestaSire } from "./puertos.js";
import { MockConsultaRuc } from "./mock/consulta-ruc.mock.js";
import { MockSireApiClient } from "./mock/sire-api-client.mock.js";
import { MockSireAuth } from "./mock/sire-auth.mock.js";
import { MockSolAuth } from "./mock/sol-auth.mock.js";
import { MockXmlProvider } from "./mock/xml-provider.mock.js";

// Prueba de humo de los fixtures de 009 (D13; CA-2, CA-9). No prueba los mocks uno por uno (eso lo hacen sus
// `*.mock.spec.ts`): cruza cada fila de `fixtures/sire/` con su XML de `fixtures/xml/`, revisa los RUC y los
// finales de número, y comprueba que ningún mock devuelve, registra ni deja en un error una credencial canario.

const RAIZ = join(__dirname, "..", "..", "..", "fixtures");
const CONTRIBUYENTE = "20700000002";
const PERIODO = "202610";
const TOKEN = { token: "token-de-humo", expiraEn: new Date("2026-10-27T16:00:00Z") };

// --- Lectura del XML (regex en vez de una dependencia nueva: la forma de los fixtures es fija) -------------------

type Moneda = "PEN" | "USD";

interface XmlLeido {
  serie: string;
  numero: string;
  tipo: string;
  fechaEmision: string;
  moneda: Moneda;
  tipoCambio?: string;
  rucProveedor: string;
  rucCliente: string;
  valorVenta: Money;
  total: Money;
  /** Por esquema de impuesto (1000 IGV, 9997 EXO, 2000 ISC, 7152 ICBPER...), a nivel de documento. */
  base: Map<string, Money>;
  impuesto: Map<string, Money>;
  descripciones: string[];
  /** Cantidad de líneas (`InvoiceLine`) que traen cada esquema. */
  lineasConEsquema: Map<string, number>;
}

function unico(texto: string, patron: RegExp, que: string): string {
  const m = patron.exec(texto);
  if (m?.[1] === undefined) throw new Error(`falta ${que} en el XML`);
  return m[1];
}

function leerXml(crudo: string): XmlLeido {
  const xml = crudo.replace(/<!--[\s\S]*?-->/g, "");
  const moneda = unico(xml, /<cbc:DocumentCurrencyCode>(\w+)</, "moneda") as Moneda;
  const dinero = (valor: string): Money => Money.desde(valor, moneda);

  // Todo `currencyID` debe ser la moneda del documento.
  for (const m of xml.matchAll(/currencyID="(\w+)"/g)) {
    expect(m[1], "currencyID distinto de la moneda del documento").toBe(moneda);
  }

  const [serie = "", numero = ""] = unico(xml, /<cbc:ID>([A-Z0-9]{4}-\d+)</, "ID").split("-");

  const proveedor = unico(xml, /<cac:AccountingSupplierParty>[\s\S]*?<cbc:ID schemeID="6">(\d{11})</, "RUC proveedor");
  const cliente = unico(xml, /<cac:AccountingCustomerParty>[\s\S]*?<cbc:ID schemeID="6">(\d{11})</, "RUC cliente");

  const cabecera = xml.slice(xml.indexOf("</cac:AccountingCustomerParty>"), xml.indexOf("<cac:LegalMonetaryTotal>"));
  const base = new Map<string, Money>();
  const impuesto = new Map<string, Money>();
  for (const sub of cabecera.matchAll(/<cac:TaxSubtotal>([\s\S]*?)<\/cac:TaxSubtotal>/g)) {
    const bloque = sub[1] ?? "";
    const esquema = unico(bloque, /<cac:TaxScheme>\s*<cbc:ID>(\d+)</, "esquema");
    impuesto.set(esquema, dinero(unico(bloque, /<cbc:TaxAmount currencyID="\w+">([\d.]+)</, "TaxAmount")));
    const gravable = /<cbc:TaxableAmount currencyID="\w+">([\d.]+)</.exec(bloque)?.[1];
    if (gravable !== undefined) base.set(esquema, dinero(gravable));
  }

  const lineasConEsquema = new Map<string, number>();
  for (const linea of xml.matchAll(/<cac:InvoiceLine>([\s\S]*?)<\/cac:InvoiceLine>/g)) {
    const esquemas = new Set([...(linea[1] ?? "").matchAll(/<cac:TaxScheme>\s*<cbc:ID>(\d+)</g)].map((m) => m[1] ?? ""));
    for (const e of esquemas) lineasConEsquema.set(e, (lineasConEsquema.get(e) ?? 0) + 1);
  }

  const tc = /<cbc:CalculationRate>([\d.]+)</.exec(xml)?.[1];
  return {
    serie,
    numero,
    tipo: unico(xml, /<cbc:InvoiceTypeCode[^>]*>(\d{2})</, "tipo"),
    fechaEmision: unico(xml, /<cbc:IssueDate>([\d-]+)</, "fecha"),
    moneda,
    ...(tc === undefined ? {} : { tipoCambio: tc }),
    rucProveedor: proveedor,
    rucCliente: cliente,
    valorVenta: dinero(unico(xml, /<cac:LegalMonetaryTotal>\s*<cbc:LineExtensionAmount currencyID="\w+">([\d.]+)</, "valor de venta")),
    total: dinero(unico(xml, /<cbc:PayableAmount currencyID="\w+">([\d.]+)</, "total")),
    base,
    impuesto,
    descripciones: [...xml.matchAll(/<cbc:Description>([^<]*)</g)].map((m) => m[1] ?? ""),
    lineasConEsquema,
  };
}

const cero = (m: Moneda): Money => Money.cero(m);
const deEsquema = (mapa: Map<string, Money>, esquemas: string[], m: Moneda): Money =>
  Money.suma(esquemas.map((e) => mapa.get(e) ?? cero(m)), m);

/** Montos de la fila que la propuesta DEBERÍA traer según el XML (ya corregida por 011). */
function esperadoDelXml(x: XmlLeido) {
  return {
    baseGravada: deEsquema(x.base, ["1000"], x.moneda),
    igv: deEsquema(x.impuesto, ["1000"], x.moneda),
    noGravado: deEsquema(x.base, ["9997", "9998", "9996"], x.moneda),
    isc: deEsquema(x.impuesto, ["2000"], x.moneda),
    icbper: deEsquema(x.impuesto, ["7152"], x.moneda),
    total: x.total,
  };
}

type CampoMonto = keyof ReturnType<typeof esperadoDelXml>;

/** Montos de la fila tal como vienen de la propuesta (las bases y el IGV suman sus tres columnas). */
function montosDeFila(f: FilaPropuestaSire) {
  const m = f.moneda;
  const d = (v: string): Money => Money.desde(v, m);
  return {
    baseGravada: Money.suma([d(f.biDg), d(f.biDgng), d(f.biDng)], m),
    igv: Money.suma([d(f.igvDg), d(f.igvDgng), d(f.igvDng)], m),
    noGravado: d(f.noGravado),
    isc: d(f.isc),
    icbper: d(f.icbper),
    total: d(f.total),
  };
}

/** Campos monetarios en que la fila difiere del XML: `[fila, xml]`. Vacío = la fila coincide con el XML. */
function diferencias(f: FilaPropuestaSire, x: XmlLeido): Partial<Record<CampoMonto, [string, string]>> {
  const fila = montosDeFila(f);
  const xml = esperadoDelXml(x);
  const salida: Partial<Record<CampoMonto, [string, string]>> = {};
  for (const campo of Object.keys(xml) as CampoMonto[]) {
    if (!fila[campo].igual(xml[campo])) salida[campo] = [fila[campo].toString(), xml[campo].toString()];
  }
  return salida;
}

// --- Carga a través de los mocks (así se piden en el worker) ------------------------------------------------------

const clave = (f: Pick<FilaPropuestaSire, "tipo" | "serie" | "numero" | "rucContraparte">) =>
  `${f.rucContraparte}-${f.tipo}-${f.serie}-${f.numero}`;

async function cargar() {
  const propuesta = await new MockSireApiClient().descargarPropuesta(TOKEN, {
    ruc: CONTRIBUYENTE,
    periodo: PERIODO,
    libro: "compras",
  });
  const proveedor = new MockXmlProvider();
  const casos = new Map<string, { fila: FilaPropuestaSire; xml: XmlLeido; crudo: string }>();
  for (const fila of propuesta.filas) {
    const r = await proveedor.obtener({
      rucEmisor: fila.rucContraparte,
      tipo: fila.tipo,
      serie: fila.serie,
      numero: fila.numero,
    });
    expect(r.fuente, `${clave(fila)} debe salir de un fixture`).toBe("fixture");
    expect(r.origen).toBe("simulado");
    casos.set(clave(fila), { fila, xml: leerXml(r.xml), crudo: r.xml });
  }
  return casos;
}

const archivosDe = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));

// ---------------------------------------------------------------------------------------------------------------

describe("humo: cada fila de compras coincide con su XML (CA-2)", () => {
  // Montos mal ubicados a propósito en la propuesta (los corrige el motor de 011). Es el ÚNICO desvío permitido
  // entre fila y XML; `[fila, xml]`. San Juan: la fila pone el ISC en DG y deja la columna ISC en 0.00.
  // Mixta: la fila pone todo (gravado + no gravado) en DG y deja 0.00 en no gravado.
  const MAL_UBICADOS: Record<string, Partial<Record<CampoMonto, [string, string]>>> = {
    "20700000011-01-F001-1040": { baseGravada: ["770.00", "0.00"], isc: ["0.00", "770.00"] },
    "20700000045-01-F001-2056": { baseGravada: ["21.48", "8.97"], noGravado: ["0.00", "12.51"] },
  };

  it("hay un XML por cada fila de compras y una fila por cada XML (sin desalineación)", async () => {
    const casos = await cargar();
    const xmls = readdirSync(join(RAIZ, "xml")).map((n) => n.replace(/\.xml$/, "")).sort();
    expect([...casos.keys()].sort()).toEqual(xmls);
    expect(xmls).toHaveLength(5);
  });

  it("identidad y cabecera de la fila coinciden con el XML (tipo, serie, número, fecha, RUC, moneda, TC)", async () => {
    for (const [k, { fila, xml }] of await cargar()) {
      expect(xml.tipo, k).toBe(fila.tipo);
      expect(xml.serie, k).toBe(fila.serie);
      expect(xml.numero, k).toBe(fila.numero);
      expect(xml.fechaEmision, k).toBe(fila.fechaEmision);
      expect(xml.rucProveedor, k).toBe(fila.rucContraparte);
      expect(xml.rucCliente, k).toBe(CONTRIBUYENTE);
      expect(xml.moneda, k).toBe(fila.moneda);
      expect(xml.tipoCambio, k).toBe(fila.tipoCambio);
    }
  });

  it("total, IGV, ISC, ICBPER y moneda coinciden; solo difieren los montos mal ubicados declarados", async () => {
    for (const [k, { fila, xml }] of await cargar()) {
      const dif = diferencias(fila, xml);
      expect(dif, `${k}: diferencias fila↔XML`).toEqual(MAL_UBICADOS[k] ?? {});
      // El total y el IGV nunca se desalinean, ni siquiera en los mal ubicados.
      expect(dif.total, k).toBeUndefined();
      expect(dif.igv, k).toBeUndefined();
      expect(dif.icbper, k).toBeUndefined();
    }
  });

  it("cada XML cuadra: total = valor de venta + IGV + ISC + ICBPER, y valor de venta = gravado + no gravado", async () => {
    for (const [k, { xml }] of await cargar()) {
      const e = esperadoDelXml(xml);
      const m = xml.moneda;
      expect(xml.valorVenta.igual(Money.suma([e.baseGravada, e.noGravado], m)), `${k}: valor de venta`).toBe(true);
      expect(xml.total.igual(Money.suma([xml.valorVenta, e.igv, e.isc, e.icbper], m)), `${k}: total`).toBe(true);
    }
  });

  it("las filas mal ubicadas, una vez corregidas al XML, coinciden en todo", async () => {
    // «Corregir» = tomar los montos del XML. Si la fila corregida difiriera, el fixture estaría roto.
    const casos = await cargar();
    for (const k of Object.keys(MAL_UBICADOS)) {
      const { fila, xml } = casos.get(k) ?? (() => { throw new Error(`falta ${k}`); })();
      const dif = diferencias(fila, xml);
      const corregida = { ...montosDeFila(fila) };
      for (const campo of Object.keys(dif) as CampoMonto[]) corregida[campo] = esperadoDelXml(xml)[campo];
      const esperado = esperadoDelXml(xml);
      for (const campo of Object.keys(esperado) as CampoMonto[]) {
        expect(corregida[campo].igual(esperado[campo]), `${k}.${campo}`).toBe(true);
      }
    }
  });

  describe("cada caso de CA-2 muestra su dato", () => {
    it("San Juan: ISC separado de 770.00 (esquema 2000), sin valor de venta ni IGV", async () => {
      const { xml, fila } = (await cargar()).get("20700000011-01-F001-1040")!;
      expect(xml.impuesto.get("2000")?.toString()).toBe("770.00");
      expect(xml.valorVenta.toString()).toBe("0.00");
      expect(xml.impuesto.get("1000")).toBeUndefined();
      // Fila con montos mal ubicados: el ISC viaja en DG.
      expect(fila.biDg).toBe("770.00");
      expect(fila.isc).toBe("0.00");
    });

    it("mixta: gravado 8.97 con IGV 1.61 y no gravado (exonerado 9997) 12.51; la fila lo junta en DG 21.48", async () => {
      const { xml, fila } = (await cargar()).get("20700000045-01-F001-2056")!;
      expect(xml.base.get("1000")?.toString()).toBe("8.97");
      expect(xml.impuesto.get("1000")?.toString()).toBe("1.61");
      expect(xml.base.get("9997")?.toString()).toBe("12.51");
      expect(xml.valorVenta.toString()).toBe("21.48");
      expect(fila.biDg).toBe("21.48");
      expect(fila.igvDg).toBe("1.61");
    });

    it("ICBPER: 7152 por línea (1.50 = 3 bolsas × 0.50) y la columna ICBPER de la fila lo trae", async () => {
      const { xml, fila, crudo } = (await cargar()).get("20700000053-01-F001-3064")!;
      expect(xml.impuesto.get("7152")?.toString()).toBe("1.50");
      expect(xml.lineasConEsquema.get("7152"), "alguna línea trae el ICBPER").toBeGreaterThanOrEqual(1);
      expect(crudo).toContain('<cbc:PerUnitAmount currencyID="PEN">0.50</cbc:PerUnitAmount>');
      expect(fila.icbper).toBe("1.50");
    });

    it("redondeo USD: BI 0.15, IGV 0.03, total 0.18, TC 3.300, y el IGV es el de 010 (igvEsperado)", async () => {
      const { xml, fila } = (await cargar()).get("20700000061-01-F001-4062")!;
      expect(xml.moneda).toBe("USD");
      expect(xml.base.get("1000")?.toString()).toBe("0.15");
      expect(xml.impuesto.get("1000")?.toString()).toBe("0.03");
      expect(xml.total.toString()).toBe("0.18");
      expect(xml.tipoCambio).toBe("3.300");
      expect(fila.tipoCambio).toBe("3.300");
      expect(igvEsperado(Money.desde("0.15", "USD"), TASA_IGV_18).toString()).toBe("0.03");
    });

    it("zapatilla: una línea con la glosa «zapatillas»", async () => {
      const { xml } = (await cargar()).get("20700000070-01-F001-5070")!;
      expect(xml.descripciones.some((d) => /zapatillas/i.test(d))).toBe(true);
    });
  });
});

describe("humo: la propuesta de ventas (CA-5/CA-2, D12)", () => {
  // T1 (013): las filas de ventas llevan las columnas de `FilaVentaSire` (plan, Contratos), no las de compras. Ese
  // tipo aún no existe en puertos.ts (llega en T11), así que la fila se tipa aquí a mano; cuando exista, se importa.
  type FilaVentaFixture = {
    tipo: string;
    serie: string;
    numero: string;
    tipoDocContraparte?: string;
    docContraparte: string;
    fechaEmision: string;
    moneda: "PEN" | "USD";
    tipoCambio?: string;
    baseGravada: string;
    igv: string;
    exonerada: string;
    inafecta: string;
    isc: string;
    icbper: string;
    otros: string;
    total: string;
  };
  const COLUMNAS = ["baseGravada", "igv", "exonerada", "inafecta", "isc", "icbper", "otros", "total"] as const;
  const claveVenta = (f: Pick<FilaVentaFixture, "tipo" | "serie" | "numero">) => `${f.tipo}-${f.serie}-${f.numero}`;

  const descargarVentas = async (): Promise<FilaVentaFixture[]> => {
    const p = await new MockSireApiClient().descargarPropuesta(TOKEN, {
      ruc: CONTRIBUYENTE,
      periodo: PERIODO,
      libro: "ventas",
    });
    // `PropuestaSire.filas` se tipa como FilaPropuestaSire; en ventas las filas son las de FilaVentaSire.
    return p.filas as unknown as FilaVentaFixture[];
  };

  it("trae las boletas B001-290 y B001-292 y no la 291; ninguna fila de ventas tiene XML", async () => {
    const filas = await descargarVentas();
    const claves = filas.map(claveVenta);
    expect(claves).toContain("03-B001-290");
    expect(claves).toContain("03-B001-292");
    expect(claves).not.toContain("03-B001-291");
    const xmls = readdirSync(join(RAIZ, "xml"));
    expect(filas.filter((f) => xmls.includes(`${CONTRIBUYENTE}-${f.tipo}-${f.serie}-${f.numero}.xml`))).toEqual([]);
  });

  it("cada fila tiene las columnas de FilaVentaSire en su formato (números, fecha del periodo, montos, documento y TC)", async () => {
    for (const f of await descargarVentas()) {
      const k = claveVenta(f);
      expect(f.tipo, k).toMatch(/^(01|03|07)$/);
      expect(f.serie, k).toMatch(/^[A-Z0-9]{4}$/);
      expect(f.numero, k).toMatch(/^[1-9][0-9]{0,7}$/);
      expect(f.fechaEmision.slice(0, 7).replace("-", ""), k).toBe(PERIODO);
      for (const c of COLUMNAS) expect(f[c], `${k}.${c}`).toMatch(/^-?\d+\.\d{2}$/);
      // El documento de la contraparte va completo (tipo y número) o es `-` sin tipo (D14b).
      if (f.docContraparte === "-") {
        expect(f.tipoDocContraparte, k).toBeUndefined();
      } else {
        expect(f.tipoDocContraparte, k).toBe("6");
        expect(f.docContraparte, k).toMatch(/^\d{11}$/);
      }
      // El tipo de cambio solo existe en USD y tiene tres decimales.
      if (f.tipoCambio !== undefined) {
        expect(f.moneda, k).toBe("USD");
        expect(f.tipoCambio, k).toMatch(/^\d+\.\d{3}$/);
      }
    }
  });

  it("cada fila cuadra: total = suma de sus columnas de monto, y el IGV es el 18 % de su base gravada (010)", async () => {
    for (const f of await descargarVentas()) {
      const k = claveVenta(f);
      const m = (valor: string) => Money.desde(valor, f.moneda);
      const sinTotal = COLUMNAS.filter((c) => c !== "total").map((c) => m(f[c]));
      expect(m(f.total).igual(Money.suma(sinTotal, f.moneda)), `${k}: total`).toBe(true);
      expect(igvEsperado(m(f.baseGravada), TASA_IGV_18).igual(m(f.igv)), `${k}: IGV`).toBe(true);
    }
  });

  it("trae los casos de D12: serie completa, nota de crédito en negativo, USD con y sin TC, salto de B003 y base exonerada", async () => {
    const filas = await descargarVentas();
    const numeros = (tipo: string, serie: string) =>
      filas.filter((f) => f.tipo === tipo && f.serie === serie).map((f) => f.numero);
    expect(numeros("01", "F001")).toEqual(["10", "11", "12"]);
    expect(numeros("01", "F002")).toEqual(["1", "2"]);
    expect(numeros("03", "B003")).toEqual(["400", "401", "405"]);
    // Una nota de crédito (tipo 07) con todos sus montos en cero o negativos (010 D6).
    const notas = filas.filter((f) => f.tipo === "07");
    expect(notas).toHaveLength(1);
    for (const c of COLUMNAS) expect(notas[0]?.[c] ?? "", c).toMatch(/^(-|0\.00$)/);
    // Dos ventas USD: una con tipo de cambio y otra sin él (CA-9).
    const usd = filas.filter((f) => f.moneda === "USD");
    expect(usd.filter((f) => f.tipoCambio !== undefined)).toHaveLength(1);
    expect(usd.filter((f) => f.tipoCambio === undefined)).toHaveLength(1);
    // Una fila con base exonerada.
    expect(filas.some((f) => f.exonerada !== "0.00")).toBe(true);
  });
});

describe("humo: RUC de prueba y finales de número (D5, D17)", () => {
  const rucs: Array<{ ruc: string }> = JSON.parse(readFileSync(join(RAIZ, "rucs-prueba.json"), "utf8"));
  const permitidos = new Set(rucs.map((r) => r.ruc));

  it("los RUC de rucs-prueba.json son válidos, de prefijo 20 y no terminan en 7, 8 ni 9", () => {
    expect(permitidos.size).toBe(rucs.length);
    for (const ruc of permitidos) {
      expect(validarRuc(ruc), ruc).toBe(true);
      expect(ruc.startsWith("20"), ruc).toBe(true);
      expect(ruc, ruc).toMatch(/[0-6]$/);
    }
  });

  it("todo número de 11 dígitos en fixtures/ (contenido y nombres) está en rucs-prueba.json", () => {
    const hallados = new Set<string>();
    for (const archivo of archivosDe(RAIZ)) {
      const texto = `${archivo.slice(RAIZ.length)}\n${readFileSync(archivo, "utf8")}`;
      for (const m of texto.matchAll(/(?<![\d])\d{11}(?![\d])/g)) hallados.add(m[0]);
    }
    expect(hallados.size).toBeGreaterThan(0);
    for (const ruc of hallados) expect(permitidos.has(ruc), `RUC fuera de rucs-prueba.json: ${ruc}`).toBe(true);
  });

  it("ningún número de comprobante de fixtures/ termina en 7, 8 ni 9", () => {
    const numeros: string[] = [];
    for (const archivo of archivosDe(join(RAIZ, "xml"))) {
      numeros.push(unico(readFileSync(archivo, "utf8"), /<cbc:ID>[A-Z0-9]{4}-(\d+)</, "ID"));
      numeros.push(unico(archivo, /-\d{2}-[A-Z0-9]{4}-(\d+)\.xml$/, "nombre"));
    }
    for (const archivo of archivosDe(join(RAIZ, "sire")).filter((a) => a.endsWith(".json"))) {
      const filas = (JSON.parse(readFileSync(archivo, "utf8")) as { filas: FilaPropuestaSire[] }).filas;
      numeros.push(...filas.map((f) => f.numero));
    }
    expect(numeros.length).toBeGreaterThan(5);
    for (const n of numeros) expect(n, `número ${n}`).toMatch(/[0-6]$/);
  });

  it("los fixtures de datos (JSON y XML) no traen claves, secretos ni tokens", () => {
    for (const archivo of archivosDe(RAIZ).filter((a) => /\.(json|xml)$/.test(a))) {
      expect(readFileSync(archivo, "utf8"), archivo).not.toMatch(/secret|passw|clave|token|bearer|apikey/i);
    }
  });
});

// --- CA-9: canario ------------------------------------------------------------------------------------------------

const CANARIO = "CANARIO-9f3a7c1e-NO-DEBE-SALIR";

type Resultado = { ok: true; valor: unknown } | { ok: false; error: unknown };
const correr = async (f: () => Promise<unknown>): Promise<Resultado> => {
  try {
    return { ok: true, valor: await f() };
  } catch (error) {
    return { ok: false, error };
  }
};

/** Todas las formas en que un valor podría filtrar el canario: JSON, String, inspect profundo, mensaje y pila. */
function textosDe(valor: unknown): string[] {
  const salida = [inspect(valor, { depth: null, showHidden: true, maxArrayLength: null, maxStringLength: null })];
  try {
    salida.push(JSON.stringify(valor) ?? "");
  } catch {
    // Circular o no serializable: inspect ya lo cubre.
  }
  salida.push(String(valor));
  if (valor instanceof Error) salida.push(valor.message, valor.stack ?? "", valor.name);
  return salida;
}

function sinCanario(valor: unknown, que: string): void {
  for (const t of textosDe(valor)) expect(t, `${que} contiene el canario`).not.toContain(CANARIO);
}

describe("humo: CA-9, ningún mock devuelve, registra ni lanza el canario", () => {
  it("MockSireAuth: resultado, errores (fallar 401/timeout/5xx, clave-errada) y estado interno", async () => {
    const mock = new MockSireAuth();
    const cred = (secreto: string) => ({
      clientId: CANARIO,
      clientSecret: secreto,
      usuarioSol: CANARIO,
      claveSol: CANARIO,
      ruc: CONTRIBUYENTE,
    });

    const feliz = await correr(() => mock.obtenerToken(cred(CANARIO)));
    expect(feliz.ok).toBe(true);
    sinCanario(feliz, "token");

    const errores: unknown[] = [];
    for (const modo of ["401", "timeout", "5xx"] as const) {
      mock.fallar(modo);
      const r = await correr(() => mock.obtenerToken(cred(CANARIO)));
      expect(r.ok, modo).toBe(false);
      if (!r.ok) errores.push(r.error);
    }
    mock.fallar(null);
    const errada = await correr(() => mock.obtenerToken({ ...cred("clave-errada"), clientId: CANARIO }));
    expect(errada.ok).toBe(false);
    if (!errada.ok) errores.push(errada.error);

    expect(errores).toHaveLength(4);
    for (const e of errores) {
      expect(e).toBeInstanceOf(ErrorSunat);
      sinCanario(e, "error de SireAuth");
    }
    expect(mock.llamadas).toBe(5);
    sinCanario(mock, "estado de MockSireAuth");
  });

  it("MockSolAuth: resultado, errores (fallar 401/timeout/5xx, clave-errada) y estado interno", async () => {
    const mock = new MockSolAuth();
    const cred = (clave: string) => ({ ruc: CONTRIBUYENTE, usuarioSol: CANARIO, claveSol: clave });

    const feliz = await correr(() => mock.verificar(cred(CANARIO)));
    expect(feliz.ok).toBe(true);
    sinCanario(feliz, "resultado");

    const errores: unknown[] = [];
    for (const modo of ["401", "timeout", "5xx"] as const) {
      mock.fallar(modo);
      const r = await correr(() => mock.verificar(cred(CANARIO)));
      expect(r.ok, modo).toBe(false);
      if (!r.ok) errores.push(r.error);
    }
    mock.fallar(null);
    const errada = await correr(() => mock.verificar(cred("clave-errada")));
    expect(errada.ok).toBe(false);
    if (!errada.ok) errores.push(errada.error);

    expect(errores).toHaveLength(4);
    for (const e of errores) {
      expect(e).toBeInstanceOf(ErrorSunat);
      sinCanario(e, "error de SolAuth");
    }
    expect(mock.llamadas).toBe(5);
    sinCanario(mock, "estado de MockSolAuth");
  });

  it("MockConsultaRuc: no tiene credencial; ni el resultado ni los errores repiten la entrada", async () => {
    // El RUC no es un secreto, así que el contador por RUC se omite; se comprueba que no se haga eco.
    const mock = new MockConsultaRuc();
    const feliz = await correr(() => mock.consultar(`${CANARIO}0`));
    expect(feliz.ok).toBe(true);
    sinCanario(feliz, "resultado");

    const errores: unknown[] = [];
    for (const ruc of [`${CANARIO}7`, `${CANARIO}8`]) {
      const r = await correr(() => mock.consultar(ruc));
      expect(r.ok, ruc).toBe(false);
      if (!r.ok) errores.push(r.error);
    }
    for (const modo of ["timeout", "5xx", "datos"] as const) {
      mock.fallar(modo);
      const r = await correr(() => mock.consultar(`${CANARIO}0`));
      expect(r.ok, modo).toBe(false);
      if (!r.ok) errores.push(r.error);
    }
    expect(errores).toHaveLength(5);
    for (const e of errores) sinCanario(e, "error de ConsultaRuc");
  });

  it("MockSireApiClient: el token canario no sale en propuestas, errores, registro ni estado", async () => {
    const mock = new MockSireApiClient();
    const token = { token: CANARIO, expiraEn: new Date("2026-10-27T16:00:00Z") };
    const pedir = (ruc: string, periodo = PERIODO, libro: "compras" | "ventas" = "compras") => ({ ruc, periodo, libro });

    const propuestas = [
      await correr(() => mock.descargarPropuesta(token, pedir(CONTRIBUYENTE))),
      await correr(() => mock.descargarPropuesta(token, pedir(CONTRIBUYENTE, PERIODO, "ventas"))),
      await correr(() => mock.descargarPropuesta(token, pedir("20700000096", "202611"))), // genérico
    ];
    for (const p of propuestas) {
      expect(p.ok).toBe(true);
      sinCanario(p, "propuesta");
    }

    const errores: unknown[] = [];
    const intentos: Array<() => Promise<unknown>> = [
      () => mock.descargarPropuesta(token, pedir("20700000007")), // centinelas por último dígito
      () => mock.descargarPropuesta(token, pedir("20700000008")),
      () => mock.descargarPropuesta(token, pedir("20700000009")),
      () => mock.descargarPropuesta(token, pedir("123")), // entrada inválida
      () => mock.descargarPropuesta(token, pedir(CONTRIBUYENTE, "2026-10")),
      () => mock.descargarPropuesta({ token: "", expiraEn: token.expiraEn }, pedir(CONTRIBUYENTE)),
    ];
    for (const intento of intentos) {
      const r = await correr(intento);
      expect(r.ok).toBe(false);
      if (!r.ok) errores.push(r.error);
    }
    for (const modo of ["401", "timeout", "5xx", "datos"] as const) {
      mock.fallar(modo);
      const r = await correr(() => mock.descargarPropuesta(token, pedir(CONTRIBUYENTE)));
      expect(r.ok, modo).toBe(false);
      if (!r.ok) errores.push(r.error);
    }
    expect(errores).toHaveLength(10);
    for (const e of errores) {
      expect(e).toBeInstanceOf(ErrorSunat);
      sinCanario(e, "error de SireApiClient");
    }
    sinCanario(mock.registro(), "registro de SireApiClient");
    sinCanario(mock, "estado de MockSireApiClient");
    expect(mock.registro().length).toBeGreaterThan(0);
  });

  it("MockXmlProvider: una entrada con el canario no se repite en errores ni en el registro", async () => {
    const mock = new MockXmlProvider();
    const referencia = {
      fechaEmision: "2026-10-02",
      moneda: "PEN" as const,
      baseGravada: "100.00",
      igv: "18.00",
      noGravado: "0.00",
      isc: "0.00",
      icbper: "0.00",
      otros: "0.00",
      total: "118.00",
    };
    const base = { rucEmisor: "20700000011", tipo: "01", serie: "F001", numero: "1040" };

    // Felices: fixture y sintético (la fuente «fixture» devuelve el XML del fixture, que no lleva el canario).
    const fixture = await correr(() => mock.obtener(base));
    const sintetico = await correr(() => mock.obtener({ ...base, rucEmisor: "20700000096", numero: "6", referencia }));
    expect(fixture.ok).toBe(true);
    expect(sintetico.ok).toBe(true);
    sinCanario(fixture, "fixture");
    sinCanario(sintetico, "sintético");

    const errores: unknown[] = [];
    const casos: Array<Parameters<MockXmlProvider["obtener"]>[0]> = [
      { ...base, rucEmisor: CANARIO }, // fuera de la gramática (D6)
      { ...base, serie: CANARIO },
      { ...base, numero: CANARIO },
      { ...base, tipo: CANARIO },
      { ...base, numero: `${CANARIO}/../..` },
      { ...base, rucEmisor: "20700000096", numero: "6", referencia: { ...referencia, total: CANARIO } }, // referencia inválida
      { ...base, rucEmisor: "20700000096", numero: "6", referencia: { ...referencia, fechaEmision: CANARIO } },
      { ...base, numero: "17" }, // centinelas
      { ...base, numero: "18" },
      { ...base, numero: "19" },
      { ...base, numero: "5" }, // sin fixture ni referencia
    ];
    for (const c of casos) {
      const r = await correr(() => mock.obtener(c));
      expect(r.ok).toBe(false);
      if (!r.ok) errores.push(r.error);
    }
    for (const modo of ["no_encontrado", "timeout", "credencial"] as const) {
      mock.fallar(modo);
      const r = await correr(() => mock.obtener({ ...base, serie: "F002" }));
      expect(r.ok, modo).toBe(false);
      if (!r.ok) errores.push(r.error);
    }
    expect(errores).toHaveLength(14);
    for (const e of errores) {
      expect(e).toBeInstanceOf(ErrorSunat);
      expect(clasificarError(e).clase).toMatch(/transitorio|credencial|datos/);
      sinCanario(e, "error de XmlProvider");
    }
    sinCanario(mock.registro(), "registro de XmlProvider");
    sinCanario(mock, "estado de MockXmlProvider");
    expect(mock.registro().length).toBe(2 + casos.length + 3);
  });
});
