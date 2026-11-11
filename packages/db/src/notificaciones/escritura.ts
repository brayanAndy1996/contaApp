// Escritura de notificaciones (spec 017, D-8, D-9). Nadie de la app inserta: insertan los triggers de aviso en la transacción del
// hecho. El backend solo cambia `leida_en` (NULL -> instante); el worker purga con `notificacion_purgar` (SECURITY DEFINER).
import { sql } from "drizzle-orm";
import { renderizar, type Alcance } from "../acceso/alcance";
import { consultar, type TxConsulta } from "../acceso/errores";
import { visibleNotificacion } from "./lectura";

const SQL_MARCAR = `update notificacion set leida_en = now()
 where id = $1::uuid and leida_en is null
   and usuario_id = nullif(current_setting('app.user_id', true), '')::uuid
returning id`;

const SQL_EXISTE = `select 1 as ok from notificacion
 where id = $1::uuid and usuario_id = nullif(current_setting('app.user_id', true), '')::uuid`;

/**
 * Marca como leída una notificación propia. Idempotente: `true` si es del usuario del contexto (aunque ya estuviera leída, y
 * entonces `leida_en` conserva su primer valor); `false` si es ajena, de otro estudio o no existe, sin cambiar nada.
 */
export async function marcarLeida(tx: TxConsulta, id: string): Promise<boolean> {
  if ((await consultar(tx, SQL_MARCAR, [id])).length > 0) return true;
  return (await consultar(tx, SQL_EXISTE, [id])).length > 0;
}

/** Marca las propias, visibles y no leídas con `creadaEn <= hasta`. Devuelve cuántas marcó. */
export async function marcarLeidasHasta(tx: TxConsulta, alcance: Alcance, hasta: Date): Promise<number> {
  const { texto, valores } = renderizar(sql`with marcadas as (
      update notificacion n set leida_en = now()
       where n.usuario_id = nullif(current_setting('app.user_id', true), '')::uuid
         and n.leida_en is null and n.creada_en <= ${hasta}::timestamptz and ${visibleNotificacion(alcance)}
      returning 1)
    select count(*)::int as n from marcadas`);
  const filas = await consultar(tx, texto, valores);
  return Number(filas[0]?.n ?? 0);
}

/** Usuarios, sin repetir, a los que ESTA transacción les creó una notificación (aviso en vivo tras el commit). */
export async function destinatariosNuevos(tx: TxConsulta): Promise<string[]> {
  const filas = await consultar(tx, "select notificaciones_de_esta_transaccion() as usuario_id", []);
  return [...new Set(filas.map((f) => f.usuario_id as string))];
}

/** Borra las notificaciones del estudio del contexto con más de `dias` días (rol worker). Devuelve cuántas. */
export async function purgarNotificaciones(tx: TxConsulta, dias: number): Promise<number> {
  const filas = await consultar(tx, "select notificacion_purgar($1::int) as n", [dias]);
  return Number(filas[0]?.n ?? 0);
}
