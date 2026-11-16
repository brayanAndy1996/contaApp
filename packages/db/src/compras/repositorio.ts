// Piezas comunes de los repositorios de compras (spec 014): lectura de una compra con su versión, escritura por lotes de
// versiones, punteros y hallazgos, y operaciones. Solo SQL estático y parametrizado: los datos viajan como $n o como un solo
// jsonb por lote, nunca en el texto. Los NUMERIC se leen con `::text` (cadenas exactas); nada pasa por `number`.
//
// Orden de bloqueo de las escrituras (plan 014, «Contrato real de 013», punto 9): advisory (solo la descarga) -> `compra_periodo`
// -> `compra_operacion` -> `compra` por id ascendente. Las funciones de este paquete que escriben una fila bloquean en ese orden;
// el advisory y el estado del periodo los toma quien llama (`bloquearPeriodoLibro`, `leerEstadoPeriodo`).
import {
  consultar,
  ComprasRepoError,
  type Fila,
  type TxConsulta,
} from "./errores";
import { leerXmlVigentesDeCompras } from "../xml/documentos";
import {
  COLUMNAS_MONTO,
  type CompraConXml,
  type CompraLeida,
  type DatosVersion,
  type Evaluar,
  type HallazgoNuevo,
  type MontosCompra,
  type VersionFila,
  type XmlParaEvaluar,
} from "./tipos";

/** Filas por sentencia: acota el tamaño del parámetro jsonb y mantiene el texto SQL fijo. */
export const LOTE = 500;

const MONTOS_SQL = `bi_dg, igv_dg, bi_dgng, igv_dgng, bi_dng, igv_dng, no_gravado, isc, icbper, otros_tributos, total`;
const MONTOS_TEXTO = `bi_dg::text as bi_dg, igv_dg::text as igv_dg, bi_dgng::text as bi_dgng, igv_dgng::text as igv_dgng,
  bi_dng::text as bi_dng, igv_dng::text as igv_dng, no_gravado::text as no_gravado, isc::text as isc,
  icbper::text as icbper, otros_tributos::text as otros_tributos, total::text as total`;
const MONTOS_ENTRADA = `bi_dg text, igv_dg text, bi_dgng text, igv_dgng text, bi_dng text, igv_dng text, no_gravado text,
  isc text, icbper text, otros_tributos text, total text`;
const MONTOS_CAST = `x.bi_dg::numeric, x.igv_dg::numeric, x.bi_dgng::numeric, x.igv_dgng::numeric, x.bi_dng::numeric,
  x.igv_dng::numeric, x.no_gravado::numeric, x.isc::numeric, x.icbper::numeric, x.otros_tributos::numeric, x.total::numeric`;

/** Columnas de `compra c` unida a la versión `v` que se quiere leer, en la forma de `CompraLeida`. */
export const COLUMNAS_LEIDA = `c.id, c.cliente_id, c.periodo, c.propuesta_id, c.origen, c.clave, c.tipo_doc, c.serie, c.numero,
  c.doc_tipo, c.doc_numero, c.razon_social, to_char(c.fecha, 'YYYY-MM-DD') as fecha, c.moneda,
  c.tipo_cambio::text as tipo_cambio, v.n as version, v.excluida, v.motivo, v.clasificada,
  v.bi_dg::text as bi_dg, v.igv_dg::text as igv_dg, v.bi_dgng::text as bi_dgng, v.igv_dgng::text as igv_dgng,
  v.bi_dng::text as bi_dng, v.igv_dng::text as igv_dng, v.no_gravado::text as no_gravado, v.isc::text as isc,
  v.icbper::text as icbper, v.otros_tributos::text as otros_tributos, v.total::text as total`;

/** Unión de una compra con su versión vigente. */
export const UNION_VIGENTE = `compra c join compra_version v on v.tenant_id = c.tenant_id and v.compra_id = c.id
    and v.n = c.version_vigente`;

/** Unión de una compra con su versión 1 (el original). */
export const UNION_ORIGINAL = `compra c join compra_version v on v.tenant_id = c.tenant_id and v.compra_id = c.id and v.n = 1`;

