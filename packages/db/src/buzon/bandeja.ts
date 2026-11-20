// Bandeja de buzones y detalle de atención (spec 024, D-2 a D-5, D-12; CA-1, CA-2, CA-9). Todo con la `tx` de withTenant (RLS: solo
// el estudio de la sesión) y parametrizado: el texto de cada consulta se arma solo con fragmentos fijos según qué filtros vienen;
// los valores viajan siempre como $n. Estado de atención como partición: atendido si `atendido_en`; si no, histórico si
// `historico`; si no, pendiente. Orden fijo fecha desc, id desc; posición por valor `(fecha, id) < ($f, $id)`.
// Formas (plan 024, «Consultas»), cada una pensada para un índice de 0059:
//   (a) bandeja fijada (`clienteId`): un cliente por buzon_mensaje_lista_idx o, en «pendientes», el parcial por cliente;
//   (b) alcance global sin «solo donde soy responsable»: índice por estudio y fecha según el filtro (bandeja, pendiente o crítico
//       pendiente) con JOIN al cliente para descartar archivados;
//   (c) alcance asignado o «solo donde soy responsable»: CTE con los clientes visibles y LATERAL por cliente (LIMIT n + 1 sobre el
//       índice por cliente), luego orden y LIMIT n + 1.
import { filtroAlcance, renderizar, type Alcance } from "../acceso/alcance";
import { sql } from "drizzle-orm";
import { consultar, type FilaBuzon, type TxConsulta } from "./errores";
import type { MensajeBuzonFila } from "./lectura";

export type FiltroAtencionBuzon = "pendientes" | "atendidos" | "historicos" | "todos";
export type EstadoAtencionBuzon = "pendiente" | "atendido" | "historico";

export interface FiltrosBandejaBuzon {
  clienteId?: string;
  responsableId?: string;
  categoria?: string;
  leido?: boolean;
  atencion?: FiltroAtencionBuzon;
  desde?: string;
  hasta?: string;
  archivados?: boolean;
}

export interface PosicionBandeja {
  fecha: string;
  id: string;
}

export interface AtencionVigente {
  estado: EstadoAtencionBuzon;
  por: { id: string; nombre: string | null } | null;
  en: Date | null;
}

export interface FilaBandejaBuzon extends MensajeBuzonFila {
  fechaTexto: string;
  cliente: { id: string; razonSocial: string; archivado: boolean };
  atencion: AtencionVigente;
}

export interface EventoAtencionBuzon {
  accion: "atendido" | "deshecho";
  comentario: string | null;
  usuario: { id: string; nombre: string | null };
  en: Date;
}

export interface DetalleAtencionBuzon extends AtencionVigente {
  comentario: string | null;
  historial: EventoAtencionBuzon[];
}

