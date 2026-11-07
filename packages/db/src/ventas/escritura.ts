// Escritura de ventas (spec 013, D3, D9, D16). SQL estático y parametrizado dentro de withTenant. Las filas del SIRE se
// insertan y nunca se actualizan (trigger `venta_inmutable` de 0030); las agregadas a mano son lo único que se quita.
import { consultar, type TxConsulta } from "./errores";
import { aVenta, COLUMNAS_VENTA } from "./lectura";
import type { ContextoInsercionVentas, VentaFila, VentaNueva } from "./tipos";

// El lote viaja como un solo jsonb de cadenas: el texto SQL no depende de la cantidad de filas ni de los datos, y el
// destino aplica las conversiones y los límites de columna (serie varchar(4), NUMERIC(14,2), fecha) con error, no con
// truncamiento. 20.000 filas no caben en un solo INSERT parametrizado (65.535 parámetros): se parte en lotes.
const SQL_INSERTAR = `insert into venta (cliente_id, periodo, propuesta_id, origen, clave, tipo, serie, numero, numero_n,
    fecha, tipo_doc_contraparte, doc_contraparte, moneda, tipo_cambio, base_gravada, igv, exonerada, inafecta, isc,
    icbper, otros, total)
  select $1::uuid, $2, $3::uuid, 'sire', x.clave, x.tipo, x.serie, x.numero,
         case when x.numero ~ '^[0-9]{1,8}$' then x.numero::integer end,
         x.fecha::date, x.tipo_doc_contraparte, x.doc_contraparte, x.moneda, x.tipo_cambio::numeric,
         x.base_gravada::numeric, x.igv::numeric, x.exonerada::numeric, x.inafecta::numeric, x.isc::numeric,
         x.icbper::numeric, x.otros::numeric, x.total::numeric
    from jsonb_to_recordset($4::jsonb) as x(clave text, tipo text, serie text, numero text, fecha text,
      tipo_doc_contraparte text, doc_contraparte text, moneda text, tipo_cambio text, base_gravada text, igv text,
      exonerada text, inafecta text, isc text, icbper text, otros text, total text)`;

// numero_n se deriva igual que en el lote: entero si `numero` tiene de 1 a 8 dígitos (D7).
const SQL_CREAR_MANUAL = `insert into venta (cliente_id, periodo, propuesta_id, origen, clave, tipo, serie, numero,
    numero_n, fecha, tipo_doc_contraparte, doc_contraparte, moneda, tipo_cambio, base_gravada, igv, exonerada, inafecta,
    isc, icbper, otros, total, creada_por)
  values ($1, $2, null, 'manual', $3, $4, $5, $6::text,
    case when $6::text ~ '^[0-9]{1,8}$' then $6::text::integer end,
    $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
  returning ${COLUMNAS_VENTA}`;

// Solo borra una fila `manual`: la del SIRE no entra al DELETE (el trigger la rechazaría con error).
const SQL_QUITAR_MANUAL = `delete from venta where id = $1 and origen = 'manual'`;

/** Filas por sentencia: acota el tamaño del parámetro jsonb (el tope de una propuesta es 20.000 filas). */
const LOTE_VENTAS = 2000;

/**
 * Inserta las filas nuevas del SIRE o de una importación (origen `sire`), todo o nada con la transacción. Calcula
 * `numero_n`. Una clave repetida (en el lote o ya guardada) lanza `23505`. Nunca actualiza.
 */
export async function insertarVentas(
  tx: TxConsulta,
  ctx: ContextoInsercionVentas,
  ventas: VentaNueva[],
): Promise<void> {
  for (let i = 0; i < ventas.length; i += LOTE_VENTAS) {
    const lote = ventas.slice(i, i + LOTE_VENTAS).map((v) => ({
      clave: v.clave,
      tipo: v.tipo,
      serie: v.serie,
      numero: v.numero,
      fecha: v.fecha,
      tipo_doc_contraparte: v.tipoDocContraparte,
      doc_contraparte: v.docContraparte,
      moneda: v.moneda,
      tipo_cambio: v.tipoCambio,
      base_gravada: v.baseGravada,
      igv: v.igv,
      exonerada: v.exonerada,
      inafecta: v.inafecta,
      isc: v.isc,
      icbper: v.icbper,
      otros: v.otros,
      total: v.total,
    }));
    await consultar(tx, SQL_INSERTAR, [ctx.clienteId, ctx.periodo, ctx.propuestaId, JSON.stringify(lote)]);
  }
}

/** Agrega una venta a mano (origen `manual`, sin propuesta). Una clave repetida, también contra el SIRE, lanza `23505`. */
export async function crearVentaManual(
  tx: TxConsulta,
  nueva: VentaNueva & { clienteId: string; periodo: string; creadaPor: string },
): Promise<VentaFila> {
  const r = await consultar(tx, SQL_CREAR_MANUAL, [
    nueva.clienteId,
    nueva.periodo,
    nueva.clave,
    nueva.tipo,
    nueva.serie,
    nueva.numero,
    nueva.fecha,
    nueva.tipoDocContraparte,
    nueva.docContraparte,
    nueva.moneda,
    nueva.tipoCambio,
    nueva.baseGravada,
    nueva.igv,
    nueva.exonerada,
    nueva.inafecta,
    nueva.isc,
    nueva.icbper,
    nueva.otros,
    nueva.total,
    nueva.creadaPor,
  ]);
  return aVenta(r.rows[0]!);
}

/** `true` solo si borró una fila `manual` del estudio; una del SIRE, inexistente o de otro estudio da `false`. */
export async function quitarVentaManual(tx: TxConsulta, ventaId: string): Promise<boolean> {
  const r = await consultar(tx, SQL_QUITAR_MANUAL, [ventaId]);
  return r.rowCount > 0;
}
