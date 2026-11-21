// Repositorio de candidatas del aprendizaje del historial (spec 025, D-4 a D-6, U-8; CA-3, CA-4, CA-13). Solo SQL estático y
// parametrizado en la `tx` de withTenant. El listado es de solo lectura (RLS del estudio y filtro por cliente); activar, reemplazar
// y descartar van por las funciones acotadas de 0062. Errores: AprendizajeRepoError (solo el SQLSTATE); CA409 al reemplazar vuelve
// como `regla_cambiada`.
import type { TxConsulta } from "../compras/errores";
import type { DestinoRegla } from "../reglas/tipos";
import {
  AprendizajeRepoError,
  consultarAprendizaje,
  consultarPorId,
  type FilaAprendizaje,
} from "./importacion";

export type GrupoCandidatas =
  "propuestas" | "sin_criterio" | "conflicto" | "resueltas";
export type EstadoCandidata =
  "pendiente" | "activada" | "descartada" | "reemplazada";
export type ConflictoCandidata = "ninguno" | "ya_aprendida" | "distinto";
export type MotivoOmitida =
  "conflicto" | "ya_aprendida" | "no_pendiente" | "sin_criterio";

export interface PosicionCandidata {
  docTipo: string;
  docNumero: string;
}

export interface CandidataFila {
  id: string;
  proveedor: { tipo: string; numero: string; razonSocial: string | null };
  destinoPropuesto: DestinoRegla | null;
  conteos: {
    DG: number;
    DGNG: number;
    DNG: number;
    mixto: number;
    total: number;
  };
  periodosConProveedor: number;
  periodosLeidos: number;
  estado: EstadoCandidata;
  destinoElegido: DestinoRegla | null;
  /**
   * `activa: false` solo si la regla está desactivada (D-6: se reactiva desde la página de reglas, no desde aquí); con la regla
   * activa la clave no va, así el cuerpo de siempre no cambia.
   */
  regla: { id: string; destino: DestinoRegla; version: number; activa?: false } | null;
  conflicto: ConflictoCandidata;
}

const LIMITE_MAXIMO = 1000;

// Candidatas de la ÚLTIMA importación completada del cliente, en orden (doc_tipo, doc_numero) y con cursor por valor: la única
// (tenant, importacion, doc_tipo, doc_numero) da el orden. `v`: la regla viva del proveedor de una pendiente con destino propuesto
// (conflicto, por el índice único de reglas vivas de 021); `a`: la regla creada al activar. Grupos (partición):
//   propuestas   pendiente, con destino propuesto y sin regla viva;   sin_criterio pendiente sin destino propuesto;
//   conflicto    pendiente, con destino propuesto y regla viva;       resueltas    activada o descartada.
const SQL_LISTAR = `with ultima as (
    select i.id, i.periodos_leidos from regla_importacion i
     where i.cliente_id = $1 and i.estado = 'completada'
     order by i.solicitada_en desc, i.id desc
     limit 1
  )
  select k.id, k.doc_tipo, k.doc_numero, k.razon_social, k.destino_propuesto, k.n_dg, k.n_dgng, k.n_dng, k.n_mixto, k.n_total,
         k.periodos_con_proveedor, coalesce(u.periodos_leidos, 0) as periodos_leidos, k.estado, k.destino_elegido,
         coalesce(v.id, a.id) as regla_id, coalesce(v.destino, a.destino) as regla_destino,
         coalesce(v.version, a.version) as regla_version, coalesce(v.activa, a.activa) as regla_activa,
         case when v.id is null then 'ninguno' when v.destino = k.destino_propuesto then 'ya_aprendida' else 'distinto' end
           as conflicto
    from ultima u
    join regla_candidata k on k.importacion_id = u.id and k.cliente_id = $1
    left join regla_aprendida v
      on k.estado = 'pendiente' and k.destino_propuesto is not null and v.tenant_id = k.tenant_id
     and v.cliente_id = k.cliente_id and v.doc_tipo = k.doc_tipo and v.doc_numero = k.doc_numero and v.eliminada_en is null
    left join regla_aprendida a on k.estado = 'activada' and a.tenant_id = k.tenant_id and a.id = k.regla_id
   where (
         ($2 = 'propuestas' and k.estado = 'pendiente' and k.destino_propuesto is not null and v.id is null)
      or ($2 = 'sin_criterio' and k.estado = 'pendiente' and k.destino_propuesto is null)
      or ($2 = 'conflicto' and k.estado = 'pendiente' and k.destino_propuesto is not null and v.id is not null)
      or ($2 = 'resueltas' and k.estado in ('activada', 'descartada'))
     )
     and ($3::text is null or (k.doc_tipo, k.doc_numero) > ($3::text, $4::text))
   order by k.doc_tipo, k.doc_numero
   limit $5`;

const SQL_ACTIVAR =
  "select * from public.reglas_candidatas_activar($1::uuid, $2::jsonb, $3::uuid)";
const SQL_REEMPLAZAR =
  "select * from public.reglas_candidata_reemplazar($1::uuid, $2::uuid, $3::text, $4::integer)";
const SQL_DESCARTAR =
  "select * from public.reglas_candidatas_descartar($1::uuid, $2::uuid[])";

