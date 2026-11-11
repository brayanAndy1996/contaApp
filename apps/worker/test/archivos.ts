// Soporte de las pruebas del worker de la spec 012b (T5, rojo). No es código de producción ni una prueba.
//
// CONTRATO DE BD que usa (lo implementa T10 en 0039/0040; es el de `tests/aislamiento/archivos-soporte.ts`):
//  - `venta_periodo(tenant_id, cliente_id, periodo, estado, marcado_por, marcado_en)` = `compra_periodo`.
//  - `venta_exclusion(id, tenant_id, cliente_id, periodo, venta_id, motivo, excluida_por, excluida_en, restaurada_por,
//    restaurada_en)`.
//  - `archivo_generado(id, tenant_id, cliente_id, periodo, libro, version, formato_id, formato_version, provisional,
//    nombre_txt, nombre_zip, sha256_txt bytea, sha256_zip bytea, bytes_zip, lineas, huella, modificadas, excluidas,
//    agregadas, impacto_igv_dg/dgng/dng/total NUMERIC(14,2), avisos jsonb, ruta, trabajo_id, generado_por, generado_en)`.
// Todo se siembra y se lee con el rol administrativo (pasa por triggers y FK, no por RLS ni grants).
//
// CONTRATO DEL PROCESADOR que fija (T11): ver el encabezado de `src/trabajos/procesadores/generar-archivo.ts`.
//  - La huella del trabajo es `sha256Hex(prepararArchivo(...).canon)` con la cabecera `{rucDeclarante: ruc del cliente,
//    periodo, libro}`, las filas de `original` (origen SIRE, versión 1 / ventas `sire`) y `vigente` (todas las vivas,
//    con `excluida` marcada) adaptadas con `compraLeidaAFila` / `ventaAFila`: lo mismo que arma el previo del backend.
//    `huellaDe` la calcula igual a partir de SQL, sin pasar por `packages/db` (que T10 aún no entrega).
//  - Consumidor final: estas pruebas usan siempre contraparte con documento, para no fijar cómo se mapea el «0»/«-».
import { randomBytes, randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import type { ContappDb } from "@contapp/db";
import { compraLeidaAFila, prepararArchivo, ventaAFila } from "@contapp/domain";
import type { CompraLeidaPlana, VentaLeidaPlana } from "@contapp/domain";
import type { Redis } from "ioredis";
import type { ContextoProcesador } from "../src/trabajos/ejecutor.js";
import { PERIODO, filaCompra, nuevaVersion, sembrarCompra } from "./compras.js";
import { fila, liberarDedupe, type FilaVenta, type MundoVentas } from "./ventas.js";
import { limpiarVentas } from "./ventas.js";
import { encolarYPublicar } from "./trabajos.js";
import { sha256Hex } from "./xml.js";

export { PERIODO, sha256Hex };
export { AlmacenEspia } from "./xml.js";

export type Libro = "compras" | "ventas";
export type EstadoPeriodo = "abierto" | "revisado" | "generado";

export const TIPO_ARCHIVO = "archivo.generar";
/** RUC válido, distinto del contribuyente de prueba, para un segundo cliente. */
export const RUC_OTRO_CLIENTE = "20700000011";
const RUC_CONTRAPARTE = "20100070970";

export interface ParametrosGenerar {
  periodo: string;
  libro: Libro;
  estadoVisto: "abierto" | "revisado";
  huella: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Siembras de ventas (la propuesta, el estado del periodo y las exclusiones)
// ---------------------------------------------------------------------------------------------------------------

/** Venta con contraparte con RUC (así no depende de cómo se mapea el consumidor final). `extra` pisa cualquier campo. */
export function ventaFactura(
  serie: string,
  numero: string,
  extra: Partial<FilaVenta> = {},
): FilaVenta {
  return fila(serie, numero, {
    tipo: "01",
    tipoDocContraparte: "6",
    docContraparte: RUC_CONTRAPARTE,
    ...extra,
  });
}

/** Boleta con DNI (las del caso real B001-290 y B001-292 sin la 291). */
export function ventaBoleta(
  numero: string,
  extra: Partial<FilaVenta> = {},
): FilaVenta {
  return fila("B001", numero, {
    tipoDocContraparte: "1",
    docContraparte: "45678912",
    ...extra,
  });
}

const SQL_VENTA = `insert into venta (
    tenant_id, cliente_id, periodo, propuesta_id, origen, clave, tipo, serie, numero, numero_n, fecha,
    tipo_doc_contraparte, doc_contraparte, moneda, tipo_cambio, base_gravada, igv, exonerada, inafecta, isc, icbper, otros,
    total, creada_por)
  values ($1, $2, $3, $4, 'sire', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, null)
  returning id`;

/** Venta de origen SIRE colgada de una propuesta (créala con `sembrarPropuesta`). Devuelve su id. */
export async function sembrarVentaSire(
  admin: ContappDb,
  m: Pick<MundoVentas, "T" | "c">,
  propuestaId: string,
  f: FilaVenta,
  o: { periodo?: string } = {},
): Promise<string> {
  const numero = f.numero.replace(/^0+(?=.)/, "");
  const r = await admin.pool.query(SQL_VENTA, [
    m.T,
    m.c.id,
    o.periodo ?? PERIODO,
    propuestaId,
    `${f.tipo}|${f.serie.toUpperCase()}|${numero}`,
    f.tipo,
    f.serie.toUpperCase(),
    f.numero,
    /^[0-9]{1,8}$/.test(f.numero) ? Number(f.numero) : null,
    f.fechaEmision,
    f.tipoDocContraparte ?? "0",
    f.docContraparte,
    f.moneda,
    f.tipoCambio ?? null,
    f.baseGravada,
    f.igv,
    f.exonerada,
    f.inafecta,
    f.isc,
    f.icbper,
    f.otros,
    f.total,
  ]);
  return r.rows[0].id as string;
}

/**
 * Siembra `n` ventas SIRE (F900-1 a F900-n, factura de S/ 118.00 con RUC) colgadas de una propuesta sembrada, en una sola
 * sentencia. Sirve para el volumen de RNF-035.
 */
export async function sembrarVentasConRuc(
  admin: ContappDb,
  m: Pick<MundoVentas, "T" | "c">,
  propuestaId: string,
  n: number,
): Promise<void> {
  await admin.pool.query(
    `insert into venta (
       tenant_id, cliente_id, periodo, propuesta_id, origen, clave, tipo, serie, numero, numero_n, fecha,
       tipo_doc_contraparte, doc_contraparte, moneda, tipo_cambio, base_gravada, igv, exonerada, inafecta, isc, icbper,
       otros, total, creada_por)
     select $1, $2, $3, $4, 'sire', '01|F900|' || g, '01', 'F900', g::text, g, '2026-10-05', '6', $5, 'PEN', null,
            100, 18, 0, 0, 0, 0, 0, 118, null
       from generate_series(1, $6::int) g`,
    [m.T, m.c.id, PERIODO, propuestaId, RUC_CONTRAPARTE, n],
  );
}

/** Exclusión vigente de una venta (como la deja `excluirVenta`); pasa por el trigger de inserción. Devuelve su id. */
export async function sembrarExclusion(
  admin: ContappDb,
  m: Pick<MundoVentas, "T" | "u" | "c">,
  ventaId: string,
  motivo: string,
  o: { periodo?: string } = {},
): Promise<string> {
  const r = await admin.pool.query(
    `insert into venta_exclusion (tenant_id, cliente_id, periodo, venta_id, motivo, excluida_por)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [m.T, m.c.id, o.periodo ?? PERIODO, ventaId, motivo, m.u],
  );
  return r.rows[0].id as string;
}

/** Cierra la exclusión vigente de la venta (como `restaurarVenta`). */
export async function restaurarExclusion(
  admin: ContappDb,
  m: Pick<MundoVentas, "u">,
  ventaId: string,
): Promise<void> {
  await admin.pool.query(
    `update venta_exclusion set restaurada_por = $2, restaurada_en = now()
      where venta_id = $1 and restaurada_en is null`,
    [ventaId, m.u],
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Estado del periodo de cualquiera de los dos libros
// ---------------------------------------------------------------------------------------------------------------

// Un SQL estático por libro (la tabla nunca se interpola).
const SQL_FIJAR_ESTADO: Record<Libro, string> = {
  compras: `insert into compra_periodo (tenant_id, cliente_id, periodo, estado, marcado_por, marcado_en)
     values ($1, $2, $3, $4, $5, now())
     on conflict (tenant_id, cliente_id, periodo) do update
       set estado = excluded.estado, marcado_por = excluded.marcado_por, marcado_en = excluded.marcado_en`,
  ventas: `insert into venta_periodo (tenant_id, cliente_id, periodo, estado, marcado_por, marcado_en)
     values ($1, $2, $3, $4, $5, now())
     on conflict (tenant_id, cliente_id, periodo) do update
       set estado = excluded.estado, marcado_por = excluded.marcado_por, marcado_en = excluded.marcado_en`,
};
const SQL_LEER_ESTADO: Record<Libro, string> = {
  compras: `select estado, marcado_por, marcado_en::text as marcado_en from compra_periodo
      where cliente_id = $1 and periodo = $2`,
  ventas: `select estado, marcado_por, marcado_en::text as marcado_en from venta_periodo
      where cliente_id = $1 and periodo = $2`,
};

/** Estado del periodo sembrado con el rol administrativo (marcado por `m.u`; el worker lo exige al generar). */
export async function fijarEstado(
  admin: ContappDb,
  libro: Libro,
  m: Pick<MundoVentas, "T" | "u" | "c">,
  estado: EstadoPeriodo,
  periodo = PERIODO,
): Promise<void> {
  await admin.pool.query(SQL_FIJAR_ESTADO[libro], [m.T, m.c.id, periodo, estado, m.u]);
}

/** Estado del periodo, o `null` si no hay fila (la ausencia equivale a `abierto`). */
export async function estadoDe(
  admin: ContappDb,
  libro: Libro,
  clienteId: string,
  periodo = PERIODO,
): Promise<{ estado: string; marcado_por: string | null; marcado_en: string | null } | null> {
  const r = await admin.pool.query(SQL_LEER_ESTADO[libro], [clienteId, periodo]);
  return (
    (r.rows[0] as { estado: string; marcado_por: string | null; marcado_en: string | null } | undefined) ?? null
  );
}

/** El cliente queda archivado (baja lógica). */
export async function archivarCliente(admin: ContappDb, clienteId: string): Promise<void> {
  await admin.pool.query("update cliente set archivado_at = now() where id = $1", [clienteId]);
}

// ---------------------------------------------------------------------------------------------------------------
// El previo desde SQL: la huella y el resumen que verían el backend y el worker
// ---------------------------------------------------------------------------------------------------------------

const COLUMNAS_MONTO_COMPRA = `v.bi_dg::text as bi_dg, v.igv_dg::text as igv_dg, v.bi_dgng::text as bi_dgng,
  v.igv_dgng::text as igv_dgng, v.bi_dng::text as bi_dng, v.igv_dng::text as igv_dng, v.no_gravado::text as no_gravado,
  v.isc::text as isc, v.icbper::text as icbper, v.otros_tributos::text as otros_tributos, v.total::text as total`;

const SELECT_COMPRA = `select c.id, c.origen, c.tipo_doc, c.serie, c.numero, c.doc_tipo, c.doc_numero, c.razon_social,
            c.fecha::text as fecha, c.moneda, c.tipo_cambio::text as tipo_cambio, v.n::int as version, v.excluida,
            ${COLUMNAS_MONTO_COMPRA}`;
const SQL_COMPRAS: Record<"original" | "vigente", string> = {
  original: `${SELECT_COMPRA}
       from compra c join compra_version v on v.compra_id = c.id and v.n = 1
      where c.cliente_id = $1 and c.periodo = $2 and c.descartada_en is null and c.origen = 'sire'
      order by c.clave, c.id`,
  vigente: `${SELECT_COMPRA}
       from compra c join compra_version v on v.compra_id = c.id and v.n = c.version_vigente
      where c.cliente_id = $1 and c.periodo = $2 and c.descartada_en is null
      order by c.clave, c.id`,
};

export async function comprasPlanas(
  admin: ContappDb,
  clienteId: string,
  periodo: string,
  vigente: boolean,
): Promise<CompraLeidaPlana[]> {
  const r = await admin.pool.query(SQL_COMPRAS[vigente ? "vigente" : "original"], [clienteId, periodo]);
  return (r.rows as Array<Record<string, string | number | boolean | null>>).map((f) => ({
    id: f.id as string,
    origen: f.origen as "sire" | "agregada",
    tipoDoc: f.tipo_doc as string,
    serie: f.serie as string,
    numero: f.numero as string,
    docTipo: f.doc_tipo as string,
    docNumero: f.doc_numero as string,
    razonSocial: f.razon_social as string | null,
    fecha: f.fecha as string,
    moneda: f.moneda as "PEN" | "USD",
    tipoCambio: f.tipo_cambio as string | null,
    version: f.version as number,
    excluida: f.excluida as boolean,
    montos: {
      biDg: f.bi_dg as string,
      igvDg: f.igv_dg as string,
      biDgng: f.bi_dgng as string,
      igvDgng: f.igv_dgng as string,
      biDng: f.bi_dng as string,
      igvDng: f.igv_dng as string,
      noGravado: f.no_gravado as string,
      isc: f.isc as string,
      icbper: f.icbper as string,
      otrosTributos: f.otros_tributos as string,
      total: f.total as string,
    },
  }));
}

const SELECT_VENTA = `select v.id, v.origen, v.tipo, v.serie, v.numero, v.fecha::text as fecha, v.tipo_doc_contraparte,
            v.doc_contraparte, v.moneda, v.tipo_cambio::text as tipo_cambio, v.base_gravada::text as base_gravada,
            v.igv::text as igv, v.exonerada::text as exonerada, v.inafecta::text as inafecta, v.isc::text as isc,
            v.icbper::text as icbper, v.otros::text as otros, v.total::text as total`;
const SQL_VENTAS: Record<"original" | "vigente", string> = {
  original: `${SELECT_VENTA}, false as excluida
       from venta v
      where v.cliente_id = $1 and v.periodo = $2 and v.origen = 'sire'
      order by v.clave, v.id`,
  vigente: `${SELECT_VENTA}, (x.id is not null) as excluida
       from venta v left join venta_exclusion x on x.venta_id = v.id and x.restaurada_en is null
      where v.cliente_id = $1 and v.periodo = $2
      order by v.clave, v.id`,
};

export async function ventasPlanas(
  admin: ContappDb,
  clienteId: string,
  periodo: string,
  vigente: boolean,
): Promise<VentaLeidaPlana[]> {
  const r = await admin.pool.query(SQL_VENTAS[vigente ? "vigente" : "original"], [clienteId, periodo]);
  return (r.rows as Array<Record<string, string | boolean | null>>).map((f) => ({
    id: f.id as string,
    origen: f.origen as "sire" | "manual",
    tipo: f.tipo as string,
    serie: f.serie as string,
    numero: f.numero as string,
    fecha: f.fecha as string,
    tipoDocContraparte: f.tipo_doc_contraparte as string,
    docContraparte: f.doc_contraparte as string,
    moneda: f.moneda as "PEN" | "USD",
    tipoCambio: f.tipo_cambio as string | null,
    baseGravada: f.base_gravada as string,
    igv: f.igv as string,
    exonerada: f.exonerada as string,
    inafecta: f.inafecta as string,
    isc: f.isc as string,
    icbper: f.icbper as string,
    otros: f.otros as string,
    total: f.total as string,
    excluida: f.excluida as boolean,
  }));
}

/** Lo que el previo del backend (y el worker) calculan hoy para el libro: huella, resumen y aptitud. */
export async function previoDe(
  admin: ContappDb,
  m: Pick<MundoVentas, "c">,
  libro: Libro,
  periodo = PERIODO,
) {
  const cabecera = { rucDeclarante: m.c.ruc, periodo, libro } as const;
  const preparado =
    libro === "compras"
      ? prepararArchivo({
          libro: "compras",
          cabecera,
          original: (await comprasPlanas(admin, m.c.id, periodo, false)).map((c) => compraLeidaAFila(c).fila),
          vigente: (await comprasPlanas(admin, m.c.id, periodo, true)).map((c) => compraLeidaAFila(c).fila),
          permitirProvisional: true,
        })
      : prepararArchivo({
          libro: "ventas",
          cabecera,
          original: (await ventasPlanas(admin, m.c.id, periodo, false)).map(ventaAFila),
          vigente: (await ventasPlanas(admin, m.c.id, periodo, true)).map(ventaAFila),
          permitirProvisional: true,
        });
  return { ...preparado, huella: sha256Hex(preparado.canon) };
}

/** La huella del previo vigente. */
export async function huellaDe(
  admin: ContappDb,
  m: Pick<MundoVentas, "c">,
  libro: Libro,
  periodo = PERIODO,
): Promise<string> {
  return (await previoDe(admin, m, libro, periodo)).huella;
}

// ---------------------------------------------------------------------------------------------------------------
// Compras de la mayoría de las pruebas
// ---------------------------------------------------------------------------------------------------------------

/** Razón social con el canario: aparece en el TXT, nunca en `resultado`, logs ni errores. */
export const RAZON_CANARIO = "PROVEEDOR CANARIO RZ-7Q3X S.A.C.";
/** Serie y monto únicos de las compras sembradas, para buscarlos en logs y resultados. */
export const SERIE_CANARIO = "F7Q3";
export const BASE_CANARIO = "837000.00";
export const IGV_CANARIO = "150660.00";
export const TOTAL_CANARIO = "987660.00";

export interface ComprasBase {
  /** Facturas F001-1 a F001-3 (S/ 118.00 cada una), tal como bajaron del SIRE. */
  a: string;
  b: string;
  c: string;
  /** La mixta F001-2056 (21.48 + 1.61 = 23.09) con la corrección aplicada (8.97 + 12.51, IGV 1.61): una modificada. */
  mixta: string;
  /** Agregada a mano F001-9001 (base 200.00, IGV 36.00). */
  agregada: string;
  /** La «zapatilla» F001-4062: excluida con motivo. Su número no debe salir en el TXT. */
  zapatilla: string;
}

/** Periodo de compras apto y con las tres clases de cambio (1 modificada, 1 agregada, 1 excluida): 5 líneas en el TXT. */
export async function sembrarComprasBase(
  admin: ContappDb,
  m: Pick<MundoVentas, "T" | "u" | "c">,
  o: { periodo?: string } = {},
): Promise<ComprasBase> {
  const periodo = o.periodo ?? PERIODO;
  const fechaEmision = `${periodo.slice(0, 4)}-${periodo.slice(4)}-05`;
  const base = (n: string, extra = {}) =>
    sembrarCompra(admin, m, filaCompra(n, { razonSocialContraparte: RAZON_CANARIO, fechaEmision, ...extra }), { periodo });
  const a = await base("1");
  const b = await base("2");
  const c = await base("3");
  const mixta = await base("2056", {
    biDg: "21.48",
    igvDg: "1.61",
    total: "23.09",
  });
  const zapatilla = await base("4062");
  const agregada = await sembrarCompra(
    admin,
    m,
    filaCompra("9001", {
      razonSocialContraparte: RAZON_CANARIO,
      fechaEmision,
      biDg: "200.00",
      igvDg: "36.00",
      total: "236.00",
    }),
    { periodo, origen: "agregada" },
  );
  // La corrección de la mixta (8.97 + 12.51) y la «zapatilla» excluida.
  await nuevaVersion(admin, m, mixta, { montos: { biDg: "8.97", igvDg: "1.61", biDng: "12.51" }, accion: "editar" });
  await nuevaVersion(admin, m, zapatilla, { excluida: true, motivo: "Zapatilla: gasto personal", accion: "excluir" });
  return { a, b, c, mixta, agregada, zapatilla };
}

// ---------------------------------------------------------------------------------------------------------------
// Encolado y ejecución directa del procesador
// ---------------------------------------------------------------------------------------------------------------

/**
 * Encola `archivo.generar` como lo hace el backend (rol backend) y libera la clave de deduplicación para poder encolar otro
 * igual (dos trabajos distintos con el mismo previo, como en el reintento o la carrera). Devuelve el id del trabajo.
 */
export async function encolarGenerar(
  admin: ContappDb,
  backend: ContappDb,
  redis: Redis,
  prefijo: string,
  m: Pick<MundoVentas, "T" | "u" | "c">,
  p: ParametrosGenerar,
  o: { liberar?: boolean } = {},
): Promise<string> {
  const r = await encolarYPublicar(backend, redis, prefijo, m.T, {
    tipo: TIPO_ARCHIVO,
    clienteId: m.c.id,
    parametros: p,
    prioridad: "interactivo",
    creadoPor: m.u,
  });
  if (o.liberar !== false) await liberarDedupe(admin, r.trabajo.id);
  return r.trabajo.id;
}

/** El contexto que el ejecutor de 008 le pasa al procesador. */
export function ctxDe(
  m: Pick<MundoVentas, "T" | "u" | "c">,
  trabajoId: string,
  parametros: unknown,
): ContextoProcesador {
  return {
    trabajo: {
      id: trabajoId,
      tenantId: m.T,
      clienteId: m.c.id,
      ruc: m.c.ruc,
      tipo: TIPO_ARCHIVO,
      parametros,
      intentos: 0,
      creadoPor: m.u,
    },
    conToken: () => {
      throw new Error("archivo.generar no usa credenciales ni token");
    },
  };
}

/**
 * Versión ya guardada (sembrada saltando los triggers, solo para sembrar: los CHECK siguen aplicando). Sirve para forzar
 * un 23505 por `trabajo_id` repetido o para probar con versiones previas. Devuelve su id.
 */
export async function sembrarVersion(
  admin: ContappDb,
  m: Pick<MundoVentas, "T" | "u" | "c">,
  libro: Libro,
  trabajoId: string,
  o: { periodo?: string; version?: number } = {},
): Promise<string> {
  const id = randomUUID();
  const periodo = o.periodo ?? PERIODO;
  const base = `CONTAPP-PROVISIONAL-${m.c.ruc}-${periodo}-${libro === "compras" ? "RCE" : "RVIE"}`;
  const cx = await admin.pool.connect();
  try {
    await cx.query("BEGIN");
    await cx.query("SET LOCAL session_replication_role = replica");
    await cx.query(
      `insert into archivo_generado (id, tenant_id, cliente_id, periodo, libro, version, formato_id, formato_version,
         provisional, nombre_txt, nombre_zip, sha256_txt, sha256_zip, bytes_zip, lineas, huella, modificadas, excluidas,
         agregadas, impacto_igv_dg, impacto_igv_dgng, impacto_igv_dng, impacto_igv_total, avisos, ruta, trabajo_id,
         generado_por)
       values ($1, $2, $3, $4, $5, $6, 'SEMBRADO', '0', true, $7, $8, decode(repeat('aa', 32), 'hex'),
         decode(repeat('bb', 32), 'hex'), 100, 1, repeat('c', 64), 0, 0, 0, $9, $9, $9, '0.00', '{}'::jsonb, $10, $11, $12)`,
      [
        id,
        m.T,
        m.c.id,
        periodo,
        libro,
        o.version ?? 1,
        `${base}.txt`,
        `${base}.zip`,
        libro === "compras" ? "0.00" : null,
        `archivos/${m.T}/${m.c.id}/${id}.zip`,
        trabajoId,
        m.u,
      ],
    );
    await cx.query("COMMIT");
  } catch (e) {
    await cx.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    cx.release();
  }
  return id;
}

// ---------------------------------------------------------------------------------------------------------------
// Lecturas (rol administrativo) y del ZIP
// ---------------------------------------------------------------------------------------------------------------

export interface VersionBd {
  id: string;
  libro: string;
  periodo: string;
  version: number;
  formato_id: string;
  provisional: boolean;
  nombre_txt: string;
  nombre_zip: string;
  sha_txt: string;
  sha_zip: string;
  bytes_zip: number;
  lineas: number;
  huella: string;
  modificadas: number;
  excluidas: number;
  agregadas: number;
  impacto_dg: string | null;
  impacto_dgng: string | null;
  impacto_dng: string | null;
  impacto_total: string;
  avisos: Record<string, number>;
  ruta: string;
  trabajo_id: string;
  generado_por: string;
}

/** Versiones guardadas del cliente (todas si no se da libro o periodo), de la menor a la mayor. */
export async function versionesDe(
  admin: ContappDb,
  clienteId: string,
  o: { libro?: Libro; periodo?: string } = {},
): Promise<VersionBd[]> {
  const r = await admin.pool.query(
    `select id, libro, periodo, version::int as version, formato_id, provisional, nombre_txt, nombre_zip,
            encode(sha256_txt, 'hex') as sha_txt, encode(sha256_zip, 'hex') as sha_zip, bytes_zip::int as bytes_zip,
            lineas::int as lineas, huella, modificadas::int as modificadas, excluidas::int as excluidas,
            agregadas::int as agregadas, impacto_igv_dg::text as impacto_dg, impacto_igv_dgng::text as impacto_dgng,
            impacto_igv_dng::text as impacto_dng, impacto_igv_total::text as impacto_total, avisos, ruta, trabajo_id,
            generado_por
       from archivo_generado
      where cliente_id = $1 and ($2::text is null or libro = $2) and ($3::text is null or periodo = $3)
      order by periodo, libro, version`,
    [clienteId, o.libro ?? null, o.periodo ?? null],
  );
  return r.rows as VersionBd[];
}

/** Todas las versiones guardadas en los estudios dados (para buscar canarios o contar). */
export async function contarVersiones(admin: ContappDb, estudios: string[]): Promise<number> {
  const r = await admin.pool.query(
    "select count(*)::int as n from archivo_generado where tenant_id = any($1::uuid[])",
    [estudios],
  );
  return r.rows[0].n as number;
}

/** Texto de las tablas nuevas de los estudios dados (para buscar canarios). */
export async function volcarTablasArchivos(admin: ContappDb, estudios: string[]): Promise<string> {
  const r = await admin.pool.query(
    `select (to_jsonb(t) - 'ruta')::text as t from archivo_generado t where tenant_id = any($1::uuid[])
     union all select to_jsonb(t)::text from venta_periodo t where tenant_id = any($1::uuid[])`,
    [estudios],
  );
  return (r.rows as Array<{ t: string }>).map((f) => f.t).join("\n");
}

/** Lecturas de credenciales descifradas que registró el sistema para los estudios dados (el trabajo no debe dejar ninguna). */
export async function descifradosDe(admin: ContappDb, estudios: string[]): Promise<number> {
  const r = await admin.pool.query(
    "select count(*)::int as n from auditoria_descifrado where tenant_id = any($1::uuid[])",
    [estudios],
  );
  return r.rows[0].n as number;
}

/** El único archivo de un ZIP: su nombre y su contenido (descomprimido). Lee el directorio central. */
export function leerZipUnico(zip: Uint8Array): { nombre: string; contenido: Buffer } {
  const b = Buffer.from(zip);
  const fin = b.length - 22;
  if (fin < 0 || b.readUInt32LE(fin) !== 0x06054b50) throw new Error("ZIP sin registro de fin");
  if (b.readUInt16LE(fin + 10) !== 1) throw new Error("el ZIP debe tener una sola entrada");
  const central = b.readUInt32LE(fin + 16);
  if (b.readUInt32LE(central) !== 0x02014b50) throw new Error("ZIP sin directorio central");
  const metodo = b.readUInt16LE(central + 10);
  const comprimido = b.readUInt32LE(central + 20);
  const largoNombre = b.readUInt16LE(central + 28);
  const local = b.readUInt32LE(central + 42);
  const nombre = b.subarray(central + 46, central + 46 + largoNombre).toString("latin1");
  const inicio = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
  const datos = b.subarray(inicio, inicio + comprimido);
  return { nombre, contenido: metodo === 8 ? inflateRawSync(datos) : Buffer.from(datos) };
}

/** Líneas no vacías de un TXT en latin1 (el provisional termina cada línea con CRLF). */
export function lineasDeTxt(txt: Buffer): string[] {
  return txt
    .toString("latin1")
    .split("\r\n")
    .filter((l) => l !== "");
}

/** Cadena única para usar de motivo de exclusión: aparece en BD, nunca en el TXT, `resultado`, logs ni errores. */
export const motivoCanario = (): string => `MOTIVO-CANARIO-${randomBytes(6).toString("hex")}`;

// ---------------------------------------------------------------------------------------------------------------
// Limpieza
// ---------------------------------------------------------------------------------------------------------------

/**
 * Borra lo que dejan las pruebas en las tablas nuevas de 012b y luego en las de ventas (`venta_exclusion`, `venta_periodo`
 * y `archivo_generado` también las borra `limpiarVentas`). Con `session_replication_role = replica`: salta el trigger de
 * inmutabilidad. Llamar antes de `limpiarCompras` y de `e.limpiar()`.
 */
export async function limpiarArchivos(admin: ContappDb, estudios: string[]): Promise<void> {
  const c = await admin.pool.connect();
  try {
    await c.query("SET session_replication_role = replica");
    for (const sql of [
      "delete from archivo_generado where tenant_id = any($1::uuid[])",
      "delete from venta_exclusion where tenant_id = any($1::uuid[])",
      "delete from venta_periodo where tenant_id = any($1::uuid[])",
    ])
      await c.query(sql, [estudios]).catch(() => undefined);
  } finally {
    c.release(true); // se destruye: no vuelve al pool con session_replication_role = replica
  }
  await limpiarVentas(admin, estudios);
}
