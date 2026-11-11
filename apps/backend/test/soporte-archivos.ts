/* eslint-disable @typescript-eslint/no-explicit-any -- filas de BD y cuerpos JSON dinámicos en pruebas */
// Soporte de las pruebas HTTP de la spec 012b (T6): generar el archivo SIRE, versiones, descarga, estado de ventas y
// excluir/restaurar ventas. Encima de `soporte-ventas.ts`/`soporte-compras.ts`. No es una prueba ni código de producción.
//
// CONTRATO DE BD QUE ASUME LA SIEMBRA (plan 012b, «BD»; el mismo de `tests/aislamiento/archivos-soporte.ts`, T4):
//  - `venta_periodo(tenant_id, cliente_id, periodo, estado, marcado_por, marcado_en)` = `compra_periodo`.
//  - `venta_exclusion(id, tenant_id, cliente_id, periodo, venta_id, motivo, excluida_por, excluida_en, restaurada_por,
//    restaurada_en)`; el trigger de inserción exige una venta `sire` del mismo cliente y periodo.
//  - `archivo_generado(id, tenant_id, cliente_id, periodo, libro, version, formato_id, formato_version, provisional,
//    nombre_txt, nombre_zip, sha256_txt, sha256_zip, bytes_zip, lineas, huella, modificadas, excluidas, agregadas,
//    impacto_igv_dg, impacto_igv_dgng, impacto_igv_dng, impacto_igv_total, avisos, ruta, trabajo_id, generado_por,
//    generado_en)`. Es inmutable por trigger: se siembra con `session_replication_role = replica` (los CHECK siguen
//    aplicando) y la limpieza de `cerrar()` de los soportes hace lo mismo.
//  - Storage: `STORAGE=local` y `STORAGE_DIR=<carpeta>` (`prepararStorage`); el ZIP de una versión queda en
//    `{STORAGE_DIR}/archivos/{tenant}/{cliente}/{id}.zip` y la prueba lo altera con `node:fs`.
//  - Trabajo: `job_registro` con `tipo = 'archivo.generar'`, `cola = 'archivos'`, `canal = 'ninguno'`.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createDb } from "@contapp/db";
import * as shared from "@contapp/shared";
import { fila, PERIODO, type BancoVentas, type FilaV } from "./soporte-ventas.js";
import type { StoragePrueba } from "./soporte-xml.js";

export { archivosBajo, prepararStorage, trabajosDeTipo, type StoragePrueba } from "./soporte-xml.js";

export type Libro = "compras" | "ventas";
export type EstadoPeriodoBd = "abierto" | "revisado" | "generado";

/** Ruta base de las rutas de archivos de un libro. */
export const rutaArchivos = (clienteId: string, periodo: string, libro: Libro): string =>
  `/clientes/${clienteId}/periodos/${periodo}/${libro}/archivos`;
/** Ruta base de ventas (estado, excluir y restaurar). */
export const rutaVentas = (clienteId: string, periodo = PERIODO): string =>
  `/clientes/${clienteId}/periodos/${periodo}/ventas`;

export const HEX64 = /^[0-9a-f]{64}$/;
export const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

// --- Esquemas de `@contapp/shared` (se leen por nombre: si falta uno, la prueba falla con este mensaje) -----------------
type Esquema = { safeParse(v: unknown): { success: boolean; error?: unknown } };
function esquema(nombre: string): Esquema {
  const e = (shared as unknown as Record<string, Esquema | undefined>)[nombre];
  if (!e) throw new Error(`@contapp/shared aún no exporta ${nombre} (T8)`);
  return e;
}
/** `true` si `valor` cumple el esquema de `shared` con ese nombre. */
export const cumple = (nombre: string, valor: unknown): boolean => esquema(nombre).safeParse(valor).success;

// --- Filas de ventas de prueba -------------------------------------------------------------------------------------------

/** Boleta B001-290 con total 119.00 (Σ = 118.00): descuadrada por 1.00. Llega así del SIRE (013 D3). */
export const descuadrada = (serie = "D001", numero: string | number = 1): FilaV =>
  fila(serie, numero, { total: "119.00" });
