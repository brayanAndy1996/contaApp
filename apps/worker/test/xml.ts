// Soporte de las pruebas de integración de `xml.obtener` (spec 016, T6). No es código de producción ni una prueba.
//
// CONTRATO de BD que fija (T11 lo implementa; nombres del plan 016, «Contratos: BD»):
// - `documento_xml(cliente_id, ruc_emisor, tipo, serie, numero, n, origen, ruta, sha256 bytea, tamano, detalle jsonb,
//   subido_por)`: vigente = mayor `n`; serie en mayúsculas y número sin ceros a la izquierda.
// - `documento_xml_obtencion(cliente_id, ruc_emisor, tipo, serie, numero, estado, intentos)`:
//   `estado` ∈ pendiente | no_encontrado | credencial | transitorio.
// - `compra_evaluacion(compra_id, version_n, n, documento_xml_id)` y `compra_hallazgo.evaluacion_n`.
// Todo se lee con el rol administrativo (no pasa por RLS ni por grants).
//
// CONTRATO del worker que fija (T12):
// - `DepsTrabajos` gana `xmlProvider?: XmlProvider` (por defecto el mock), `storage?: StorageProvider` (por defecto el
//   de `STORAGE`) y `xmlSimuladoEnReglas?: boolean` (P-4; sin valor, apagada). `iniciarTrabajos` registra el procesador
//   `xml.obtener`. Estas pruebas pasan los tres a mano.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ContappDb } from "@contapp/db";
import {
  MockXmlProvider,
  type RespuestaXml,
  type SolicitudXml,
  type XmlProvider,
} from "@contapp/sunat";
import type { Redis } from "ioredis";
import { arrancar007b } from "./procesadores-007b.js";
import { compuerta, encolarYPublicar } from "./trabajos.js";
import type { ProcesoWorker } from "./trabajos.js";
import { PERIODO } from "./ventas.js";

export { PERIODO };

// ---------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------

const DIR_FIXTURES = new URL("../../../fixtures/xml/", import.meta.url);

/** Los cinco comprobantes del contribuyente de prueba (RUC_FIXTURE): número -> RUC del emisor. */
export const EMISORES: Readonly<Record<string, string>> = {
  "1040": "20700000011",
  "2056": "20700000045",
  "3064": "20700000053",
  "4062": "20700000061",
  "5070": "20700000070",
};

export const NUMEROS_FIXTURE = Object.keys(EMISORES);

/** `{ruc}-01-F001-{numero}` como lo entiende `MockXmlProvider.inyectar`. */
export const claveXml = (numero: string): string =>
  `${EMISORES[numero]}-01-F001-${numero}`;

export function fixtureXml(numero: string): string {
  return readFileSync(
    fileURLToPath(new URL(`${claveXml(numero)}.xml`, DIR_FIXTURES)),
    "utf8",
  );
}

export const sha256Hex = (b: Uint8Array | string): string =>
  createHash("sha256").update(b).digest("hex");

export const canarioXml = (etiqueta = "xml"): string =>
  `CANARIO-${etiqueta}-${randomBytes(8).toString("hex")}`;

/** Reemplaza `buscado` y falla si no estaba (una prueba que no cambia nada no prueba nada). */
export function reemplazar(texto: string, buscado: string, nuevo: string): string {
  if (!texto.includes(buscado))
    throw new Error(`el fixture ya no contiene «${buscado}»`);
  return texto.replace(buscado, nuevo);
}

// ---------------------------------------------------------------------------------------------------------------
// Puertos de la prueba
// ---------------------------------------------------------------------------------------------------------------

/** El `StorageProvider` del plan 016 (estructural: este soporte no depende de `@contapp/storage`). */
export interface StorageProbado {
  guardar(ruta: string, bytes: Uint8Array): Promise<void>;
  leer(ruta: string): Promise<Uint8Array>;
  eliminar(ruta: string): Promise<void>;
}

