// Versiones de compras (spec 014, D-1, D-2, D-4, D-7). `crearVersion` es el ÚNICO punto de escritura de una versión de una compra
// existente: comprueba la versión base, inserta la n+1, mueve el puntero con compare-and-set, re-evalúa la fila con la función
// inyectada y guarda sus hallazgos, todo en la transacción de `withTenant`. `packages/db` no sabe de reglas: recibe `evaluar`.
import { aplicarReglaHistorial } from "../reglas/aplicar";
import { consultar, ComprasReglaError, type TxConsulta } from "./errores";
import {
  escribirVersiones,
  esUuid,
  evaluarYGuardar,
  insertarVersiones,
  leerCompra,
  LOTE,
  type VersionPorEscribir,
} from "./repositorio";
import type {
  CompraLeida,
  CompraNueva,
  DatosVersion,
  Evaluar,
  IdentidadCompra,
  MontosCompra,
  VersionFila,
} from "./tipos";

export interface EntradaCrearVersion {
  compraId: string;
  /** Versión que el usuario vio; si ya no es la vigente, `version_obsoleta` y no se escribe nada. */
  versionBase: number;
  datos: DatosVersion;
  accion: string;
  usuarioId: string;
  operacionId?: string | null;
}

/**
 * Crea la versión n+1 de una compra viva. Errores (ComprasReglaError): `version_obsoleta` con `versionVigente`, o `no_encontrada`
 * (inexistente, de otro estudio o descartada: el mismo código, sin revelar). Si `evaluar` lanza, no queda nada escrito.
 */
export async function crearVersion(
  tx: TxConsulta,
  e: EntradaCrearVersion,
  f: { evaluar: Evaluar },
): Promise<VersionFila> {
  const actual = await leerCompra(tx, e.compraId, true);
  if (!actual) throw new ComprasReglaError("no_encontrada");
  if (actual.version !== e.versionBase) {
    throw new ComprasReglaError("version_obsoleta", {
      versionVigente: actual.version,
    });
  }
  const [version] = await escribirVersiones(
    tx,
    [
      {
        compra: actual,
        n: actual.version + 1,
        datos: e.datos,
        accion: e.accion,
        operacionId: e.operacionId ?? null,
        usuarioId: e.usuarioId,
      },
    ],
    f.evaluar,
  );
  return version!;
}

const SQL_INSERTAR_COMPRAS = `insert into compra (cliente_id, periodo, propuesta_id, clave, tipo_doc, serie, numero, doc_tipo,
    doc_numero, razon_social, fecha, moneda, tipo_cambio, origen, version_vigente)
  select $1::uuid, $2::char(6), $3::uuid, x.clave, x.tipo_doc, x.serie, x.numero, x.doc_tipo, x.doc_numero, x.razon_social,
         x.fecha::date, x.moneda, x.tipo_cambio::numeric, $4::text, 1
    from jsonb_to_recordset($5::jsonb) as x(clave text, tipo_doc text, serie text, numero text, doc_tipo text,
      doc_numero text, razon_social text, fecha text, moneda text, tipo_cambio text)
  returning id, clave`;

const SQL_AGREGAR = `insert into compra (cliente_id, periodo, propuesta_id, clave, tipo_doc, serie, numero, doc_tipo,
    doc_numero, razon_social, fecha, moneda, tipo_cambio, origen, version_vigente)
  values ($1, $2, null, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, $12::numeric, 'agregada', 1)
  on conflict (tenant_id, cliente_id, periodo, clave) where descartada_en is null do nothing
  returning id`;

const SQL_VIVA_POR_CLAVE = `select id from compra where cliente_id = $1 and periodo = $2 and clave = $3 and descartada_en is null`;

const datosOriginales = (m: MontosCompra): DatosVersion => ({
  montos: m,
  excluida: false,
  motivo: null,
  clasificada: false,
});

const comoLeida = (
  id: string,
  clienteId: string,
  periodo: string,
  propuestaId: string | null,
  origen: "sire" | "agregada",
  i: IdentidadCompra,
  datos: DatosVersion,
): CompraLeida => ({
  ...i,
  id,
  clienteId,
  periodo,
  origen,
  propuestaId,
  version: 1,
  excluida: datos.excluida,
  motivo: datos.motivo,
  clasificada: datos.clasificada,
  montos: datos.montos,
});

/** Alta manual (D-7): compra `agregada` con su versión 1 (acción `agregada`), sin operación y sin propuesta. */
export async function agregarCompra(
  tx: TxConsulta,
  e: {
    clienteId: string;
    periodo: string;
    usuarioId: string;
    identidad: IdentidadCompra;
    montos: MontosCompra;
    /** Acción de la versión 1; por omisión `agregada`, una de `ACCIONES_VERSION` de `shared`. */
    accion?: string;
  },
  f: { evaluar: Evaluar },
): Promise<{ id: string; version: VersionFila }> {
  const i = e.identidad;
  const r = await consultar(tx, SQL_AGREGAR, [
    e.clienteId,
    e.periodo,
    i.clave,
    i.tipoDoc,
    i.serie,
    i.numero,
    i.docTipo,
    i.docNumero,
    i.razonSocial,
    i.fecha,
    i.moneda,
    i.tipoCambio,
  ]);
  if (r.rowCount === 0) {
    // Clave viva repetida (sire, excluida o agregada). Si la otra transacción ya confirmó, la vemos; la que perdió la carrera
    // espera su confirmación en el INSERT y llega aquí con la fila visible.
    const viva = await consultar(tx, SQL_VIVA_POR_CLAVE, [
      e.clienteId,
      e.periodo,
      i.clave,
    ]);
    throw new ComprasReglaError("duplicado", {
      ids: viva.rows.map((x) => x.id as string),
    });
  }
  const id = r.rows[0]!.id as string;
  const datos = datosOriginales(e.montos);
  const compra = comoLeida(
    id,
    e.clienteId,
    e.periodo,
    null,
    "agregada",
    i,
    datos,
  );
  const lote: VersionPorEscribir[] = [
    {
      compra,
      n: 1,
      datos,
      accion: e.accion ?? "agregada",
      operacionId: null,
      usuarioId: e.usuarioId,
    },
  ];
  const [version] = await insertarVersiones(tx, lote);
  await evaluarYGuardar(tx, lote, f.evaluar);
  return { id, version: version! };
}