const aCandidataFila = (f: FilaAprendizaje): CandidataFila => ({
  id: f.id as string,
  proveedor: {
    tipo: f.doc_tipo as string,
    numero: f.doc_numero as string,
    razonSocial: f.razon_social as string | null,
  },
  destinoPropuesto: f.destino_propuesto as DestinoRegla | null,
  conteos: {
    DG: f.n_dg as number,
    DGNG: f.n_dgng as number,
    DNG: f.n_dng as number,
    mixto: f.n_mixto as number,
    total: f.n_total as number,
  },
  periodosConProveedor: f.periodos_con_proveedor as number,
  periodosLeidos: f.periodos_leidos as number,
  estado: f.estado as EstadoCandidata,
  destinoElegido: f.destino_elegido as DestinoRegla | null,
  regla:
    f.regla_id === null
      ? null
      : {
          id: f.regla_id as string,
          destino: f.regla_destino as DestinoRegla,
          version: f.regla_version as number,
          ...(f.regla_activa === false ? { activa: false as const } : {}),
        },
  conflicto: f.conflicto as ConflictoCandidata,
});

/**
 * Una página de un grupo de candidatas de la última importación completada del cliente. `posicion` es la `siguiente` de la página
 * anterior (valor, no desplazamiento: no repite ni omite aunque cambien las filas); `siguiente` es `null` si no queda ninguna más.
 */
export async function listarCandidatas(
  tx: TxConsulta,
  e: {
    clienteId: string;
    grupo: GrupoCandidatas;
    posicion: PosicionCandidata | null;
    limite: number;
  },
): Promise<{
  candidatas: CandidataFila[];
  siguiente: PosicionCandidata | null;
}> {
  // El backend ya valida 1..200 (filtrosCandidatasSchema); aquí solo se acota. Un grupo desconocido no devuelve filas.
  const limite = Math.min(Math.max(Math.trunc(e.limite), 1), LIMITE_MAXIMO);
  const filas = await consultarPorId(tx, e.clienteId, SQL_LISTAR, [
    e.clienteId,
    e.grupo,
    e.posicion?.docTipo ?? null,
    e.posicion?.docNumero ?? null,
    limite + 1,
  ]);
  const pagina = filas.slice(0, limite).map(aCandidataFila);
  const ultima = pagina[pagina.length - 1];
  return {
    candidatas: pagina,
    siguiente:
      filas.length > limite && ultima
        ? { docTipo: ultima.proveedor.tipo, docNumero: ultima.proveedor.numero }
        : null,
  };
}

export type EntradaActivar =
  | { clienteId: string; items: Array<{ id: string; destino?: DestinoRegla }> }
  | { clienteId: string; todas: string };

/**
 * Activa candidatas por id (con el destino elegido o el propuesto) o «todas» las de la última importación completada
 * (`reglas_candidatas_activar`). Ids ajenos o inexistentes: AprendizajeRepoError P0002 y nada cambia.
 */
export async function activarCandidatas(
  tx: TxConsulta,
  e: EntradaActivar,
): Promise<{
  activadas: string[];
  omitidas: Array<{ id: string; motivo: MotivoOmitida }>;
}> {
  const valores =
    "items" in e
      ? [
          e.clienteId,
          JSON.stringify(
            e.items.map((i) =>
              i.destino === undefined
                ? { id: i.id }
                : { id: i.id, destino: i.destino },
            ),
          ),
          null,
        ]
      : [e.clienteId, null, e.todas];
  const filas = await consultarAprendizaje(tx, SQL_ACTIVAR, valores);
  const activadas: string[] = [];
  const omitidas: Array<{ id: string; motivo: MotivoOmitida }> = [];
  for (const f of filas) {
    if (f.resultado === "activada") activadas.push(f.candidata_id as string);
    else
      omitidas.push({
        id: f.candidata_id as string,
        motivo: f.resultado as MotivoOmitida,
      });
  }
  return { activadas, omitidas };
}

/** Reemplaza la regla vigente del proveedor por el destino de la candidata (`reglas_candidata_reemplazar`). */
export async function reemplazarCandidata(
  tx: TxConsulta,
  e: {
    clienteId: string;
    candidataId: string;
    destino?: DestinoRegla;
    versionRegla: number;
  },
): Promise<{ reglaId: string } | "regla_cambiada"> {
  try {
    const filas = await consultarAprendizaje(tx, SQL_REEMPLAZAR, [
      e.clienteId,
      e.candidataId,
      e.destino ?? null,
      e.versionRegla,
    ]);
    return { reglaId: filas[0]!.regla_id as string };
  } catch (error) {
    if (error instanceof AprendizajeRepoError && error.codigo === "CA409")
      return "regla_cambiada";
    throw error;
  }
}

/** Descarta las candidatas pendientes (`reglas_candidatas_descartar`); las ya resueltas vuelven como omitidas. */
export async function descartarCandidatas(
  tx: TxConsulta,
  e: { clienteId: string; ids: string[] },
): Promise<{ descartadas: string[]; omitidas: string[] }> {
  const filas = await consultarAprendizaje(tx, SQL_DESCARTAR, [
    e.clienteId,
    e.ids,
  ]);
  const descartadas: string[] = [];
  const omitidas: string[] = [];
  for (const f of filas) {
    if (f.descartada === true) descartadas.push(f.candidata_id as string);
    else omitidas.push(f.candidata_id as string);
  }
  return { descartadas, omitidas };
}