/** Factura en USD del SIRE sin tipo de cambio (`USD_SIN_TC`). */
export const usdSinTc = (serie = "U001", numero: string | number = 1): FilaV =>
  fila(serie, numero, { tipo: "01", tipoDocContraparte: "6", docContraparte: "20700000011", moneda: "USD" });

// --- Soporte con conexión de migraciones -------------------------------------------------------------------------------

export interface OpcionesVersion {
  tenantId: string;
  clienteId: string;
  /** Miembro que figura como `generado_por`. */
  usuarioId: string;
  libro: Libro;
  periodo?: string;
  /** Por omisión, el máximo + 1. */
  version?: number;
  /** Bytes del ZIP; por omisión 300 bytes aleatorios tras la firma `PK`. */
  zip?: Uint8Array;
  /** `false`: no deja el archivo en storage. */
  enStorage?: boolean;
  lineas?: number;
  modificadas?: number;
  excluidas?: number;
  agregadas?: number;
  /** Impacto en IGV; en ventas DG/DGNG/DNG van en null. */
  impactoTotal?: string;
  avisos?: Record<string, number>;
  provisional?: boolean;
  huella?: string;
}

export interface VersionSembrada {
  id: string;
  version: number;
  ruta: string;
  nombreTxt: string;
  nombreZip: string;
  zip: Buffer;
  sha256Zip: string;
  sha256Txt: string;
  huella: string;
  trabajoId: string;
  lineas: number;
  modificadas: number;
  excluidas: number;
  agregadas: number;
  impactoTotal: string;
  avisos: Record<string, number>;
  generadoPor: string;
}

export interface ExclusionBd {
  id: string;
  venta_id: string;
  motivo: string;
  excluida_por: string;
  restaurada_por: string | null;
  restaurada: boolean;
}

export interface SoporteArchivos {
  sql<T = any>(texto: string, valores?: unknown[]): Promise<T[]>;
  /** Estado del periodo de ventas sembrado por SQL (como `estadoPeriodo` de compras). */
  estadoVentas(tenantId: string, clienteId: string, periodo: string, estado: EstadoPeriodoBd, marcadoPor?: string | null): Promise<void>;
  /** `null` si el periodo aún no tiene fila (equivale a `abierto`). */
  periodoVentas(clienteId: string, periodo?: string): Promise<{ estado: EstadoPeriodoBd; marcado_por: string | null } | null>;
  /** Versión de archivo sembrada (y su ZIP en storage). */
  sembrarVersion(o: OpcionesVersion, st: StoragePrueba | null): Promise<VersionSembrada>;
  /** Filas de `archivo_generado` del cliente (todas las versiones, todos los libros). */
  versionesBd(clienteId: string, libro?: Libro): Promise<any[]>;
  /** Exclusión de ventas sembrada por SQL (pasa por el trigger de inserción). */
  sembrarExclusion(
    tenantId: string,
    clienteId: string,
    ventaId: string,
    o: { usuarioId: string; motivo?: string; periodo?: string },
  ): Promise<string>;
  exclusiones(clienteId: string, periodo?: string): Promise<ExclusionBd[]>;
  /** `n` ventas `sire` S/ 118.00 con total 119.00 (descuadradas), en una sola sentencia; devuelve el id de la propuesta. */
  sembrarDescuadradas(tenantId: string, clienteId: string, n: number, o: { usuarioId: string; periodo?: string }): Promise<string>;
  /** Todo lo que una escritura de ventas rechazada no debe cambiar. */
  fotoVentas(v: BancoVentas, clienteId: string, periodo?: string): Promise<unknown>;
  /** Número de trabajos `archivo.generar` del cliente. */
  trabajosArchivo(clienteId: string): Promise<any[]>;
  cerrar(): Promise<void>;
}

const URL_ADMIN = (): string => {
  const url = process.env.MIGRATIONS_DATABASE_URL;
  if (!url) throw new Error("falta MIGRATIONS_DATABASE_URL para las pruebas de archivos");
  return url;
};

