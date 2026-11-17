// Escrituras de reglas aprendidas (spec 021, D-2, D-5, P-1, P-2, P-5, P-9, P-10, CA-9). Compare-and-set por `version` en la
// `tx` de withTenant: un UPDATE con `version = versionBase` espera a quien tenga la fila bloqueada (una descarga la lee con
// FOR SHARE, CA-9) y, si ya cambió, no toca nada y devuelve `regla_cambiada`. Crear usa la única parcial con ON CONFLICT DO
// NOTHING: de dos «Recordar» simultáneos, uno crea y el otro recibe `regla_cambiada`. Nunca bloquea compras ni crea versiones
// (D-5). La auditoría la escriben los triggers de 0047; la confirmación `recordar` se inserta aquí, en la misma transacción.
import { consultar, type TxConsulta } from "../compras/errores";
import { DOC_NUMERO_NORMALIZADO, esUuidRegla, leerRegla } from "./lectura";
import type {
  CodigoRegla,
  EntradaEditar,
  EntradaEliminar,
  EntradaRecordar,
  ReglaFila,
} from "./tipos";

const SQL_COMPRAS = `select c.id, c.periodo::text as periodo, btrim(c.doc_tipo) as doc_tipo,
    ${DOC_NUMERO_NORMALIZADO("c.doc_numero")} as doc_numero
  from compra c
  where c.id = any($1::uuid[]) and c.cliente_id = $2 and c.descartada_en is null`;

const SQL_CREAR = `insert into regla_aprendida (cliente_id, doc_tipo, doc_numero, destino, activa, version, periodo_aprendido,
    creada_por, actualizada_por)
  values ($1, $2, $3, $4, true, 1, $5, $6, $6)
  on conflict (tenant_id, cliente_id, doc_tipo, doc_numero) where eliminada_en is null do nothing
  returning id`;

// «Recordar» sobre una regla viva: destino nuevo, reactivada y aprendida en el periodo de estas compras (P-5).
const SQL_RECORDAR_EXISTENTE = `update regla_aprendida
  set destino = $4, activa = true, version = version + 1, periodo_aprendido = $5, actualizada_por = $6, actualizada_en = now()
  where cliente_id = $1 and doc_tipo = $2 and doc_numero = $3 and eliminada_en is null and version = $7
  returning id`;

// Solo RUC 20 (documento tipo 6) y con el aporte del estudio encendido (sin fila = encendido): P-1, P-10.
const SQL_CONFIRMAR = `insert into regla_confirmacion (regla_id, cliente_id, ruc_proveedor, destino, origen)
  select $1::uuid, $2::uuid, $3::text, $4::text, 'recordar'
  where $5::text = '6' and $3::text ~ '^20[0-9]{9}$'
    and coalesce((select k.aportar_catalogo from estudio_reglas_config k), true)`;

const SQL_EDITAR = `update regla_aprendida
  set destino = coalesce($4::text, destino), activa = coalesce($5::boolean, activa), version = version + 1,
      actualizada_por = $6, actualizada_en = now()
  where id = $1 and cliente_id = $2 and eliminada_en is null and version = $3
  returning id`;

const SQL_ELIMINAR = `update regla_aprendida
  set eliminada_en = now(), eliminada_por = $4, version = version + 1, actualizada_por = $4, actualizada_en = now()
  where id = $1 and cliente_id = $2 and eliminada_en is null and version = $3`;

const SQL_VIVA = `select 1 from regla_aprendida where id = $1 and cliente_id = $2 and eliminada_en is null`;

/** `version` es int4: fuera de 1..2^31-1 no hay regla con esa versión (y la BD respondería 22003, H-021-1-2). */
const VERSION_MAX = 2_147_483_647;
const versionValida = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= VERSION_MAX;

async function releer(tx: TxConsulta, clienteId: string, reglaId: string): Promise<ReglaFila> {
  const fila = await leerRegla(tx, clienteId, reglaId);
  // La fila se acaba de escribir en esta transacción: siempre se ve.
  if (!fila) throw new Error("regla: no se pudo releer la regla escrita");
  return fila;
}

