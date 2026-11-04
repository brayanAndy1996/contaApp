// Repositorios de clientes (spec 007a, D1, D4, D5, D7). Todos con la `tx` de withTenant. El servicio toma antes
// bloquearMiembros y CupoRucs.reservar: aquí NO se bloquean miembros ni cupo. Texto SQL estático; los valores viajan
// como parámetros. Ninguna consulta toca columnas del sobre cifrado (solo `credencial.estado`).
import type { ClienteDto, PerfilFiscal } from "@contapp/shared";
import { sql, type SQL } from "drizzle-orm";
import { filtroAlcance, renderizar, type Alcance } from "../acceso/alcance";
import { AccesoRepoError, type TxConsulta } from "../acceso/errores";
import { cliente } from "../schema/clientes";
import { ClienteArchivadoError, RucDuplicadoError } from "./errores";
import { condicionesFiltros, type FiltrosListado } from "./filtros";

export type { FiltrosListado } from "./filtros";

export interface DatosCliente {
  /** Id explícito (007b D7): permite cifrar la credencial con el AAD final antes de abrir la transacción. */
  id?: string;
  ruc: string;
  razonSocial?: string;
  perfil?: PerfilFiscal;
}

type Resultado = { rows: Array<Record<string, any>>; rowCount: number | null }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function ejecutar(
  tx: TxConsulta,
  texto: string,
  valores: unknown[],
): Promise<Resultado> {
  try {
    return (await tx.query(texto, valores)) as Resultado;
  } catch (e) {
    throw AccesoRepoError.desde(e);
  }
}

const PERFIL_DEFECTO: PerfilFiscal = {
  regimen: null,
  zona: "general",
  ventasExoneradas: false,
  ventasMixtas: false,
  monedaHabitual: "PEN",
};

const SQL_CREAR = `insert into cliente (id, tenant_id, ruc, razon_social, regimen, zona, ventas_exoneradas, ventas_mixtas, moneda_habitual)
  values (coalesce($9::uuid, gen_random_uuid()), $1::uuid, $2, $3, $4, $5, $6, $7, $8) returning id`;

/** Crea el cliente y devuelve su id. Sin razón social guarda «RUC <número>» (D1). RUC repetido -> RucDuplicadoError. */
export async function crearCliente(
  tx: TxConsulta,
  tenantId: string,
  d: DatosCliente,
): Promise<string> {
  const razon = d.razonSocial?.trim();
  const p = d.perfil ?? PERFIL_DEFECTO;
  try {
    const r = await tx.query(SQL_CREAR, [
      tenantId,
      d.ruc,
      razon !== undefined && razon !== "" ? razon : `RUC ${d.ruc}`,
      p.regimen,
      p.zona,
      p.ventasExoneradas,
      p.ventasMixtas,
      p.monedaHabitual,
      d.id ?? null,
    ]);
    return r.rows[0]?.id as string;
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === "23505")
      throw new RucDuplicadoError();
    throw AccesoRepoError.desde(e);
  }
}

// Datos de la consulta de RUC (007b D1, rol worker). La razón social solo se reemplaza si sigue siendo la provisional
// «RUC <ruc>»; la comparación va en el mismo UPDATE, así una edición manual concurrente no se pisa.
const SQL_COMPLETAR_RUC = `update cliente
  set razon_social = case when razon_social = 'RUC ' || ruc then $2 else razon_social end,
      estado_contribuyente = $3, condicion_contribuyente = $4, updated_at = now()
  where id = $1::uuid`;

/** Completa razón social (si es la provisional), estado y condición del cliente. No lanza si el cliente no existe. */
export async function completarDatosRuc(
  tx: TxConsulta,
  clienteId: string,
  d: { razonSocial: string; estado: string; condicion: string },
): Promise<void> {
  await ejecutar(tx, SQL_COMPLETAR_RUC, [
    clienteId,
    d.razonSocial,
    d.estado,
    d.condicion,
  ]);
}

const SQL_RUCS_EXISTENTES = `select ruc, archivado_at is not null as archivado from cliente
  where ruc = any($1::text[])`;

/** RUC (de la lista) que ya existen en el estudio, activos o archivados. Los que no existen se omiten. */
export async function rucsExistentes(
  tx: TxConsulta,
  rucs: string[],
): Promise<Array<{ ruc: string; archivado: boolean }>> {
  if (rucs.length === 0) return [];
  const r = await ejecutar(tx, SQL_RUCS_EXISTENTES, [rucs]);
  return r.rows.map((f) => ({ ruc: f.ruc as string, archivado: f.archivado as boolean }));
}

const SQL_ARCHIVADO = "select archivado_at from cliente where id = $1::uuid";

/**
 * Edita razón social y/o perfil (el RUC no se toca). Un archivado está en solo lectura: ClienteArchivadoError.
 * Devuelve false si el cliente no existe en el estudio.
 */
