// Soporte de las pruebas de BD de la spec 012b (T4, rojo). No es una prueba (no termina en .spec.ts).
//
// CONTRATO DE BD QUE FIJAN LAS PRUEBAS DE T4 (T10 lo implementa en 0039/0040 y en `packages/db/src/{ventas,archivos}/`).
// Plan «Contratos: BD y orden de bloqueo». Todo con RLS ENABLE + FORCE, politica `tenant_isolation` FOR ALL sobre
// `app.tenant_id`, dueno `contapp_migrator`, columna `tenant_id` con el DEFAULT de contexto de las demas tablas.
//
// TABLAS
//   venta_periodo(tenant_id, cliente_id, periodo char(6), estado text, marcado_por uuid null, marcado_en timestamptz null)
//     = compra_periodo: PK (tenant_id, cliente_id, periodo); CHECK de periodo AAAAMM y estado IN (abierto, revisado, generado);
//     FK (tenant_id, cliente_id) -> cliente y (tenant_id, marcado_por) -> membresia.
//   venta_exclusion(id uuid, tenant_id, cliente_id, periodo char(6), venta_id uuid, motivo text, excluida_por uuid,
//     excluida_en timestamptz, restaurada_por uuid null, restaurada_en timestamptz null)
//     FK (tenant_id, cliente_id) -> cliente, (tenant_id, venta_id) -> venta(tenant_id, id), (tenant_id, excluida_por) y
//     (tenant_id, restaurada_por) -> membresia. CHECK: motivo de 1 a 200 caracteres; restaurada_por y restaurada_en las dos
//     nulas o las dos no nulas. Unico PARCIAL (tenant_id, venta_id) WHERE restaurada_en IS NULL (una sola vigente por venta).
//   archivo_generado(id, tenant_id, cliente_id, periodo, libro, version, formato_id text, formato_version text, provisional,
//     nombre_txt, nombre_zip, sha256_txt bytea, sha256_zip bytea, bytes_zip, lineas, huella text, modificadas, excluidas,
//     agregadas, impacto_igv_dg/dgng/dng NUMERIC(14,2) NULL, impacto_igv_total NUMERIC(14,2), avisos jsonb, ruta, trabajo_id,
//     generado_por, generado_en). Unicas (tenant_id, cliente_id, periodo, libro, version) y (tenant_id, trabajo_id).
//     CHECK (todos 23514): libro IN (compras, ventas); periodo AAAAMM; version >= 1; sha256_* de 32 bytes; huella hex de 64;
//     nombre_txt acaba en .txt y nombre_zip en .zip, sin `/`, `\`, `..`, espacios ni controles (gramatica de generarTxt);
//     ruta = 'archivos/' || tenant_id || '/' || cliente_id || '/' || id || '.zip'; impactos por destino NULOS si y solo si
//     libro = ventas; avisos = objeto JSON (no arreglo ni escalar) de a lo sumo 2 KB.
//
// GRANTS EXACTOS (nadie mas que contapp_migrator, dueno, tiene algo; ni PUBLIC, contapp_app, contapp_platform ni contapp_auth)
//   venta_periodo     backend y worker: SELECT, INSERT y UPDATE (estado, marcado_por, marcado_en). Sin DELETE ni TRUNCATE.
//   venta_exclusion   backend: SELECT, INSERT y UPDATE (restaurada_por, restaurada_en). worker: SELECT.
//   archivo_generado  backend: SELECT. worker: SELECT, INSERT. Nadie actualiza ni borra.
//   venta_salto_justificado  el worker gana SELECT (solo lectura); el backend queda como estaba.
//
// TRIGGERS (funciones de dueno contapp_migrator, `SET search_path = pg_catalog, pg_temp`, mensajes fijos sin datos)
//   periodo_worker_acotado BEFORE INSERT OR UPDATE FOR EACH ROW en compra_periodo y en venta_periodo: si current_user es
//     contapp_worker solo inserta `abierto` sin marca y solo actualiza de abierto|revisado a generado con marcado_por no nulo;
//     otro caso -> 42501. El backend no cambia.
//   archivo_generado BEFORE UPDATE OR DELETE -> 42501 para todos (tambien superusuario y contapp_migrator); se salta solo con
//     session_replication_role = replica (la limpieza de las pruebas). BEFORE INSERT -> 23514 si el periodo de ESE libro no esta
//     `generado` por el mismo usuario que `generado_por` o si version <> max(version) + 1 de (tenant, cliente, periodo, libro).
//   venta_exclusion BEFORE UPDATE OR DELETE -> 42501 salvo cerrar una vigente una vez tocando solo restaurada_por y
//     restaurada_en. BEFORE INSERT -> 23514 si la venta no existe, no es de origen `sire` o no es del mismo cliente y periodo.
//
// FUNCIONES (exportadas por @contapp/db; la `tx` de withTenant es siempre el primer argumento; montos como cadenas)
//   ventas/periodo.ts
//     leerEstadoPeriodoVentas(tx, clienteId, periodo, opciones?: { compartido?: boolean }): Promise<EstadoPeriodo>
//     fijarEstadoPeriodoVentas(tx, clienteId, periodo, desde, hacia, usuarioId): Promise<EstadoPeriodo | null>
//       mismo contrato que leerEstadoPeriodo / fijarEstadoPeriodo de compras (014).
//   ventas/exclusion.ts
//     excluirVenta(tx, { clienteId, periodo, ventaId, motivo, usuarioId }): Promise<ExclusionVenta | null>
//       null si la venta ya tenia una exclusion vigente (ON CONFLICT DO NOTHING: nunca lanza por eso, tampoco con dos a la vez).
//       Una venta que el trigger rechaza (inexistente, manual, de otro cliente o periodo) lanza VentasRepoError (SQLSTATE).
//     restaurarVenta(tx, ventaId, usuarioId): Promise<boolean>   true si cerro una vigente; false si no habia.
//     exclusionVigente(tx, ventaId): Promise<ExclusionVenta | null>
//       ExclusionVenta = { id, ventaId, motivo, excluidaPor, excluidaEn: Date, restauradaPor: null, restauradaEn: null }.
//   ventas/lectura.ts: listarVentas y leerFilasVentas suman a cada VentaFila `exclusion: { motivo, por, en: Date } | null`
//     (la vigente; null si nunca se excluyo o se restauro).
//   ventas/filas-reemplazo.ts
//     leerFilasReemplazoVentas<T>(tx, clienteId, periodo, aFila: (v: VentaFila) => T): Promise<{ original: T[]; vigente: T[] }>
//       original = ventas de origen `sire` (todas, tambien las excluidas) con `exclusion: null`; vigente = todas las ventas
//       (sire y manual) con `exclusion` = la vigente o null. Orden por clave y luego id.
//     leerExcluidasVentas(tx, clienteId, periodo): Promise<{ ventaId, tipo, serie, numero, motivo }[]>
//       solo las vigentes, en el orden de la grilla (tipo, serie, numero numerico, numero, id).
//   archivos/ (errores.ts: ArchivosRepoError { codigo } conserva solo el SQLSTATE, como VentasRepoError)
//     VersionArchivo = { id, clienteId, periodo, libro, version, formatoId, formatoVersion, provisional, nombreTxt, nombreZip,
//       sha256Txt: string (64 hex), sha256Zip: string (64 hex), bytesZip: number, lineas, huella, modificadas, excluidas,
//       agregadas, impactoIgvDg: string | null, impactoIgvDgng, impactoIgvDng, impactoIgvTotal: string,
//       avisos: Record<string, number>, ruta, trabajoId, generadoPor, generadoEn: Date }
//     ultimaVersion(tx, clienteId, periodo, libro): Promise<VersionArchivo | null>
//     insertarVersion(tx, v: Omit<VersionArchivo, 'generadoEn'>): Promise<VersionArchivo>   (la version y el id los da quien llama)
//     listarVersiones(tx, clienteId, periodo, libro): Promise<VersionArchivo[]>              mayor version primero
//     leerVersion(tx, archivoId, { clienteId, periodo, libro }): Promise<VersionArchivo | null>
//       otro estudio, cliente, periodo o libro = null.
//   Orden de bloqueo: advisory `propuesta:{libro}:{periodo}:{cliente}` (bloquearPeriodoLibro) -> {libro}_periodo (FOR SHARE
//   las escrituras, FOR UPDATE generar) -> filas -> archivo_generado. Las acciones de compras no toman el advisory.
//
// Siembra con el superusuario (pasa por los triggers y las FK) y limpieza con `session_replication_role = replica`.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { EscenarioCompras } from "./compras-soporte";
import type { ContappDb, Tx } from "./soporte";
import type { ClientePrueba } from "./trabajos-soporte";
import { exportado } from "./auth-soporte";

