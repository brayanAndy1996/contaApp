/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y cuerpos JSON dinámicos en pruebas */
// Soporte de las pruebas de integración HTTP de compras (spec 014, T9 y T10). Encima de `soporte-ventas.ts` (cola con
// Redis real, estudios rastreados, clientes con `sire_api` verificada, siembra de `propuesta`): añade la siembra por SQL de
// `compra`, `compra_version`, `compra_hallazgo`, `compra_operacion` y `compra_periodo` con la conexión de migraciones (no
// pasa por RLS ni por grants; sí por los triggers y las FK), las lecturas de verificación y un lector mínimo de `.xlsx`.
// No es una prueba ni código de producción. Datos sintéticos (RUC de `fixtures/sire/rucs-prueba.json`, sin RUC reales).
//
// CONTRATO DE BD QUE ASUME LA SIEMBRA (plan 014, «BD»; el mismo de `tests/aislamiento/compras-soporte.ts`, T6):
//  - `compra(id, tenant_id, cliente_id, periodo, propuesta_id, clave, tipo_doc, serie, numero, doc_tipo, doc_numero,
//    razon_social, fecha, moneda, tipo_cambio, origen, version_vigente, descartada_*)`.
//  - `compra_version(tenant_id, compra_id, n, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado, isc, icbper,
//    otros_tributos, total, excluida, motivo, clasificada, accion, operacion_id, usuario_id, creada_en)`.
//  - `compra_evaluacion(tenant_id, compra_id, version_n, n)` (016 P-2: se siembra la n = 1 antes de cada hallazgo).
//  - `compra_hallazgo(tenant_id, compra_id, version_n, evaluacion_n, regla, sugerencia jsonb, lecturas jsonb, requiere_confirmacion)`.
//  - `compra_operacion(tenant_id, cliente_id, periodo, usuario_id, tipo, estado, referencia_id, creada_en, deshecha_en)`.
//  - `compra_periodo(tenant_id, cliente_id, periodo, estado, marcado_por, marcado_en)`.
//  - `accion` de la versión 1: `original` (SIRE) o `agregada` (a mano), como en `ACCIONES_VERSION` de `@contapp/shared`.
// Los hallazgos de las filas del fixture se calculan con `evaluarReglas` de 011 (la misma regla que aplica la descarga) y se
// guardan con la sugerencia y las lecturas como cadenas decimales (la forma de `HallazgoVista` de `@contapp/shared`).
import { readFileSync } from "node:fs";
import { createDb } from "@contapp/db";
import {
  DICCIONARIO_GLOSAS_BASE,
  evaluarReglas,
  Money,
  MontosComprobante,
  type FilaEvaluable,
  type Hallazgo,
  type Sugerencia,
} from "@contapp/domain";
import { strFromU8, unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import {
  abrirBancoVentas,
  PERIODO,
  type Actor,
  type BancoVentas,
  type Estudio,
} from "./soporte-ventas.js";
import type { Resp } from "./soporte.js";

export { PERIODO };
export type { Actor, BancoVentas, Estudio };

// --- Montos ---------------------------------------------------------------------------------------------------------

export const COLUMNAS = [
  "biDg",
  "igvDg",
  "biDgng",
  "igvDgng",
  "biDng",
  "igvDng",
  "noGravado",
  "isc",
  "icbper",
  "otrosTributos",
] as const;
export type Columna = (typeof COLUMNAS)[number];
export type Montos = Record<Columna | "total", string>;


/** Dinero en céntimos con BigInt: ninguna prueba usa `number` para dinero. */
export const centimos = (monto: string): bigint => {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(monto);
  if (m === null) throw new Error(`monto no decimal: ${monto}`);
  const v = BigInt(m[2]! + (m[3] ?? "").padEnd(2, "0"));
  return m[1] === "-" ? -v : v;
};
export const deCentimos = (c: bigint): string => {
  const neg = c < 0n;
  const a = (neg ? -c : c).toString().padStart(3, "0");
  return `${neg ? "-" : ""}${a.slice(0, -2)}.${a.slice(-2)}`;
};

/** Montos en cero; el total es la suma de las 10 columnas salvo que se indique otro (así una fila puede no cuadrar). */
export function montos(o: Partial<Montos> = {}): Montos {
  const base = Object.fromEntries(
    COLUMNAS.map((c) => [c, o[c] ?? "0.00"]),
  ) as Record<Columna, string>;
  const total =
    o.total ??
    deCentimos(COLUMNAS.reduce((s, c) => s + centimos(base[c]), 0n));
  return { ...base, total };
}

/** Factura gravada típica: BI 100.00, IGV 18.00, total 118.00. */
export const MONTOS_DG = montos({ biDg: "100.00", igvDg: "18.00" });

// --- Filas ----------------------------------------------------------------------------------------------------------

/** Fila del SIRE de compras tal como la entrega `fixtures/sire/*-compras-*.json`. */
export interface FilaSire {
  tipo: string;
  serie: string;
  numero: string;
  rucContraparte: string;
  razonSocialContraparte?: string;
  fechaEmision: string;
  moneda: "PEN" | "USD";
  tipoCambio?: string;
  biDg: string;
  igvDg: string;
  biDgng: string;
  igvDgng: string;
  biDng: string;
  igvDng: string;
  noGravado: string;
  isc: string;
  icbper: string;
  otros: string;
  total: string;
}

export function filasFixtureCompras(): FilaSire[] {
  const ruta = new URL(
    "../../../fixtures/sire/20700000002-compras-202610.json",
    import.meta.url,
  );
  return (JSON.parse(readFileSync(ruta, "utf8")) as { filas: FilaSire[] })
    .filas;
}

/** `F001-1040` → id de la compra sembrada. */
export type IdsPorNumero = Record<string, string>;
export const etiqueta = (f: { serie: string; numero: string }): string =>
  `${f.serie}-${f.numero}`;

export const claveCompra = (
  tipoDoc: string,
  serie: string,
  numero: string,
  docTipo: string,
  doc: string,
): string =>
  `${tipoDoc}|${serie.toUpperCase()}|${numero.replace(/^0+(?=.)/, "")}|${docTipo}|${doc.toUpperCase()}`;

/** Ruta base de compras de un cliente y periodo. */
export const base = (clienteId: string, periodo = PERIODO): string =>
  `/clientes/${clienteId}/periodos/${periodo}/compras`;

// --- Hallazgos ------------------------------------------------------------------------------------------------------

export interface HallazgoSembrado {
  regla: "R-ISC" | "R-MIX" | "R-RED" | "R-NEW" | "R-GP";
  sugerencia: unknown;
  lecturas: Record<string, string>;
  requiereConfirmacion: boolean;
}

function sugerenciaJson(s: Sugerencia | null): unknown {
  if (s === null) return null;
  switch (s.tipo) {
    case "mover":
      return {
        tipo: "mover",
        origen: s.origen,
        destino: s.destino,
        monto: s.monto.toString(),
      };
    case "separar":
      return {
        tipo: "separar",
        columnaBi: s.columnaBi,
        min: s.min.toString(),
        max: s.max.toString(),
        estimado: s.estimado.toString(),
        exacto: s.exacto === null ? null : s.exacto.toString(),
      };
    case "ajustar":
      return {
        tipo: "ajustar",
        valores: Object.fromEntries(
          Object.entries(s.valores).map(([k, v]) => [k, (v as Money).toString()]),
        ),
      };
    case "clasificar":
      return { tipo: "clasificar" };
    case "excluir":
      return { tipo: "excluir", palabra: s.palabra, categoria: s.categoria };
  }
}

function aHallazgoSembrado(h: Hallazgo): HallazgoSembrado {
  return {
    regla: h.regla,
    sugerencia: sugerenciaJson(h.sugerencia),
    lecturas: Object.fromEntries(
      Object.entries(h.lecturas).map(([k, v]) => [k, (v as Money).toString()]),
    ),
    requiereConfirmacion: h.requiereConfirmacion,
  };
}

/** Hallazgo R-RED respaldado por el XML (`requiereConfirmacion = false`): el único que entra en una masiva (DU-15). */
export function hallazgoRedXml(m: Montos, totalCorrecto: string): HallazgoSembrado {
  return {
    regla: "R-RED",
    sugerencia: { tipo: "ajustar", valores: { total: totalCorrecto } },
    lecturas: Object.fromEntries(
      [...COLUMNAS, "total" as const].map((c) => [c, m[c]]),
    ),
    requiereConfirmacion: false,
  };
}

/** Hallazgo R-ISC respaldado por el XML (mover `monto` de la BI de DG al ISC sin pedir confirmación). */
export function hallazgoIscXml(m: Montos, monto: string): HallazgoSembrado {
  return {
    regla: "R-ISC",
    sugerencia: { tipo: "mover", origen: "biDg", destino: "isc", monto },
    lecturas: { biDg: m.biDg, igvDg: m.igvDg },
    requiereConfirmacion: false,
  };
}

/** Hallazgo R-ISC sin XML (pide confirmación): en una masiva es `no_masiva`. */
export function hallazgoIscSinXml(m: Montos): HallazgoSembrado {
  return {
    regla: "R-ISC",
    sugerencia: { tipo: "mover", origen: "biDg", destino: "isc", monto: m.biDg },
    lecturas: { biDg: m.biDg, igvDg: m.igvDg },
    requiereConfirmacion: true,
  };
}

// --- Opciones de siembra --------------------------------------------------------------------------------------------

export interface OpcionesCompra {
  periodo?: string;
  origen?: "sire" | "agregada";
  /** Obligatorio si `origen = "sire"` (si no se pasa, se crea una propuesta de compras). */
  propuestaId?: string | null;
  tipoDoc?: string;
  serie: string;
  numero: string;
  docTipo?: string;
  doc?: string;
  razonSocial?: string | null;
  fecha?: string;
  moneda?: "PEN" | "USD";
  tipoCambio?: string | null;
  /** Montos de la versión 1. */
  montos?: Partial<Montos>;
  usuarioId: string;
  /** Versiones siguientes (n = 2, 3…) con los campos que cambian; la última queda como vigente. */
  versiones?: {
    montos?: Partial<Montos>;
    excluida?: boolean;
    motivo?: string | null;
    clasificada?: boolean;
    accion?: string;
  }[];
  /** Hallazgos de la versión vigente (si se omite, no hay ninguno). */
  hallazgos?: HallazgoSembrado[];
  /** Una agregada ya descartada (D-7): `descartada_en` con la hora de ahora. */
  descartada?: boolean;
}

export interface CompraBd {
  id: string;
  clave: string;
  tipo_doc: string;
  serie: string;
  numero: string;
  doc_tipo: string;
  doc_numero: string;
  razon_social: string | null;
  fecha: string;
  moneda: string;
  tipo_cambio: string | null;
  origen: string;
  propuesta_id: string | null;
  version_vigente: number;
  descartada: boolean;
}

export interface VersionBd extends Montos {
  id: string;
  compra_id: string;
  n: number;
  excluida: boolean;
  motivo: string | null;
  clasificada: boolean;
  accion: string;
  operacion_id: string | null;
  usuario_id: string | null;
}

export interface OperacionBd {
  id: string;
  usuario_id: string;
  tipo: string;
  estado: string;
}

export interface BancoCompras extends BancoVentas {
  /** Una compra con su versión 1 (y las siguientes), en una sola transacción. Devuelve su id. */
  sembrarCompra(
    tenantId: string,
    clienteId: string,
    o: OpcionesCompra,
  ): Promise<string>;
  /**
   * Las 5 filas del fixture de 009 (San Juan ISC, mixta, zapatilla/bolsas, USD, gravada común) como compras del SIRE, con
   * los hallazgos de `evaluarReglas`. `conocidos` (por omisión true): los proveedores ya tienen historial (sin R-NEW).
   */
  sembrarFixture(
    tenantId: string,
    clienteId: string,
    o: {
      usuarioId: string;
      periodo?: string;
      conocidos?: boolean;
      /** Versiones siguientes por fila (`F001-1040`); esas filas quedan sin hallazgos (se corrigieron). */
      versiones?: Record<string, NonNullable<OpcionesCompra["versiones"]>>;
    },
  ): Promise<IdsPorNumero>;
  /**
   * `n` compras del SIRE (F002-1 a F002-n, BI 100.00 + IGV 18.00 = 118.00, 50 proveedores) en una sola sentencia; devuelve
   * los ids en orden de número.
   */
  sembrarVolumen(
    tenantId: string,
    clienteId: string,
    n: number,
    o: { usuarioId: string; periodo?: string },
  ): Promise<string[]>;
  /** Una fila de `propuesta_diferencia` con la clave de compras (`tipo|SERIE|numero|tipoDoc|DOC`). */
  sembrarDiferenciaCompra(
    tenantId: string,
    propuestaId: string,
    o: {
      clave: string;
      origenExistente?: "sire" | "manual";
      campos: string[];
      valoresSire: Record<string, string>;
    },
  ): Promise<void>;
  estadoPeriodo(
    tenantId: string,
    clienteId: string,
    periodo: string,
    estado: "abierto" | "revisado" | "generado",
    marcadoPor?: string | null,
  ): Promise<void>;
  compras(clienteId: string, periodo?: string): Promise<CompraBd[]>;
  versiones(compraId: string): Promise<VersionBd[]>;
  hallazgosDe(compraId: string, versionN: number): Promise<any[]>;
  operaciones(clienteId: string, periodo?: string): Promise<OperacionBd[]>;
  /** `null` si el periodo aún no tiene fila (equivale a `abierto`). */
  periodoFila(clienteId: string, periodo?: string): Promise<any | null>;
  /** Petición sin cookie ni CSRF (sin sesión). */
  sinSesion(
    metodo: "GET" | "POST",
    ruta: string,
    cuerpo?: unknown,
  ): Promise<Resp>;
  /** Una sesión nueva del mismo usuario (recargar la sesión): misma persona, otra cookie. */
  nuevaSesion(a: Actor): Promise<Actor>;
  /** Foto de lo que 014 guarda de un cliente (para comprobar que un intento rechazado no cambió nada). */
  foto(clienteId: string): Promise<{
    compras: CompraBd[];
    versiones: VersionBd[];
    operaciones: OperacionBd[];
    periodo: any | null;
    propuestas: number;
    trabajos: number;
  }>;
}

const SQL_COMPRA = `insert into compra (tenant_id, cliente_id, periodo, propuesta_id, clave, tipo_doc, serie, numero, doc_tipo,
    doc_numero, razon_social, fecha, moneda, tipo_cambio, origen, version_vigente)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) returning id`;

const SQL_VERSION = `insert into compra_version (tenant_id, compra_id, n, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng,
    no_gravado, isc, icbper, otros_tributos, total, excluida, motivo, clasificada, accion, usuario_id)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`;

// 016 P-2: el hallazgo cuelga de una evaluación numerada (`compra_evaluacion`); las siembras usan la evaluación n = 1.
const SQL_EVALUACION = `insert into compra_evaluacion (tenant_id, compra_id, version_n, n)
  values ($1, $2, $3, 1) on conflict do nothing`;

const SQL_HALLAZGO = `insert into compra_hallazgo (tenant_id, compra_id, version_n, evaluacion_n, regla, sugerencia, lecturas, requiere_confirmacion)
  values ($1, $2, $3, 1, $4, $5::jsonb, $6::jsonb, $7)`;

const COLS_VERSION_SELECT = `v.id, v.compra_id, v.n::int as n, v.bi_dg::text as "biDg", v.igv_dg::text as "igvDg",
  v.bi_dgng::text as "biDgng", v.igv_dgng::text as "igvDgng", v.bi_dng::text as "biDng", v.igv_dng::text as "igvDng",
  v.no_gravado::text as "noGravado", v.isc::text as isc, v.icbper::text as icbper, v.otros_tributos::text as "otrosTributos",
  v.total::text as total, v.excluida, v.motivo, v.clasificada, v.accion, v.operacion_id, v.usuario_id`;

export async function abrirBancoCompras(): Promise<BancoCompras> {
  const v = await abrirBancoVentas();
  const sql = v.b.sql;
  const tenants: string[] = [];
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!url)
    throw new Error("falta MIGRATIONS_DATABASE_URL para las pruebas de compras");
  const admin = createDb({ rolApp: "contapp_backend", url, poolMax: 2 });

  const sembrarCompra: BancoCompras["sembrarCompra"] = async (
    tenantId,
    clienteId,
    o,
  ) => {
    const periodo = o.periodo ?? PERIODO;
    const origen = o.origen ?? "sire";
    const propuestaId =
      origen === "agregada"
        ? null
        : (o.propuestaId ??
          (await v.sembrarPropuesta(tenantId, clienteId, {
            periodo,
            libro: "compras",
            nuevas: 1,
            usuarioId: o.usuarioId,
          })));
    const tipoDoc = o.tipoDoc ?? "01";
    const docTipo = o.docTipo ?? "6";
    const doc = o.doc ?? "20700000011";
    const m1 = montos(o.montos ?? MONTOS_DG);
    const versiones = o.versiones ?? [];
    const c = await admin.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await c.query(SQL_COMPRA, [
        tenantId,
        clienteId,
        periodo,
        propuestaId,
        claveCompra(tipoDoc, o.serie, o.numero, docTipo, doc),
        tipoDoc,
        o.serie,
        o.numero,
        docTipo,
        doc,
        o.razonSocial === undefined ? "PROVEEDOR SINTETICO SAC" : o.razonSocial,
        o.fecha ?? "2026-10-05",
        o.moneda ?? "PEN",
        o.tipoCambio ?? null,
        origen,
        1 + versiones.length,
      ]);
      const id = r.rows[0].id as string;
      const poner = async (
        n: number,
        m: Montos,
        extra: {
          excluida: boolean;
          motivo: string | null;
          clasificada: boolean;
          accion: string;
        },
      ) =>
        c.query(SQL_VERSION, [
          tenantId,
          id,
          n,
          m.biDg,
          m.igvDg,
          m.biDgng,
          m.igvDgng,
          m.biDng,
          m.igvDng,
          m.noGravado,
          m.isc,
          m.icbper,
          m.otrosTributos,
          m.total,
          extra.excluida,
          extra.motivo,
          extra.clasificada,
          extra.accion,
          o.usuarioId,
        ]);
      let actual = m1;
      let estado = { excluida: false, motivo: null as string | null, clasificada: false };
      await poner(1, m1, { ...estado, accion: origen === "sire" ? "original" : "agregada" });
      let n = 1;
      for (const x of versiones) {
        n++;
        actual = montos({ ...actual, ...(x.montos ?? {}), total: x.montos?.total ?? undefined });
        estado = {
          excluida: x.excluida ?? estado.excluida,
          motivo: x.motivo === undefined ? estado.motivo : x.motivo,
          clasificada: x.clasificada ?? estado.clasificada,
        };
        await poner(n, actual, { ...estado, accion: x.accion ?? "editar" });
      }
      for (const h of o.hallazgos ?? []) {
        await c.query(SQL_EVALUACION, [tenantId, id, n]);
        await c.query(SQL_HALLAZGO, [
          tenantId,
          id,
          n,
          h.regla,
          JSON.stringify(h.sugerencia),
          JSON.stringify(h.lecturas),
          h.requiereConfirmacion,
        ]);
      }
      if (o.descartada === true)
        await c.query("update compra set descartada_en = now() where id = $1", [id]);
      await c.query("COMMIT");
      return id;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  };

  const sembrarFixture: BancoCompras["sembrarFixture"] = async (
    tenantId,
    clienteId,
    o,
  ) => {
    const periodo = o.periodo ?? PERIODO;
    const filas = filasFixtureCompras();
    const propuestaId = await v.sembrarPropuesta(tenantId, clienteId, {
      periodo,
      libro: "compras",
      nuevas: filas.length,
      usuarioId: o.usuarioId,
    });
    const ids: IdsPorNumero = {};
    const evaluables: FilaEvaluable[] = [];
    for (const f of filas) {
      const id = await sembrarCompra(tenantId, clienteId, {
        periodo,
        propuestaId,
        tipoDoc: f.tipo,
        serie: f.serie,
        numero: f.numero,
        doc: f.rucContraparte,
        razonSocial: f.razonSocialContraparte ?? null,
        fecha: f.fechaEmision,
        moneda: f.moneda,
        tipoCambio: f.tipoCambio ?? null,
        montos: {
          biDg: f.biDg,
          igvDg: f.igvDg,
          biDgng: f.biDgng,
          igvDgng: f.igvDgng,
          biDng: f.biDng,
          igvDng: f.igvDng,
          noGravado: f.noGravado,
          isc: f.isc,
          icbper: f.icbper,
          otrosTributos: f.otros,
          total: f.total,
        },
        usuarioId: o.usuarioId,
        ...(o.versiones?.[etiqueta(f)] ? { versiones: o.versiones[etiqueta(f)]! } : {}),
      });
      ids[etiqueta(f)] = id;
      evaluables.push({
        id,
        proveedor: { tipo: "6", numero: f.rucContraparte },
        comprobante: { tipo: f.tipo, serie: f.serie, numero: f.numero },
        montos: MontosComprobante.desde(f.moneda, {
          biDg: f.biDg,
          igvDg: f.igvDg,
          biDgng: f.biDgng,
          igvDgng: f.igvDgng,
          biDng: f.biDng,
          igvDng: f.igvDng,
          noGravado: f.noGravado,
          isc: f.isc,
          icbper: f.icbper,
          otrosTributos: f.otros,
          total: f.total,
        } as never),
      });
    }
    const conocidos = o.conocidos ?? true;
    // Cada fila se evalúa sola: una fila que la regla no admite se queda sin hallazgos (D-4, aislamiento de 012 D19).
    const corregidas = new Set(Object.keys(o.versiones ?? {}).map((k) => ids[k]));
    for (const fila of evaluables) {
      if (corregidas.has(fila.id)) continue;
      let hallazgos: readonly Hallazgo[] = [];
      try {
        hallazgos = evaluarReglas([fila], {
          proveedoresConocidos: conocidos ? [fila.proveedor] : [],
          proveedoresIsc: [],
          diccionario: DICCIONARIO_GLOSAS_BASE,
        }).hallazgos;
      } catch {
        hallazgos = [];
      }
      for (const h of hallazgos) {
        const s = aHallazgoSembrado(h);
        await sql(SQL_EVALUACION, [tenantId, fila.id, 1]);
        await sql(
          `insert into compra_hallazgo (tenant_id, compra_id, version_n, evaluacion_n, regla, sugerencia, lecturas, requiere_confirmacion)
           values ($1, $2, 1, 1, $3, $4::jsonb, $5::jsonb, $6)`,
          [
            tenantId,
            fila.id,
            s.regla,
            JSON.stringify(s.sugerencia),
            JSON.stringify(s.lecturas),
            s.requiereConfirmacion,
          ],
        );
      }
    }
    return ids;
  };

  const sembrarVolumen: BancoCompras["sembrarVolumen"] = async (
    tenantId,
    clienteId,
    n,
    o,
  ) => {
    const periodo = o.periodo ?? PERIODO;
    const propuestaId = await v.sembrarPropuesta(tenantId, clienteId, {
      periodo,
      libro: "compras",
      nuevas: n,
      usuarioId: o.usuarioId,
    });
    await sql(
      `with nuevas as (
         insert into compra (tenant_id, cliente_id, periodo, propuesta_id, clave, tipo_doc, serie, numero, doc_tipo, doc_numero,
                             razon_social, fecha, moneda, tipo_cambio, origen, version_vigente)
         select $1, $2, $3, $4, '01|F002|' || g || '|6|' || ('207' || lpad((g % 50)::text, 8, '0')), '01', 'F002', g::text, '6',
                '207' || lpad((g % 50)::text, 8, '0'), 'PROVEEDOR VOLUMEN ' || (g % 50), '2026-10-05', 'PEN', null, 'sire', 1
           from generate_series(1, $5::int) g
         returning id, numero)
       insert into compra_version (tenant_id, compra_id, n, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado, isc,
                                   icbper, otros_tributos, total, excluida, motivo, clasificada, accion, usuario_id)
       select $1, id, 1, 100, 18, 0, 0, 0, 0, 0, 0, 0, 0, 118, false, null, false, 'descarga', $6 from nuevas`,
      [tenantId, clienteId, periodo, propuestaId, n, o.usuarioId],
    );
    const filas = await sql(
      "select id from compra where cliente_id = $1 and periodo = $2 and serie = 'F002' order by numero::int",
      [clienteId, periodo],
    );
    return filas.map((f: any) => f.id as string);
  };

  const compras: BancoCompras["compras"] = (clienteId, periodo = PERIODO) =>
    sql(
      `select c.id, c.clave, c.tipo_doc, c.serie, c.numero, c.doc_tipo, c.doc_numero, c.razon_social, c.fecha::text as fecha,
              c.moneda, c.tipo_cambio::text as tipo_cambio, c.origen, c.propuesta_id, c.version_vigente::int as version_vigente,
              coalesce(to_jsonb(c)->>'descartada_en', to_jsonb(c)->>'descartada_at') is not null as descartada
         from compra c where c.cliente_id = $1 and c.periodo = $2 order by c.serie, c.numero::int, c.doc_numero`,
      [clienteId, periodo],
    );

  const versiones: BancoCompras["versiones"] = (compraId) =>
    sql(
      `select ${COLS_VERSION_SELECT} from compra_version v where v.compra_id = $1 order by v.n`,
      [compraId],
    );

  const operaciones: BancoCompras["operaciones"] = (
    clienteId,
    periodo = PERIODO,
  ) =>
    sql(
      `select id, usuario_id, tipo, estado from compra_operacion where cliente_id = $1 and periodo = $2 order by creada_en, id`,
      [clienteId, periodo],
    );

  const periodoFila: BancoCompras["periodoFila"] = async (
    clienteId,
    periodo = PERIODO,
  ) => {
    const r = await sql(
      `select estado, marcado_por, marcado_en from compra_periodo where cliente_id = $1 and periodo = $2`,
      [clienteId, periodo],
    );
    return r[0] ?? null;
  };

  const conSesionAdmin = v.b.c.p.b;

  return {
    ...v,
    estudio: async () => {
      const e = await v.estudio();
      tenants.push(e.tenantId);
      return e;
    },
    sembrarCompra,
    sembrarFixture,
    sembrarVolumen,
    sembrarDiferenciaCompra: async (tenantId, propuestaId, o) => {
      const [tipo = "", serie = "", numero = ""] = o.clave.split("|");
      await sql(
        `insert into propuesta_diferencia (tenant_id, propuesta_id, clave, tipo, serie, numero, origen_existente, campos,
                                           valores_sire)
         values ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::jsonb)`,
        [tenantId, propuestaId, o.clave, tipo, serie, numero, o.origenExistente ?? "sire", o.campos, JSON.stringify(o.valoresSire)],
      );
    },
    estadoPeriodo: async (tenantId, clienteId, periodo, estado, marcadoPor = null) => {
      await sql(
        `insert into compra_periodo (tenant_id, cliente_id, periodo, estado, marcado_por, marcado_en)
         values ($1, $2, $3, $4, $5, case when $5::uuid is null then null else now() end)
         on conflict (tenant_id, cliente_id, periodo) do update set estado = excluded.estado,
           marcado_por = excluded.marcado_por, marcado_en = excluded.marcado_en`,
        [tenantId, clienteId, periodo, estado, marcadoPor],
      );
    },
    compras,
    versiones,
    hallazgosDe: (compraId, versionN) =>
      sql(
        `select regla, sugerencia, lecturas, requiere_confirmacion from compra_hallazgo where compra_id = $1 and version_n = $2
          order by regla`,
        [compraId, versionN],
      ),
    operaciones,
    periodoFila,
    sinSesion: (metodo, ruta, cuerpo) =>
      conSesionAdmin.h.pedir({ metodo, ruta, ...(cuerpo === undefined ? {} : { cuerpo }) }),
    nuevaSesion: async (a) => {
      const s = await conSesionAdmin.sesion(a, a.tenantId);
      return { ...a, cookie: s.cookie, csrf: s.csrf };
    },
    foto: async (clienteId) => {
      const cs = await compras(clienteId);
      const vs: VersionBd[] = [];
      for (const c of cs) vs.push(...(await versiones(c.id)));
      const cuenta = await sql(
        "select (select count(*)::int from propuesta where cliente_id = $1) as propuestas",
        [clienteId],
      );
      return {
        compras: cs,
        versiones: vs,
        operaciones: await operaciones(clienteId),
        periodo: await periodoFila(clienteId),
        propuestas: cuenta[0].propuestas as number,
        trabajos: (await v.trabajos(clienteId)).length,
      };
    },
    cerrar: async () => {
      if (tenants.length > 0) {
        const c = await admin.pool.connect();
        try {
          await c.query("SET session_replication_role = replica");
          // Un DELETE estático por tabla, de la hija a la madre; ventas y propuestas las limpia `v.cerrar()`.
          const borrar = [
            // Spec 012b: las versiones de archivo (inmutables por trigger) se borran con `replica`, antes que el resto.
            "delete from archivo_generado where tenant_id = any($1::uuid[])",
            "delete from compra_hallazgo where tenant_id = any($1::uuid[])",
            "delete from compra_evaluacion where tenant_id = any($1::uuid[])",
            "delete from compra_version where tenant_id = any($1::uuid[])",
            "delete from compra_operacion where tenant_id = any($1::uuid[])",
            "delete from compra where tenant_id = any($1::uuid[])",
            "delete from compra_periodo where tenant_id = any($1::uuid[])",
          ];
          for (const texto of borrar)
            await c.query(texto, [tenants]).catch(() => undefined);
        } finally {
          c.release(true); // se destruye: no vuelve al pool con session_replication_role = replica
        }
      }
      try {
        await v.cerrar();
      } finally {
        await admin.close();
      }
    },
  };
}

