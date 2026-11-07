// Soporte de las pruebas de integración del persistidor de compras (spec 014, T8). No es código de producción ni una
// prueba (vive fuera de `src`, como `ventas.ts`, del que reutiliza el mundo, el puerto controlado y el encolado).
//
// CONTRATO de BD que fijan (T11 lo implementa; son los nombres de T6, `tests/aislamiento/compras-soporte.ts`): tablas
// `compra`, `compra_version`, `compra_hallazgo`, `compra_operacion` y `compra_periodo`; columnas en snake_case que no
// terminan en `_at` (`creada_en`, `descartada_en`, `marcado_en`); los 10 montos y el total son `bi_dg, igv_dg, bi_dgng,
// igv_dgng, bi_dng, igv_dng, no_gravado, isc, icbper, otros_tributos, total` (NUMERIC(14,2)). Todo se siembra y se lee con
// el rol administrativo (no pasa por RLS ni por grants; sí por triggers y FK).
import type { ContappDb } from "@contapp/db";
import type { FilaPropuestaSire } from "@contapp/sunat";
import { PERIODO, limpiarVentas, type MundoVentas } from "./ventas.js";

export {
  PERIODO,
  RUC_FIXTURE,
  SireApiControlado,
  encolarDescarga,
  mundoVentas,
} from "./ventas.js";
export type { MundoVentas } from "./ventas.js";

/** Columna de la propuesta -> columna de la tabla (la décima se llama `otros` en la propuesta y `otros_tributos` en BD). */
export const MONTOS: ReadonlyArray<readonly [keyof FilaPropuestaSire, string]> =
  [
    ["biDg", "bi_dg"],
    ["igvDg", "igv_dg"],
    ["biDgng", "bi_dgng"],
    ["igvDgng", "igv_dgng"],
    ["biDng", "bi_dng"],
    ["igvDng", "igv_dng"],
    ["noGravado", "no_gravado"],
    ["isc", "isc"],
    ["icbper", "icbper"],
    ["otros", "otros_tributos"],
    ["total", "total"],
  ];

/** Proveedor sintético de las filas armadas a mano. */
export const RUC_PROVEEDOR = "20100070970";

/** Factura de S/ 118.00 (100 + 18) que cuadra; `extra` pisa cualquier campo. */
export function filaCompra(
  numero: string,
  extra: Partial<FilaPropuestaSire> = {},
): FilaPropuestaSire {
  return {
    tipo: "01",
    serie: "F001",
    numero,
    rucContraparte: RUC_PROVEEDOR,
    razonSocialContraparte: "PRUEBA PROVEEDOR SINTETICO S.A.C.",
    fechaEmision: "2026-10-05",
    moneda: "PEN",
    biDg: "100.00",
    igvDg: "18.00",
    biDgng: "0.00",
    igvDgng: "0.00",
    biDng: "0.00",
    igvDng: "0.00",
    noGravado: "0.00",
    isc: "0.00",
    icbper: "0.00",
    otros: "0.00",
    total: "118.00",
    ...extra,
  };
}

