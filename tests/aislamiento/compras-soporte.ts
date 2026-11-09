// Soporte de las pruebas de BD de la spec 014 (T6). No es una prueba (no termina en .spec.ts).
// Siembra `propuesta` (hereda de 013), `compra`, `compra_version`, `compra_operacion` y `compra_periodo` con la conexion
// administrativa (superusuario: no pasa por RLS ni por grants, pero SI por los triggers y las FK) y los borra al final con
// `session_replication_role = replica` (las versiones y la identidad de `compra` son inmutables por trigger y las FK compuestas
// impedirian borrar en cualquier orden). Datos sinteticos: sin RUC reales.
//
// CONTRATO QUE FIJAN LAS PRUEBAS DE T6 (T11 lo implementa en las migraciones 0032 y 0033; T12 en `packages/db/src/compras/`).
// Las firmas completas estan en el encabezado de cada `compras-*.spec.ts`; los tipos estructurales comunes estan aqui.
//   - Columnas en snake_case; ninguna termina en `_at` (013): `creada_en`, `deshecha_en`, `descartada_en`, `marcado_en`.
//   - `compra_version.n` y `compra.version_vigente` son enteros; `versionBase` es ese entero.
//   - Los 10 montos de 010 + total: bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado, isc, icbper,
//     otros_tributos, total (NUMERIC(14,2) NOT NULL). En TypeScript viajan como cadenas con la clave en camelCase.
import type { Pool } from "pg";
import { EscenarioVentas, PERIODO } from "./ventas-soporte";
import type { ClientePrueba } from "./trabajos-soporte";

export { PERIODO };