export const montosDe = (f: Fila): MontosCompra => ({
  biDg: f.bi_dg,
  igvDg: f.igv_dg,
  biDgng: f.bi_dgng,
  igvDgng: f.igv_dgng,
  biDng: f.bi_dng,
  igvDng: f.igv_dng,
  noGravado: f.no_gravado,
  isc: f.isc,
  icbper: f.icbper,
  otrosTributos: f.otros_tributos,
  total: f.total,
});

export const aCompraLeida = (f: Fila): CompraLeida => ({
  id: f.id,
  clienteId: f.cliente_id,
  periodo: f.periodo,
  propuestaId: f.propuesta_id,
  origen: f.origen,
  clave: f.clave,
  tipoDoc: f.tipo_doc,
  serie: f.serie,
  numero: f.numero,
  docTipo: f.doc_tipo,
  docNumero: f.doc_numero,
  razonSocial: f.razon_social,
  fecha: f.fecha,
  moneda: f.moneda,
  tipoCambio: f.tipo_cambio,
  version: f.version,
  excluida: f.excluida,
  motivo: f.motivo,
  clasificada: f.clasificada,
  montos: montosDe(f),
});

const aVersion = (f: Fila): VersionFila => ({
  id: f.id,
  compraId: f.compra_id,
  n: f.n,
  montos: montosDe(f),
  excluida: f.excluida,
  motivo: f.motivo,
  clasificada: f.clasificada,
  accion: f.accion,
  operacionId: f.operacion_id,
  usuarioId: f.usuario_id,
  creadaEn: f.creada_en,
});

/** Datos de una versión de una compra ya leída: lo que compara deshacer y rehacer. */
export const datosDe = (c: CompraLeida): DatosVersion => ({
  montos: c.montos,
  excluida: c.excluida,
  motivo: c.motivo,
  clasificada: c.clasificada,
});

/** Igualdad exacta de dos versiones por valor (cadenas, booleanos y motivo). */
const COLUMNAS_COMPARADAS = [...COLUMNAS_MONTO, "total"] as const;

export function mismosDatos(a: DatosVersion, b: DatosVersion): boolean {
  if (
    a.excluida !== b.excluida ||
    a.clasificada !== b.clasificada ||
    a.motivo !== b.motivo
  )
    return false;
  return COLUMNAS_COMPARADAS.every((k) => a.montos[k] === b.montos[k]);
}

const SQL_LEER_UNA = `select ${COLUMNAS_LEIDA} from ${UNION_VIGENTE} where c.id = $1 and c.descartada_en is null`;
const SQL_BLOQUEAR_UNA = `select id from compra where id = $1 and descartada_en is null for update`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const esUuid = (v: unknown): v is string =>
  typeof v === "string" && UUID.test(v);

/**
 * La compra viva con su versión vigente, o `null` si no existe, es de otro estudio (RLS) o está descartada. Con `bloquear` la toma
 * `FOR UPDATE` y la lee DESPUÉS en otra sentencia: así, si otra transacción la movió mientras esperábamos el bloqueo, la lectura
 * ve la versión nueva (leer y bloquear en una sola sentencia con el join descartaría la fila en vez de devolverla actualizada).
 */
export async function leerCompra(
  tx: TxConsulta,
  compraId: string,
  bloquear: boolean,
): Promise<CompraLeida | null> {
  if (!esUuid(compraId)) return null;
  if (bloquear) {
    const b = await consultar(tx, SQL_BLOQUEAR_UNA, [compraId]);
    if (b.rowCount === 0) return null;
  }
  const r = await consultar(tx, SQL_LEER_UNA, [compraId]);
  return r.rows[0] ? aCompraLeida(r.rows[0]) : null;
}

const SQL_BLOQUEAR_VARIAS = `select id from compra
  where id = any($1::uuid[]) and cliente_id = $2 and periodo = $3 and descartada_en is null order by id for update`;