const SQL_BLOQUEAR_DESCARTAR = `select id, origen, version_vigente from compra where id = $1 and descartada_en is null for update`;
const SQL_DESCARTAR = `update compra set descartada_en = now() where id = $1 and version_vigente = $2`;

/**
 * Descarta una agregada (D-7): la fila se conserva con `descartada_en`, su clave queda libre y no se crea versión ni operación.
 * `no_descartable` (de SIRE: se excluye, no se descarta), `version_obsoleta` y `no_encontrada`.
 */
export async function descartar(
  tx: TxConsulta,
  e: { compraId: string; versionBase: number; usuarioId: string },
): Promise<void> {
  if (!esUuid(e.compraId)) throw new ComprasReglaError("no_encontrada");
  const r = await consultar(tx, SQL_BLOQUEAR_DESCARTAR, [e.compraId]);
  const fila = r.rows[0];
  if (!fila) throw new ComprasReglaError("no_encontrada");
  if (fila.origen !== "agregada") throw new ComprasReglaError("no_descartable");
  if (fila.version_vigente !== e.versionBase) {
    throw new ComprasReglaError("version_obsoleta", {
      versionVigente: fila.version_vigente as number,
    });
  }
  await consultar(tx, SQL_DESCARTAR, [e.compraId, e.versionBase]);
}

/**
 * R-HIS en la descarga (spec 021, D-7): para una compra nueva (su versión 1), la regla aprendida que la mueve y la versión 1
 * consolidada en su destino, o `null` si no se aplica. La decide el dominio (`planificarHistorial`) y entra inyectada.
 */
export type HistorialDescarga = (
  fila: CompraLeida,
) => { reglaId: string; datos: MontosCompra } | null;

/**
 * Inserta las compras que trae una descarga (D-3, para el persistidor): origen `sire` con su propuesta, versión 1 (acción
 * `original`) de cada una, y evalúa cada una guardando sus hallazgos con `version_n` = 1. Devuelve los ids en el orden de `nuevas`.
 * Todo o nada con la transacción; una clave viva repetida (en el lote o ya existente) lanza `ComprasRepoError` 23505 y un monto
 * que no cabe en NUMERIC(14,2), 22003. Inserta por lotes.
 *
 * Spec 021: con `historial`, después de las versiones 1 (ya evaluadas: sus hallazgos quedan en su historial) crea la versión 2
 * `historial` de cada compra que lo pida con `aplicar_regla_historial` y la evalúa también (P-6). Si la BD rechaza una (42501),
 * toda la descarga se revierte. Sin `historial` el resultado es idéntico al de antes.
 */
export async function insertarCompras(
  tx: TxConsulta,
  contexto: { clienteId: string; periodo: string; propuestaId: string },
  nuevas: CompraNueva[],
  f: { evaluar: Evaluar; historial?: HistorialDescarga },
): Promise<string[]> {
  const ids: string[] = [];
  const lote: VersionPorEscribir[] = [];
  for (let desde = 0; desde < nuevas.length; desde += LOTE) {
    const parte = nuevas.slice(desde, desde + LOTE);
    const r = await consultar(tx, SQL_INSERTAR_COMPRAS, [
      contexto.clienteId,
      contexto.periodo,
      contexto.propuestaId,
      "sire",
      JSON.stringify(
        parte.map((n) => ({
          clave: n.clave,
          tipo_doc: n.tipoDoc,
          serie: n.serie,
          numero: n.numero,
          doc_tipo: n.docTipo,
          doc_numero: n.docNumero,
          razon_social: n.razonSocial,
          fecha: n.fecha,
          moneda: n.moneda,
          tipo_cambio: n.tipoCambio,
        })),
      ),
    ]);
    const idPorClave = new Map(
      r.rows.map((x) => [x.clave as string, x.id as string]),
    );
    for (const n of parte) {
      const id = idPorClave.get(n.clave)!;
      ids.push(id);
      const datos = datosOriginales(n.montos);
      lote.push({
        compra: comoLeida(
          id,
          contexto.clienteId,
          contexto.periodo,
          contexto.propuestaId,
          "sire",
          n,
          datos,
        ),
        n: 1,
        datos,
        accion: "original",
        operacionId: null,
        usuarioId: null,
      });
    }
  }
  await insertarVersiones(tx, lote);
  await evaluarYGuardar(tx, lote, f.evaluar);
  if (f.historial) {
    const segunHistorial: VersionPorEscribir[] = [];
    for (const p of lote) {
      const h = f.historial(p.compra);
      if (!h) continue;
      const n = await aplicarReglaHistorial(tx, p.compra.id, h.reglaId, h.datos);
      segunHistorial.push({
        compra: p.compra,
        n,
        datos: { montos: h.datos, excluida: false, motivo: null, clasificada: true },
        accion: "historial",
        operacionId: null,
        usuarioId: null,
      });
    }
    await evaluarYGuardar(tx, segunHistorial, f.evaluar);
  }
  return ids;
}
