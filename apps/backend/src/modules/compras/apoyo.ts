// Auxiliares comunes de las rutas de compras (spec 014). Periodo y cliente del alcance son los mismos que usa ventas.
import type { DiferenciaFila, PropuestaFila } from "@contapp/db";
import type { DiferenciaComprasDto, PropuestaComprasDto } from "@contapp/shared";
import { AccesoError } from "../acceso/errores.js";
import { esUuid } from "../clientes/contexto.js";

export { exigirCliente, periodoDe } from "../ventas/apoyo.js";

/** Un id mal formado en la ruta es un recurso inexistente (404), igual que uno que no existe. */
export function idDe(valor: string): string {
  if (!esUuid(valor)) throw new AccesoError("no_encontrado");
  return valor;
}

export function aPropuestaDto(p: PropuestaFila): PropuestaComprasDto {
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

export function aDiferenciaDto(d: DiferenciaFila): DiferenciaComprasDto {
  return {
    clave: d.clave,
    tipo: d.tipo,
    serie: d.serie,
    numero: d.numero,
    origenExistente: d.origenExistente,
    campos: d.campos,
    valoresSire: d.valoresSire,
  };
}
