// Lectura de ventas (spec 013, D10, D16). SQL estático y parametrizado dentro de withTenant: filtros, orden y
// paginación en el servidor; los montos del rango se comparan como NUMERIC en SQL, nunca como `number`.
import { consultar, VentasRepoError, type Fila, type TxConsulta } from "./errores";
import type {
  ExistenteVenta,
  FiltrosVentas,
  PaginaVentas,
  VentaFila,
} from "./tipos";

/** «Todas» entrega como máximo 5.000 filas (D10); el resto se pide paginando. */
export const TOPE_TODAS = 5000;

/** Columnas de `venta` en la forma de `VentaFila`: montos y tipo de cambio como cadenas, fecha AAAA-MM-DD. */
export const COLUMNAS_VENTA = `id, cliente_id, periodo, propuesta_id, origen, clave, tipo, serie, numero, numero_n,
  to_char(fecha, 'YYYY-MM-DD') as fecha, tipo_doc_contraparte, doc_contraparte, moneda, tipo_cambio::text as tipo_cambio,
  base_gravada::text as base_gravada, igv::text as igv, exonerada::text as exonerada, inafecta::text as inafecta,
  isc::text as isc, icbper::text as icbper, otros::text as otros, total::text as total, creada_por, creada_en`;

// Orden de la grilla (D10): tipo, serie, número numérico y, al final de la serie, los no evaluables por su texto.
const ORDEN = `order by tipo, serie, numero_n nulls last, numero, id`;

export const aVenta = (f: Fila): VentaFila => ({
  id: f.id,
  clienteId: f.cliente_id,
  periodo: f.periodo,
  propuestaId: f.propuesta_id,
  origen: f.origen,
  clave: f.clave,
  tipo: f.tipo,
  serie: f.serie,
  numero: f.numero,
  numeroN: f.numero_n,
  fecha: f.fecha,
  tipoDocContraparte: f.tipo_doc_contraparte,
  docContraparte: f.doc_contraparte,
  moneda: f.moneda,
  tipoCambio: f.tipo_cambio,
  baseGravada: f.base_gravada,
  igv: f.igv,
  exonerada: f.exonerada,
  inafecta: f.inafecta,
  isc: f.isc,
  icbper: f.icbper,
  otros: f.otros,
  total: f.total,
  creadaPor: f.creada_por,
  creadaEn: f.creada_en,
});

// Filtros opcionales: un parámetro nulo desactiva su condición. `q` ya llega con %, _ y \ escapados (escape '\').
const DONDE = `cliente_id = $1 and periodo = $2
    and ($3::text is null or tipo = $3::text)
    and ($4::text is null or serie = $4::text)
    and ($5::numeric is null or total >= $5::numeric)
    and ($6::numeric is null or total <= $6::numeric)
    and ($7::text is null or (serie || '-' || numero) ilike '%' || $7::text || '%' escape '\\'
         or doc_contraparte ilike '%' || $7::text || '%' escape '\\')`;

const SQL_CONTAR = `select count(*)::int as n from venta where ${DONDE}`;

const SQL_PAGINA = `select ${COLUMNAS_VENTA} from venta where ${DONDE} ${ORDEN} limit $8::int offset $9::int`;

const SQL_TODAS_DEL_PERIODO = `select ${COLUMNAS_VENTA} from venta where cliente_id = $1 and periodo = $2 ${ORDEN}`;

const SQL_EXISTENTES = `select clave, origen, to_char(fecha, 'YYYY-MM-DD') as fecha, moneda,
    coalesce(tipo_cambio::text, '') as tipo_cambio, tipo_doc_contraparte, doc_contraparte,
    base_gravada::text as base_gravada, igv::text as igv, exonerada::text as exonerada, inafecta::text as inafecta,
    isc::text as isc, icbper::text as icbper, otros::text as otros, total::text as total
  from venta where cliente_id = $1 and periodo = $2 order by clave`;

