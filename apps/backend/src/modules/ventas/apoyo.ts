// Auxiliares comunes de las rutas de ventas (spec 013): el servicio de ventas y el de importación los comparten.
import { clienteVisible, leerClienteDto, type Alcance, type PropuestaFila, type Tx } from "@contapp/db";
import type { PropuestaVentasDto } from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";

/** Periodo AAAAMM con mes 01 a 12. Lo futuro lo rechaza el catálogo de la cola al descargar (008/013 D2). */
const PERIODO = /^[0-9]{4}(?:0[1-9]|1[0-2])$/;

export function periodoDe(valor: string): string {
  if (!PERIODO.test(valor)) throw new AccesoError("solicitud_invalida");
  return valor;
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
