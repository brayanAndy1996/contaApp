// Acciones de fila y masivas con operación, deshacer y rehacer (spec 014, D-2, D-6, D-14, D-15, DU-5, DU-14). Cada una arma una
// `compra_operacion` del usuario (la pila de deshacer vive en la BD) y escribe versiones nuevas; nada se borra ni se actualiza.
// `packages/db` no sabe de reglas ni de edición: `transformar` (el cálculo de la versión nueva) y `evaluar` (las reglas) las
// inyecta quien llama.
//
// ORDEN DE BLOQUEO (el mismo en todas, para no dar interbloqueos): [advisory y `compra_periodo`: los toma quien llama] ->
// `compra_operacion` (las `deshecha` del usuario, o la operación que se deshace) -> `compra` por id ascendente.
import {
  consultar,
  ComprasReglaError,
  type Fila,
  type TxConsulta,
} from "./errores";
import {
  bloquearCompras,
  bloquearDeshechas,
  caducarDeshechas,
  crearOperacion,
  datosDe,
  escribirVersiones,
  esUuid,
  leerCompra,
  mismosDatos,
  montosDe,
  type VersionPorEscribir,
} from "./repositorio";
import type {
  CompraLeida,
  DatosVersion,
  Evaluar,
  ResultadoAccion,
  ResultadoMasiva,
  ResultadoPila,
  Transformar,
} from "./tipos";

interface Funciones {
  transformar: Transformar;
  evaluar: Evaluar;
}

/** Valida la fila contra el estado actual y calcula la versión nueva; devuelve los datos o el código de rechazo. */
async function calcular(
  actual: CompraLeida,
  versionBase: number,
  accion: string,
  parametros: unknown,
  transformar: Transformar,
): Promise<
  { datos: DatosVersion } | { codigo: string; versionVigente?: number }
> {
  if (actual.version !== versionBase)
    return { codigo: "version_obsoleta", versionVigente: actual.version };
  if (actual.excluida && accion !== "restaurar")
    return { codigo: "fila_excluida" };
  const r = await transformar(actual, parametros);
  if ("rechazo" in r) return { codigo: r.rechazo };
  return { datos: r };
}

/**
 * Una acción sobre una fila (clasificar, editar, aceptar sugerencia, excluir, restaurar): una operación nueva del usuario y la
 * versión nueva con su `operacion_id`. Las operaciones `deshecha` del usuario en ese cliente y periodo pasan a `caducada`.
 * Errores (ComprasReglaError): `no_encontrada`, `version_obsoleta`, `fila_excluida` (salvo restaurar) y el `rechazo` de
 * `transformar`; ninguno escribe nada.
 */
export async function aplicarAccion(
  tx: TxConsulta,
  e: {
    compraId: string;
    versionBase: number;
    accion: string;
    parametros: unknown;
    usuarioId: string;
  },
  f: Funciones,
): Promise<ResultadoAccion> {
  // Se necesita el cliente y el periodo para bloquear primero las operaciones; esta lectura no bloquea.
  const previa = await leerCompra(tx, e.compraId, false);
  if (!previa) throw new ComprasReglaError("no_encontrada");
  await bloquearDeshechas(tx, previa.clienteId, previa.periodo, e.usuarioId);
  const actual = await leerCompra(tx, e.compraId, true);
  if (!actual) throw new ComprasReglaError("no_encontrada");
  const r = await calcular(
    actual,
    e.versionBase,
    e.accion,
    e.parametros,
    f.transformar,
  );
  if ("codigo" in r) {
    throw new ComprasReglaError(
      r.codigo,
      r.versionVigente === undefined
        ? {}
        : { versionVigente: r.versionVigente },
    );
  }
  await caducarDeshechas(tx, actual.clienteId, actual.periodo, e.usuarioId);
  const operacionId = await crearOperacion(
    tx,
    actual.clienteId,
    actual.periodo,
    e.usuarioId,
    e.accion,
    null,
  );
  const [version] = await escribirVersiones(
    tx,
    [
      {
        compra: actual,
        n: actual.version + 1,
        datos: r.datos,
        accion: e.accion,
        operacionId,
        usuarioId: e.usuarioId,
      },
    ],
    f.evaluar,
  );
  return { operacionId, version: version! };
}

/**
 * Acción masiva parcial (D-15, DU-5): bloquea las filas en orden de id (sea cual sea el orden de `items`) y aplica a cada una lo
 * mismo que `aplicarAccion`; las que no se pueden quedan en `rechazadas` con su código y no escriben. Las válidas forman UNA
 * operación y todas sus versiones llevan ese `operacion_id`. Sin ninguna aplicada: `operacionId` null y nada escrito. Una compra
 * de otro estudio, cliente o periodo, inexistente o descartada es `no_encontrada`. Si `transformar` o `evaluar` lanzan, la
 * llamada falla entera.
 */