const DECIMAL = /^-?[0-9]{1,14}(\.[0-9]{1,6})?$/;
const TAMANOS = new Set<unknown>([10, 25, 50, "todas"]);
const PAGINA_MAX = 1_000_000;
// 22023 = invalid_parameter_value: el llamador (HTTP) valida antes con zod; esto es la última barrera.
const ARGUMENTO_INVALIDO = "22023";

/** Escapa los comodines de LIKE (\, % y _) para buscar el texto literal. */
export function escaparLike(q: string): string {
  return q.replace(/[\\%_]/g, "\\$&");
}

function decimalOpcional(v: string | undefined): string | null {
  if (v === undefined) return null;
  if (typeof v !== "string" || !DECIMAL.test(v)) throw new VentasRepoError(ARGUMENTO_INVALIDO);
  return v;
}

function textoOpcional(v: string | undefined): string | null {
  if (v === undefined) return null;
  if (typeof v !== "string") throw new VentasRepoError(ARGUMENTO_INVALIDO);
  return v;
}

/**
 * Página de ventas de un cliente y periodo, filtrada y ordenada en el servidor (D10). `tipo` y `serie` son igualdad
 * exacta; `min` y `max` se comparan con el total como NUMERIC sin redondear el límite; `q` busca una coincidencia
 * parcial, sin distinguir mayúsculas, en `serie-numero` y en el documento de la contraparte. «Todas» entrega como
 * máximo 5.000 filas y agrega `todas_limitada` cuando hay más.
 */
export async function listarVentas(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  f: FiltrosVentas,
): Promise<PaginaVentas> {
  if (!Number.isSafeInteger(f.pagina) || f.pagina < 1 || f.pagina > PAGINA_MAX || !TAMANOS.has(f.tamano)) {
    throw new VentasRepoError(ARGUMENTO_INVALIDO);
  }
  const q = textoOpcional(f.q);
  const filtros = [
    clienteId,
    periodo,
    textoOpcional(f.tipo),
    textoOpcional(f.serie),
    decimalOpcional(f.min),
    decimalOpcional(f.max),
    q === null ? null : escaparLike(q),
  ];
  const limite = f.tamano === "todas" ? TOPE_TODAS : f.tamano;
  const desplazamiento = f.tamano === "todas" ? 0 : (f.pagina - 1) * f.tamano;
  const [conteo, pagina] = await Promise.all([
    consultar(tx, SQL_CONTAR, filtros),
    consultar(tx, SQL_PAGINA, [...filtros, limite, desplazamiento]),
  ]);
  const total: number = conteo.rows[0]!.n;
  return {
    filas: pagina.rows.map(aVenta),
    total,
    avisos: f.tamano === "todas" && total > TOPE_TODAS ? ["todas_limitada"] : [],
  };
}

/** Todas las filas del periodo en el orden de la grilla, sin tope de 5.000: base del resumen y de la correlatividad. */
export async function leerFilasVentas(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
): Promise<VentaFila[]> {
  const r = await consultar(tx, SQL_TODAS_DEL_PERIODO, [clienteId, periodo]);
  return r.rows.map(aVenta);
}

/** Lo ya guardado del periodo (sire y manual) en la forma que consume `planificarComplemento` (D16). */
export async function leerExistentes(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
): Promise<ExistenteVenta[]> {
  const r = await consultar(tx, SQL_EXISTENTES, [clienteId, periodo]);
  return r.rows.map((f) => ({
    clave: f.clave,
    origen: f.origen,
    campos: {
      fecha: f.fecha,
      moneda: f.moneda,
      tipoCambio: f.tipo_cambio,
      tipoDocContraparte: f.tipo_doc_contraparte,
      docContraparte: f.doc_contraparte,
      baseGravada: f.base_gravada,
      igv: f.igv,
      exonerada: f.exonerada,
      inafecta: f.inafecta,
      isc: f.isc,
      icbper: f.icbper,
      otros: f.otros,
      total: f.total,
    },
  }));
}
