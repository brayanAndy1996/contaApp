// Repositorio de `job_registro` (spec 008). Todas las funciones reciben la `tx` de withTenant (la RLS limita al estudio
// del contexto) y usan SQL estático y parametrizado: los datos de entrada viajan como $n, nunca en el texto. Los grants
// por columna de 0018 deciden qué puede cada rol (el backend encola y cancela; el worker despacha, ejecuta y purga).
// Toda transición es un UPDATE ... WHERE estado = <desde>: gana quien obtiene rowCount = 1 (D2).
import { sql, type SQL } from "drizzle-orm";
import { filtroAlcance, renderizar, type Alcance } from "../acceso/alcance";
import { consultar, type Fila, type TxConsulta } from "./errores";

export type EstadoTrabajo =
  "en_cola" | "ejecutando" | "completado" | "error" | "cancelado";
export type ColaTrabajo =
  "sire" | "sol" | "xml" | "archivos" | "programados" | "notificaciones";
export type CanalTrabajo = "sire" | "sol" | "ninguno";
export type PrioridadTrabajo = "interactivo" | "programado";
export type MotivoTrabajo =
  | "sunat_no_responde"
  | "credencial_invalida"
  | "datos_invalidos"
  | "portal_cambio"
  | "interrumpido"
  | "acceso_retirado"
  | "cancelado_usuario"
  | "error_interno";

/** Fila completa de job_registro en camelCase (Date para fechas, Buffer para bytea). */
export interface TrabajoFila {
  id: string;
  tenantId: string;
  clienteId: string;
  ruc: string;
  tipo: string;
  cola: ColaTrabajo;
  canal: CanalTrabajo;
  prioridad: PrioridadTrabajo;
  estado: EstadoTrabajo;
  parametros: unknown;
  claveDedupe: Buffer;
  creadoPor: string | null;
  intentos: number;
  maxIntentos: number;
  motivo: MotivoTrabajo | null;
  resultado: unknown | null;
  disponibleDesde: Date;
  creadoEn: Date;
  iniciadoEn: Date | null;
  terminadoEn: Date | null;
  actualizadoEn: Date;
}

/** Vista pública de un trabajo (forma de `TrabajoVista` de @contapp/shared): fechas ISO y `posicion` sin calcular. */
export interface TrabajoVistaDb {
  id: string;
  tipo: string;
  clienteId: string;
  estado: EstadoTrabajo;
  posicion: number | null;
  intentos: number;
  motivo: MotivoTrabajo | null;
  creadoEn: string;
  iniciadoEn: string | null;
  terminadoEn: string | null;
  creadoPor: { usuarioId: string } | null;
}

export interface NuevoTrabajo {
  clienteId: string;
  ruc: string;
  tipo: string;
  cola: ColaTrabajo;
  canal: CanalTrabajo;
  prioridad: PrioridadTrabajo;
  parametros: unknown;
  claveDedupe: Buffer;
  creadoPor: string | null;
  maxIntentos: number;
}

/** Campos que acompañan una transición. Las fechas de inicio y fin las fija `transicionar`, nunca quien llama. */
export interface CamposTransicion {
  motivo?: MotivoTrabajo | null;
  intentos?: number;
  resultado?: unknown;
  disponibleDesde?: Date;
}

export interface FiltrosTrabajos {
  clienteId?: string;
  estado?: EstadoTrabajo;
}

const COLUMNAS = `id, tenant_id, cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe,
  creado_por, intentos, max_intentos, motivo, resultado, disponible_desde, creado_en, iniciado_en, terminado_en,
  actualizado_en`;
const COLUMNAS_VISTA = `id, tipo, cliente_id, estado, intentos, motivo, creado_en, iniciado_en, terminado_en, creado_por`;

const TERMINALES: readonly string[] = ["completado", "error", "cancelado"];

const iso = (d: unknown): string | null =>
  d === null || d === undefined ? null : new Date(d as Date).toISOString();

const fecha = (d: unknown): Date | null =>
  d === null || d === undefined ? null : new Date(d as Date);

function aVista(f: Fila): TrabajoVistaDb {
  return {
    id: f.id,
    tipo: f.tipo,
    clienteId: f.cliente_id,
    estado: f.estado,
    posicion: null,
    intentos: Number(f.intentos),
    motivo: f.motivo ?? null,
    creadoEn: iso(f.creado_en) as string,
    iniciadoEn: iso(f.iniciado_en),
    terminadoEn: iso(f.terminado_en),
    creadoPor: f.creado_por ? { usuarioId: f.creado_por } : null,
  };
}