export { PERIODO } from "./ventas-soporte";

export type Libro = "compras" | "ventas";
export type EstadoPeriodoDb = "abierto" | "revisado" | "generado";

export const HEX = (c: string): string => c.repeat(64).slice(0, 64);
export const BYTES = (c: string): Buffer => Buffer.from(HEX(c), "hex");

export interface DatosArchivo {
  id: string;
  tenantId: string;
  clienteId: string;
  periodo: string;
  libro: Libro;
  version: number;
  formatoId: string;
  formatoVersion: string;
  provisional: boolean;
  nombreTxt: string;
  nombreZip: string;
  sha256Txt: Buffer;
  sha256Zip: Buffer;
  bytesZip: number;
  lineas: number;
  huella: string;
  modificadas: number;
  excluidas: number;
  agregadas: number;
  impactoDg: string | null;
  impactoDgng: string | null;
  impactoDng: string | null;
  impactoTotal: string;
  avisos: Record<string, unknown> | unknown[] | string;
  ruta: string;
  trabajoId: string;
  generadoPor: string;
}

export const rutaDeArchivo = (t: string, c: string, id: string): string =>
  `archivos/${t}/${c}/${id}.zip`;

/** Datos validos de una version; `o` pisa cualquier campo (la ruta se recalcula si cambia el id y no se pasa). */
export function datosArchivo(
  tenantId: string,
  c: ClientePrueba,
  usuarioId: string,
  trabajoId: string,
  o: Partial<DatosArchivo> = {},
): DatosArchivo {
  const id = o.id ?? randomUUID();
  const libro = o.libro ?? "compras";
  const periodo = o.periodo ?? "202610";
  const sufijo = libro === "compras" ? "RCE" : "RVIE";
  const base = `CONTAPP-PROVISIONAL-${c.ruc}-${periodo}-${sufijo}`;
  return {
    id,
    tenantId,
    clienteId: c.id,
    periodo,
    libro,
    version: 1,
    formatoId: libro === "compras" ? "RCE-REEMPLAZO" : "RVIE-REEMPLAZO",
    formatoVersion: "0-provisional",
    provisional: true,
    nombreTxt: `${base}.txt`,
    nombreZip: `${base}.zip`,
    sha256Txt: BYTES("a"),
    sha256Zip: BYTES("b"),
    bytesZip: 1234,
    lineas: 3,
    huella: HEX("c"),
    modificadas: libro === "compras" ? 1 : 0,
    excluidas: 0,
    agregadas: 0,
    impactoDg: libro === "compras" ? "10.00" : null,
    impactoDgng: libro === "compras" ? "0.00" : null,
    impactoDng: libro === "compras" ? "0.00" : null,
    impactoTotal: "10.00",
    avisos: { "R-ISC": 1 },
    ruta: rutaDeArchivo(tenantId, c.id, id),
    trabajoId,
    generadoPor: usuarioId,
    ...o,
  };
}

