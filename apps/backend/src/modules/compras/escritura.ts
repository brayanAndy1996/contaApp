// Piezas comunes de las escrituras de compras (spec 014, D-2, D-4, D-9, D-11). Las llamadas a `domain` (reglas, estado del
// periodo) se hacen aquí y entran a `packages/db` como funciones inyectadas: `packages/db` no depende de `domain`.
import {
  ComprasReglaError,
  leerEstadoPeriodo,
  leerProveedoresConocidos,
  leerReglasMotor,
  type Alcance,
  type EvaluarCompra,
  type ProveedorConocido,
  type Tx,
} from "@contapp/db";
import { crearEvaluarCompras, DineroError, puedeEscribir, type CodigoReglaMotor } from "@contapp/domain";
import { AccesoError } from "../acceso/errores.js";
import { aEvaluable } from "./evaluable.js";
import { ComprasError, type CodigoCompras } from "./errores.js";
import { exigirCliente } from "./apoyo.js";

/**
 * Cliente del alcance (404 / 409 archivado) y estado del periodo (D-9) con el permiso de la sesión: `revisado` solo con
 * `sire.aprobar_generar` (403 `periodo_revisado`), `generado` nadie (409 `periodo_generado`). El estado se comprueba ANTES que la
 * versión base y que cualquier precondición de la acción. Con `crear`, la fila de `compra_periodo` se crea si falta y se lee
 * `FOR SHARE` (el primer bloqueo del orden de la sección «BD» del plan); sin él solo se lee y no se escribe nada (calcular).
 */
export async function exigirEscritura(
  tx: Tx,
  alcance: Alcance,
  permisos: ReadonlySet<string>,
  clienteId: string,
  periodo: string,
  o: { crear: boolean; archivado: boolean },
): Promise<void> {
  await exigirCliente(tx, clienteId, alcance, o.archivado);
  const { estado } = await leerEstadoPeriodo(tx, clienteId, periodo, o.crear ? { compartido: true } : {});
  const escritura = puedeEscribir(estado, [...permisos]);
  if (!escritura.ok) throw new ComprasError(escritura.codigo);
}

/** El entorno de reglas de la petición: el historial de proveedores del cliente en otros periodos y la evaluación de una fila. */
export interface EntornoReglas {
  readonly conocidos: ProveedorConocido[];
  readonly evaluar: EvaluarCompra;
}

export async function entornoDeReglas(tx: Tx, clienteId: string, periodo: string): Promise<EntornoReglas> {
  const conocidos = await leerProveedoresConocidos(tx, clienteId, periodo);
  // 021, RF-089: las reglas que el estudio apagó (sin fila = encendida) no se evalúan. R-HIS no es hallazgo ni se evalúa aquí
  // (solo el worker la aplica en la descarga) y por eso no se pasan reglas aprendidas (P-3): corregir no devuelve la fila a la regla.
  const apagadas = (await leerReglasMotor(tx)).filas.filter((f) => !f.activa).map((f) => f.codigo as CodigoReglaMotor);
  // P-4: el XML simulado solo entra en las reglas con `XML_SIMULADO_EN_REGLAS=1` (apagado por defecto).
  const evaluarDominio = crearEvaluarCompras(conocidos, {
    xmlSimuladoEnReglas: process.env.XML_SIMULADO_EN_REGLAS === "1",
    reglasApagadas: apagadas,
  });
  return { conocidos, evaluar: (fila) => evaluarDominio(aEvaluable(fila)) };
}

/** El entorno de reglas de cada periodo (su historial de proveedores), leído una vez por periodo en la transacción. */
export function evaluarPorPeriodo(tx: Tx, clienteId: string): (periodo: string) => Promise<EvaluarCompra> {
  const memo = new Map<string, Promise<EvaluarCompra>>();
  return (periodo) => {
    let e = memo.get(periodo);
    if (e === undefined) {
      e = entornoDeReglas(tx, clienteId, periodo).then((x) => x.evaluar);
      memo.set(periodo, e);
    }
    return e;
  };
}

const CODIGOS_PROPIOS: ReadonlySet<string> = new Set<CodigoCompras>([
  "version_obsoleta",
  "fila_excluida",
  "no_excluida",
  "no_descartable",
  "duplicado",
  "fila_cambiada",
  "nada_que_deshacer",
  "nada_que_rehacer",
  "revisar_de_nuevo",
  "requiere_dato",
  "requiere_confirmacion",
  "estado_invalido",
]);

/**
 * Un incumplimiento de regla de `packages/db` → su respuesta HTTP, sin mensajes crudos ni datos de la fila. `datoPedido` lo
 * aporta quien rechazó con `requiere_dato` (la regla no lo lleva en el error). Cualquier otro error pasa tal cual (el filtro
 * global lo responde 500 sin detalle).
 */
export function aErrorHttp(e: unknown, datoPedido?: "gravado" | "destino"): unknown {
  if (!(e instanceof ComprasReglaError)) return e;
  if (e.codigo === "no_encontrada") return new AccesoError("no_encontrado");
  if (e.codigo === "solicitud_invalida") return new AccesoError("solicitud_invalida");
  if (!CODIGOS_PROPIOS.has(e.codigo)) return e;
  const codigo = e.codigo as CodigoCompras;
  return new ComprasError(codigo, {
    ...(e.versionVigente === undefined ? {} : { versionVigente: e.versionVigente }),
    ...(codigo === "requiere_dato" && datoPedido !== undefined ? { dato: datoPedido } : {}),
    ...(codigo === "duplicado" && e.ids?.[0] !== undefined ? { id: e.ids[0] } : {}),
    ...(codigo === "fila_cambiada" && e.ids !== undefined ? { ids: e.ids } : {}),
  });
}

/** Un error de dinero del dominio (monto con más de 2 decimales, fuera de NUMERIC(14,2), suma que no cabe) es 400, no un 500. */
export function aSolicitudInvalida(e: unknown): unknown {
  return e instanceof DineroError ? new AccesoError("solicitud_invalida") : e;
}

/** La fila que se pidió, o el 404 de siempre (inexistente, de otro cliente, periodo o estudio, o descartada). */
export function exigir<T>(valor: T | null): T {
  if (valor === null) throw new AccesoError("no_encontrado");
  return valor;
}