function aFila(f: Fila): TrabajoFila {
  return {
    id: f.id,
    tenantId: f.tenant_id,
    clienteId: f.cliente_id,
    ruc: f.ruc,
    tipo: f.tipo,
    cola: f.cola,
    canal: f.canal,
    prioridad: f.prioridad,
    estado: f.estado,
    parametros: f.parametros,
    claveDedupe: f.clave_dedupe,
    creadoPor: f.creado_por ?? null,
    intentos: Number(f.intentos),
    maxIntentos: Number(f.max_intentos),
    motivo: f.motivo ?? null,
    resultado: f.resultado ?? null,
    disponibleDesde: fecha(f.disponible_desde) as Date,
    creadoEn: fecha(f.creado_en) as Date,
    iniciadoEn: fecha(f.iniciado_en),
    terminadoEn: fecha(f.terminado_en),
    actualizadoEn: fecha(f.actualizado_en) as Date,
  };
}

// tenant_id, intentos y las fechas toman su DEFAULT (el estudio sale del contexto, nunca del llamador).
const SQL_INSERTAR = `insert into job_registro
  (cliente_id, ruc, tipo, cola, canal, prioridad, estado, parametros, clave_dedupe, creado_por, max_intentos)
  values ($1, $2, $3, $4, $5, $6, 'en_cola', $7::jsonb, $8, $9, $10)
  returning ${COLUMNAS_VISTA}`;

/** Encola un trabajo en el estudio del contexto (nace en_cola, intentos 0). Rol: contapp_backend. */
export async function insertarTrabajo(
  tx: TxConsulta,
  e: NuevoTrabajo,
): Promise<TrabajoVistaDb> {
  const r = await consultar(tx, SQL_INSERTAR, [
    e.clienteId,
    e.ruc,
    e.tipo,
    e.cola,
    e.canal,
    e.prioridad,
    JSON.stringify(e.parametros),
    e.claveDedupe,
    e.creadoPor,
    e.maxIntentos,
  ]);
  return aVista(r.rows[0]!);
}

const SQL_VIVO_POR_CLAVE = `select ${COLUMNAS_VISTA} from job_registro
  where clave_dedupe = $1 and estado in ('en_cola', 'ejecutando') limit 1`;

/** Trabajo vivo (en_cola o ejecutando) con esa clave de dedupe en el estudio, o null (D8). */
export async function trabajoVivoPorClave(
  tx: TxConsulta,
  claveDedupe: Buffer,
): Promise<TrabajoVistaDb | null> {
  const r = await consultar(tx, SQL_VIVO_POR_CLAVE, [claveDedupe]);
  return r.rows.length === 0 ? null : aVista(r.rows[0]!);
}

const SQL_CONTAR_PENDIENTES = `select count(*) as n from job_registro where cola = $1 and estado = 'en_cola'`;

/** Trabajos en_cola de esa cola en el estudio (tope `max_pendientes_tenant`). */
export async function contarPendientes(
  tx: TxConsulta,
  cola: ColaTrabajo,
): Promise<number> {
  const r = await consultar(tx, SQL_CONTAR_PENDIENTES, [cola]);
  return Number(r.rows[0]?.n ?? 0);
}

const SQL_SIGUIENTE = `select ${COLUMNAS} from job_registro
  where cola = $1 and estado = 'en_cola' and disponible_desde <= $2
  order by (prioridad = 'programado'), creado_en, id
  limit 1`;

/** Primer en_cola disponible de la cola: interactivo antes que programado, luego creado_en y id (CA-2). */
export async function siguienteDisponible(
  tx: TxConsulta,
  cola: ColaTrabajo,
  ahora: Date,
): Promise<TrabajoFila | null> {
  const r = await consultar(tx, SQL_SIGUIENTE, [cola, ahora]);
  return r.rows.length === 0 ? null : aFila(r.rows[0]!);
}

/**
 * `UPDATE ... WHERE id = $1 AND estado = $2`: true solo si cambió la fila (ganador único, D2). Fija iniciado_en al pasar
 * a ejecutando, terminado_en al pasar a un estado terminal y actualizado_en siempre; los campos ausentes no se tocan.
 */
export async function transicionar(
  tx: TxConsulta,
  id: string,
  desde: EstadoTrabajo,
  hacia: EstadoTrabajo,
  campos: CamposTransicion = {},
): Promise<boolean> {
  const valores: unknown[] = [id, desde, hacia];
  const sets = ["estado = $3"];
  const agregar = (columna: string, valor: unknown, cast = "") => {
    valores.push(valor);
    sets.push(`${columna} = $${valores.length}${cast}`);
  };
  if (campos.motivo !== undefined) agregar("motivo", campos.motivo);
  if (campos.intentos !== undefined) agregar("intentos", campos.intentos);
  if (campos.resultado !== undefined) {
    agregar(
      "resultado",
      campos.resultado === null ? null : JSON.stringify(campos.resultado),
      "::jsonb",
    );
  }
  if (campos.disponibleDesde !== undefined) {
    agregar("disponible_desde", campos.disponibleDesde);
  }
  if (hacia === "ejecutando") sets.push("iniciado_en = now()");
  if (TERMINALES.includes(hacia)) sets.push("terminado_en = now()");
  sets.push("actualizado_en = now()");
  // Las columnas salen de la lista fija de arriba; los valores, de $n.
  const texto = `update job_registro set ${sets.join(", ")} where id = $1 and estado = $2`;
  const r = await consultar(tx, texto, valores);
  return r.rowCount === 1;
}

