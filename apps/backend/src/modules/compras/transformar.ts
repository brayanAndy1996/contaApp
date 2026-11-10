// Cálculo de la versión nueva de cada acción (spec 014, D-4 a D-6, D-15). Entra a `packages/db` como `Transformar`: recibe la
// fila vigente (ya bloqueada, con la versión base comprobada) y devuelve los datos de la versión nueva o un rechazo. Aquí viven
// las llamadas a `domain` (cambiarDestino, aplicarEdicion, aceptarSugerenciaGuardada); un monto o destino que el dominio no
// acepta es `solicitud_invalida`, un defecto de programa se propaga.
import type {
  CompraLeida,
  HallazgoGuardadoCompra,
  MontosCompra,
  ProveedorConocido,
  ResultadoTransformarCompra,
  TransformarCompra,
} from "@contapp/db";
import {
  aceptarSugerenciaGuardada,
  aplicarEdicion,
  cambiarDestino,
  DineroError,
  MontosComprobante,
  type CambiosMontos,
} from "@contapp/domain";
import type { DatoSugerencia, DestinoCompra } from "@contapp/shared";
import { aEvaluable } from "./evaluable.js";

/** La fila vigente en el dominio (`Money` en su moneda). */
export const montosDeDominio = (c: Pick<CompraLeida, "moneda" | "montos">): MontosComprobante =>
  MontosComprobante.desde(c.moneda, c.montos);

/** Las 10 columnas y el total como cadenas, la forma de `packages/db`. */
export const montosACadenas = (m: MontosComprobante): MontosCompra => ({ ...m.toJSON().columnas, total: m.total.toString() });

/** Un error de dinero del dominio (monto o destino que no vale) es una solicitud inválida, no un 500. */
function conDinero(f: () => ResultadoTransformarCompra): ResultadoTransformarCompra {
  try {
    return f();
  } catch (e) {
    if (e instanceof DineroError) return { rechazo: "solicitud_invalida" };
    throw e;
  }
}

export const transformarClasificar: TransformarCompra = (actual, parametros) =>
  conDinero(() => {
    const { destino } = parametros as { destino: DestinoCompra };
    const { montos } = cambiarDestino(montosDeDominio(actual), destino);
    return { montos: montosACadenas(montos), excluida: actual.excluida, motivo: actual.motivo, clasificada: true };
  });

export const transformarEditar: TransformarCompra = (actual, parametros) =>
  conDinero(() => {
    const { cambios } = parametros as { cambios: CambiosMontos };
    const { montos } = aplicarEdicion(montosDeDominio(actual), cambios);
    return { montos: montosACadenas(montos), excluida: actual.excluida, motivo: actual.motivo, clasificada: actual.clasificada };
  });

export const transformarExcluir: TransformarCompra = (actual, parametros) => {
  const { motivo } = parametros as { motivo?: string };
  return { montos: actual.montos, excluida: true, motivo: motivo ?? null, clasificada: actual.clasificada };
};

export const transformarRestaurar: TransformarCompra = (actual) =>
  actual.excluida
    ? { montos: actual.montos, excluida: false, motivo: null, clasificada: actual.clasificada }
    : { rechazo: "no_excluida" };

export interface ContextoSugerencia {
  /** Los hallazgos vigentes de las filas de la petición; se piden UNA vez, cuando las filas ya están bloqueadas. */
  cargarHallazgos: () => Promise<Map<string, HallazgoGuardadoCompra[]>>;
  conocidos: ProveedorConocido[];
  enMasa: boolean;
  regla: string;
  confirmar: boolean;
  dato: DatoSugerencia | undefined;
  /** Se llama con el dato que pidió un `requiere_dato` (la regla de `packages/db` no lo lleva en el error). */
  alPedirDato?: (dato: "gravado" | "destino") => void;
}

/**
 * Aceptar la sugerencia GUARDADA de la versión base (D-4, DU-22). Los hallazgos se leen cuando `packages/db` ya bloqueó las
 * filas (la transformación se llama después del bloqueo), así que no pueden cambiar entre la lectura y la escritura.
 */
export function transformarSugerencia(ctx: ContextoSugerencia): TransformarCompra {
  let hallazgos: Map<string, HallazgoGuardadoCompra[]> | null = null;
  return async (actual) => {
    hallazgos ??= await ctx.cargarHallazgos();
    const r = aceptarSugerenciaGuardada({
      compra: aEvaluable(actual),
      hallazgo: hallazgos.get(actual.id)?.find((h) => h.regla === ctx.regla),
      proveedoresConocidos: ctx.conocidos,
      confirmar: ctx.confirmar,
      dato: ctx.dato,
      enMasa: ctx.enMasa,
    });
    if (!r.ok) {
      if (r.rechazo === "requiere_dato" && r.dato !== undefined) ctx.alPedirDato?.(r.dato);
      return { rechazo: r.rechazo };
    }
    return {
      montos: r.montos,
      excluida: r.excluir ? true : actual.excluida,
      motivo: r.excluir ? null : actual.motivo,
      clasificada: actual.clasificada || r.clasifica,
    };
  };
}
