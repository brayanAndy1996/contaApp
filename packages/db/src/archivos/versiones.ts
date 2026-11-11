// Versiones del archivo de reemplazo (spec 012b, D3, D6). `archivo_generado` es inmutable (0040): el worker inserta la versión
// máx + 1 con el periodo de ese libro ya `generado` por quien genera (lo exige el trigger) y nadie la cambia ni la borra. SQL estático
// y parametrizado dentro de withTenant. Los hashes viajan como hex (bytea en la tabla) y los impactos como cadenas decimales.
import { consultar, type Fila, type TxConsulta } from "./errores";

export type LibroArchivo = "compras" | "ventas";

/** Una versión generada. Montos como cadenas (NUMERIC(14,2)); los impactos por destino son `null` en ventas. */
export interface VersionArchivo {
  id: string;
  clienteId: string;
  periodo: string;
  libro: LibroArchivo;
  version: number;
  formatoId: string;
  formatoVersion: string;
  provisional: boolean;
  nombreTxt: string;
  nombreZip: string;
  /** sha256 del TXT en hex (64). */
  sha256Txt: string;
  /** sha256 del ZIP en hex (64). */
  sha256Zip: string;
  bytesZip: number;
  lineas: number;
  huella: string;
  modificadas: number;
  excluidas: number;
  agregadas: number;
  impactoIgvDg: string | null;
  impactoIgvDgng: string | null;
  impactoIgvDng: string | null;
  impactoIgvTotal: string;
  /** Conteos por código de aviso. */
  avisos: Record<string, number>;
  /** Ruta del ZIP en el storage (`archivos/{tenant}/{cliente}/{id}.zip`). Nunca sale por HTTP. */
  ruta: string;
  trabajoId: string;
  generadoPor: string;
  generadoEn: Date;
}

/** Lo que inserta el worker: la versión y el id los da quien llama (el id es también el nombre del ZIP en el storage). */
export type NuevaVersionArchivo = Omit<VersionArchivo, "generadoEn">;

export const COLUMNAS_VERSION = `id, cliente_id, periodo, libro, version, formato_id, formato_version, provisional, nombre_txt,
  nombre_zip, encode(sha256_txt, 'hex') as sha256_txt, encode(sha256_zip, 'hex') as sha256_zip, bytes_zip, lineas, huella,
  modificadas, excluidas, agregadas, impacto_igv_dg::text as impacto_igv_dg, impacto_igv_dgng::text as impacto_igv_dgng,
  impacto_igv_dng::text as impacto_igv_dng, impacto_igv_total::text as impacto_igv_total, avisos, ruta, trabajo_id, generado_por,
  generado_en`;

export const aVersion = (f: Fila): VersionArchivo => ({
  id: f.id,
  clienteId: f.cliente_id,
  periodo: f.periodo,
  libro: f.libro,
  version: f.version,
  formatoId: f.formato_id,
  formatoVersion: f.formato_version,
  provisional: f.provisional,
  nombreTxt: f.nombre_txt,
  nombreZip: f.nombre_zip,
  sha256Txt: f.sha256_txt,
  sha256Zip: f.sha256_zip,
  bytesZip: f.bytes_zip,
  lineas: f.lineas,
  huella: f.huella,
  modificadas: f.modificadas,
  excluidas: f.excluidas,
  agregadas: f.agregadas,
  impactoIgvDg: f.impacto_igv_dg,
  impactoIgvDgng: f.impacto_igv_dgng,
  impactoIgvDng: f.impacto_igv_dng,
  impactoIgvTotal: f.impacto_igv_total,
  avisos: f.avisos,
  ruta: f.ruta,
  trabajoId: f.trabajo_id,
  generadoPor: f.generado_por,
  generadoEn: f.generado_en,
});

const SQL_ULTIMA = `select ${COLUMNAS_VERSION} from archivo_generado
  where cliente_id = $1 and periodo = $2 and libro = $3 order by version desc limit 1`;

const SQL_INSERTAR = `insert into archivo_generado (id, cliente_id, periodo, libro, version, formato_id, formato_version,
    provisional, nombre_txt, nombre_zip, sha256_txt, sha256_zip, bytes_zip, lineas, huella, modificadas, excluidas, agregadas,
    impacto_igv_dg, impacto_igv_dgng, impacto_igv_dng, impacto_igv_total, avisos, ruta, trabajo_id, generado_por)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, decode($11, 'hex'), decode($12, 'hex'), $13, $14, $15, $16, $17, $18,
          $19, $20, $21, $22, $23::jsonb, $24, $25, $26)
  returning ${COLUMNAS_VERSION}`;

/** La mayor versión de (cliente, periodo, libro) o `null` si aún no hay ninguna. */
export async function ultimaVersion(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  libro: LibroArchivo,
): Promise<VersionArchivo | null> {
  const r = await consultar(tx, SQL_ULTIMA, [clienteId, periodo, libro]);
  return r.rows[0] ? aVersion(r.rows[0]) : null;
}

/**
 * Inserta una versión (rol del worker). El trigger de 0040 exige el periodo de ese libro `generado` por `generadoPor` y
 * `version = máx + 1` (23514); el mismo trabajo dos veces da 23505. Todo error sale como ArchivosRepoError con su SQLSTATE.
 * Protocolo (plan «Orden de bloqueo»): advisory del libro -> `fijarEstadoPeriodo{,Ventas}` -> filas -> `ultimaVersion` -> esta.
 */
export async function insertarVersion(
  tx: TxConsulta,
  v: NuevaVersionArchivo,
): Promise<VersionArchivo> {
  const r = await consultar(tx, SQL_INSERTAR, [
    v.id,
    v.clienteId,
    v.periodo,
    v.libro,
    v.version,
    v.formatoId,
    v.formatoVersion,
    v.provisional,
    v.nombreTxt,
    v.nombreZip,
    v.sha256Txt,
    v.sha256Zip,
    v.bytesZip,
    v.lineas,
    v.huella,
    v.modificadas,
    v.excluidas,
    v.agregadas,
    v.impactoIgvDg,
    v.impactoIgvDgng,
    v.impactoIgvDng,
    v.impactoIgvTotal,
    JSON.stringify(v.avisos),
    v.ruta,
    v.trabajoId,
    v.generadoPor,
  ]);
  return aVersion(r.rows[0]!);
}
