// Repositorios comunes de propuestas (spec 013, D1, D16). Todas las funciones reciben la `tx` de withTenant (la RLS limita
// al estudio del contexto) y usan SQL estático y parametrizado: los datos viajan como $n, nunca en el texto. Las dos
// tablas son de solo inserción para los roles de la app (0028, 0029). Sirven a ventas (013) y a compras (014).
import { consultar, type Fila, type TxConsulta } from "./errores";

export type LibroPropuesta = "compras" | "ventas";
export type FuentePropuesta = "api" | "importacion";

export interface NuevaPropuesta {
  clienteId: string;
  /** AAAAMM. */
  periodo: string;
  libro: LibroPropuesta;
  fuente: FuentePropuesta;
  /** SHA-256 hexadecimal en minúsculas del contenido recibido. */
  hash: string;
  filasRecibidas: number;
  filasNuevas: number;
  filasIguales: number;
  filasDistintas: number;
  usuarioId: string;
  trabajoId: string | null;
}

export type PropuestaFila = NuevaPropuesta & { id: string; creadaEn: Date };

export interface NuevaDiferencia {
  clave: string;
  tipo: string;
  serie: string;
  numero: string;
  origenExistente: "sire" | "manual";
  /** Campos que difieren (al menos uno). */
  campos: string[];
  /** Valor que trajo el SIRE para cada campo, como cadena. */
  valoresSire: Record<string, string>;
}

export type DiferenciaFila = NuevaDiferencia & { id: string };

const COLUMNAS_PROPUESTA = `id, cliente_id, periodo, libro, fuente, hash, filas_recibidas, filas_nuevas, filas_iguales,
  filas_distintas, usuario_id, trabajo_id, creada_en`;

const SQL_BLOQUEAR = `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`;

const SQL_CREAR = `insert into propuesta (cliente_id, periodo, libro, fuente, hash, filas_recibidas, filas_nuevas,
    filas_iguales, filas_distintas, usuario_id, trabajo_id)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  returning ${COLUMNAS_PROPUESTA}`;

const SQL_LISTAR = `select ${COLUMNAS_PROPUESTA} from propuesta
  where cliente_id = $1 and periodo = $2 and libro = $3
  order by creada_en desc, id desc`;

// El lote viaja como un solo jsonb: el texto SQL no depende de la cantidad de filas ni de los datos.
const SQL_INSERTAR_DIFERENCIAS = `insert into propuesta_diferencia (propuesta_id, clave, tipo, serie, numero,
    origen_existente, campos, valores_sire)
  select $1::uuid, x.clave, x.tipo, x.serie, x.numero, x.origen_existente,
         array(select jsonb_array_elements_text(x.campos)), x.valores_sire
    from jsonb_to_recordset($2::jsonb)
      as x(clave text, tipo text, serie text, numero text, origen_existente text, campos jsonb, valores_sire jsonb)`;

const SQL_LISTAR_DIFERENCIAS = `select id, clave, tipo, serie, numero, origen_existente, campos, valores_sire
  from propuesta_diferencia where propuesta_id = $1 order by clave, id`;

/** Diferencias por sentencia: acota el tamaño del parámetro jsonb (el tope de una propuesta es 20.000 filas). */
const LOTE_DIFERENCIAS = 2000;

const aPropuesta = (f: Fila): PropuestaFila => ({
  id: f.id,
  clienteId: f.cliente_id,
  periodo: f.periodo,
  libro: f.libro,
  fuente: f.fuente,
  hash: f.hash,
  filasRecibidas: f.filas_recibidas,
  filasNuevas: f.filas_nuevas,
  filasIguales: f.filas_iguales,
  filasDistintas: f.filas_distintas,
  usuarioId: f.usuario_id,
  trabajoId: f.trabajo_id,
  creadaEn: f.creada_en,
});

/**
 * Serializa por (cliente, periodo, libro) hasta el commit o rollback de la transacción (D16): dos descargas o
 * importaciones simultáneas del mismo periodo no se solapan ni dan `40P01`. Clientes, periodos o libros distintos no se
 * bloquean entre sí. Orden de bloqueo de una escritura: este bloqueo, luego `cliente`, luego las filas (plan).
 */
export async function bloquearPeriodoLibro(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  libro: LibroPropuesta,
): Promise<void> {
  await consultar(tx, SQL_BLOQUEAR, [`propuesta:${libro}:${periodo}:${clienteId}`]);
}

/** Crea el encabezado de una descarga o importación. Inmutable después (ni UPDATE ni DELETE). */
export async function crearPropuesta(tx: TxConsulta, nueva: NuevaPropuesta): Promise<PropuestaFila> {
  const r = await consultar(tx, SQL_CREAR, [
    nueva.clienteId,
    nueva.periodo,
    nueva.libro,
    nueva.fuente,
    nueva.hash,
    nueva.filasRecibidas,
    nueva.filasNuevas,
    nueva.filasIguales,
    nueva.filasDistintas,
    nueva.usuarioId,
    nueva.trabajoId,
  ]);
  return aPropuesta(r.rows[0]!);
}

/** Guarda las diferencias de una propuesta (todo o nada con la transacción). Una lista vacía no hace nada. */
export async function insertarDiferencias(
  tx: TxConsulta,
  propuestaId: string,
  diferencias: NuevaDiferencia[],
): Promise<void> {
  for (let i = 0; i < diferencias.length; i += LOTE_DIFERENCIAS) {
    const lote = diferencias.slice(i, i + LOTE_DIFERENCIAS).map((d) => ({
      clave: d.clave,
      tipo: d.tipo,
      serie: d.serie,
      numero: d.numero,
      origen_existente: d.origenExistente,
      campos: d.campos,
      valores_sire: d.valoresSire,
    }));
    await consultar(tx, SQL_INSERTAR_DIFERENCIAS, [propuestaId, JSON.stringify(lote)]);
  }
}

/** Historial de un cliente, periodo y libro: la más reciente primero. */
export async function listarPropuestas(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  libro: LibroPropuesta,
): Promise<PropuestaFila[]> {
  const r = await consultar(tx, SQL_LISTAR, [clienteId, periodo, libro]);
  return r.rows.map(aPropuesta);
}

/** Diferencias de una propuesta ordenadas por clave; una propuesta ajena o inexistente da `[]`. */
export async function listarDiferencias(tx: TxConsulta, propuestaId: string): Promise<DiferenciaFila[]> {
  const r = await consultar(tx, SQL_LISTAR_DIFERENCIAS, [propuestaId]);
  return r.rows.map((f) => ({
    id: f.id,
    clave: f.clave,
    tipo: f.tipo,
    serie: f.serie,
    numero: f.numero,
    origenExistente: f.origen_existente,
    campos: f.campos,
    valoresSire: f.valores_sire,
  }));
}