/** INSERT para los roles de la app (tenant_id sale del contexto). Mismo orden que `valoresArchivo`. */
export const INSERTAR_ARCHIVO = `insert into archivo_generado (id, cliente_id, periodo, libro, version, formato_id, formato_version,
    provisional, nombre_txt, nombre_zip, sha256_txt, sha256_zip, bytes_zip, lineas, huella, modificadas, excluidas, agregadas,
    impacto_igv_dg, impacto_igv_dgng, impacto_igv_dng, impacto_igv_total, avisos, ruta, trabajo_id, generado_por)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23::jsonb, $24,
          $25, $26) returning id`;

const jsonb = (a: DatosArchivo["avisos"]): string => JSON.stringify(a);

export function valoresArchivo(d: DatosArchivo): unknown[] {
  return [
    d.id,
    d.clienteId,
    d.periodo,
    d.libro,
    d.version,
    d.formatoId,
    d.formatoVersion,
    d.provisional,
    d.nombreTxt,
    d.nombreZip,
    d.sha256Txt,
    d.sha256Zip,
    d.bytesZip,
    d.lineas,
    d.huella,
    d.modificadas,
    d.excluidas,
    d.agregadas,
    d.impactoDg,
    d.impactoDgng,
    d.impactoDng,
    d.impactoTotal,
    jsonb(d.avisos),
    d.ruta,
    d.trabajoId,
    d.generadoPor,
  ];
}