/** Storage en memoria que anota cada llamada (para comprobar que NO se escribió nada). */
export class AlmacenEspia implements StorageProbado {
  readonly guardados = new Map<string, Uint8Array>();
  readonly intentosGuardar: string[] = [];
  readonly eliminados: string[] = [];

  async guardar(ruta: string, bytes: Uint8Array): Promise<void> {
    this.intentosGuardar.push(ruta);
    this.guardados.set(ruta, Uint8Array.from(bytes));
  }
  async leer(ruta: string): Promise<Uint8Array> {
    const b = this.guardados.get(ruta);
    if (b === undefined) throw new Error("no existe");
    return Uint8Array.from(b);
  }
  async eliminar(ruta: string): Promise<void> {
    this.eliminados.push(ruta);
    this.guardados.delete(ruta);
  }
  /** Rutas que quedaron guardadas (lo guardado menos lo eliminado). */
  rutas(): string[] {
    return [...this.guardados.keys()];
  }
  /** Todo lo que vio el storage (rutas y bytes) como texto, para buscar canarios. */
  volcado(): string {
    return [
      ...this.intentosGuardar,
      ...[...this.guardados.values()].map((b) => Buffer.from(b).toString("latin1")),
    ].join("\n");
  }
}

export interface LlamadaXml {
  solicitud: SolicitudXml;
  /** Transacciones del worker abiertas en el instante de la llamada (0 = ninguna, 008 D6). */
  en: number;
}

/**
 * `XmlProvider` de la prueba: delega en `MockXmlProvider` (fixtures, centinelas e `inyectar`; su `registro()` es el
 * que CA-10 mira), anota las solicitudes, puede pausarse dentro de la llamada y puede fallar UNA vez por comprobante.
 */
export class XmlProviderControlado implements XmlProvider {
  readonly mock = new MockXmlProvider();
  readonly llamadas: LlamadaXml[] = [];
  /** Cuántas transacciones tiene abiertas el worker (se conecta con `ProcesoWorker.dbEstado`). */
  contarTx: () => number = () => 0;
  private puerta: ReturnType<typeof compuerta> | null = null;
  private readonly unaVez = new Map<string, Error>();

  /** Las llamadas siguientes esperan hasta `abrir()`. */
  pausar(): void {
    this.puerta = compuerta();
  }
  abrir(): void {
    this.puerta?.abrir();
    this.puerta = null;
  }
  /** La primera llamada por `clave` lanza `error`; las siguientes siguen al mock. */
  fallarUnaVez(clave: string, error: Error): void {
    this.unaVez.set(clave, error);
  }
  /** Claves (`{ruc}-{tipo}-{serie}-{numero}`) que pidió el worker, en orden. */
  claves(): string[] {
    return this.llamadas.map(
      (l) => `${l.solicitud.rucEmisor}-${l.solicitud.tipo}-${l.solicitud.serie}-${l.solicitud.numero}`,
    );
  }

