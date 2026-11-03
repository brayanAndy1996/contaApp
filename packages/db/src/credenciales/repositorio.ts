// Repositorios de credenciales (spec 003). SQL estático y parametrizado; se llaman dentro de withTenant
// (la RLS limita al estudio del contexto). Los privilegios por columna de 0006 deciden qué puede cada rol:
// contapp_backend solo guarda y consulta estado; contapp_worker lee el sobre, re-envuelve y audita.
// Todo error de `pg` se reduce a CredencialRepoError con solo el SQLSTATE.
import type { Tx } from "../with-tenant";
import { CredencialRepoError } from "./errores";

export type TxConsulta = Pick<Tx, "query">;
export type TipoCredencial = "sol" | "sire_api";
export type ResultadoDescifrado =
  "ok" | "no_encontrada" | "integridad" | "formato" | "llave";

/** Sobre cifrado tal como lo produce @contapp/crypto (estructuralmente compatible). */
export interface SobreGuardado {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  dekEnvuelta: Buffer;
  kekId: string;
  version: 1;
}

/** Fila de credencial con el sobre completo (solo la lee contapp_worker). */
export interface CredencialConSobre {
  id: string;
  tenantId: string;
  clienteId: string;
  tipo: TipoCredencial;
  sobre: SobreGuardado;
}

/** Columnas de estado de una credencial (las únicas que contapp_backend puede leer). */
export interface EstadoCredencial {
  id: string;
  tenantId: string;
  clienteId: string;
  tipo: TipoCredencial;
  createdAt: Date;
  updatedAt: Date;
}

interface FilaSobre {
  id: string;
  tenant_id: string;
  cliente_id: string;
  tipo: TipoCredencial;
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  dek_envuelta: Buffer;
  kek_id: string;
  version: number;
}

interface FilaEstado {
  id: string;
  tenant_id: string;
  cliente_id: string;
  tipo: TipoCredencial;
  created_at: Date;
  updated_at: Date;
}

// Upsert sin EXCLUDED: leer EXCLUDED.<columna del sobre> exige SELECT, que el backend no tiene (CA-4c).
const SQL_GUARDAR = `insert into credencial (cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version)
  values ($1, $2, $3, $4, $5, $6, $7, $8)
  on conflict (tenant_id, cliente_id, tipo) do update set
    ciphertext = $3, nonce = $4, tag = $5, dek_envuelta = $6, kek_id = $7, version = $8, updated_at = now()
  returning id`;

const SQL_ESTADO = `select id, tenant_id, cliente_id, tipo, created_at, updated_at
  from credencial where cliente_id = $1 order by tipo, id`;

const SQL_LEER = `select id, tenant_id, cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version
  from credencial where id = $1`;

const SQL_LISTAR = `select id, tenant_id, cliente_id, tipo, ciphertext, nonce, tag, dek_envuelta, kek_id, version
  from credencial where kek_id = $1 order by id limit $2`;

// CAS sobre dek_envuelta y kek_id (= $5, obligatorio desde 008): si el backend escribió cualquiera de los dos entre la
// lectura y esta escritura, gana el backend.
const SQL_REEMPLAZAR_DEK = `update credencial set dek_envuelta = $3, kek_id = $4, updated_at = now()
  where id = $1 and dek_envuelta = $2 and kek_id = $5`;

// Sin RETURNING: contapp_worker no tiene SELECT sobre la auditoría.
const SQL_AUDITAR = `insert into auditoria_descifrado (credencial_id, cliente_id, tipo, motivo, resultado)
  values ($1, $2, $3, $4, $5)`;

async function consultar<R extends object>(
  tx: TxConsulta,
  texto: string,
  valores: unknown[],
): Promise<{ rows: R[]; rowCount: number | null }> {
  try {
    return await tx.query<R & Record<string, unknown>>(texto, valores);
  } catch (error) {
    throw CredencialRepoError.desde(error);
  }
}

