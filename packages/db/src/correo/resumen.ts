// Lectura del resumen diario de un usuario (spec 028; R-13, D-6, R-16), en UNA consulta con la `tx` del estudio (worker o backend):
// alcance del usuario (asignados no archivados, o todos los no archivados si «todos» rige), mensajes por cliente desde el corte y estado
// del periodo del mes anterior por libro con su descarga. El dominio ordena y recorta.
import {
  ARGUMENTO_INVALIDO,
  consultarCorreo,
  CorreoRepoError,
  exigirFecha,
  exigirIdCorreo,
  type TxConsulta,
} from "./errores";

export type EstadoPeriodoResumen = "sin_descargar" | "abierto" | "revisado";

export interface ClienteResumen {
  clienteId: string;
  razonSocial: string;
  /** No históricos con `primera_captura_en` estrictamente posterior a `desde` (atendidos o no). */
  nuevos: number;
  /** De esos nuevos, los críticos. */
  criticosNuevos: number;
  /** Todos los no históricos sin `atendido_en` del cliente (nuevos o anteriores). */
  pendientesAtender: number;
  /** Estado del periodo de compras; null si está `generado`. */
  compras: EstadoPeriodoResumen | null;
  ventas: EstadoPeriodoResumen | null;
}

export interface ParametrosResumen {
  usuarioId: string;
  /** Corte: `corte_hasta` del resumen anterior o ahora - 24 h. */
  desde: Date;
  /** AAAAMM del mes anterior en Lima. */
  periodo: string;
  /** Marca guardada de «todos los clientes»; solo rige para Dueño o Administrador sin asignaciones. */
  todos: boolean;
}

const PERIODO = /^\d{4}(0[1-9]|1[0-2])$/;

// $1 usuario, $2 desde, $3 periodo, $4 todos. La RLS ata cada tabla al estudio de la sesión.
const SQL_RESUMEN = `
with u as (
  select m.rol, exists (select 1 from asignacion a where a.usuario_id = m.usuario_id) as asignado
    from membresia m where m.usuario_id = $1::uuid
), alcance as (
  select c.id, c.razon_social
    from cliente c cross join u
   where c.archivado_at is null
     and (exists (select 1 from asignacion a where a.cliente_id = c.id and a.usuario_id = $1::uuid)
          or ($4::boolean and u.rol in ('dueno', 'admin') and not u.asignado))
), msg as (
  select bm.cliente_id,
         count(*) filter (where bm.primera_captura_en > $2::timestamptz)::int as nuevos,
         count(*) filter (where bm.primera_captura_en > $2::timestamptz and bm.critico)::int as criticos,
         count(*) filter (where bm.atendido_en is null)::int as pendientes
    from buzon_mensaje bm
   where bm.cliente_id in (select id from alcance) and not bm.historico
     and (bm.primera_captura_en > $2::timestamptz or bm.atendido_en is null)
   group by bm.cliente_id
)
select a.id, a.razon_social,
       coalesce(msg.nuevos, 0) as nuevos, coalesce(msg.criticos, 0) as criticos, coalesce(msg.pendientes, 0) as pendientes,
       (select cp.estado from compra_periodo cp where cp.cliente_id = a.id and cp.periodo = $3::text) as compras_estado,
       (select vp.estado from venta_periodo vp where vp.cliente_id = a.id and vp.periodo = $3::text) as ventas_estado,
       exists (select 1 from job_registro j
                where j.cliente_id = a.id and j.tipo = 'sire.propuesta.descargar' and j.estado = 'completado'
                  and j.parametros ->> 'periodo' = $3::text and j.parametros ->> 'libro' = 'compras') as compras_descargado,
       exists (select 1 from job_registro j
                where j.cliente_id = a.id and j.tipo = 'sire.propuesta.descargar' and j.estado = 'completado'
                  and j.parametros ->> 'periodo' = $3::text and j.parametros ->> 'libro' = 'ventas') as ventas_descargado
  from alcance a
  left join msg on msg.cliente_id = a.id`;

function estado(
  guardado: unknown,
  descargado: unknown,
): EstadoPeriodoResumen | null {
  if (guardado === "generado") return null;
  if (guardado === "revisado") return "revisado";
  return descargado === true ? "abierto" : "sin_descargar";
}

/**
 * Clientes del alcance del usuario (asignados no archivados; todos los no archivados si `todos` rige) que tengan algo que contar:
 * `nuevos > 0` o `compras`/`ventas` distintos de null. Sin orden fijo (el dominio ordena y recorta a 50).
 */
export async function leerResumen(
  tx: TxConsulta,
  p: ParametrosResumen,
): Promise<ClienteResumen[]> {
  const usuarioId = exigirIdCorreo(p?.usuarioId);
  const desde = exigirFecha(p.desde);
  if (typeof p.periodo !== "string" || !PERIODO.test(p.periodo))
    throw new CorreoRepoError(ARGUMENTO_INVALIDO);
  if (typeof p.todos !== "boolean")
    throw new CorreoRepoError(ARGUMENTO_INVALIDO);
  const filas = await consultarCorreo(tx, SQL_RESUMEN, [
    usuarioId,
    desde,
    p.periodo,
    p.todos,
  ]);
  const salida: ClienteResumen[] = [];
  for (const f of filas) {
    const r: ClienteResumen = {
      clienteId: String(f.id),
      razonSocial: String(f.razon_social),
      nuevos: Number(f.nuevos),
      criticosNuevos: Number(f.criticos),
      pendientesAtender: Number(f.pendientes),
      compras: estado(f.compras_estado, f.compras_descargado),
      ventas: estado(f.ventas_estado, f.ventas_descargado),
    };
    if (r.nuevos > 0 || r.compras !== null || r.ventas !== null) salida.push(r);
  }
  return salida;
}