// La versión vigente de cada compra se busca por su clave única con LATERAL … OFFSET 0: así el plan no depende de las
// estadísticas (recién cargado un periodo de miles de filas, sin ANALYZE, el planificador recorría el índice de versiones
// una vez por compra y 5.000 ids tardaban segundos; mismo caso que la lectura de T15).
const SQL_LEER_VARIAS = `select ${COLUMNAS_LEIDA} from compra c
  join lateral (select * from compra_version v where v.tenant_id = c.tenant_id and v.compra_id = c.id
    and v.n = c.version_vigente offset 0) v on true
  where c.id = any($1::uuid[]) and c.cliente_id = $2 and c.periodo = $3 and c.descartada_en is null order by c.id`;

/**
 * Las compras vivas de un cliente y periodo (con su versión vigente) bloqueadas `FOR UPDATE` en orden de id ascendente, que es
 * el último paso del orden de bloqueo. Las que no existen, son de otro cliente, periodo o estudio, o están descartadas, no salen.
 */
export async function bloquearCompras(
  tx: TxConsulta,
  ids: string[],
  clienteId: string,
  periodo: string,
): Promise<CompraLeida[]> {
  if (ids.length === 0) return [];
  await consultar(tx, SQL_BLOQUEAR_VARIAS, [ids, clienteId, periodo]);
  const r = await consultar(tx, SQL_LEER_VARIAS, [ids, clienteId, periodo]);
  return r.rows.map(aCompraLeida);
}

/** Una compra a la que se le escribe una versión nueva (la compra ya está leída y bloqueada). */
export interface VersionPorEscribir {
  /** La compra tal como se leyó (su `version` es la que se reemplaza). */
  compra: CompraLeida;
  n: number;
  datos: DatosVersion;
  accion: string;
  operacionId: string | null;
  usuarioId: string | null;
}

const SQL_MOVER_PUNTEROS = `update compra c set version_vigente = x.n
  from jsonb_to_recordset($1::jsonb) as x(id uuid, base int, n int)
  where c.id = x.id and c.version_vigente = x.base`;

/** Mueve los punteros con compare-and-set. Las filas ya están bloqueadas, así que un desajuste es un error interno. */
export async function moverPunteros(
  tx: TxConsulta,
  lote: VersionPorEscribir[],
): Promise<void> {
  for (let i = 0; i < lote.length; i += LOTE) {
    const parte = lote.slice(i, i + LOTE);
    const r = await consultar(tx, SQL_MOVER_PUNTEROS, [
      JSON.stringify(
        parte.map((p) => ({ id: p.compra.id, base: p.compra.version, n: p.n })),
      ),
    ]);
    // 40001 (serialization_failure): la fila cambió a pesar del bloqueo; la tx se revierte entera.
    if (r.rowCount !== parte.length) throw new ComprasRepoError("40001");
  }
}

const SQL_INSERTAR_VERSIONES_SIN_RETORNO = `insert into compra_version (compra_id, n, ${MONTOS_SQL}, excluida, motivo, clasificada, accion,
    operacion_id, usuario_id)
  select x.compra_id, x.n, ${MONTOS_CAST}, x.excluida, x.motivo, x.clasificada, x.accion, x.operacion_id, x.usuario_id
    from jsonb_to_recordset($1::jsonb) as x(compra_id uuid, n int, ${MONTOS_ENTRADA}, excluida boolean, motivo text,
      clasificada boolean, accion text, operacion_id uuid, usuario_id uuid)`;

const SQL_INSERTAR_VERSIONES = `${SQL_INSERTAR_VERSIONES_SIN_RETORNO}
  returning id, compra_id, n, ${MONTOS_TEXTO}, excluida, motivo, clasificada, accion, operacion_id, usuario_id, creada_en`;

/**
 * Una fila de `compra_version` por entrada, devueltas en el orden de `lote`. Con `devolver = false` no se leen de vuelta (salen
 * `[]`): quien llama con miles de filas y no usa las versiones se ahorra el `RETURNING` y su lectura.
 */