/** Lo que `insertarVersion` recibe (cadenas hex, avisos como objeto). */
export function entradaVersion(d: DatosArchivo) {
  return {
    id: d.id,
    clienteId: d.clienteId,
    periodo: d.periodo,
    libro: d.libro,
    version: d.version,
    formatoId: d.formatoId,
    formatoVersion: d.formatoVersion,
    provisional: d.provisional,
    nombreTxt: d.nombreTxt,
    nombreZip: d.nombreZip,
    sha256Txt: d.sha256Txt.toString("hex"),
    sha256Zip: d.sha256Zip.toString("hex"),
    bytesZip: d.bytesZip,
    lineas: d.lineas,
    huella: d.huella,
    modificadas: d.modificadas,
    excluidas: d.excluidas,
    agregadas: d.agregadas,
    impactoIgvDg: d.impactoDg,
    impactoIgvDgng: d.impactoDgng,
    impactoIgvDng: d.impactoDng,
    impactoIgvTotal: d.impactoTotal,
    avisos: d.avisos as Record<string, number>,
    ruta: d.ruta,
    trabajoId: d.trabajoId,
    generadoPor: d.generadoPor,
  };
}

const COLUMNAS_CRUDO = `id, tenant_id, cliente_id, periodo, libro, version, formato_id, formato_version, provisional, nombre_txt,
    nombre_zip, sha256_txt, sha256_zip, bytes_zip, lineas, huella, modificadas, excluidas, agregadas, impacto_igv_dg,
    impacto_igv_dgng, impacto_igv_dng, impacto_igv_total, avisos, ruta, trabajo_id, generado_por`;

function valoresCrudo(d: DatosArchivo): unknown[] {
  const v = valoresArchivo(d);
  // tenant_id va en la posicion 2 (despues de id).
  return [v[0], d.tenantId, ...v.slice(1)];
}
const SQL_CRUDO = `insert into archivo_generado (${COLUMNAS_CRUDO})
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24::jsonb,
          $25, $26, $27)`;

export class EscenarioArchivos extends EscenarioCompras {
  /** Trabajo `archivo.generar` sembrado (el trabajo_id de una version apunta a un trabajo real). */
  async trabajoArchivo(tenantId: string, c: ClientePrueba): Promise<string> {
    return this.job(tenantId, c, {
      tipo: "archivo.generar",
      cola: "archivos",
      canal: "ninguno",
      estado: "completado",
    });
  }

  /** Estado del periodo de un libro, sembrado con el superusuario. */
  async periodoDe(
    libro: Libro,
    tenantId: string,
    c: ClientePrueba | string,
    periodo: string,
    estado: EstadoPeriodoDb,
    marcadoPor: string | null = null,
  ): Promise<void> {
    const tabla = libro === "compras" ? "compra_periodo" : "venta_periodo";
    await this.admin.query(
      `insert into ${tabla} (tenant_id, cliente_id, periodo, estado, marcado_por, marcado_en)
       values ($1, $2, $3, $4, $5, case when $5::uuid is null then null else now() end)
       on conflict (tenant_id, cliente_id, periodo) do update
         set estado = excluded.estado, marcado_por = excluded.marcado_por, marcado_en = excluded.marcado_en`,
      [tenantId, typeof c === "string" ? c : c.id, periodo, estado, marcadoPor],
    );
  }

  /**
   * Version sembrada saltando los triggers (session_replication_role = replica, solo para sembrar): los CHECK siguen aplicando.
   * Devuelve los datos con el id y la ruta.
   */
  async archivo(
    tenantId: string,
    c: ClientePrueba,
    usuarioId: string,
    o: Partial<DatosArchivo> = {},
  ): Promise<DatosArchivo> {
    const trabajoId = o.trabajoId ?? (await this.trabajoArchivo(tenantId, c));
    const d = datosArchivo(tenantId, c, usuarioId, trabajoId, o);
    const cx = await this.admin.connect();
    try {
      await cx.query("BEGIN");
      await cx.query("SET LOCAL session_replication_role = replica");
      await cx.query(SQL_CRUDO, valoresCrudo(d));
      await cx.query("COMMIT");
    } catch (e) {
      await cx.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      cx.release();
    }
    return d;
  }

  /** Intenta insertar saltando los triggers; devuelve el SQLSTATE o 'ok' (siempre con ROLLBACK). Prueba los CHECK. */
  async insertarCrudo(d: DatosArchivo): Promise<string> {
    const cx = await this.admin.connect();
    try {
      await cx.query("BEGIN");
      await cx.query("SET LOCAL session_replication_role = replica");
      await cx.query(SQL_CRUDO, valoresCrudo(d));
      return "ok";
    } catch (e) {
      return String((e as { code?: string }).code ?? "sin_codigo");
    } finally {
      await cx.query("ROLLBACK").catch(() => undefined);
      cx.release();
    }
  }