export async function editarCliente(
  tx: TxConsulta,
  clienteId: string,
  d: { razonSocial?: string; perfil?: PerfilFiscal },
): Promise<boolean> {
  const valores: unknown[] = [clienteId];
  const sets: string[] = ["updated_at = now()"];
  const poner = (columna: string, valor: unknown) => {
    valores.push(valor);
    sets.push(`${columna} = $${valores.length}`);
  };
  if (d.razonSocial !== undefined) poner("razon_social", d.razonSocial.trim());
  if (d.perfil !== undefined) {
    poner("regimen", d.perfil.regimen);
    poner("zona", d.perfil.zona);
    poner("ventas_exoneradas", d.perfil.ventasExoneradas);
    poner("ventas_mixtas", d.perfil.ventasMixtas);
    poner("moneda_habitual", d.perfil.monedaHabitual);
  }
  const r = await ejecutar(
    tx,
    `update cliente set ${sets.join(", ")} where id = $1::uuid and archivado_at is null returning id`,
    valores,
  );
  if ((r.rowCount ?? r.rows.length) > 0) return true;
  const fila = (await ejecutar(tx, SQL_ARCHIVADO, [clienteId])).rows[0];
  if (fila === undefined) return false;
  throw new ClienteArchivadoError();
}

// Idempotente: archivar uno ya archivado no mueve la marca. Solo libera cupo (D4): no lo bloquea ni toca miembros.
const SQL_ARCHIVAR =
  "update cliente set archivado_at = now(), updated_at = now() where id = $1::uuid and archivado_at is null returning id";
const SQL_REACTIVAR =
  "update cliente set archivado_at = null, updated_at = now() where id = $1::uuid and archivado_at is not null returning id";

/** Archiva (baja lógica). Idempotente. */
export async function archivarCliente(
  tx: TxConsulta,
  clienteId: string,
): Promise<void> {
  await ejecutar(tx, SQL_ARCHIVAR, [clienteId]);
}

/** Reactiva. El servicio ya reservó el cupo (D4). Idempotente. */
export async function reactivarCliente(
  tx: TxConsulta,
  clienteId: string,
): Promise<void> {
  await ejecutar(tx, SQL_REACTIVAR, [clienteId]);
}

// Una fila por cliente: responsable (si tiene) y el estado de cada tipo de credencial (solo `estado`).
const SELECCION: SQL = sql`select ${cliente.id} as id, ${cliente.ruc} as ruc, ${cliente.razonSocial} as razon_social,
       ${cliente.estadoContribuyente} as estado_contribuyente, ${cliente.condicionContribuyente} as condicion_contribuyente,
       ${cliente.regimen} as regimen, ${cliente.zona} as zona, ${cliente.ventasExoneradas} as ventas_exoneradas,
       ${cliente.ventasMixtas} as ventas_mixtas, ${cliente.monedaHabitual} as moneda_habitual,
       ${cliente.archivadoAt} as archivado_at,
       r.usuario_id as responsable_id, u.nombre as responsable_nombre,
       cr.sol as cred_sol, cr.sire_api as cred_sire_api
  from cliente
  left join asignacion r on r.cliente_id = ${cliente.id} and r.tipo = ${"responsable"}
  left join usuario u on u.id = r.usuario_id
  left join lateral (
    select max(c2.estado) filter (where c2.tipo = ${"sol"}) as sol,
           max(c2.estado) filter (where c2.tipo = ${"sire_api"}) as sire_api
      from credencial c2 where c2.cliente_id = ${cliente.id}
  ) cr on true`;

type Fila = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function aDto(f: Fila): ClienteDto {
  return {
    id: f.id,
    ruc: f.ruc,
    razonSocial: f.razon_social,
    estadoContribuyente: f.estado_contribuyente ?? null,
    condicionContribuyente: f.condicion_contribuyente ?? null,
    perfil: {
      regimen: f.regimen ?? null,
      zona: f.zona,
      ventasExoneradas: f.ventas_exoneradas,
      ventasMixtas: f.ventas_mixtas,
      monedaHabitual: f.moneda_habitual,
    },
    archivado: f.archivado_at !== null && f.archivado_at !== undefined,
    responsable:
      f.responsable_id === null || f.responsable_id === undefined
        ? null
        : { id: f.responsable_id, nombre: f.responsable_nombre ?? null },
    credenciales: {
      sol: f.cred_sol ?? "no_configurada",
      sire_api: f.cred_sire_api ?? "no_configurada",
    },
  };
}

/** El cliente del estudio con responsable, perfil y estado de credenciales, o null (sin alcance: lo aplica el guard). */
export async function leerClienteDto(
  tx: TxConsulta,
  clienteId: string,
): Promise<ClienteDto | null> {
  const { texto, valores } = renderizar(
    sql`${SELECCION} where ${cliente.id} = ${clienteId}::uuid`,
  );
  const fila = (await ejecutar(tx, texto, valores)).rows[0];
  return fila === undefined ? null : aDto(fila);
}

/** Clientes del alcance que cumplen todos los filtros (AND), por razón social e id. Activos salvo `archivados`. */
export async function listarClientesFiltrado(
  tx: TxConsulta,
  a: Alcance,
  f: FiltrosListado,
): Promise<ClienteDto[]> {
  const condiciones = [filtroAlcance(cliente.id, a), ...condicionesFiltros(f)];
  const { texto, valores } = renderizar(
    sql`${SELECCION} where ${sql.join(condiciones, sql` and `)} order by ${cliente.razonSocial}, ${cliente.id}`,
  );
  return (await ejecutar(tx, texto, valores)).rows.map(aDto);
}