export async function insertarVersiones(
  tx: TxConsulta,
  lote: VersionPorEscribir[],
  devolver = true,
): Promise<VersionFila[]> {
  const salida: VersionFila[] = [];
  for (let i = 0; i < lote.length; i += LOTE) {
    const parte = lote.slice(i, i + LOTE);
    const r = await consultar(
      tx,
      devolver ? SQL_INSERTAR_VERSIONES : SQL_INSERTAR_VERSIONES_SIN_RETORNO,
      [
        JSON.stringify(
          parte.map((p) => ({
            compra_id: p.compra.id,
            n: p.n,
            bi_dg: p.datos.montos.biDg,
            igv_dg: p.datos.montos.igvDg,
            bi_dgng: p.datos.montos.biDgng,
            igv_dgng: p.datos.montos.igvDgng,
            bi_dng: p.datos.montos.biDng,
            igv_dng: p.datos.montos.igvDng,
            no_gravado: p.datos.montos.noGravado,
            isc: p.datos.montos.isc,
            icbper: p.datos.montos.icbper,
            otros_tributos: p.datos.montos.otrosTributos,
            total: p.datos.montos.total,
            excluida: p.datos.excluida,
            motivo: p.datos.motivo,
            clasificada: p.datos.clasificada,
            accion: p.accion,
            operacion_id: p.operacionId,
            usuario_id: p.usuarioId,
          })),
        ),
      ],
    );
    if (!devolver) continue;
    const porCompra = new Map(
      r.rows.map((f) => [f.compra_id as string, aVersion(f)]),
    );
    for (const p of parte) salida.push(porCompra.get(p.compra.id)!);
  }
  return salida;
}

const SQL_INSERTAR_HALLAZGOS = `insert into compra_hallazgo (compra_id, version_n, evaluacion_n, regla, sugerencia, lecturas,
    requiere_confirmacion)
  select x.compra_id, x.version_n, x.evaluacion_n, x.regla, x.sugerencia, x.lecturas, x.requiere_confirmacion
    from jsonb_to_recordset($1::jsonb) as x(compra_id uuid, version_n int, evaluacion_n int, regla text, sugerencia jsonb,
      lecturas jsonb, requiere_confirmacion boolean)`;

const SQL_INSERTAR_EVALUACIONES = `insert into compra_evaluacion (compra_id, version_n, n, documento_xml_id)
  select x.compra_id, x.version_n, x.n, x.documento_xml_id
    from jsonb_to_recordset($1::jsonb) as x(compra_id uuid, version_n int, n int, documento_xml_id uuid)`;

/** La compra tal como queda con la versión nueva: es lo que `evaluar` recibe (con su XML). */
export const conVersion = (
  compra: CompraLeida,
  n: number,
  datos: DatosVersion,
): CompraLeida => ({
  ...compra,
  version: n,
  excluida: datos.excluida,
  motivo: datos.motivo,
  clasificada: datos.clasificada,
  montos: datos.montos,
});

/** La fila más su XML vigente (016): lo que reciben `evaluar` y `transformar`. */
export const conXml = (
  compra: CompraLeida,
  xml: XmlParaEvaluar | null,
): CompraConXml => ({ ...compra, xml });

/** Una evaluación por escribir: la versión, su número de evaluación y el XML con el que se evaluó. */
export interface EvaluacionPorEscribir {
  fila: CompraLeida;
  n: number;
  xml: { id: string; xml: XmlParaEvaluar } | null;
}

/** Un hallazgo por guardar, con la versión y la evaluación a la que pertenece. */
interface HallazgoPorGuardar {
  compra_id: string;
  version_n: number;
  evaluacion_n: number;
  hallazgo: HallazgoNuevo;
}

/** Inserta las filas de `compra_evaluacion` (no dependen del resultado de `evaluar`). */
async function insertarEvaluaciones(
  tx: TxConsulta,
  lote: EvaluacionPorEscribir[],
): Promise<void> {
  for (let i = 0; i < lote.length; i += LOTE) {
    await consultar(tx, SQL_INSERTAR_EVALUACIONES, [
      JSON.stringify(
        lote.slice(i, i + LOTE).map((e) => ({
          compra_id: e.fila.id,
          version_n: e.fila.version,
          n: e.n,
          documento_xml_id: e.xml?.id ?? null,
        })),
      ),
    ]);
  }
}