/** Sin escritura por versión vieja: `regla_cambiada` si la regla sigue viva y `no_encontrada` si no (404 idéntico, CA-5). */
async function sinEscritura(
  tx: TxConsulta,
  clienteId: string,
  reglaId: string,
): Promise<"regla_cambiada" | "no_encontrada"> {
  const r = await consultar(tx, SQL_VIVA, [reglaId, clienteId]);
  return r.rowCount > 0 ? "regla_cambiada" : "no_encontrada";
}

/**
 * «Recordar» (D-2, D-5): todas las compras deben ser del cliente, vivas, de un mismo proveedor (P-2) y de un mismo periodo
 * (H-021-1-1: `periodos_distintos`, sin escribir). `versionBase = null` crea la regla (si ya hay una viva, `regla_cambiada`); con
 * número actualiza el destino y reactiva la viva si la versión coincide. `periodo_aprendido` = periodo de esas compras. Registra la
 * confirmación `recordar` (P-1).
 */
export async function recordarRegla(
  tx: TxConsulta,
  e: EntradaRecordar,
): Promise<ReglaFila | CodigoRegla> {
  const ids = [...new Set(e.compraIds)];
  if (!esUuidRegla(e.clienteId) || ids.length === 0 || !ids.every(esUuidRegla)) return "no_encontrada";
  if (e.versionBase !== null && !versionValida(e.versionBase)) return "regla_cambiada";
  const compras = await consultar(tx, SQL_COMPRAS, [ids, e.clienteId]);
  if (compras.rowCount !== ids.length) return "no_encontrada";
  const proveedores = new Set(compras.rows.map((c) => `${c.doc_tipo as string}:${c.doc_numero as string}`));
  if (proveedores.size !== 1) return "proveedores_distintos";
  const periodos = new Set(compras.rows.map((c) => c.periodo as string));
  if (periodos.size !== 1) return "periodos_distintos";
  const docTipo = compras.rows[0]!.doc_tipo as string;
  const docNumero = compras.rows[0]!.doc_numero as string;
  const periodo = compras.rows[0]!.periodo as string;

  const escrita =
    e.versionBase === null
      ? await consultar(tx, SQL_CREAR, [e.clienteId, docTipo, docNumero, e.destino, periodo, e.usuarioId])
      : await consultar(tx, SQL_RECORDAR_EXISTENTE, [
          e.clienteId,
          docTipo,
          docNumero,
          e.destino,
          periodo,
          e.usuarioId,
          e.versionBase,
        ]);
  const reglaId = escrita.rows[0]?.id as string | undefined;
  if (!reglaId) return "regla_cambiada";
  await consultar(tx, SQL_CONFIRMAR, [reglaId, e.clienteId, docNumero, e.destino, docTipo]);
  return releer(tx, e.clienteId, reglaId);
}

/** Cambia el destino y/o el estado (compare-and-set por versión, CA-7). */
export async function editarRegla(
  tx: TxConsulta,
  e: EntradaEditar,
): Promise<ReglaFila | "regla_cambiada" | "no_encontrada"> {
  if (!esUuidRegla(e.clienteId) || !esUuidRegla(e.reglaId)) return "no_encontrada";
  if (!versionValida(e.versionBase)) return sinEscritura(tx, e.clienteId, e.reglaId);
  const r = await consultar(tx, SQL_EDITAR, [
    e.reglaId,
    e.clienteId,
    e.versionBase,
    e.destino ?? null,
    e.activa ?? null,
    e.usuarioId,
  ]);
  if (r.rowCount === 0) return sinEscritura(tx, e.clienteId, e.reglaId);
  return releer(tx, e.clienteId, e.reglaId);
}

/** Baja lógica (P-9): la fila se conserva con `eliminada_en` y deja de listarse y de aplicarse. */
export async function eliminarRegla(
  tx: TxConsulta,
  e: EntradaEliminar,
): Promise<"ok" | "regla_cambiada" | "no_encontrada"> {
  if (!esUuidRegla(e.clienteId) || !esUuidRegla(e.reglaId)) return "no_encontrada";
  if (!versionValida(e.versionBase)) return sinEscritura(tx, e.clienteId, e.reglaId);
  const r = await consultar(tx, SQL_ELIMINAR, [e.reglaId, e.clienteId, e.versionBase, e.usuarioId]);
  if (r.rowCount === 0) return sinEscritura(tx, e.clienteId, e.reglaId);
  return "ok";
}