export async function abrirArchivos(v: BancoVentas): Promise<SoporteArchivos> {
  const sql = v.b.sql;
  const admin = createDb({ rolApp: "contapp_backend", url: URL_ADMIN(), poolMax: 2 });

  const versionesBd: SoporteArchivos["versionesBd"] = (clienteId, libro) =>
    sql(
      `select id, version::int as version, periodo, libro, nombre_zip, encode(sha256_zip, 'hex') as sha256_zip, bytes_zip::int as bytes_zip,
              lineas::int as lineas, huella, trabajo_id, generado_por, ruta
         from archivo_generado where cliente_id = $1 and ($2::text is null or libro = $2) order by libro, periodo, version`,
      [clienteId, libro ?? null],
    );

  const exclusiones: SoporteArchivos["exclusiones"] = (clienteId, periodo = PERIODO) =>
    sql(
      `select id, venta_id, motivo, excluida_por, restaurada_por, restaurada_en is not null as restaurada
         from venta_exclusion where cliente_id = $1 and periodo = $2 order by excluida_en, id`,
      [clienteId, periodo],
    );

  const periodoVentas: SoporteArchivos["periodoVentas"] = async (clienteId, periodo = PERIODO) => {
    const r = await sql(
      "select estado, marcado_por from venta_periodo where cliente_id = $1 and periodo = $2",
      [clienteId, periodo],
    );
    return r[0] ?? null;
  };

  const trabajosArchivo: SoporteArchivos["trabajosArchivo"] = (clienteId) =>
    sql("select * from job_registro where cliente_id = $1 and tipo = 'archivo.generar' order by creado_en, id", [clienteId]);

  const sembrarVersion: SoporteArchivos["sembrarVersion"] = async (o, st) => {
    const periodo = o.periodo ?? PERIODO;
    const id = randomUUID();
    const ruta = `archivos/${o.tenantId}/${o.clienteId}/${id}.zip`;
    const siguiente =
      o.version ??
      Number(
        (
          await sql(
            "select coalesce(max(version), 0)::int + 1 as n from archivo_generado where cliente_id = $1 and periodo = $2 and libro = $3",
            [o.clienteId, periodo, o.libro],
          )
        )[0].n,
      );
    const ruc = (await sql("select ruc from cliente where id = $1", [o.clienteId]))[0].ruc as string;
    const sufijo = o.libro === "compras" ? "RCE" : "RVIE";
    const base = `CONTAPP-PROVISIONAL-${ruc}-${periodo}-${sufijo}`;
    const zip = Buffer.from(o.zip ?? Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(300)]));
    const txt = randomBytes(64);
    const huella = o.huella ?? sha256(randomBytes(16));
    const lineas = o.lineas ?? 3;
    const modificadas = o.modificadas ?? (o.libro === "compras" ? 2 : 0);
    const excluidas = o.excluidas ?? 0;
    const agregadas = o.agregadas ?? 0;
    const impactoTotal = o.impactoTotal ?? "10.00";
    const avisos = o.avisos ?? { "R-ISC": 1 };
    const compras = o.libro === "compras";

    // El trabajo que generó la versión (la FK `trabajo_id` apunta a un trabajo real).
    const t = await sql(
      `insert into job_registro (tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe,
                                 creado_por, max_intentos, iniciado_en, terminado_en)
       values ($1, $2, $3, 'archivo.generar', 'archivos', 'ninguno', 'interactivo', 'completado', $4::jsonb,
               sha256(convert_to(gen_random_uuid()::text, 'UTF8')), $5, 3, now(), now()) returning id`,
      [o.tenantId, o.clienteId, ruc, JSON.stringify({ periodo, libro: o.libro, estadoVisto: "abierto", huella }), o.usuarioId],
    );
    const trabajoId = t[0].id as string;

    const c = await admin.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(
        `insert into archivo_generado (id, tenant_id, cliente_id, periodo, libro, version, formato_id, formato_version, provisional,
           nombre_txt, nombre_zip, sha256_txt, sha256_zip, bytes_zip, lineas, huella, modificadas, excluidas, agregadas,
           impacto_igv_dg, impacto_igv_dgng, impacto_igv_dng, impacto_igv_total, avisos, ruta, trabajo_id, generado_por)
         values ($1, $2, $3, $4, $5, $6, $7, '0-provisional', $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                 $19, $20, $21, $22, $23::jsonb, $24, $25, $26)`,
        [
          id,
          o.tenantId,
          o.clienteId,
          periodo,
          o.libro,
          siguiente,
          compras ? "RCE-REEMPLAZO" : "RVIE-REEMPLAZO",
          o.provisional ?? true,
          `${base}.txt`,
          `${base}.zip`,
          createHash("sha256").update(txt).digest(),
          createHash("sha256").update(zip).digest(),
          zip.length,
          lineas,
          huella,
          modificadas,
          excluidas,
          agregadas,
          compras ? impactoTotal : null,
          compras ? "0.00" : null,
          compras ? "0.00" : null,
          impactoTotal,
          JSON.stringify(avisos),
          ruta,
          trabajoId,
          o.usuarioId,
        ],
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release(true); // se destruye: no vuelve al pool con session_replication_role = replica
    }

    if (st !== null && o.enStorage !== false) {
      const destino = join(st.dir, ruta);
      mkdirSync(dirname(destino), { recursive: true });
      writeFileSync(destino, zip);
    }
    return {
      id,
      version: siguiente,
      ruta,
      nombreTxt: `${base}.txt`,
      nombreZip: `${base}.zip`,
      zip,
      sha256Zip: sha256(zip),
      sha256Txt: sha256(txt),
      huella,
      trabajoId,
      lineas,
      modificadas,
      excluidas,
      agregadas,
      impactoTotal,
      avisos,
      generadoPor: o.usuarioId,
    };
  };

  return {
    sql,
    estadoVentas: async (tenantId, clienteId, periodo, estado, marcadoPor = null) => {
      await sql(
        `insert into venta_periodo (tenant_id, cliente_id, periodo, estado, marcado_por, marcado_en)
         values ($1, $2, $3, $4, $5, case when $5::uuid is null then null else now() end)
         on conflict (tenant_id, cliente_id, periodo) do update set estado = excluded.estado,
           marcado_por = excluded.marcado_por, marcado_en = excluded.marcado_en`,
        [tenantId, clienteId, periodo, estado, marcadoPor],
      );
    },
    periodoVentas,
    sembrarVersion,
    versionesBd,
    sembrarExclusion: async (tenantId, clienteId, ventaId, o) => {
      const r = await sql(
        `insert into venta_exclusion (tenant_id, cliente_id, periodo, venta_id, motivo, excluida_por)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [tenantId, clienteId, o.periodo ?? PERIODO, ventaId, o.motivo ?? "Descuadrada en el SIRE", o.usuarioId],
      );
      return r[0].id as string;
    },
    exclusiones,
    sembrarDescuadradas: async (tenantId, clienteId, n, o) => {
      const periodo = o.periodo ?? PERIODO;
      const propuestaId = await v.sembrarPropuesta(tenantId, clienteId, { periodo, nuevas: n, usuarioId: o.usuarioId });
      await sql(
        `insert into venta (
              tenant_id, cliente_id, periodo, propuesta_id, origen, clave, tipo, serie, numero, numero_n, fecha,
              tipo_doc_contraparte, doc_contraparte, moneda, tipo_cambio, base_gravada, igv, exonerada, inafecta, isc, icbper,
              otros, total, creada_por)
         select $1, $2, $3, $4, 'sire', '03|D001|' || g, '03', 'D001', g::text, g, '2026-10-05', '0', '-',
                'PEN', null, 100, 18, 0, 0, 0, 0, 0, 119, null
           from generate_series(1, $5::int) g`,
        [tenantId, clienteId, periodo, propuestaId, n],
      );
      return propuestaId;
    },
    fotoVentas: async (vb, clienteId, periodo = PERIODO) => ({
      ventas: await vb.ventas(clienteId, periodo),
      saltos: await vb.saltos(clienteId, periodo),
      exclusiones: await exclusiones(clienteId, periodo),
      periodo: await periodoVentas(clienteId, periodo),
      propuestas: (await vb.propuestas(clienteId, periodo)).map((p: any) => p.id),
      trabajos: (await vb.b.sql("select id from job_registro where cliente_id = $1 order by id", [clienteId])).map((t: any) => t.id),
    }),
    trabajosArchivo,
    cerrar: async () => {
      await admin.close();
    },
  };
}