/** Ms de cómputo seguidos que `evaluarFilas` se permite antes de ceder el hilo (para que el socket de la BD se atienda). */
const REBANADA_MS = 2;

/**
 * Llama a `evaluar` con cada fila y su XML (en orden). Con `ceder`, cada `REBANADA_MS` devuelve el hilo al bucle de eventos: así
 * una escritura en curso en la misma transacción sigue avanzando mientras se evalúa (el cómputo se solapa con la BD).
 */
async function evaluarFilas(
  lote: EvaluacionPorEscribir[],
  evaluar: Evaluar,
  ceder: boolean,
): Promise<HallazgoPorGuardar[]> {
  const hallazgos: HallazgoPorGuardar[] = [];
  let desde = performance.now();
  for (const e of lote) {
    const encontrados =
      (await evaluar(conXml(e.fila, e.xml?.xml ?? null))) ?? [];
    for (const h of encontrados)
      hallazgos.push({
        compra_id: e.fila.id,
        version_n: e.fila.version,
        evaluacion_n: e.n,
        hallazgo: h,
      });
    if (ceder && performance.now() - desde >= REBANADA_MS) {
      await new Promise<void>((seguir) => setImmediate(seguir));
      desde = performance.now();
    }
  }
  return hallazgos;
}

async function insertarHallazgos(
  tx: TxConsulta,
  hallazgos: HallazgoPorGuardar[],
): Promise<void> {
  for (let i = 0; i < hallazgos.length; i += LOTE) {
    await consultar(tx, SQL_INSERTAR_HALLAZGOS, [
      JSON.stringify(
        hallazgos.slice(i, i + LOTE).map((h) => ({
          compra_id: h.compra_id,
          version_n: h.version_n,
          evaluacion_n: h.evaluacion_n,
          regla: h.hallazgo.regla,
          sugerencia: h.hallazgo.sugerencia ?? null,
          lecturas: h.hallazgo.lecturas,
          requiere_confirmacion: h.hallazgo.requiereConfirmacion,
        })),
      ),
    ]);
  }
}

/**
 * Inserta cada evaluación (`compra_evaluacion`), llama a `evaluar` con la fila y su XML (en orden) y guarda los hallazgos con
 * `version_n` y `evaluacion_n`. Si `evaluar` lanza, se propaga y la transacción de quien llama se revierte entera.
 */
export async function guardarEvaluaciones(
  tx: TxConsulta,
  lote: EvaluacionPorEscribir[],
  evaluar: Evaluar,
): Promise<void> {
  await insertarEvaluaciones(tx, lote);
  await insertarHallazgos(tx, await evaluarFilas(lote, evaluar, false));
}

/** El XML vigente de cada compra del lote, leído ahora (después de que quien llama bloqueó las filas). */
export const xmlDeCompras = (tx: TxConsulta, compras: CompraLeida[]) =>
  leerXmlVigentesDeCompras(
    tx,
    compras.map((c) => ({
      compraId: c.id,
      clienteId: c.clienteId,
      tipoDoc: c.tipoDoc,
      serie: c.serie,
      numero: c.numero,
      docNumero: c.docNumero,
    })),
  );

/**
 * Evalúa cada compra con su versión nueva (en orden) en su evaluación 1 (016 D-5) y guarda los hallazgos. Es el único punto de
 * escritura de versiones: cada versión nueva se evalúa con el XML vigente del comprobante, leído en esta transacción después del
 * bloqueo de la fila (así una edición y la llegada del XML convergen en cualquier orden, CA-8). Los hallazgos y evaluaciones de
 * versiones anteriores no se tocan. Si `evaluar` lanza, se propaga y la transacción de quien llama se revierte entera.
 */
export async function evaluarYGuardar(
  tx: TxConsulta,
  lote: VersionPorEscribir[],
  evaluar: Evaluar,
): Promise<void> {
  if (lote.length === 0) return;
  const xmls = await xmlDeCompras(
    tx,
    lote.map((p) => p.compra),
  );
  await guardarEvaluaciones(
    tx,
    lote.map((p) => ({
      fila: conVersion(p.compra, p.n, p.datos),
      n: 1,
      xml: xmls.get(p.compra.id) ?? null,
    })),
    evaluar,
  );
}