  /**
   * Inserta con `tenant_id` explicito (`d.tenantId`) bajo el rol y el contexto de estudio indicados (siempre con ROLLBACK):
   * prueba que la politica RLS rechaza una escritura para otro estudio. Devuelve el SQLSTATE o 'ok'.
   */
  async insertarComoRol(
    rol: "contapp_backend" | "contapp_worker",
    contextoTenantId: string,
    d: DatosArchivo,
  ): Promise<string> {
    const cx = await this.admin.connect();
    try {
      await cx.query("BEGIN");
      await cx.query(`SET LOCAL ROLE ${rol}`);
      await cx.query("select set_config('app.tenant_id', $1, true)", [
        contextoTenantId,
      ]);
      await cx.query(SQL_CRUDO, valoresCrudo(d));
      return "ok";
    } catch (e) {
      return String((e as { code?: string }).code ?? "sin_codigo");
    } finally {
      await cx.query("ROLLBACK").catch(() => undefined);
      cx.release();
    }
  }

  /** Exclusion sembrada con el superusuario (pasa por el trigger de insercion). Devuelve su id. */
  async exclusion(
    tenantId: string,
    clienteId: string,
    ventaId: string,
    o: {
      periodo?: string;
      motivo?: string;
      por: string;
      restauradaPor?: string | null;
    },
  ): Promise<string> {
    const r = await this.admin.query(
      `insert into venta_exclusion (tenant_id, cliente_id, periodo, venta_id, motivo, excluida_por, restaurada_por, restaurada_en)
       values ($1, $2, $3, $4, $5, $6, $7::uuid, case when $7::uuid is null then null else now() end) returning id`,
      [
        tenantId,
        clienteId,
        o.periodo ?? "202610",
        ventaId,
        o.motivo ?? "Descuadrada en el SIRE",
        o.por,
        o.restauradaPor ?? null,
      ],
    );
    return r.rows[0].id as string;
  }
}

/** Mantiene una transaccion abierta (con lo que haga `fn` dentro) hasta que se llame a `soltar`. */
export function sostener<T>(
  db: ContappDb,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
) {
  let soltar!: () => void;
  let adentro!: () => void;
  const espera = new Promise<void>((r) => (soltar = r));
  const dentro = new Promise<void>((r) => (adentro = r));
  const fin = db.withTenant({ tenantId }, async (tx) => {
    const v = await fn(tx);
    adentro();
    await espera;
    return v;
  });
  return {
    dentro: Promise.race([dentro, fin.then(() => undefined)]),
    soltar,
    fin,
  };
}

/** Error de dominio de las simulaciones de «el servicio rechaza porque el periodo esta generado». */
export class PeriodoGenerado extends Error {
  readonly codigo = "periodo_generado";
  constructor() {
    super("periodo_generado");
  }
}

/**
 * Lo que hace una escritura de ventas del backend (plan, orden de bloqueo): advisory del libro -> `venta_periodo FOR SHARE`;
 * con el periodo `generado` rechaza; si no, ejecuta `fn`. Usa las funciones reales de @contapp/db.
 */
export async function escrituraVentas<T>(
  tx: Tx,
  clienteId: string,
  periodo: string,
  fn: () => Promise<T>,
): Promise<T> {
  await exportado<(tx: Tx, c: string, p: string, l: string) => Promise<void>>(
    "bloquearPeriodoLibro",
  )(tx, clienteId, periodo, "ventas");
  const e = await exportado<
    (
      tx: Tx,
      c: string,
      p: string,
      o: { compartido: boolean },
    ) => Promise<{ estado: string }>
  >("leerEstadoPeriodoVentas")(tx, clienteId, periodo, { compartido: true });
  if (e.estado === "generado") throw new PeriodoGenerado();
  return fn();
}

/** Codigo de lo que lanza una promesa (`codigo` del repositorio, `code` de pg), o 'ok'. */
export async function codigoRepo(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    const x = e as { codigo?: string; code?: string };
    return String(x.codigo ?? x.code ?? "sin_codigo");
  }
}

export async function contarEn(
  admin: Pool,
  tabla: string,
  donde = "true",
  valores: unknown[] = [],
): Promise<number> {
  return (
    await admin.query(
      `select count(*)::int as n from ${tabla} where ${donde}`,
      valores,
    )
  ).rows[0].n as number;
}