  async obtener(solicitud: SolicitudXml): Promise<RespuestaXml> {
    this.llamadas.push({ solicitud: structuredClone(solicitud), en: this.contarTx() });
    await this.puerta?.esperar();
    const clave = `${solicitud.rucEmisor}-${solicitud.tipo}-${solicitud.serie}-${solicitud.numero}`;
    const error = this.unaVez.get(clave);
    if (error !== undefined) {
      this.unaVez.delete(clave);
      throw error;
    }
    return this.mock.obtener(solicitud);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Arranque del worker
// ---------------------------------------------------------------------------------------------------------------

export interface PuertosXml {
  xml: XmlProviderControlado;
  almacen: AlmacenEspia;
}

export function puertosXml(): PuertosXml {
  return { xml: new XmlProviderControlado(), almacen: new AlmacenEspia() };
}

/** Arranca el worker con el XmlProvider y el storage de la prueba. `extra` suma `sireApi`, `logger`, `notificador`... */
export async function arrancarXml(
  prefijo: string,
  p: PuertosXml,
  o: { simuladoEnReglas: boolean } & Record<string, unknown>,
): Promise<ProcesoWorker> {
  const { simuladoEnReglas, ...extra } = o;
  const w = await arrancar007b({
    prefijo,
    xmlProvider: p.xml,
    storage: p.almacen,
    xmlSimuladoEnReglas: simuladoEnReglas,
    ...extra,
  } as Parameters<typeof arrancar007b>[0]);
  p.xml.contarTx = () => w.dbEstado.abiertas;
  return w;
}

// ---------------------------------------------------------------------------------------------------------------
// Encolado como lo hace el backend (rol backend)
// ---------------------------------------------------------------------------------------------------------------

/** Encola `xml.obtener` para las compras dadas (ids ordenados y únicos, como pide el catálogo) y devuelve el id del trabajo. */
export async function encolarXml(
  backend: ContappDb,
  redis: Redis,
  prefijo: string,
  m: { T: string; u: string; c: { id: string } },
  compraIds: string[],
  o: { periodo?: string; prioridad?: "interactivo" | "programado" } = {},
): Promise<string> {
  const r = await encolarYPublicar(backend, redis, prefijo, m.T, {
    tipo: "xml.obtener",
    clienteId: m.c.id,
    parametros: {
      periodo: o.periodo ?? PERIODO,
      compraIds: [...new Set(compraIds)].sort(),
    },
    prioridad: o.prioridad ?? "interactivo",
    creadoPor: m.u,
  });
  return r.trabajo.id;
}

// ---------------------------------------------------------------------------------------------------------------
// Lecturas (rol administrativo)
// ---------------------------------------------------------------------------------------------------------------

export interface DocumentoXmlBd {
  id: string;
  ruc_emisor: string;
  tipo: string;
  serie: string;
  numero: string;
  n: number;
  origen: string;
  ruta: string;
  sha: string;
  tamano: number;
  detalle: string;
  subido_por: string | null;
}

export async function documentosDe(
  admin: ContappDb,
  clienteId: string,
): Promise<DocumentoXmlBd[]> {
  const r = await admin.pool.query(
    `select id, ruc_emisor, tipo, serie, numero, n::int as n, origen, ruta, encode(sha256, 'hex') as sha,
            tamano::int as tamano, detalle::text as detalle, subido_por
       from documento_xml where cliente_id = $1 order by serie, numero::bigint, n`,
    [clienteId],
  );
  return r.rows as DocumentoXmlBd[];
}

export async function contarDocumentos(
  admin: ContappDb,
  clienteId: string,
): Promise<number> {
  const r = await admin.pool.query(
    "select count(*)::int as n from documento_xml where cliente_id = $1",
    [clienteId],
  );
  return r.rows[0].n as number;
}

export interface ObtencionBd {
  ruc_emisor: string;
  tipo: string;
  serie: string;
  numero: string;
  estado: string;
  intentos: number;
}

export async function obtencionesDe(
  admin: ContappDb,
  clienteId: string,
): Promise<ObtencionBd[]> {
  const r = await admin.pool.query(
    `select ruc_emisor, tipo, serie, numero, estado, intentos::int as intentos
       from documento_xml_obtencion where cliente_id = $1 order by serie, numero::bigint`,
    [clienteId],
  );
  return r.rows as ObtencionBd[];
}

export interface EvaluacionBd {
  version_n: number;
  n: number;
  documento_xml_id: string | null;
}

/** Evaluaciones de una compra, de la versión 1 en adelante y por número. */
export async function evaluacionesDe(
  admin: ContappDb,
  compraId: string,
): Promise<EvaluacionBd[]> {
  const r = await admin.pool.query(
    `select version_n::int as version_n, n::int as n, documento_xml_id
       from compra_evaluacion where compra_id = $1 order by version_n, n`,
    [compraId],
  );
  return r.rows as EvaluacionBd[];
}

export interface HallazgoEvaluado {
  version_n: number;
  evaluacion_n: number;
  regla: string;
  requiere_confirmacion: boolean;
  sugerencia: Record<string, unknown> | null;
}

export async function hallazgosEvaluadosDe(
  admin: ContappDb,
  compraId: string,
): Promise<HallazgoEvaluado[]> {
  const r = await admin.pool.query(
    `select version_n::int as version_n, evaluacion_n::int as evaluacion_n, regla, requiere_confirmacion, sugerencia
       from compra_hallazgo where compra_id = $1 order by version_n, evaluacion_n, regla`,
    [compraId],
  );
  return r.rows as HallazgoEvaluado[];
}

export interface TrabajoXmlBd {
  id: string;
  cola: string;
  canal: string;
  prioridad: string;
  estado: string;
  motivo: string | null;
  intentos: number;
  parametros: { periodo: string; compraIds: string[] };
  resultado: Record<string, number> | null;
}

/** Los trabajos `xml.obtener` del cliente, del más antiguo al más nuevo. */
export async function trabajosXmlDe(
  admin: ContappDb,
  clienteId: string,
): Promise<TrabajoXmlBd[]> {
  const r = await admin.pool.query(
    `select id, cola, canal, prioridad, estado, motivo, intentos::int as intentos, parametros, resultado
       from job_registro where cliente_id = $1 and tipo = 'xml.obtener' order by creado_en, id`,
    [clienteId],
  );
  return r.rows as TrabajoXmlBd[];
}

const TERMINALES = ["completado", "error", "cancelado"];

/** Espera a que existan al menos `minimo` trabajos `xml.obtener` del cliente y todos hayan terminado. */
export async function esperarLotesXml(
  admin: ContappDb,
  clienteId: string,
  minimo: number,
  esperar: (
    cond: () => boolean | Promise<boolean>,
    etiqueta: string,
    o?: { timeoutMs?: number },
  ) => Promise<void>,
  timeoutMs = 25_000,
): Promise<TrabajoXmlBd[]> {
  await esperar(
    async () => {
      const t = await trabajosXmlDe(admin, clienteId);
      return t.length >= minimo && t.every((x) => TERMINALES.includes(x.estado));
    },
    `${minimo} lote(s) de xml.obtener terminados`,
    { timeoutMs },
  );
  return trabajosXmlDe(admin, clienteId);
}

/** Texto de las tablas de XML de los estudios dados (para buscar canarios). */
export async function volcarTablasXml(
  admin: ContappDb,
  estudios: string[],
): Promise<string> {
  const r = await admin.pool.query(
    `select to_jsonb(t)::text as t from documento_xml t where tenant_id = any($1::uuid[])
     union all select to_jsonb(t)::text from documento_xml_obtencion t where tenant_id = any($1::uuid[])
     union all select to_jsonb(t)::text from compra_evaluacion t where tenant_id = any($1::uuid[])`,
    [estudios],
  );
  return (r.rows as Array<{ t: string }>).map((f) => f.t).join("\n");
}

/** Resultado vacío de un lote: los seis contadores del plan en cero. */
export const RESULTADO_CERO = {
  guardados: 0,
  omitidos: 0,
  noEncontrados: 0,
  credencial: 0,
  transitorios: 0,
  invalidos: 0,
} as const;

/**
 * Borra lo que dejan las pruebas en las tablas de 016. Con `session_replication_role = replica` (las FK compuestas y los
 * triggers de solo-inserción impiden borrar en cualquier orden). Llamar antes de `limpiarCompras` y de `e.limpiar()`.
 */
export async function limpiarXml(
  admin: ContappDb,
  estudios: string[],
): Promise<void> {
  const c = await admin.pool.connect();
  try {
    await c.query("SET session_replication_role = replica");
    for (const sql of [
      "delete from compra_hallazgo where tenant_id = any($1::uuid[])",
      "delete from compra_evaluacion where tenant_id = any($1::uuid[])",
      "delete from documento_xml_obtencion where tenant_id = any($1::uuid[])",
      "delete from documento_xml where tenant_id = any($1::uuid[])",
    ])
      await c.query(sql, [estudios]).catch(() => undefined);
  } finally {
    c.release(true); // se destruye: no vuelve al pool con session_replication_role = replica
  }
}