export async function aplicarMasiva(
  tx: TxConsulta,
  e: {
    clienteId: string;
    periodo: string;
    usuarioId: string;
    accion: string;
    parametros: unknown;
    items: { compraId: string; versionBase: number }[];
  },
  f: Funciones,
): Promise<ResultadoMasiva> {
  // Una misma compra repetida en `items` cuenta una vez (la primera).
  const pedidas = new Map<string, { compraId: string; versionBase: number }>();
  for (const it of e.items) {
    const k = typeof it.compraId === "string" ? it.compraId.toLowerCase() : "";
    if (!pedidas.has(k)) pedidas.set(k, it);
  }
  const rechazo = new Map<string, string>();
  const validas: string[] = [];
  for (const [k, it] of pedidas) {
    if (esUuid(it.compraId)) validas.push(k);
    else rechazo.set(k, "no_encontrada");
  }

  await bloquearDeshechas(tx, e.clienteId, e.periodo, e.usuarioId);
  const filas = await bloquearCompras(tx, validas, e.clienteId, e.periodo);

  const plan: { compra: CompraLeida; datos: DatosVersion }[] = [];
  const encontradas = new Set<string>();
  for (const compra of filas) {
    encontradas.add(compra.id);
    const it = pedidas.get(compra.id)!;
    const r = await calcular(
      compra,
      it.versionBase,
      e.accion,
      e.parametros,
      f.transformar,
    );
    if ("codigo" in r) rechazo.set(compra.id, r.codigo);
    else plan.push({ compra, datos: r.datos });
  }
  for (const k of validas)
    if (!encontradas.has(k)) rechazo.set(k, "no_encontrada");

  const rechazadas = [...pedidas]
    .filter(([k]) => rechazo.has(k))
    .map(([k, it]) => ({ compraId: it.compraId, codigo: rechazo.get(k)! }));
  if (plan.length === 0) return { operacionId: null, aplicadas: 0, rechazadas };

  await caducarDeshechas(tx, e.clienteId, e.periodo, e.usuarioId);
  const operacionId = await crearOperacion(
    tx,
    e.clienteId,
    e.periodo,
    e.usuarioId,
    e.accion,
    null,
  );
  await escribirVersiones(
    tx,
    plan.map((p): VersionPorEscribir => ({
      compra: p.compra,
      n: p.compra.version + 1,
      datos: p.datos,
      accion: e.accion,
      operacionId,
      usuarioId: e.usuarioId,
    })),
    f.evaluar,
  );
  return { operacionId, aplicadas: plan.length, rechazadas };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Deshacer y rehacer

const SQL_ULTIMA_VIGENTE = `select id from compra_operacion
  where cliente_id = $1 and periodo = $2 and usuario_id = $3 and estado = 'vigente' and tipo not in ('deshacer', 'rehacer')
  order by creada_en desc, id desc limit 1 for update`;

const SQL_ULTIMA_DESHECHA = `select id from compra_operacion
  where cliente_id = $1 and periodo = $2 and usuario_id = $3 and estado = 'deshecha' and tipo not in ('deshacer', 'rehacer')
  order by deshecha_en desc, id desc limit 1 for update`;

const COLUMNAS_VERSION = `v.compra_id, v.n, v.excluida, v.motivo, v.clasificada, v.bi_dg::text as bi_dg,
  v.igv_dg::text as igv_dg, v.bi_dgng::text as bi_dgng, v.igv_dgng::text as igv_dgng, v.bi_dng::text as bi_dng,
  v.igv_dng::text as igv_dng, v.no_gravado::text as no_gravado, v.isc::text as isc, v.icbper::text as icbper,
  v.otros_tributos::text as otros_tributos, v.total::text as total`;

// Lo que escribió la operación y la versión inmediatamente anterior de cada fila (la que existía antes de ella).
const SQL_VERSIONES_DE_OPERACION = `select ${COLUMNAS_VERSION} from compra_version v where v.operacion_id = $1 order by v.compra_id`;
// La anterior se busca por su clave única con LATERAL … OFFSET 0: el plan no depende de las estadísticas (con las tablas recién
// cargadas, sin ANALYZE, el planificador recorría el índice de versiones una vez por fila y 5.000 filas tardaban decenas de s).
const SQL_VERSIONES_PREVIAS = `select ${COLUMNAS_VERSION} from compra_version o
  join lateral (select * from compra_version v where v.tenant_id = o.tenant_id and v.compra_id = o.compra_id
    and v.n = o.n - 1 offset 0) v on true
  where o.operacion_id = $1 order by v.compra_id`;

const SQL_MARCAR_DESHECHA = `update compra_operacion set estado = 'deshecha', deshecha_en = now() where id = $1`;
const SQL_MARCAR_VIGENTE = `update compra_operacion set estado = 'vigente', deshecha_en = null where id = $1`;

const aDatos = (f: Fila): DatosVersion => ({
  montos: montosDe(f),
  excluida: f.excluida,
  motivo: f.motivo,
  clasificada: f.clasificada,
});

type Sentido = "deshacer" | "rehacer";

/**
 * Revierte (`deshacer`) o repone (`rehacer`) una operación del usuario sin tocar la historia: escribe por cada fila UNA versión
 * nueva que copia los valores de la versión anterior a la operación (deshacer) o los que la operación dejó (rehacer), con el
 * `operacion_id` de una operación nueva (tipo `deshacer`/`rehacer`, `referencia_id` = la operación tratada).
 *
 * «La fila sigue como la dejó la operación» se decide por VALOR (los montos, la exclusión, el motivo y la clasificación de la
 * versión vigente son los que dejó la operación) y no por número de versión: así las versiones que escribe deshacer/rehacer sobre
 * una fila no cuentan como un cambio ajeno y la pila de dos niveles sobre la misma fila funciona (ambigüedad 1 de T6, D-14). Si
 * alguna fila difiere, `fila_cambiada` con los ids y no se escribe nada.
 */
async function revertir(
  tx: TxConsulta,
  e: { clienteId: string; periodo: string; usuarioId: string },
  f: { evaluar: Evaluar },
  sentido: Sentido,
): Promise<ResultadoPila> {
  const ultima = await consultar(
    tx,
    sentido === "deshacer" ? SQL_ULTIMA_VIGENTE : SQL_ULTIMA_DESHECHA,
    [e.clienteId, e.periodo, e.usuarioId],
  );
  const operacion = ultima.rows[0]?.id as string | undefined;
  if (!operacion)
    throw new ComprasReglaError(
      sentido === "deshacer" ? "nada_que_deshacer" : "nada_que_rehacer",
    );

  const dejo = new Map(
    (await consultar(tx, SQL_VERSIONES_DE_OPERACION, [operacion])).rows.map(
      (r) => [r.compra_id as string, aDatos(r)],
    ),
  );
  const antes = new Map(
    (await consultar(tx, SQL_VERSIONES_PREVIAS, [operacion])).rows.map((r) => [
      r.compra_id as string,
      aDatos(r),
    ]),
  );
  // Qué debe tener hoy la fila para poder tratarla, y qué se escribe.
  const esperado = sentido === "deshacer" ? dejo : antes;
  const destino = sentido === "deshacer" ? antes : dejo;

  const filas = await bloquearCompras(
    tx,
    [...dejo.keys()],
    e.clienteId,
    e.periodo,
  );
  const vigentes = new Map(filas.map((c) => [c.id, c]));
  const cambiadas = [...dejo.keys()].filter((id) => {
    const c = vigentes.get(id);
    const quiere = esperado.get(id);
    return !c || !quiere || !mismosDatos(datosDe(c), quiere);
  });
  if (cambiadas.length > 0)
    throw new ComprasReglaError("fila_cambiada", { ids: cambiadas });

  const nueva = await crearOperacion(
    tx,
    e.clienteId,
    e.periodo,
    e.usuarioId,
    sentido,
    operacion,
  );
  const lote: VersionPorEscribir[] = filas.map((compra) => ({
    compra,
    n: compra.version + 1,
    datos: destino.get(compra.id)!,
    accion: sentido,
    operacionId: nueva,
    usuarioId: e.usuarioId,
  }));
  await escribirVersiones(tx, lote, f.evaluar);
  await consultar(
    tx,
    sentido === "deshacer" ? SQL_MARCAR_DESHECHA : SQL_MARCAR_VIGENTE,
    [operacion],
  );
  return { operacionId: nueva, filas: lote.length };
}

/** Deshace la última operación `vigente` del propio usuario en ese cliente y periodo (una masiva es un paso). */
export function deshacer(
  tx: TxConsulta,
  e: { clienteId: string; periodo: string; usuarioId: string },
  f: { evaluar: Evaluar },
): Promise<ResultadoPila> {
  return revertir(tx, e, f, "deshacer");
}

/** Repone la última operación `deshecha` del usuario (vale hasta su siguiente acción nueva, que la caduca). */
export function rehacer(
  tx: TxConsulta,
  e: { clienteId: string; periodo: string; usuarioId: string },
  f: { evaluar: Evaluar },
): Promise<ResultadoPila> {
  return revertir(tx, e, f, "rehacer");
}

const SQL_FILAS_DE_OPERACION = `select distinct compra_id from compra_version where operacion_id = $1 order by compra_id`;

/** Ids de las compras que una operación (acción, masiva, deshacer o rehacer) dejó con una versión nueva, por id ascendente. */
export async function leerCompraIdsDeOperacion(
  tx: TxConsulta,
  operacionId: string,
): Promise<string[]> {
  if (!esUuid(operacionId)) return [];
  const r = await consultar(tx, SQL_FILAS_DE_OPERACION, [operacionId]);
  return r.rows.map((f) => f.compra_id as string);
}