const SQL_LEER = `select ${COLUMNAS} from job_registro where id = $1`;

/** Fila completa del trabajo en el estudio del contexto, o null (ajeno o inexistente). */
export async function leerTrabajo(
  tx: TxConsulta,
  id: string,
): Promise<TrabajoFila | null> {
  const r = await consultar(tx, SQL_LEER, [id]);
  return r.rows.length === 0 ? null : aFila(r.rows[0]!);
}

/** Trabajos visibles con el alcance (filtroAlcance de 005), del más nuevo al más viejo, máximo 100. */
export async function listarTrabajos(
  tx: TxConsulta,
  alcance: Alcance,
  filtros: FiltrosTrabajos = {},
): Promise<TrabajoVistaDb[]> {
  const condiciones: SQL[] = [filtroAlcance(sql`j.cliente_id`, alcance)];
  if (filtros.clienteId !== undefined) {
    condiciones.push(sql`j.cliente_id = ${filtros.clienteId}::uuid`);
  }
  if (filtros.estado !== undefined) {
    condiciones.push(sql`j.estado = ${filtros.estado}`);
  }
  const { texto, valores } = renderizar(
    sql`select ${sql.raw(COLUMNAS_VISTA.replace(/(\w+)/g, "j.$1"))} from job_registro j where ${sql.join(condiciones, sql` and `)} order by j.creado_en desc, j.id desc limit 100`,
  );
  const r = await consultar(tx, texto, valores);
  return r.rows.map(aVista);
}

// Posición (RF-042): 1 + los en_cola del mismo estudio (RLS) y cola que salen antes; null si no está en_cola.
const SQL_POSICION = `select case when j.estado = 'en_cola' then 1 + (
    select count(*) from job_registro o
     where o.cola = j.cola and o.estado = 'en_cola' and o.id <> j.id
       and ((o.prioridad = 'programado')::int < (j.prioridad = 'programado')::int
         or ((o.prioridad = j.prioridad) and (o.creado_en < j.creado_en or (o.creado_en = j.creado_en and o.id < j.id))))
  ) end as posicion
  from job_registro j where j.id = $1`;

/** Posición en la cola del estudio, o null si el trabajo no está en_cola (o es ajeno/inexistente). */
export async function posicion(
  tx: TxConsulta,
  id: string,
): Promise<number | null> {
  const r = await consultar(tx, SQL_POSICION, [id]);
  const p = r.rows[0]?.posicion;
  return p === null || p === undefined ? null : Number(p);
}

const SQL_PURGAR = `delete from job_registro
  where estado in ('completado', 'error', 'cancelado') and terminado_en < $1`;

/** Borra los terminados con terminado_en anterior al corte (D16). Rol: contapp_worker. */
export async function purgarTerminados(
  tx: TxConsulta,
  antesDe: Date,
): Promise<number> {
  const r = await consultar(tx, SQL_PURGAR, [antesDe]);
  return r.rowCount;
}

export interface Revalidable {
  clienteId: string;
  creadoPor: string | null;
  rolesPermitidos: readonly string[] | null;
}

// D17: el cliente sigue en el estudio y, si hay creador, sigue activo, con un rol permitido y con alcance sobre el
// cliente (dueno y admin: global; los demás, con asignación). Lecturas sin FOR UPDATE (orden de bloqueo de 005).
const SQL_REVALIDAR = `select 1 as ok from cliente c
  where c.id = $1::uuid
    and ($2::uuid is null or exists (
      select 1 from membresia m
       where m.usuario_id = $2::uuid and m.desactivada_en is null
         and ($3::text[] is null or m.rol = any ($3::text[]))
         and (m.rol in ('dueno', 'admin')
              or exists (select 1 from asignacion a where a.cliente_id = c.id and a.usuario_id = $2::uuid))))`;

/**
 * 'ok' si quien encoló conserva el acceso; si no (o sin filas), 'acceso_retirado' (falla cerrado). Rol: contapp_worker.
 * Acepta el resto del trabajo de despacho (p. ej. `id`) pero solo lee clienteId, creadoPor y rolesPermitidos.
 */
export async function revalidarEncolado<T extends Revalidable>(
  tx: TxConsulta,
  t: T,
): Promise<"ok" | "acceso_retirado"> {
  const r = await consultar(tx, SQL_REVALIDAR, [
    t.clienteId,
    t.creadoPor ?? null,
    t.rolesPermitidos === null || t.rolesPermitidos === undefined
      ? null
      : [...t.rolesPermitidos],
  ]);
  return r.rows.length > 0 ? "ok" : "acceso_retirado";
}
