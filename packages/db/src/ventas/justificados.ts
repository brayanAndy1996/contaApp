// Saltos de numeración justificados (spec 013, D8, HU-12). SQL estático y parametrizado dentro de withTenant. Revertir
// solo escribe `revertido_*` (el registro se conserva con quién y cuándo); nadie borra (0031).
import { consultar, VentasRepoError, type Fila, type TxConsulta } from "./errores";
import type { DatosJustificar, Justificado } from "./tipos";

const COLUMNAS = `id, tipo, serie, desde, hasta, comentario, usuario_id, creada_en, revertido_por, revertido_en`;

// ON CONFLICT sobre la única parcial de vigentes: dos justificaciones iguales a la vez dejan una (D8).
const SQL_JUSTIFICAR = `insert into venta_salto_justificado (cliente_id, periodo, tipo, serie, desde, hasta, comentario,
    usuario_id)
  values ($1, $2, $3, $4, $5, $6, $7, $8)
  on conflict (tenant_id, cliente_id, periodo, tipo, serie, desde, hasta) where revertido_en is null do nothing
  returning ${COLUMNAS}`;

const SQL_VIGENTE = `select ${COLUMNAS} from venta_salto_justificado
  where cliente_id = $1 and periodo = $2 and tipo = $3 and serie = $4 and desde = $5 and hasta = $6
    and revertido_en is null`;

const SQL_REVERTIR = `update venta_salto_justificado set revertido_por = $2, revertido_en = now()
  where id = $1 and revertido_en is null`;

const SQL_LISTAR = `select ${COLUMNAS} from venta_salto_justificado
  where cliente_id = $1 and periodo = $2 and (revertido_en is null or $3::boolean)
  order by tipo, serie, desde, hasta, creada_en, id`;

/** Intentos de insertar o encontrar la vigente: solo se repite si otra transacción la revierte justo entre medias. */
const INTENTOS = 3;

const aJustificado = (f: Fila): Justificado => ({
  id: f.id,
  tipo: f.tipo,
  serie: f.serie,
  desde: f.desde,
  hasta: f.hasta,
  comentario: f.comentario,
  usuarioId: f.usuario_id,
  creadaEn: f.creada_en,
  revertidoPor: f.revertido_por,
  revertidoEn: f.revertido_en,
});

/**
 * Justifica un rango de una serie. Si ya hay una vigente igual, la devuelve (conserva el primer comentario) sin error y
 * sin crear otra, también con dos solicitudes simultáneas.
 */
export async function justificar(tx: TxConsulta, d: DatosJustificar): Promise<Justificado> {
  for (let i = 0; i < INTENTOS; i++) {
    const nueva = await consultar(tx, SQL_JUSTIFICAR, [
      d.clienteId,
      d.periodo,
      d.tipo,
      d.serie,
      d.desde,
      d.hasta,
      d.comentario,
      d.usuarioId,
    ]);
    if (nueva.rows[0]) return aJustificado(nueva.rows[0]);
    // Conflicto: la que ganó ya está confirmada (cada sentencia ve lo confirmado hasta ese momento).
    const vigente = await consultar(tx, SQL_VIGENTE, [d.clienteId, d.periodo, d.tipo, d.serie, d.desde, d.hasta]);
    if (vigente.rows[0]) return aJustificado(vigente.rows[0]);
  }
  // 40001 = serialization_failure: el llamador puede reintentar la operación completa.
  throw new VentasRepoError("40001");
}

/** Revierte una justificación vigente; `true` si estaba vigente. Solo escribe `revertido_por` y `revertido_en`. */
export async function revertirJustificacion(
  tx: TxConsulta,
  id: string,
  usuarioId: string,
): Promise<boolean> {
  const r = await consultar(tx, SQL_REVERTIR, [id, usuarioId]);
  return r.rowCount > 0;
}

/** Justificaciones de un cliente y periodo (vigentes por defecto) ordenadas por tipo, serie, desde y hasta. */
export async function listarJustificados(
  tx: TxConsulta,
  clienteId: string,
  periodo: string,
  opciones: { incluirRevertidas?: boolean } = {},
): Promise<Justificado[]> {
  const r = await consultar(tx, SQL_LISTAR, [clienteId, periodo, opciones.incluirRevertidas === true]);
  return r.rows.map(aJustificado);
}
