// Cálculo de la versión nueva de cada acción (spec 014, D-4 a D-6, D-15). Entra a `packages/db` como `Transformar`: recibe la
// fila vigente (ya bloqueada, con la versión base comprobada) y devuelve los datos de la versión nueva o un rechazo. Aquí viven
// las llamadas a `domain` (cambiarDestino, aplicarEdicion, aceptarSugerenciaGuardada); un monto o destino que el dominio no
// acepta es `solicitud_invalida`, un defecto de programa se propaga.
import type {
  CompraConXml,
  CompraLeida,
  EvaluarCompra,
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
  /**
   * Las reglas con el entorno ACTUAL de la petición (bandera P-4 incluida): con XML, aceptar re-evalúa con ellas (H-016-10). Sin
   * ellas, una fila con XML no se acepta (`revisar_de_nuevo`): no hay con qué contrastar.
   */
  evaluar?: EvaluarCompra;
  /**
   * La bandera P-4 de ese mismo entorno: el XML vigente de la fila (`aEvaluable`) entra en la re-evaluación de aceptar con
   * confirmación (R-GP exige XML) bajo la misma regla que en la evaluación. Por defecto, apagada.
   */
  xmlSimuladoEnReglas?: boolean;
  enMasa: boolean;
  regla: string;
  confirmar: boolean;
  dato: DatoSugerencia | undefined;
  /** Se llama con el dato que pidió un `requiere_dato` (la regla de `packages/db` no lo lleva en el error). */
  alPedirDato?: (dato: "gravado" | "destino") => void;
}

/** JSON canónico (claves ordenadas): compara lo guardado en jsonb (que reordena las claves) con lo que da `evaluar`. */
function canonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonico).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonico(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

const firma = (h: { sugerencia: unknown; lecturas: unknown; requiereConfirmacion: boolean }): string =>
  canonico({ sugerencia: h.sugerencia ?? null, lecturas: h.lecturas ?? {}, requiereConfirmacion: h.requiereConfirmacion });

/**
 * H-016-10 y H-016-11: con un XML en el comprobante, lo que la lupa mostró (el hallazgo guardado) tiene que ser lo que dan HOY
 * las reglas con el XML vigente (leído tras el bloqueo) y la bandera P-4 actual. Si el XML vigente cambió o la bandera cambió
 * desde la evaluación, el resultado difiere y no se aplica. Sin XML (ni antes ni ahora: un XML guardado no se borra) el entorno
 * de 016 no cambió y basta el contraste de 014.
 */
async function sigueVigente(
  actual: CompraConXml,
  guardado: HallazgoGuardadoCompra,
  evaluar: EvaluarCompra | undefined,
): Promise<boolean> {
  if (actual.xml === null) return true;
  if (evaluar === undefined) return false;
  const hoy = ((await evaluar(actual)) ?? []).find((h) => h.regla === guardado.regla);
  return hoy !== undefined && firma(hoy) === firma(guardado);
}

/**
 * Aceptar la sugerencia GUARDADA de la versión base (D-4, DU-22). Los hallazgos se leen cuando `packages/db` ya bloqueó las
 * filas (la transformación se llama después del bloqueo), así que no pueden cambiar entre la lectura y la escritura. Con XML, la
 * sugerencia además se contrasta con una evaluación nueva en el entorno actual (`sigueVigente`): si difiere, `revisar_de_nuevo`.
 */
export function transformarSugerencia(ctx: ContextoSugerencia): TransformarCompra {
  let hallazgos: Map<string, HallazgoGuardadoCompra[]> | null = null;
  return async (actual) => {
    hallazgos ??= await ctx.cargarHallazgos();
    const guardado = hallazgos.get(actual.id)?.find((h) => h.regla === ctx.regla);
    const r = aceptarSugerenciaGuardada({
      compra: aEvaluable(actual),
      hallazgo: guardado,
      proveedoresConocidos: ctx.conocidos,
      confirmar: ctx.confirmar,
      dato: ctx.dato,
      enMasa: ctx.enMasa,
      xmlSimuladoEnReglas: ctx.xmlSimuladoEnReglas === true,
    });
    if (!r.ok) {
      if (r.rechazo === "requiere_dato" && r.dato !== undefined) ctx.alPedirDato?.(r.dato);
      return { rechazo: r.rechazo };
    }
    if (guardado === undefined || !(await sigueVigente(actual, guardado, ctx.evaluar))) return { rechazo: "revisar_de_nuevo" };
    return {
      montos: r.montos,
      excluida: r.excluir ? true : actual.excluida,
      motivo: r.excluir ? null : actual.motivo,
      clasificada: actual.clasificada || r.clasifica,
    };
  };
}