const LIMITE_MAXIMO = 1000;
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const FECHA_TEXTO = `to_char(m.fecha at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Columnas del mensaje que necesita la fila (alias `m`); el contenido y su ruta nunca salen. */
const COLUMNAS_M = `m.id, m.cliente_id, m.asunto, m.remitente, m.fecha, m.categoria, m.critico, m.motivo_critico, m.leido_sunat,
  m.contenido_ruta is not null as contenido_obtenido, m.adjuntos_declarados, m.historico, m.atendido_en, m.atendido_por`;
/** Columnas finales de la fila (alias `m` del mensaje o de la subconsulta, `c` del cliente y `u` de quien atendió). */
const COLUMNAS_FILA = `m.id, m.asunto, m.remitente, m.fecha, ${FECHA_TEXTO} as fecha_texto, m.categoria, m.critico, m.motivo_critico,
  m.leido_sunat, m.contenido_obtenido, m.adjuntos_declarados, m.historico, m.atendido_en, m.atendido_por,
  u.nombre as atendido_por_nombre, c.id as cliente_id, c.razon_social, c.archivado_at is not null as cliente_archivado`;

/** Parámetros posicionales: cada valor se agrega una vez y devuelve su `$n`. */
class Parametros {
  readonly valores: unknown[] = [];
  agregar(v: unknown, tipo: string): string {
    this.valores.push(v);
    return `$${this.valores.length}::${tipo}`;
  }
}

/** Condiciones del mensaje (alias `m`): categoría, leído, atención, días de Lima y posición. */
function condicionesMensaje(
  p: Parametros,
  f: FiltrosBandejaBuzon,
  posicion: PosicionBandeja | null,
): string[] {
  const c: string[] = [];
  if (f.categoria === "criticos") c.push("m.critico");
  else if (f.categoria !== undefined) c.push(`m.categoria = ${p.agregar(f.categoria, "text")}`);
  if (f.leido !== undefined) c.push(`m.leido_sunat = ${p.agregar(f.leido, "boolean")}`);
  switch (f.atencion ?? "todos") {
    case "pendientes":
      c.push("m.atendido_en is null and not m.historico");
      break;
    case "atendidos":
      c.push("m.atendido_en is not null");
      break;
    case "historicos":
      c.push("m.atendido_en is null and m.historico");
      break;
    default:
  }
  if (f.desde !== undefined)
    c.push(`m.fecha >= (${p.agregar(f.desde, "date")})::timestamp at time zone 'America/Lima'`);
  if (f.hasta !== undefined)
    c.push(`m.fecha < (${p.agregar(f.hasta, "date")} + 1)::timestamp at time zone 'America/Lima'`);
  if (posicion !== null)
    c.push(
      `(m.fecha, m.id) < (${p.agregar(posicion.fecha, "timestamptz")}, ${p.agregar(posicion.id, "uuid")})`,
    );
  return c;
}

/** Visibilidad del cliente (alias `c`) por el alcance de 005: el mismo `filtroAlcance` del resto de rutas. */
function condicionAlcance(p: Parametros, a: Alcance): string {
  // filtroAlcance renderiza su propio $1; se renumera al índice siguiente de esta consulta.
  const { texto, valores } = renderizar(sql`${filtroAlcance(sql.raw("c.id"), a)}`);
  if (valores.length === 0) return texto;
  const n = p.valores.length;
  for (const v of valores) p.valores.push(v);
  return texto.replace(/\$(\d+)/g, (_t, d: string) => `$${Number(d) + n}`);
}

/** Condiciones del cliente (alias `c`): alcance, «solo donde soy responsable» y archivados. */
function condicionesCliente(p: Parametros, a: Alcance, f: FiltrosBandejaBuzon): string[] {
  const c = [condicionAlcance(p, a)];
  if (f.responsableId !== undefined)
    c.push(
      `exists (select 1 from asignacion r where r.cliente_id = c.id and r.tipo = 'responsable' and r.usuario_id = ${p.agregar(f.responsableId, "uuid")})`,
    );
  if (f.clienteId === undefined && f.archivados !== true) c.push("c.archivado_at is null");
  return c;
}

const y = (c: string[]): string => (c.length === 0 ? "true" : c.join("\n   and "));

/**
 * Orden del recorrido por cliente: el parcial de pendientes es DESC (NULLS FIRST) y el de 023 (buzon_mensaje_lista_idx) es
 * DESC NULLS LAST; las columnas son NOT NULL, así que ambos órdenes son el mismo y solo cambia qué índice lo sirve.
 */
const ordenPorCliente = (f: FiltrosBandejaBuzon): string =>
  f.atencion === "pendientes"
    ? "m.fecha desc, m.id desc"
    : "m.fecha desc nulls last, m.id desc nulls last";

function consultaBandeja(
  a: Alcance,
  f: FiltrosBandejaBuzon,
  posicion: PosicionBandeja | null,
  limite: number,
): { texto: string; valores: unknown[] } {
  const p = new Parametros();
  const usuario = "left join usuario u on u.id = m.atendido_por";
  if (f.clienteId !== undefined) {
    // (a) Bandeja fijada en un cliente (aunque esté archivado), siempre dentro del alcance.
    const cliente = p.agregar(f.clienteId, "uuid");
    const condC = condicionesCliente(p, a, f);
    const condM = condicionesMensaje(p, f, posicion);
    const lim = p.agregar(limite + 1, "integer");
    return {
      texto: `select ${COLUMNAS_FILA}
  from (select ${COLUMNAS_M} from buzon_mensaje m
         where m.tenant_id = ${TENANT} and m.cliente_id = ${cliente}
           and ${y(condM)}
         order by ${ordenPorCliente(f)}
         limit ${lim}) m
  join cliente c on c.tenant_id = ${TENANT} and c.id = m.cliente_id
  ${usuario}
 where ${y(condC)}
 order by m.fecha desc, m.id desc`,
      valores: p.valores,
    };
  }
  if (a.tipo === "global" && f.responsableId === undefined) {
    // (b) Alcance global: índice por estudio y fecha (el parcial que corresponda lo elige el planificador por el predicado).
    const condC = condicionesCliente(p, a, f).filter((x) => x !== "true");
    const condM = condicionesMensaje(p, f, posicion);
    const lim = p.agregar(limite + 1, "integer");
    return {
      texto: `select ${COLUMNAS_FILA.replace("m.contenido_obtenido", "m.contenido_ruta is not null as contenido_obtenido")}
  from buzon_mensaje m
  join cliente c on c.tenant_id = m.tenant_id and c.id = m.cliente_id
  ${usuario}
 where m.tenant_id = ${TENANT}
   and ${y([...condM, ...condC])}
 order by m.fecha desc, m.id desc
 limit ${lim}`,
      valores: p.valores,
    };
  }
  // (c) Alcance asignado o «solo donde soy responsable»: clientes visibles y LATERAL por cliente.
  const condC = condicionesCliente(p, a, f);
  const condM = condicionesMensaje(p, f, posicion);
  const lim = p.agregar(limite + 1, "integer");
  return {
    texto: `with visibles as materialized (
  select c.id, c.razon_social, c.archivado_at from cliente c
   where c.tenant_id = ${TENANT}
     and ${y(condC)}
)
select ${COLUMNAS_FILA}
  from visibles c
  cross join lateral (
    select ${COLUMNAS_M} from buzon_mensaje m
     where m.tenant_id = ${TENANT} and m.cliente_id = c.id
       and ${y(condM)}
     order by ${ordenPorCliente(f)}
     limit ${lim}) m
  ${usuario}
 order by m.fecha desc, m.id desc
 limit ${lim}`,
    valores: p.valores,
  };
}

const fecha = (v: unknown): Date | null =>
  v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v));
const texto = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function estadoDe(atendidoEn: unknown, historico: unknown): EstadoAtencionBuzon {
  return atendidoEn !== null && atendidoEn !== undefined
    ? "atendido"
    : historico === true
      ? "historico"
      : "pendiente";
}

function aAtencion(f: FilaBuzon): AtencionVigente {
  const estado = estadoDe(f.atendido_en, f.historico);
  return estado === "atendido"
    ? {
        estado,
        por: { id: String(f.atendido_por), nombre: texto(f.atendido_por_nombre) },
        en: fecha(f.atendido_en),
      }
    : { estado, por: null, en: null };
}

function aFila(f: FilaBuzon): FilaBandejaBuzon {
  return {
    id: String(f.id),
    asunto: String(f.asunto),
    remitente: String(f.remitente),
    fecha: fecha(f.fecha)!,
    fechaTexto: String(f.fecha_texto),
    categoria: String(f.categoria),
    critico: f.critico === true,
    motivoCritico: texto(f.motivo_critico),
    leidoEnSunat: f.leido_sunat === true,
    contenidoObtenido: f.contenido_obtenido === true,
    adjuntosDeclarados: Number(f.adjuntos_declarados),
    cliente: {
      id: String(f.cliente_id),
      razonSocial: String(f.razon_social),
      archivado: f.cliente_archivado === true,
    },
    atencion: aAtencion(f),
  };
}

/** Una página de la bandeja: `limite` filas (1..1000) desde `posicion` (exclusiva) y si queda alguna más. */
export async function listarBandeja(
  tx: TxConsulta,
  alcance: Alcance,
  filtros: FiltrosBandejaBuzon,
  posicion: PosicionBandeja | null,
  limite: number,
): Promise<{ filas: FilaBandejaBuzon[]; hayMas: boolean }> {
  const n = Number.isInteger(limite) ? Math.min(Math.max(limite, 1), LIMITE_MAXIMO) : 50;
  const { texto: q, valores } = consultaBandeja(alcance, filtros, posicion, n);
  const r = await consultar(tx, q, valores);
  return { filas: r.rows.slice(0, n).map(aFila), hayMas: r.rows.length > n };
}

const SQL_ESTADO_MENSAJE = `select m.historico, m.atendido_en, m.atendido_por, u.nombre as atendido_por_nombre
  from buzon_mensaje m
  left join usuario u on u.id = m.atendido_por
 where m.tenant_id = ${TENANT} and m.id = $1::uuid`;
const SQL_HISTORIAL = `select a.accion, a.comentario, a.usuario_id, u.nombre, a.creado_en
  from buzon_atencion a
  left join usuario u on u.id = a.usuario_id
 where a.tenant_id = ${TENANT} and a.mensaje_id = $1::uuid
 order by a.creado_en, a.id`;

/**
 * Estado vigente, comentario del último evento «atendido» mientras el mensaje siga atendido (null si no) e historial en orden
 * cronológico con el nombre de cada usuario. Mensaje inexistente o de otro estudio: null.
 */
export async function detalleAtencion(
  tx: TxConsulta,
  mensajeId: string,
): Promise<DetalleAtencionBuzon | null> {
  const m = (await consultar(tx, SQL_ESTADO_MENSAJE, [mensajeId])).rows[0];
  if (m === undefined) return null;
  const historial: EventoAtencionBuzon[] = (await consultar(tx, SQL_HISTORIAL, [mensajeId])).rows.map((e) => ({
    accion: e.accion === "deshecho" ? "deshecho" : "atendido",
    comentario: texto(e.comentario),
    usuario: { id: String(e.usuario_id), nombre: texto(e.nombre) },
    en: fecha(e.creado_en)!,
  }));
  const atencion = aAtencion(m);
  const ultimoAtendido = [...historial].reverse().find((e) => e.accion === "atendido");
  return {
    ...atencion,
    comentario: atencion.estado === "atendido" ? (ultimoAtendido?.comentario ?? null) : null,
    historial,
  };
}
