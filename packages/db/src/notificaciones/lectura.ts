// Lectura de notificaciones (spec 017, D-8, D-10, CA-11, CA-12). La RLS deja ver solo las del usuario del contexto en su estudio;
// una notificación con cliente solo se lista y se cuenta si el cliente sigue visible con `filtroAlcance` de 005 (las sin cliente,
// como el aviso de plan, siempre). Todo con la `tx` de withTenant.
import { sql, type SQL } from "drizzle-orm";
import { filtroAlcance, renderizar, type Alcance } from "../acceso/alcance";
import { consultar, type TxConsulta } from "../acceso/errores";

export type TipoNotificacion = "credencial_invalida" | "trabajo_terminado" | "plan_limite" | "buzon_critico";

export interface FilaNotificacion {
  id: string;
  tipo: TipoNotificacion;
  creadaEn: Date;
  leidaEn: Date | null;
  clienteId: string | null;
  trabajoId: string | null;
  razonSocial: string | null;
  params: Record<string, unknown>;
}

export interface OpcionesNotificaciones {
  /** Posición (creadaEn, id) de la última fila de la página anterior. */
  antes?: { en: Date; id: string };
  /** Se recorta a 1..50; por omisión 50. */
  limite?: number;
}

export const MAX_PAGINA_NOTIFICACIONES = 50;
export const TOPE_NO_LEIDAS = 100;

const PROPIA = sql`n.usuario_id = nullif(current_setting('app.user_id', true), '')::uuid`;

/** Visible: sin cliente, o con un cliente que el alcance deja ver. */
export const visibleNotificacion = (a: Alcance): SQL =>
  sql`(n.cliente_id is null or ${filtroAlcance(sql`n.cliente_id`, a)})`;

const entero = (n: number | undefined, por: number, min: number, max: number): number =>
  n === undefined || !Number.isFinite(n) ? por : Math.min(Math.max(Math.trunc(n), min), max);

/** Página de notificaciones propias, de la más nueva a la más vieja por (creadaEn, id); a lo sumo 50. */
export async function listarNotificaciones(
  tx: TxConsulta,
  alcance: Alcance,
  o: OpcionesNotificaciones = {},
): Promise<FilaNotificacion[]> {
  const limite = entero(o.limite, MAX_PAGINA_NOTIFICACIONES, 1, MAX_PAGINA_NOTIFICACIONES);
  const cursor = o.antes
    ? sql`and (n.creada_en < ${o.antes.en}::timestamptz or (n.creada_en = ${o.antes.en}::timestamptz and n.id < ${o.antes.id}::uuid))`
    : sql``;
  const { texto, valores } = renderizar(sql`select n.id, n.tipo, n.creada_en, n.leida_en, n.cliente_id, n.trabajo_id,
      c.razon_social, n.params
    from notificacion n left join cliente c on c.id = n.cliente_id
   where ${PROPIA} and ${visibleNotificacion(alcance)} ${cursor}
   order by n.creada_en desc, n.id desc
   limit ${limite}::int`);
  const filas = await consultar(tx, texto, valores);
  return filas.map((f) => ({
    id: f.id,
    tipo: f.tipo,
    creadaEn: f.creada_en,
    leidaEn: f.leida_en,
    clienteId: f.cliente_id,
    trabajoId: f.trabajo_id,
    razonSocial: f.razon_social ?? null,
    params: f.params,
  }));
}

/** No leídas propias y visibles, hasta `tope` (100 por omisión): el contador de la campana. */
export async function contarNoLeidas(tx: TxConsulta, alcance: Alcance, tope: number = TOPE_NO_LEIDAS): Promise<number> {
  const t = entero(tope, TOPE_NO_LEIDAS, 0, 1_000_000);
  const { texto, valores } = renderizar(sql`select count(*)::int as n from (
      select 1 from notificacion n
       where ${PROPIA} and n.leida_en is null and ${visibleNotificacion(alcance)}
       limit ${t}::int) x`);
  const filas = await consultar(tx, texto, valores);
  return Number(filas[0]?.n ?? 0);
}
