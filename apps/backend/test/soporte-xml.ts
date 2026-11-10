/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y cuerpos JSON dinámicos en pruebas */
// Soporte de las pruebas HTTP de la spec 016 (T7): lupa del comprobante y XML. Encima de `soporte-compras.ts`.
// No es una prueba ni código de producción. Datos sintéticos (fixtures de 009; RUC de `fixtures/sire/rucs-prueba.json`).
//
// CONTRATO QUE ASUME (plan 016, «Contratos»):
//  - Storage: `STORAGE=local` y `STORAGE_DIR=<carpeta>`; el XML crudo queda en `xml/{tenant}/{cliente}/{uuid}.xml` bajo esa
//    carpeta. `prepararStorage` fija ambas variables ANTES de abrir la app (el módulo de storage las lee al construirse) y
//    `archivosDe` lista lo que hay de un cliente: vacío = nada quedó en storage.
//  - BD: `documento_xml(tenant_id, cliente_id, ruc_emisor, tipo, serie, numero, n, origen, ruta, sha256, tamano, detalle,
//    subido_por, creada_en)` y `documento_xml_obtencion(tenant_id, cliente_id, ruc_emisor, tipo, serie, numero, estado,
//    intentos, actualizado_en)`. Las pruebas escriben `documento_xml_obtencion` y cambian `origen` con la conexión de
//    migraciones (no pasa por RLS ni por grants), como el resto del soporte de compras.
//  - Los XML de prueba salen de `fixtures/xml/*.xml` con el receptor cambiado al RUC del cliente de la prueba (D-3).
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import * as shared from "@contapp/shared";
import request from "supertest";
import { ipUnica } from "./soporte.js";
import type { RespBin } from "./soporte-credenciales.js";
import type { Actor, BancoCompras } from "./soporte-compras.js";

// --- Storage --------------------------------------------------------------------------------------------------------

export interface StoragePrueba {
  dir: string;
  restaurar(): void;
}