/** Clave de identidad esperada de una fila (plan 014, «Clave»). */
export function claveDe(f: FilaPropuestaSire): string {
  const numero = f.numero.replace(/^0+(?=.)/, "");
  return `${f.tipo}|${f.serie.toUpperCase()}|${numero}|${f.tipoDocContraparte ?? "6"}|${f.rucContraparte.toUpperCase()}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Lecturas (rol administrativo)
// ---------------------------------------------------------------------------------------------------------------

export interface CompraBd {
  id: string;
  propuesta_id: string | null;
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
  version_vigente: number;
  descartada_en: Date | null;
}

export async function comprasDe(
  admin: ContappDb,
  clienteId: string,
  periodo = PERIODO,
): Promise<CompraBd[]> {
  const r = await admin.pool.query(
    `select id, propuesta_id, clave, tipo_doc, serie, numero, doc_tipo, doc_numero, razon_social, fecha::text as fecha,
            moneda, tipo_cambio::text as tipo_cambio, origen, version_vigente::int as version_vigente, descartada_en
       from compra where cliente_id = $1 and periodo = $2 order by serie, numero, id`,
    [clienteId, periodo],
  );
  return r.rows as CompraBd[];
}

export async function contarCompras(
  admin: ContappDb,
  clienteId: string,
  periodo = PERIODO,
  soloVivas = false,
): Promise<number> {
  const r = await admin.pool.query(
    `select count(*)::int as n from compra where cliente_id = $1 and periodo = $2
        and ($3::boolean = false or descartada_en is null)`,
    [clienteId, periodo, soloVivas],
  );
  return r.rows[0].n as number;
}

export interface VersionBd {
  n: number;
  excluida: boolean;
  motivo: string | null;
  clasificada: boolean;
  accion: string;
  operacion_id: string | null;
  usuario_id: string | null;
  montos: Record<string, string>;
}

/** Todas las versiones de una compra, de la 1 en adelante; los montos como cadenas exactas de la columna. */
export async function versionesDe(
  admin: ContappDb,
  compraId: string,
): Promise<VersionBd[]> {
  const r = await admin.pool.query(
    `select n::int as n, excluida, motivo, clasificada, accion, operacion_id, usuario_id,
            bi_dg::text as m_bi_dg, igv_dg::text as m_igv_dg, bi_dgng::text as m_bi_dgng, igv_dgng::text as m_igv_dgng,
            bi_dng::text as m_bi_dng, igv_dng::text as m_igv_dng, no_gravado::text as m_no_gravado, isc::text as m_isc,
            icbper::text as m_icbper, otros_tributos::text as m_otros_tributos, total::text as m_total
       from compra_version where compra_id = $1 order by n`,
    [compraId],
  );
  return (r.rows as Array<Record<string, unknown>>).map((f) => ({
    n: f.n as number,
    excluida: f.excluida as boolean,
    motivo: f.motivo as string | null,
    clasificada: f.clasificada as boolean,
    accion: f.accion as string,
    operacion_id: f.operacion_id as string | null,
    usuario_id: f.usuario_id as string | null,
    montos: Object.fromEntries(
      MONTOS.map(([col, sql]) => [col, f[`m_${sql}`] as string]),
    ),
  }));
}

export interface HallazgoBd {
  version_n: number;
  regla: string;
  requiere_confirmacion: boolean;
  sugerencia: { tipo?: string } | null;
}

export async function hallazgosDe(
  admin: ContappDb,
  compraId: string,
): Promise<HallazgoBd[]> {
  const r = await admin.pool.query(
    `select version_n::int as version_n, regla, requiere_confirmacion, sugerencia
       from compra_hallazgo where compra_id = $1 order by version_n, regla`,
    [compraId],
  );
  return r.rows as HallazgoBd[];
}

/** Reglas de la versión indicada (por omisión la 1), ordenadas. */
export async function reglasDe(
  admin: ContappDb,
  compraId: string,
  versionN = 1,
): Promise<string[]> {
  return (await hallazgosDe(admin, compraId))
    .filter((h) => h.version_n === versionN)
    .map((h) => h.regla);
}

/** Cuenta filas de una de las tablas de compras de un cliente (todos los periodos). */
export async function contarDe(
  admin: ContappDb,
  tabla: "compra" | "compra_version" | "compra_hallazgo" | "compra_periodo",
  clienteId: string,
): Promise<number> {
  // Un SQL estático por tabla (la tabla nunca se interpola desde fuera).
  const sql = {
    compra: "select count(*)::int as n from compra where cliente_id = $1",
    compra_version:
      "select count(*)::int as n from compra_version v join compra c on c.id = v.compra_id where c.cliente_id = $1",
    compra_hallazgo:
      "select count(*)::int as n from compra_hallazgo h join compra c on c.id = h.compra_id where c.cliente_id = $1",
    compra_periodo:
      "select count(*)::int as n from compra_periodo where cliente_id = $1",
  }[tabla];
  return (await admin.pool.query(sql, [clienteId])).rows[0].n as number;
}

/** Estado del periodo, o `null` si no hay fila (la ausencia equivale a `abierto`). */
export async function estadoDelPeriodo(
  admin: ContappDb,
  clienteId: string,
  periodo = PERIODO,
): Promise<string | null> {
  const r = await admin.pool.query(
    "select estado from compra_periodo where cliente_id = $1 and periodo = $2",
    [clienteId, periodo],
  );
  return (r.rows[0]?.estado as string | undefined) ?? null;
}

/**
 * Foto de lo guardado de un cliente (compras, versiones y hallazgos de todos los periodos) como texto JSON por fila,
 * indexada por tabla e id. Sirve para comprobar que nada de lo anterior cambió ni siquiera un campo.
 */
export interface Foto {
  compra: Map<string, string>;
  compra_version: Map<string, string>;
  compra_hallazgo: Map<string, string>;
  compra_periodo: Map<string, string>;
}

export async function fotoDe(
  admin: ContappDb,
  clienteId: string,
): Promise<Foto> {
  const leer = async (sql: string) =>
    new Map(
      (
        (await admin.pool.query(sql, [clienteId])).rows as Array<{
          k: string;
          t: string;
        }>
      ).map((f) => [f.k, f.t]),
    );
  return {
    compra: await leer(
      "select id::text as k, to_jsonb(t)::text as t from compra t where cliente_id = $1",
    ),
    compra_version: await leer(
      `select t.id::text as k, to_jsonb(t)::text as t from compra_version t join compra c on c.id = t.compra_id
        where c.cliente_id = $1`,
    ),
    compra_hallazgo: await leer(
      `select t.id::text as k, to_jsonb(t)::text as t from compra_hallazgo t join compra c on c.id = t.compra_id
        where c.cliente_id = $1`,
    ),
    compra_periodo: await leer(
      "select (t.periodo || '/' || t.cliente_id::text) as k, to_jsonb(t)::text as t from compra_periodo t where cliente_id = $1",
    ),
  };
}

/** Las filas de `antes` siguen idénticas en `despues`. Devuelve las diferencias (vacío = nada cambió). */
export function cambiosEntre(antes: Foto, despues: Foto): string[] {
  const dif: string[] = [];
  for (const tabla of [
    "compra",
    "compra_version",
    "compra_hallazgo",
    "compra_periodo",
  ] as const) {
    for (const [k, t] of antes[tabla]) {
      const d = despues[tabla].get(k);
      if (d === undefined) dif.push(`${tabla} ${k}: desapareció`);
      else if (d !== t) dif.push(`${tabla} ${k}: cambió`);
    }
  }
  return dif;
}

/** Ids de las filas que `despues` tiene y `antes` no, por tabla. */
export function nuevasEntre(
  antes: Foto,
  despues: Foto,
  tabla: keyof Foto,
): string[] {
  return [...despues[tabla].keys()].filter((k) => !antes[tabla].has(k));
}

// ---------------------------------------------------------------------------------------------------------------
// Siembras (rol administrativo)
// ---------------------------------------------------------------------------------------------------------------

/** Encabezado de propuesta de compras sembrado (para colgar de él las compras sembradas). Devuelve su id. */
export async function sembrarPropuestaCompras(
  admin: ContappDb,
  m: Pick<MundoVentas, "T" | "u" | "c">,
  o: { periodo?: string; filas?: number } = {},
): Promise<string> {
  const n = o.filas ?? 0;
  const r = await admin.pool.query(
    `insert into propuesta (tenant_id, cliente_id, periodo, libro, fuente, hash, filas_recibidas, filas_nuevas,
                            filas_iguales, filas_distintas, usuario_id)
     values ($1, $2, $3, 'compras', 'api', $4, $5, $5, 0, 0, $6) returning id`,
    [m.T, m.c.id, o.periodo ?? PERIODO, "b".repeat(64), n, m.u],
  );
  return r.rows[0].id as string;
}

const SQL_COMPRA = `insert into compra (tenant_id, cliente_id, periodo, propuesta_id, clave, tipo_doc, serie, numero, doc_tipo,
    doc_numero, razon_social, fecha, moneda, tipo_cambio, origen, version_vigente)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 1) returning id`;

const SQL_VERSION = `insert into compra_version (tenant_id, compra_id, n, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng,
    no_gravado, isc, icbper, otros_tributos, total, excluida, motivo, clasificada, accion, operacion_id, usuario_id)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) returning id`;

/**
 * Compra sembrada con su versión 1 (en una transacción). `origen` `sire` cuelga de `propuestaId` (si falta, crea una
 * propuesta de compras del periodo); `agregada` no tiene propuesta y la pone el usuario `m.u`.
 */
export async function sembrarCompra(
  admin: ContappDb,
  m: Pick<MundoVentas, "T" | "u" | "c">,
  f: FilaPropuestaSire,
  o: {
    periodo?: string;
    origen?: "sire" | "agregada";
    propuestaId?: string;
    clienteId?: string;
    tenantId?: string;
  } = {},
): Promise<string> {
  const periodo = o.periodo ?? PERIODO;
  const origen = o.origen ?? "sire";
  const tenant = o.tenantId ?? m.T;
  const cliente = o.clienteId ?? m.c.id;
  const propuestaId =
    origen === "agregada"
      ? null
      : (o.propuestaId ??
        (await sembrarPropuestaCompras(
          admin,
          { ...m, T: tenant, c: { ...m.c, id: cliente } },
          { periodo, filas: 1 },
        )));
  const cx = await admin.pool.connect();
  try {
    await cx.query("BEGIN");
    const r = await cx.query(SQL_COMPRA, [
      tenant,
      cliente,
      periodo,
      propuestaId,
      claveDe(f),
      f.tipo,
      f.serie.toUpperCase(),
      f.numero,
      f.tipoDocContraparte ?? "6",
      f.rucContraparte.toUpperCase(),
      f.razonSocialContraparte ?? null,
      f.fechaEmision,
      f.moneda,
      f.tipoCambio ?? null,
      origen,
    ]);
    const id = r.rows[0].id as string;
    await cx.query(SQL_VERSION, [
      tenant,
      id,
      1,
      ...MONTOS.map(([col]) => f[col] as string),
      false,
      null,
      false,
      origen === "sire" ? "original" : "agregada",
      null,
      origen === "agregada" ? m.u : null,
    ]);
    await cx.query("COMMIT");
    return id;
  } catch (e) {
    await cx.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    cx.release();
  }
}

/**
 * Siembra `n` compras `sire` (F900-1 a F900-n por omisión; tipo 01, S/ 118.00 que cuadra) de un proveedor, colgadas de una
 * propuesta sembrada, en una sola sentencia. Sirve para llegar a los volúmenes de DU-20 sin pasar por la descarga.
 */
export async function sembrarCompras(
  admin: ContappDb,
  m: Pick<MundoVentas, "T" | "u" | "c">,
  n: number,
  o: { periodo?: string; serie?: string } = {},
): Promise<string> {
  const periodo = o.periodo ?? PERIODO;
  const serie = o.serie ?? "F900";
  const propuestaId = await sembrarPropuestaCompras(admin, m, {
    periodo,
    filas: n,
  });
  const cx = await admin.pool.connect();
  try {
    await cx.query("BEGIN");
    await cx.query(
      `with c as (
         insert into compra (tenant_id, cliente_id, periodo, propuesta_id, clave, tipo_doc, serie, numero, doc_tipo,
                             doc_numero, razon_social, fecha, moneda, tipo_cambio, origen, version_vigente)
         select $1, $2, $3, $4, '01|' || $5::text || '|' || g || '|6|20100070970', '01', $5::text, g::text, '6',
                '20100070970', 'PROVEEDOR SEMBRADO', '2026-10-05', 'PEN', null, 'sire', 1
           from generate_series(1, $6::int) g
         returning tenant_id, id)
       insert into compra_version (tenant_id, compra_id, n, bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado,
                                   isc, icbper, otros_tributos, total, excluida, motivo, clasificada, accion)
       select tenant_id, id, 1, 100, 18, 0, 0, 0, 0, 0, 0, 0, 0, 118, false, null, false, 'original' from c`,
      [m.T, m.c.id, periodo, propuestaId, serie, n],
    );
    await cx.query("COMMIT");
  } catch (e) {
    await cx.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    cx.release();
  }
  return propuestaId;
}

/**
 * Lo que hace el usuario con una compra: una versión nueva (n + 1) con los montos indicados sobre la vigente, y el
 * puntero apuntando a ella. Sin pasar por `packages/db` (no existe aún): solo prepara el estado de la prueba.
 */
export async function nuevaVersion(
  admin: ContappDb,
  m: Pick<MundoVentas, "T" | "u">,
  compraId: string,
  o: {
    montos?: Partial<Record<(typeof MONTOS)[number][0], string>>;
    excluida?: boolean;
    motivo?: string | null;
    clasificada?: boolean;
    accion?: string;
  } = {},
): Promise<number> {
  const act = (
    await admin.pool.query(
      `select v.n::int as n, v.excluida, v.motivo, v.clasificada,
              v.bi_dg::text as bi_dg, v.igv_dg::text as igv_dg, v.bi_dgng::text as bi_dgng, v.igv_dgng::text as igv_dgng,
              v.bi_dng::text as bi_dng, v.igv_dng::text as igv_dng, v.no_gravado::text as no_gravado, v.isc::text as isc,
              v.icbper::text as icbper, v.otros_tributos::text as otros_tributos, v.total::text as total
         from compra c join compra_version v on v.compra_id = c.id and v.n = c.version_vigente where c.id = $1`,
      [compraId],
    )
  ).rows[0] as Record<string, unknown>;
  const n = (act.n as number) + 1;
  await admin.pool.query(SQL_VERSION, [
    m.T,
    compraId,
    n,
    ...MONTOS.map(([col, sql]) => o.montos?.[col] ?? (act[sql] as string)),
    o.excluida ?? (act.excluida as boolean),
    o.motivo === undefined ? (act.motivo as string | null) : o.motivo,
    o.clasificada ?? (act.clasificada as boolean),
    o.accion ?? "editar",
    null,
    m.u,
  ]);
  await admin.pool.query(
    "update compra set version_vigente = $2 where id = $1",
    [compraId, n],
  );
  return n;
}

/** La compra agregada (o de cualquier origen) queda descartada, como la deja `descartar` de 014. */
export async function descartarCompra(
  admin: ContappDb,
  compraId: string,
): Promise<void> {
  await admin.pool.query(
    "update compra set descartada_en = now() where id = $1",
    [compraId],
  );
}

/** Estado del periodo sembrado (la fila no existe hasta que alguien la crea). */
export async function fijarEstadoPeriodo(
  admin: ContappDb,
  m: Pick<MundoVentas, "T" | "u" | "c">,
  estado: "abierto" | "revisado" | "generado",
  periodo = PERIODO,
): Promise<void> {
  await admin.pool.query(
    `insert into compra_periodo (tenant_id, cliente_id, periodo, estado, marcado_por, marcado_en)
     values ($1, $2, $3, $4, $5, now())
     on conflict (tenant_id, cliente_id, periodo) do update set estado = excluded.estado`,
    [m.T, m.c.id, periodo, estado, m.u],
  );
}

/** Texto de las tablas de compras de los estudios dados (para buscar canarios). */
export async function volcarTablasCompras(
  admin: ContappDb,
  estudios: string[],
): Promise<string> {
  const r = await admin.pool.query(
    `select to_jsonb(t)::text as t from compra t where tenant_id = any($1::uuid[])
     union all select to_jsonb(t)::text from compra_version t where tenant_id = any($1::uuid[])
     union all select to_jsonb(t)::text from compra_hallazgo t where tenant_id = any($1::uuid[])
     union all select to_jsonb(t)::text from compra_periodo t where tenant_id = any($1::uuid[])`,
    [estudios],
  );
  return (r.rows as Array<{ t: string }>).map((f) => f.t).join("\n");
}

/**
 * Borra lo que dejan las pruebas en las tablas de compras y luego en las de 013 (`propuesta`, `propuesta_diferencia`,
 * `venta`...). Va con `session_replication_role = replica`: las versiones y la identidad de `compra` son inmutables por
 * trigger y las FK compuestas impiden borrar en cualquier orden. Llamar antes de `e.limpiar()`.
 */
export async function limpiarCompras(
  admin: ContappDb,
  estudios: string[],
): Promise<void> {
  const c = await admin.pool.connect();
  try {
    await c.query("SET session_replication_role = replica");
    const borrar = [
      "delete from compra_hallazgo where tenant_id = any($1::uuid[])",
      "delete from compra_version where tenant_id = any($1::uuid[])",
      "delete from compra_operacion where tenant_id = any($1::uuid[])",
      "delete from compra where tenant_id = any($1::uuid[])",
      "delete from compra_periodo where tenant_id = any($1::uuid[])",
    ];
    for (const sql of borrar)
      await c.query(sql, [estudios]).catch(() => undefined);
  } finally {
    c.release(true); // se destruye: no vuelve al pool con session_replication_role = replica
  }
  await limpiarVentas(admin, estudios);
}