/**
 * Escribe un lote de versiones de compras ya bloqueadas: mueve los punteros, inserta, evalúa y guarda los hallazgos. Con
 * `devolver = false` no lee de vuelta las versiones insertadas (salen `[]`).
 *
 * Las sentencias que no dependen de `evaluar` (versiones, punteros y evaluaciones) corren en la BD mientras `evaluar` calcula los
 * hallazgos de todo el lote: el cómputo y la BD se solapan en vez de sumarse. Las sentencias siguen siendo las mismas, con el
 * mismo texto y en el orden de siempre (versiones antes que punteros, evaluaciones después de las versiones, hallazgos después
 * de las evaluaciones); si `evaluar` o una sentencia falla se propaga el primer error y la transacción de quien llama se revierte.
 */
export async function escribirVersiones(
  tx: TxConsulta,
  lote: VersionPorEscribir[],
  evaluar: Evaluar,
  devolver = true,
): Promise<VersionFila[]> {
  if (lote.length === 0) return [];
  // El XML vigente se lee con las filas ya bloqueadas por quien llama y antes de escribir; las escrituras no lo cambian.
  const xmls = await xmlDeCompras(
    tx,
    lote.map((p) => p.compra),
  );
  const evaluaciones = lote.map(
    (p): EvaluacionPorEscribir => ({
      fila: conVersion(p.compra, p.n, p.datos),
      n: 1,
      xml: xmls.get(p.compra.id) ?? null,
    }),
  );
  // Primero las versiones y después los punteros: el trigger de `compra` exige que la versión vigente exista (H-014-6).
  const escritura = (async () => {
    const versiones = await insertarVersiones(tx, lote, devolver);
    await moverPunteros(tx, lote);
    await insertarEvaluaciones(tx, evaluaciones);
    return versiones;
  })();
  // Si `evaluar` falla primero, el error de la escritura (si lo hay) no debe quedar sin atender.
  escritura.catch(() => undefined);
  let hallazgos: HallazgoPorGuardar[];
  try {
    hallazgos = await evaluarFilas(evaluaciones, evaluar, true);
  } catch (e) {
    await escritura.catch(() => undefined); // que ninguna sentencia siga en vuelo cuando quien llama revierta
    throw e;
  }
  const versiones = await escritura;
  await insertarHallazgos(tx, hallazgos);
  return versiones;
}

const SQL_BLOQUEAR_DESHECHAS = `select id from compra_operacion
  where cliente_id = $1 and periodo = $2 and usuario_id = $3 and estado = 'deshecha' order by id for update`;

/** Primer paso del orden de bloqueo de una acción: las operaciones `deshecha` del usuario que la acción va a caducar. */
export async function bloquearDeshechas(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  usuarioId: string,
): Promise<void> {
  await consultar(tx, SQL_BLOQUEAR_DESHECHAS, [clienteId, periodo, usuarioId]);
}

const SQL_CADUCAR = `update compra_operacion set estado = 'caducada'
  where cliente_id = $1 and periodo = $2 and usuario_id = $3 and estado = 'deshecha'`;

/** Una operación nueva del usuario caduca lo que había deshecho: rehacer vale solo hasta la siguiente acción. */
export async function caducarDeshechas(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  usuarioId: string,
): Promise<void> {
  await consultar(tx, SQL_CADUCAR, [clienteId, periodo, usuarioId]);
}

const SQL_CREAR_OPERACION = `insert into compra_operacion (cliente_id, periodo, usuario_id, tipo, estado, referencia_id)
  values ($1, $2, $3, $4, 'vigente', $5) returning id`;

export async function crearOperacion(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  usuarioId: string,
  tipo: string,
  referenciaId: string | null,
): Promise<string> {
  const r = await consultar(tx, SQL_CREAR_OPERACION, [
    clienteId,
    periodo,
    usuarioId,
    tipo,
    referenciaId,
  ]);
  return r.rows[0]!.id as string;
}