/** Fija `STORAGE=local` y `STORAGE_DIR` a una carpeta nueva. Llamar antes de `abrirBancoCompras()`. */
export function prepararStorage(): StoragePrueba {
  const antes = {
    STORAGE: process.env.STORAGE,
    STORAGE_DIR: process.env.STORAGE_DIR,
  };
  const dir = mkdtempSync(join(tmpdir(), "contapp-storage-016-"));
  process.env.STORAGE = "local";
  process.env.STORAGE_DIR = dir;
  return {
    dir,
    restaurar() {
      for (const [k, valor] of Object.entries(antes)) {
        if (valor === undefined) delete process.env[k];
        else process.env[k] = valor;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Rutas (relativas a la raíz del storage) de los archivos que hay bajo un prefijo; vacío si no hay nada. */
export function archivosBajo(dir: string, prefijo = ""): string[] {
  const salida: string[] = [];
  const recorrer = (ruta: string): void => {
    let nombres: string[];
    try {
      nombres = readdirSync(ruta);
    } catch {
      return;
    }
    for (const n of nombres) {
      const completa = join(ruta, n);
      if (statSync(completa).isDirectory()) recorrer(completa);
      else salida.push(relative(dir, completa).split("\\").join("/"));
    }
  };
  recorrer(dir);
  return salida.filter((r) => r.startsWith(prefijo)).sort();
}

/** Archivos del storage de un cliente de un estudio (`xml/{tenant}/{cliente}/…`). */
export const archivosDe = (dir: string, tenantId: string, clienteId: string) =>
  archivosBajo(dir, `xml/${tenantId}/${clienteId}/`);

// --- XML de prueba --------------------------------------------------------------------------------------------------

export type NombreXml = "1040" | "2056" | "3064" | "4062" | "5070";
const ARCHIVOS: Record<NombreXml, string> = {
  "1040": "20700000011-01-F001-1040.xml",
  "2056": "20700000045-01-F001-2056.xml",
  "3064": "20700000053-01-F001-3064.xml",
  "4062": "20700000061-01-F001-4062.xml",
  "5070": "20700000070-01-F001-5070.xml",
};
/** RUC del proveedor de cada fixture. */
export const RUC_PROVEEDOR: Record<NombreXml, string> = {
  "1040": "20700000011",
  "2056": "20700000045",
  "3064": "20700000053",
  "4062": "20700000061",
  "5070": "20700000070",
};
const RUC_RECEPTOR_FIXTURE = "20700000002";

/** El fixture como texto, con el receptor cambiado al RUC del cliente (D-3). */
export function xmlDe(nombre: NombreXml, rucCliente: string): string {
  const ruta = new URL(`../../../fixtures/xml/${ARCHIVOS[nombre]}`, import.meta.url);
  const texto = readFileSync(ruta, "utf8");
  if (!texto.includes(RUC_RECEPTOR_FIXTURE)) throw new Error("el fixture ya no trae el receptor esperado");
  return texto.replaceAll(RUC_RECEPTOR_FIXTURE, rucCliente);
}

/** Reemplaza `de` por `a` en todo el texto y falla si `de` no está (una variante que no cambia nada no prueba nada). */
export function cambiar(xml: string, de: string | RegExp, a: string): string {
  const resultado = xml.replaceAll(de, a);
  if (resultado === xml) throw new Error(`la variante no cambió nada: ${String(de)}`);
  return resultado;
}

export const bytes = (texto: string): Uint8Array => new TextEncoder().encode(texto);
/** Bytes ISO-8859-1 con la declaración cambiada (los XML de SUNAT suelen venir así). */
export function bytesLatin1(texto: string): Uint8Array {
  return Uint8Array.from(Buffer.from(cambiar(texto, 'encoding="UTF-8"', 'encoding="ISO-8859-1"'), "latin1"));
}

const LINEA_COMPLETA = /<cac:InvoiceLine>[\s\S]*<\/cac:InvoiceLine>/;
/** Factura de `n` líneas completas (la primera línea del fixture 2056 repetida), para el p95 de CA-18. */
export function xmlConItems(n: number, rucCliente: string): string {
  const xml = xmlDe("2056", rucCliente);
  const primera = /<cac:InvoiceLine>[\s\S]*?<\/cac:InvoiceLine>/.exec(xml)![0];
  const lineas = Array.from({ length: n }, (_, i) => primera.replace("<cbc:ID>1</cbc:ID>", `<cbc:ID>${i + 1}</cbc:ID>`));
  return xml.replace(LINEA_COMPLETA, () => lineas.join("\n"));
}
/** Factura de `n` líneas mínimas (≈ 300 bytes cada una), para pasar el tope de ítems sin pasar el de tamaño. */
export function xmlConLineasMinimas(n: number, rucCliente: string): string {
  const xml = xmlDe("2056", rucCliente);
  const lineas = Array.from(
    { length: n },
    (_, i) =>
      `<cac:InvoiceLine><cbc:ID>${i + 1}</cbc:ID><cbc:InvoicedQuantity unitCode="NIU">1</cbc:InvoicedQuantity>` +
      `<cbc:LineExtensionAmount currencyID="PEN">0.01</cbc:LineExtensionAmount><cac:Item><cbc:Description>x</cbc:Description></cac:Item>` +
      `<cac:Price><cbc:PriceAmount currencyID="PEN">0.01</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`,
  );
  return xml.replace(LINEA_COMPLETA, () => lineas.join(""));
}
/** El mismo XML relleno con espacios al final hasta `tamano` bytes exactos. */
export function conTamano(xml: string, tamano: number): Uint8Array {
  const base = bytes(xml);
  if (base.length > tamano) throw new Error("el XML ya pesa más que el tamaño pedido");
  const salida = new Uint8Array(tamano).fill(0x20);
  salida.set(base);
  return salida;
}

// --- Peticiones con cuerpo crudo ------------------------------------------------------------------------------------

const jsonONulo = (t: string): any => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

/**
 * Petición autenticada con cuerpo crudo y `Content-Type` a elección (las rutas de XML reciben `application/xml`, `text/xml`
 * u `application/octet-stream`). Responde bytes, texto y JSON (si lo es). Un corte de conexión por cuerpo enorme es status 0.
 */
export async function pedirXml(
  v: BancoCompras,
  a: Pick<Actor, "cookie" | "csrf" | "tenantId">,
  metodo: "GET" | "POST",
  ruta: string,
  cuerpo?: Uint8Array | string,
  contentType = "application/xml",
): Promise<RespBin> {
  const dir = v.b.c.p.b.h.app.getHttpServer().address() as { port: number };
  const base = `http://127.0.0.1:${dir.port}`;
  const t = metodo === "GET" ? request(base).get(ruta) : request(base).post(ruta);
  t.set("X-Forwarded-For", ipUnica())
    .set("Cookie", a.cookie)
    .set("X-CSRF-Token", a.csrf)
    .set("X-Estudio", a.tenantId)
    .ok(() => true)
    .buffer(true)
    .parse((res, cb) => {
      const trozos: Buffer[] = [];
      res.on("data", (c: Buffer) => trozos.push(c));
      res.on("end", () => cb(null, Buffer.concat(trozos)));
    });
  if (metodo === "POST") t.set("Origin", process.env.APP_ORIGIN ?? "http://localhost:3000");
  if (cuerpo !== undefined) t.set("Content-Type", contentType).send(Buffer.from(cuerpo as Uint8Array));
  try {
    const res = await t;
    const crudos = Buffer.isBuffer(res.body) ? res.body : Buffer.alloc(0);
    const texto = crudos.toString("utf8");
    return { status: res.status, headers: res.headers, bytes: crudos, texto, json: jsonONulo(texto) };
  } catch (e) {
    const codigo = (e as { code?: string }).code;
    if (codigo === "EPIPE" || codigo === "ECONNRESET") {
      return { status: 0, headers: {}, bytes: Buffer.alloc(0), texto: "", json: null };
    }
    throw e;
  }
}

// --- BD -------------------------------------------------------------------------------------------------------------

export interface DocumentoXmlBd {
  id: string;
  n: number;
  origen: string;
  ruc_emisor: string;
  tipo: string;
  serie: string;
  numero: string;
  ruta: string;
  sha256: string;
  tamano: number;
  subido_por: string | null;
}

/** Filas de `documento_xml` de un cliente, en orden de `n` por comprobante. */
export function documentosXml(v: BancoCompras, clienteId: string): Promise<DocumentoXmlBd[]> {
  return v.b.sql(
    `select id, n::int as n, origen, ruc_emisor, tipo, serie, numero, ruta, encode(sha256, 'hex') as sha256,
            tamano::int as tamano, subido_por
       from documento_xml where cliente_id = $1 order by serie, numero, n`,
    [clienteId],
  );
}

/** Cambia el origen de un documento ya guardado (la conexión de migraciones puede; el worker real lo inserta). */
export async function forzarOrigen(
  v: BancoCompras,
  documentoId: string,
  origen: "simulado" | "real",
): Promise<void> {
  await v.b.sql("update documento_xml set origen = $2, subido_por = null where id = $1", [documentoId, origen]);
}

export type EstadoObtencion = "pendiente" | "no_encontrado" | "credencial" | "transitorio";
/** Estado de obtención de un comprobante (identidad normalizada: serie en mayúsculas, número sin ceros). */
export async function sembrarObtencion(
  v: BancoCompras,
  o: {
    tenantId: string;
    clienteId: string;
    rucEmisor: string;
    tipo: string;
    serie: string;
    numero: string;
    estado: EstadoObtencion;
    intentos?: number;
  },
): Promise<void> {
  await v.b.sql(
    `insert into documento_xml_obtencion (tenant_id, cliente_id, ruc_emisor, tipo, serie, numero, estado, intentos, actualizado_en)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
    [o.tenantId, o.clienteId, o.rucEmisor, o.tipo, o.serie.toUpperCase(), o.numero.replace(/^0+(?=.)/, ""), o.estado, o.intentos ?? 1],
  );
}

export const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
export const uuidV4 = (): string => randomUUID();

// --- Esquemas de `@contapp/shared/xml` ------------------------------------------------------------------------------
// `shared/src/xml/index.ts` aún exporta solo `origen` (T10 suma el resto). Se leen por nombre en tiempo de ejecución para
// que el typecheck del backend no se rompa mientras tanto; si falta uno, la prueba falla con este mensaje.
type Esquema = { safeParse(v: unknown): { success: boolean } };
function esquema(nombre: string): Esquema {
  const e = (shared as unknown as Record<string, Esquema | undefined>)[nombre];
  if (!e) throw new Error(`@contapp/shared aún no exporta ${nombre} (T10)`);
  return e;
}
export const detalleLupaSchema: Esquema = { safeParse: (v) => esquema("detalleLupaSchema").safeParse(v) };
export const vistaPreviaDesdeXmlSchema: Esquema = { safeParse: (v) => esquema("vistaPreviaDesdeXmlSchema").safeParse(v) };

/** Trabajos de un tipo del cliente (`v.trabajos()` de 013/014 filtra fijo por `sire.propuesta.descargar`). */
export const trabajosDeTipo = (v: BancoCompras, clienteId: string, tipo: string): Promise<any[]> =>
  v.b.sql("select * from job_registro where cliente_id = $1 and tipo = $2 order by creado_en, id", [clienteId, tipo]);