// --- Lector mínimo de .xlsx (CA-20) --------------------------------------------------------------------------------

export interface CeldaXlsx {
  /** `texto` (cadena o cadena en línea), `numero` (sin `t` o `t="n"`), `formula` (lleva `<f>`) u `otro`. */
  tipo: "texto" | "numero" | "formula" | "otro";
  /** El contenido tal cual está en el archivo: el texto sin escapar o el número como cadena. */
  valor: string;
}
export interface HojaXlsx {
  nombre: string;
  filas: (CeldaXlsx | null)[][];
}

/**
 * `fast-xml-parser` normaliza el `\r` literal a `\n` y no decodifica las referencias numéricas (`&#13;`, `&#xD;`).
 * Un CR escrito como referencia (como hace el exportador) se cambia antes de analizar por un marcador de uso privado
 * y se restaura en `textoDe`, así el lector conserva el retorno de carro tal como está en el archivo.
 */
const MARCA_CR = "\uE000";
const REF_CR = /&#(?:0*13|x0*[dD]);/g;

const analizador = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  isArray: (nombre) => ["sheet", "Relationship", "row", "c", "si", "r"].includes(nombre),
});

const lista = (x: unknown): any[] =>
  x === undefined || x === null ? [] : Array.isArray(x) ? x : [x];