const aSobre = (f: FilaSobre): CredencialConSobre => ({
  id: f.id,
  tenantId: f.tenant_id,
  clienteId: f.cliente_id,
  tipo: f.tipo,
  sobre: {
    ciphertext: f.ciphertext,
    nonce: f.nonce,
    tag: f.tag,
    dekEnvuelta: f.dek_envuelta,
    kekId: f.kek_id,
    version: f.version as 1,
  },
});

/** Inserta o reemplaza el sobre de (cliente, tipo) en el estudio del contexto. Rol: contapp_backend. */
export async function guardarSobre(
  tx: TxConsulta,
  a: { clienteId: string; tipo: TipoCredencial; sobre: SobreGuardado },
): Promise<{ id: string }> {
  const s = a.sobre;
  const r = await consultar<{ id: string }>(tx, SQL_GUARDAR, [
    a.clienteId,
    a.tipo,
    s.ciphertext,
    s.nonce,
    s.tag,
    s.dekEnvuelta,
    s.kekId,
    s.version,
  ]);
  return { id: r.rows[0].id };
}

/** Columnas de estado (sin sobre) de las credenciales de un cliente. */
export async function estadoCredenciales(
  tx: TxConsulta,
  clienteId: string,
): Promise<EstadoCredencial[]> {
  const r = await consultar<FilaEstado>(tx, SQL_ESTADO, [clienteId]);
  return r.rows.map((f) => ({
    id: f.id,
    tenantId: f.tenant_id,
    clienteId: f.cliente_id,
    tipo: f.tipo,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
  }));
}

/** Sobre completo por id, o null si no existe en el estudio del contexto. Rol: contapp_worker. */
export async function leerSobre(
  tx: TxConsulta,
  id: string,
): Promise<CredencialConSobre | null> {
  const r = await consultar<FilaSobre>(tx, SQL_LEER, [id]);
  return r.rows.length === 0 ? null : aSobre(r.rows[0]);
}

/** Lote de credenciales envueltas con `kekId`, ordenado por id (rotación). Rol: contapp_worker. */
export async function listarParaReenvolver(
  tx: TxConsulta,
  kekId: string,
  limite: number,
): Promise<CredencialConSobre[]> {
  const r = await consultar<FilaSobre>(tx, SQL_LISTAR, [kekId, limite]);
  return r.rows.map(aSobre);
}

/**
 * Re-envuelve la DEK de una credencial con CAS sobre `dek_envuelta` y `kek_id` (= `kekAnterior`, la KEK de la
 * que se rota). true si la fila cambió; false si no existe en el estudio, su DEK ya no es `dekAnterior` o su
 * kek_id ya no es `kekAnterior`. Solo toca dek_envuelta, kek_id y updated_at.
 * Spec 008 (CA-12): `kekAnterior` es obligatorio; sin él (o vacío) lanza antes de consultar (falla cerrado).
 */
export async function reemplazarDekEnvuelta(
  tx: TxConsulta,
  a: {
    id: string;
    dekAnterior: Buffer;
    dekNueva: Buffer;
    kekNuevo: string;
    kekAnterior: string;
  },
): Promise<boolean> {
  const kekAnterior: unknown = a?.kekAnterior;
  if (typeof kekAnterior !== "string" || kekAnterior.length === 0) {
    throw new TypeError("reemplazarDekEnvuelta exige kekAnterior");
  }
  const r = await consultar(tx, SQL_REEMPLAZAR_DEK, [
    a.id,
    a.dekAnterior,
    a.dekNueva,
    a.kekNuevo,
    kekAnterior,
  ]);
  return r.rowCount === 1;
}

/** Registra un intento de descifrado (sin secreto). Rol: contapp_worker. */
export async function registrarDescifrado(
  tx: TxConsulta,
  a: {
    credencialId: string;
    clienteId?: string | null;
    tipo?: TipoCredencial | null;
    motivo: string;
    resultado: ResultadoDescifrado;
  },
): Promise<void> {
  await consultar(tx, SQL_AUDITAR, [
    a.credencialId,
    a.clienteId ?? null,
    a.tipo ?? null,
    a.motivo,
    a.resultado,
  ]);
}