export const COLUMNAS_MONTO = [
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
export type ColumnaMonto = (typeof COLUMNAS_MONTO)[number];
export type Montos = Record<ColumnaMonto | "total", string>;

/** Nombre SQL de cada columna de monto (y del total). */
export const SQL_MONTO: Record<ColumnaMonto | "total", string> = {
  biDg: "bi_dg",
  igvDg: "igv_dg",
  biDgng: "bi_dgng",
  igvDgng: "igv_dgng",
  biDng: "bi_dng",
  igvDng: "igv_dng",
  noGravado: "no_gravado",
  isc: "isc",
  icbper: "icbper",
  otrosTributos: "otros_tributos",
  total: "total",
};
export const COLUMNAS_SQL_MONTO = Object.values(SQL_MONTO);

// Aritmetica en centimos con BigInt: ninguna prueba usa `number` para dinero.
const aCentimos = (s: string): bigint => BigInt(s.replace(".", ""));
const deCentimos = (c: bigint): string => {
  const neg = c < 0n;
  const a = (neg ? -c : c).toString().padStart(3, "0");
  return `${neg ? "-" : ""}${a.slice(0, -2)}.${a.slice(-2)}`;
};

/** Montos en cero; el total es la suma de las 10 componentes salvo que se indique otro. */
export function montos(o: Partial<Montos> = {}): Montos {
  const base = Object.fromEntries(
    COLUMNAS_MONTO.map((c) => [c, o[c] ?? "0.00"]),
  ) as Record<ColumnaMonto, string>;
  const total =
    o.total ??
    deCentimos(COLUMNAS_MONTO.reduce((s, c) => s + aCentimos(base[c]), 0n));
  return { ...base, total };
}

/** Factura gravada tipica: BI 1000.00, IGV 180.00, total 1180.00. */
export const MONTOS_DG = montos({ biDg: "1000.00", igvDg: "180.00" });

export interface DatosVersion {
  montos: Montos;
  excluida: boolean;
  motivo: string | null;
  clasificada: boolean;
}

export interface IdentidadCompra {
  clave: string;
  tipoDoc: string;
  serie: string;
  numero: string;
  docTipo: string;
  docNumero: string;
  razonSocial: string | null;
  fecha: string;
  moneda: "PEN" | "USD";
  tipoCambio: string | null;
}

/** Compra tal como la lee `packages/db` (cadenas; la version es la vigente salvo que se lea la 1). */
export interface CompraLeida extends IdentidadCompra {
  id: string;
  clienteId: string;
  periodo: string;
  origen: "sire" | "agregada";
  propuestaId: string | null;
  /** n de la version que traen `montos`, `excluida`, `motivo` y `clasificada`. */
  version: number;
  excluida: boolean;
  motivo: string | null;
  clasificada: boolean;
  montos: Montos;
}

export interface VersionFila extends DatosVersion {
  id: string;
  compraId: string;
  n: number;
  accion: string;
  operacionId: string | null;
  usuarioId: string | null;
  creadaEn: Date;
}

export interface HallazgoNuevo {
  regla: string;
  sugerencia: unknown;
  lecturas: Record<string, string>;
  requiereConfirmacion: boolean;
}

export type Evaluar = (
  fila: CompraLeida,
) => Promise<HallazgoNuevo[]> | HallazgoNuevo[];
export type ResultadoTransformar = DatosVersion | { rechazo: string };
export type Transformar = (
  actual: CompraLeida,
  parametros: unknown,
) => Promise<ResultadoTransformar> | ResultadoTransformar;

/** `evaluar` falso: un hallazgo por fila que copia la BI de DG de la version evaluada (asi se ve que evaluo la nueva). */
export function evaluadorFalso(
  hacer: (f: CompraLeida) => HallazgoNuevo[] = (f) => [
    {
      regla: "R-FALSA",
      sugerencia: { destino: "DNG" },
      lecturas: { biDg: f.montos.biDg },
      requiereConfirmacion: false,
    },
  ],
) {
  const llamadas: CompraLeida[] = [];
  const evaluar: Evaluar = async (f) => {
    llamadas.push(f);
    return hacer(f);
  };
  return { evaluar, llamadas };
}

export const sinHallazgos = () => evaluadorFalso(() => []);

/** Parametros que entiende `transformarFalso`. */
export type ParametrosFalsos =
  | { tipo: "dng" }
  | { tipo: "bi"; valor: string }
  | { tipo: "excluir"; motivo?: string }
  | { tipo: "restaurar" }
  | { tipo: "rechazar"; codigo: string }
  | { tipo: "lanzar" };

/** `transformar` falso (el de verdad es del dominio y vive en el backend): ninguna prueba de `packages/db` importa el dominio. */
export const transformarFalso: Transformar = (actual, p) => {
  const par = p as ParametrosFalsos;
  const m = actual.montos;
  const datos = (
    cambios: Partial<Montos>,
    resto: Partial<DatosVersion> = {},
  ): DatosVersion => ({
    montos: montos({ ...m, ...cambios, total: undefined }),
    excluida: actual.excluida,
    motivo: actual.motivo,
    clasificada: actual.clasificada,
    ...resto,
  });
  switch (par.tipo) {
    case "dng":
      return datos(
        { biDg: "0.00", igvDg: "0.00", biDng: m.biDg, igvDng: m.igvDg },
        { clasificada: true },
      );
    case "bi":
      return datos({ biDg: par.valor });
    case "excluir":
      return datos({}, { excluida: true, motivo: par.motivo ?? null });
    case "restaurar":
      return datos({}, { excluida: false, motivo: null });
    case "rechazar":
      return { rechazo: par.codigo };
    case "lanzar":
      throw new Error("transformar fallo a proposito");
  }
};

export interface OpcionesCompra {
  periodo?: string;
  origen?: "sire" | "agregada";
  /** Obligatorio si origen = sire (si no se pasa, se crea una propuesta de compras). */
  propuestaId?: string | null;
  tipoDoc?: string;
  serie?: string;
  numero?: string;
  docTipo?: string;
  docNumero?: string;
  razonSocial?: string | null;
  fecha?: string;
  moneda?: "PEN" | "USD";
  tipoCambio?: string | null;
  clave?: string;
  /** Montos de la version 1. */
  montos?: Partial<Montos>;
  usuarioId?: string | null;
}

export interface OpcionesVersion {
  montos?: Partial<Montos>;
  excluida?: boolean;
  motivo?: string | null;
  clasificada?: boolean;
  accion?: string;
  operacionId?: string | null;
  usuarioId?: string | null;
}

export interface CompraSembrada {
  id: string;
  clave: string;
  tenantId: string;
  clienteId: string;
  periodo: string;
}

export const claveCompra = (
  tipoDoc: string,
  serie: string,
  numero: string,
  docTipo: string,
  docNumero: string,
): string =>
  `${tipoDoc}|${serie.toUpperCase()}|${numero.replace(/^0+(?=.)/, "")}|${docTipo}|${docNumero.toUpperCase()}`;

const SQL_COMPRA = `insert into compra (tenant_id, cliente_id, periodo, propuesta_id, clave, tipo_doc, serie, numero, doc_tipo,
    doc_numero, razon_social, fecha, moneda, tipo_cambio, origen, version_vigente)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 1) returning id`;

const SQL_VERSION = `insert into compra_version (tenant_id, compra_id, n, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng,
    no_gravado, isc, icbper, otros_tributos, total, excluida, motivo, clasificada, accion, operacion_id, usuario_id)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) returning id`;

export class EscenarioCompras extends EscenarioVentas {
  private readonly tenantsCompras = new Set<string>();
  private n = 0;

  /** Compra sembrada con su version 1 (en una sola transaccion: la FK del puntero, si es diferible, se resuelve al final). */
  async compra(
    tenantId: string,
    c: ClientePrueba | string,
    o: OpcionesCompra = {},
  ): Promise<CompraSembrada> {
    this.tenantsCompras.add(tenantId);
    const clienteId = typeof c === "string" ? c : c.id;
    const periodo = o.periodo ?? PERIODO;
    const origen = o.origen ?? "sire";
    const consecutivo = ++this.n;
    const tipoDoc = o.tipoDoc ?? "01";
    const serie = o.serie ?? "F001";
    const numero = o.numero ?? String(1000 + consecutivo);
    const docTipo = o.docTipo ?? "6";
    const docNumero = o.docNumero ?? "20100070970";
    const clave =
      o.clave ?? claveCompra(tipoDoc, serie, numero, docTipo, docNumero);
    const propuestaId =
      origen === "agregada"
        ? null
        : (o.propuestaId ??
          (await this.propuesta(tenantId, clienteId, {
            periodo,
            libro: "compras",
            nuevas: 1,
          })));
    const m = montos(o.montos ?? MONTOS_DG);
    const cx = await this.admin.connect();
    try {
      await cx.query("BEGIN");
      const r = await cx.query(SQL_COMPRA, [
        tenantId,
        clienteId,
        periodo,
        propuestaId,
        clave,
        tipoDoc,
        serie,
        numero,
        docTipo,
        docNumero,
        o.razonSocial === undefined ? "PROVEEDOR SINTETICO SAC" : o.razonSocial,
        o.fecha ?? "2026-10-05",
        o.moneda ?? "PEN",
        o.tipoCambio ?? null,
        origen,
      ]);
      const id = r.rows[0].id as string;
      await cx.query(
        SQL_VERSION,
        versionValores(tenantId, id, 1, m, {
          accion: origen === "sire" ? "original" : "agregada",
          usuarioId: o.usuarioId ?? null,
        }),
      );
      await cx.query("COMMIT");
      return { id, clave, tenantId, clienteId, periodo };
    } catch (e) {
      await cx.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      cx.release();
    }
  }

  /** Version `n` de una compra sembrada (superusuario); mueve el puntero a `n`. Devuelve el id de la version. */
  async version(
    tenantId: string,
    compraId: string,
    n: number,
    o: OpcionesVersion = {},
  ): Promise<string> {
    this.tenantsCompras.add(tenantId);
    const actual = await this.admin.query(
      `select v.bi_dg, v.igv_dg, v.bi_dgng, v.igv_dgng, v.bi_dng, v.igv_dng, v.no_gravado, v.isc, v.icbper, v.otros_tributos,
              v.total, v.excluida, v.motivo, v.clasificada
         from compra c join compra_version v on v.compra_id = c.id and v.n = c.version_vigente where c.id = $1`,
      [compraId],
    );
    const a = actual.rows[0];
    const previos = a
      ? montos({
          biDg: a.bi_dg,
          igvDg: a.igv_dg,
          biDgng: a.bi_dgng,
          igvDgng: a.igv_dgng,
          biDng: a.bi_dng,
          igvDng: a.igv_dng,
          noGravado: a.no_gravado,
          isc: a.isc,
          icbper: a.icbper,
          otrosTributos: a.otros_tributos,
          total: a.total,
        })
      : MONTOS_DG;
    const m = o.montos
      ? montos({ ...previos, ...o.montos, total: o.montos.total })
      : previos;
    const r = await this.admin.query(
      SQL_VERSION,
      versionValores(
        tenantId,
        compraId,
        n,
        m,
        { ...o, accion: o.accion ?? "editar" },
        a,
      ),
    );
    await this.admin.query(
      "update compra set version_vigente = $2 where id = $1",
      [compraId, n],
    );
    return r.rows[0].id as string;
  }

  /** Operacion sembrada. */
  async operacion(
    tenantId: string,
    c: ClientePrueba | string,
    o: {
      periodo?: string;
      usuarioId: string;
      tipo?: string;
      estado?: "vigente" | "deshecha" | "caducada";
      referenciaId?: string | null;
      hace?: number;
    },
  ): Promise<string> {
    this.tenantsCompras.add(tenantId);
    const estado = o.estado ?? "vigente";
    const r = await this.admin.query(
      `insert into compra_operacion (tenant_id, cliente_id, periodo, usuario_id, tipo, estado, referencia_id, creada_en,
                                     deshecha_en)
       values ($1, $2, $3, $4, $5, $6, $7, now() - make_interval(secs => $8::int),
               case when $6 = 'deshecha' then now() else null end) returning id`,
      [
        tenantId,
        typeof c === "string" ? c : c.id,
        o.periodo ?? PERIODO,
        o.usuarioId,
        o.tipo ?? "clasificar",
        estado,
        o.referenciaId ?? null,
        o.hace ?? 0,
      ],
    );
    return r.rows[0].id as string;
  }

  /** Estado del periodo sembrado. */
  async estadoPeriodo(
    tenantId: string,
    c: ClientePrueba | string,
    periodo: string,
    estado: "abierto" | "revisado" | "generado",
    marcadoPor: string | null = null,
  ): Promise<void> {
    this.tenantsCompras.add(tenantId);
    await this.admin.query(
      `insert into compra_periodo (tenant_id, cliente_id, periodo, estado, marcado_por, marcado_en)
       values ($1, $2, $3, $4, $5, case when $5::uuid is null then null else now() end)`,
      [tenantId, typeof c === "string" ? c : c.id, periodo, estado, marcadoPor],
    );
  }

  override async limpiar(): Promise<void> {
    const t = [...this.tenantsCompras, ...this.ea.estudios];
    const c = await this.admin.connect();
    try {
      await c.query("SET session_replication_role = replica");
      for (const tabla of [
        // Spec 016 (T5): las tablas de XML y de evaluacion numerada (0035 y 0036). Si aun no existen, `.catch` las ignora.
        "documento_xml_obtencion",
        "compra_evaluacion",
        "documento_xml",
        "compra_hallazgo",
        "compra_version",
        "compra_operacion",
        "compra",
        "compra_periodo",
      ]) {
        await c
          .query(`delete from ${tabla} where tenant_id = any($1::uuid[])`, [t])
          .catch(() => undefined);
      }
    } finally {
      c.release(true); // se destruye: no vuelve al pool con session_replication_role = replica
    }
    await super.limpiar();
  }
}

function versionValores(
  tenantId: string,
  compraId: string,
  n: number,
  m: Montos,
  o: OpcionesVersion & { accion: string },
  previa?: { excluida: boolean; motivo: string | null; clasificada: boolean },
): unknown[] {
  return [
    tenantId,
    compraId,
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
    o.excluida ?? previa?.excluida ?? false,
    o.motivo === undefined ? (previa?.motivo ?? null) : o.motivo,
    o.clasificada ?? previa?.clasificada ?? false,
    o.accion,
    o.operacionId ?? null,
    o.usuarioId ?? null,
  ];
}

/** Valores de insercion de `compra` para los roles de la app (tenant_id sale del contexto). */
export const INSERTAR_COMPRA = `insert into compra (cliente_id, periodo, propuesta_id, clave, tipo_doc, serie, numero, doc_tipo,
    doc_numero, razon_social, fecha, moneda, tipo_cambio, origen, version_vigente)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id`;

export function valoresCompra(
  clienteId: string,
  o: {
    periodo?: string;
    propuestaId?: string | null;
    origen?: string;
    serie?: string;
    numero?: string;
    clave?: string;
    moneda?: string;
    tipoCambio?: string | null;
    versionVigente?: number;
  } = {},
): unknown[] {
  const serie = o.serie ?? "F001";
  const numero = o.numero ?? "1";
  return [
    clienteId,
    o.periodo ?? PERIODO,
    o.propuestaId === undefined ? null : o.propuestaId,
    o.clave ?? claveCompra("01", serie, numero, "6", "20100070970"),
    "01",
    serie,
    numero,
    "6",
    "20100070970",
    "PROVEEDOR SINTETICO SAC",
    "2026-10-05",
    o.moneda ?? "PEN",
    o.tipoCambio ?? null,
    o.origen ?? "sire",
    o.versionVigente ?? 1,
  ];
}

/** Insercion de `compra_version` para los roles de la app. */
export const INSERTAR_VERSION = `insert into compra_version (compra_id, n, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado,
    isc, icbper, otros_tributos, total, excluida, motivo, clasificada, accion, operacion_id, usuario_id)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) returning id`;

export function valoresVersion(
  compraId: string,
  n: number,
  o: {
    montos?: Partial<Montos>;
    motivo?: string | null;
    usuarioId?: string | null;
    operacionId?: string | null;
  } = {},
): unknown[] {
  const m = montos(o.montos ?? MONTOS_DG);
  return [
    compraId,
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
    false,
    o.motivo ?? null,
    false,
    "editar",
    o.operacionId ?? null,
    o.usuarioId ?? null,
  ];
}

/** Dos transacciones que se esperan mutuamente (barrera) para forzar la simultaneidad. */
export function barrera(n: number): () => Promise<void> {
  let llegadas = 0;
  let abrir!: () => void;
  const puerta = new Promise<void>((r) => (abrir = r));
  return async () => {
    if (++llegadas >= n) abrir();
    await puerta;
  };
}

export const dormir = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Resuelve con el valor, o con 'pendiente' si no termino en `ms` (sirve para comprobar que algo espera un bloqueo). */
export async function conPlazo<T>(
  p: Promise<T>,
  ms: number,
): Promise<T | "pendiente"> {
  return Promise.race([p, dormir(ms).then(() => "pendiente" as const)]);
}

/** Codigo de lo que lanza una promesa (`codigo` de ComprasReglaError/ComprasRepoError o `code` de pg), o 'ok'. */
export async function codigoDe(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    const x = e as { codigo?: string; code?: string };
    return String(x.codigo ?? x.code ?? "sin_codigo");
  }
}

/** Error completo (para leer `ids` o `versionVigente`), o undefined si no lanzo. */
export async function errorDe(
  p: Promise<unknown>,
): Promise<
  { codigo?: string; ids?: string[]; versionVigente?: number } | undefined
> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e as { codigo?: string; ids?: string[]; versionVigente?: number };
  }
}

export async function contarFilas(
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