const textoDe = (t: unknown): string => {
  if (t === undefined || t === null) return "";
  if (typeof t === "string") return t.replaceAll(MARCA_CR, "\r");
  if (typeof t === "object") return textoDe((t as any)["#text"]);
  return String(t);
};
const textoEnriquecido = (si: any): string => {
  if (si?.t !== undefined) return textoDe(si.t);
  return lista(si?.r)
    .map((r) => textoDe(r.t))
    .join("");
};

const letrasAColumna = (ref: string): number => {
  const m = /^([A-Z]+)/.exec(ref);
  let n = 0;
  for (const ch of m?.[1] ?? "A") n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** Lee todas las hojas de un `.xlsx`; sin evaluar fórmulas (las marca). Suficiente para las pruebas de CA-20. */
export function leerLibroXlsx(bytes: Uint8Array): HojaXlsx[] {
  const partes = unzipSync(bytes);
  const parte = (ruta: string): any => {
    const b = partes[ruta];
    if (b === undefined) throw new Error(`falta la parte ${ruta} del .xlsx`);
    return analizador.parse(strFromU8(b).replace(REF_CR, MARCA_CR));
  };
  const libro = parte("xl/workbook.xml");
  const rels = lista(parte("xl/_rels/workbook.xml.rels")?.Relationships?.Relationship);
  const cadenas = partes["xl/sharedStrings.xml"]
    ? lista(parte("xl/sharedStrings.xml")?.sst?.si).map(textoEnriquecido)
    : [];
  const salida: HojaXlsx[] = [];
  for (const hoja of lista(libro?.workbook?.sheets?.sheet)) {
    const rid = hoja["@_id"] as string;
    const destino = rels.find((r) => r["@_Id"] === rid)?.["@_Target"] as string;
    const ruta = destino.startsWith("/") ? destino.slice(1) : `xl/${destino}`;
    const filas: (CeldaXlsx | null)[][] = [];
    for (const fila of lista(parte(ruta)?.worksheet?.sheetData?.row)) {
      const celdas: (CeldaXlsx | null)[] = [];
      for (const c of lista(fila.c)) {
        const col = letrasAColumna(String(c["@_r"] ?? "A1"));
        while (celdas.length < col) celdas.push(null);
        const t = c["@_t"] as string | undefined;
        let celda: CeldaXlsx;
        if (c.f !== undefined) celda = { tipo: "formula", valor: textoDe(c.f) };
        else if (t === "inlineStr") celda = { tipo: "texto", valor: textoEnriquecido(c.is ?? {}) };
        else if (t === "s") celda = { tipo: "texto", valor: cadenas[Number(textoDe(c.v))] ?? "" };
        else if (t === "str") celda = { tipo: "texto", valor: textoDe(c.v) };
        else if (t === undefined || t === "n") celda = { tipo: "numero", valor: textoDe(c.v) };
        else celda = { tipo: "otro", valor: textoDe(c.v) };
        celdas[col] = celda;
      }
      filas.push(celdas);
    }
    salida.push({ nombre: String(hoja["@_name"]), filas });
  }
  return salida;
}

/**
 * Céntimos de un número escrito en una celda (`"-770"`, `"1180.0"`, `"1180.00"`): compara montos exactos sin pasar por
 * `number`. Más de 2 decimales significativos lanza (el archivo guardó un monto que no es de céntimos).
 */
export function centimosDeCelda(valor: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(valor.trim());
  if (m === null) throw new Error(`celda no numérica: ${valor}`);
  const dec = m[3] ?? "";
  if (/[1-9]/.test(dec.slice(2))) throw new Error(`más de 2 decimales: ${valor}`);
  const v = BigInt(m[2]! + dec.slice(0, 2).padEnd(2, "0"));
  return m[1] === "-" ? -v : v;
}

/** p95 de una lista de tiempos (ms): el valor en la posición ⌈0,95·n⌉. */
export function p95(ms: readonly number[]): number {
  const orden = [...ms].sort((a, b) => a - b);
  return orden[Math.ceil(orden.length * 0.95) - 1]!;
}
