// Auxiliares comunes de las rutas de ventas (spec 013): el servicio de ventas y el de importación los comparten.
import {
  bloquearPeriodoLibro,
  clienteVisible,
  leerClienteDto,
  leerEstadoPeriodoVentas,
  type Alcance,
  type EstadoPeriodoVentas,
  type PropuestaFila,
  type Tx,
  type VentaFila,
} from "@contapp/db";
import { cuadraVenta, puedeEscribir } from "@contapp/domain";
import type { PropuestaVentasDto, VentaDto } from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import type { PeticionAcceso } from "../acceso/guards/decoradores.js";
import { alcanceDe, esUuid } from "../clientes/contexto.js";
import { VentasError } from "./errores.js";

/** Periodo AAAAMM con mes 01 a 12. Lo futuro lo rechaza el catálogo de la cola al descargar (008/013 D2). */
const PERIODO = /^[0-9]{4}(?:0[1-9]|1[0-2])$/;

export function periodoDe(valor: string): string {
  if (!PERIODO.test(valor)) throw new AccesoError("solicitud_invalida");
  return valor;
}

const HUSO_LIMA_MS = 5 * 60 * 60 * 1000;

/** Mes en curso (hora de Lima, UTC-5) como AAAAMM; se evalúa en cada llamada. Mismo criterio que el catálogo de la cola. */
function periodoEnCurso(): string {
  const ahora = new Date(Date.now() - HUSO_LIMA_MS);
  return `${ahora.getUTCFullYear()}${String(ahora.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** `periodoDe` y, además, sin futuro (no posterior al mes en curso): el estado de un periodo que no ha ocurrido no se marca (012b P-1). */
export function periodoSinFuturoDe(valor: string): string {
  const periodo = periodoDe(valor);
  if (periodo > periodoEnCurso()) throw new AccesoError("solicitud_invalida");
  return periodo;
}

/**
 * Cliente del alcance (D5). `ClienteScopeGuard` ya filtró la ruta; esto lo repite dentro de la misma transacción
 * (`filtroAlcance` vía `clienteVisible`) y, en una escritura, rechaza al cliente archivado con 409.
 */
export async function exigirCliente(
  tx: Tx,
  clienteId: string,
  alcance: Alcance,
  escritura: boolean,
): Promise<void> {
  if (!(await clienteVisible(tx, clienteId, alcance))) throw new AccesoError("no_encontrado");
  if (!escritura) return;
  const cliente = await leerClienteDto(tx, clienteId);
  if (cliente === null) throw new AccesoError("no_encontrado");
  if (cliente.archivado) throw new AccesoError("cliente_archivado");
}

export function aPropuestaDto(p: PropuestaFila): PropuestaVentasDto {
  return {
    id: p.id,
    fuente: p.fuente,
    filasRecibidas: p.filasRecibidas,
    filasNuevas: p.filasNuevas,
    filasIguales: p.filasIguales,
    filasDistintas: p.filasDistintas,
    creadaEn: p.creadaEn.toISOString(),
  };
}

/** `[alcance, permisos]` de la sesión (005 D5; P-9 de 012b); sin acceso resuelto, la ruta no se atiende. */
export function accesoDe(req: PeticionAcceso): readonly [Alcance, ReadonlySet<string>] {
  if (req.acceso === undefined) throw new AccesoError("permiso_denegado");
  return [alcanceDe(req.acceso), req.acceso.permisos];
}

/**
 * Estado del periodo de ventas para ESCRIBIR (012b, D5, P-9; ronda 1, H-012b-1). Como las escrituras de compras (014,
 * `exigirEscritura`): con `bloquear`, la fila de `venta_periodo` se crea `abierto` si falta y se lee `FOR SHARE` ANTES de decidir,
 * de modo que revisar, reabrir y generar (`FOR UPDATE`) esperan a la escritura en curso, o la escritura ve su resultado. Sin
 * `bloquear` (encolar la descarga: el worker lo repite bajo el bloqueo) solo se lee y no se crea nada.
 */
async function estadoParaEscribir(tx: Tx, clienteId: string, periodo: string, bloquear: boolean): Promise<EstadoPeriodoVentas> {
  return (await leerEstadoPeriodoVentas(tx, clienteId, periodo, bloquear ? { compartido: true } : {})).estado;
}

/**
 * Cliente del alcance (404 / 409 archivado), advisory del libro y estado del periodo con el permiso de la sesión: `revisado` solo
 * con `sire.aprobar_generar` (403 `periodo_revisado`), `generado` nadie (409 `periodo_generado`). Orden de bloqueo del plan:
 * advisory del libro, luego `venta_periodo` (`FOR SHARE`), luego las filas. Con `bloquear: false` (encolar la descarga: el worker
 * lo repite bajo el bloqueo) solo se lee.
 */
export async function exigirEscrituraVentas(
  tx: Tx,
  alcance: Alcance,
  permisos: ReadonlySet<string>,
  clienteId: string,
  periodo: string,
  o: { bloquear: boolean } = { bloquear: true },
): Promise<void> {
  await exigirCliente(tx, clienteId, alcance, true);
  if (o.bloquear) await bloquearPeriodoLibro(tx, clienteId, periodo, "ventas");
  const estado = await estadoParaEscribir(tx, clienteId, periodo, o.bloquear);
  const r = puedeEscribir(estado, [...permisos]);
  if (!r.ok) throw new VentasError(r.codigo);
}

/** Un id mal formado en la ruta es un recurso inexistente (404), igual que uno que no existe. */
export function idDe(valor: string): string {
  if (!esUuid(valor)) throw new AccesoError("no_encontrado");
  return valor;
}

/**
 * Fila de la BD → `VentaDto`: ni la clave interna, ni la propuesta, ni el usuario, ni el estudio. `cuadra` se calcula
 * aquí con el dominio (D26): no hay columna; la fila se devuelve tal cual llegó aunque no cuadre (D3).
 */
export function aVentaDto(f: VentaFila): VentaDto {
  return {
    id: f.id,
    origen: f.origen,
    tipo: f.tipo,
    serie: f.serie,
    numero: f.numero,
    fechaEmision: f.fecha,
    tipoDocContraparte: f.tipoDocContraparte,
    docContraparte: f.docContraparte,
    moneda: f.moneda,
    tipoCambio: f.tipoCambio,
    baseGravada: f.baseGravada,
    igv: f.igv,
    exonerada: f.exonerada,
    inafecta: f.inafecta,
    isc: f.isc,
    icbper: f.icbper,
    otros: f.otros,
    total: f.total,
    cuadra: cuadraVenta(f, f.moneda),
    // 012b D12: la exclusión vigente (motivo, quién y cuándo) o null.
    exclusion: f.exclusion === null ? null : { motivo: f.exclusion.motivo, por: f.exclusion.por, en: f.exclusion.en.toISOString() },
  };
}
