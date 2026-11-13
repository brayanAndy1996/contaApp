// R-HIS (021, RF-086, D-7). No es un hallazgo del motor (plan, Decisiones: «R-HIS fuera de la lista de hallazgos»): planifica
// qué filas nuevas de la descarga se mueven solas al destino de la regla aprendida de su proveedor, con los montos de
// `cambiarDestino` (010). La BD recalcula la misma consolidación y falla cerrado si no coincide. Puro: sin IO, sin `number`.
import { cambiarDestino } from "../comprobante/index";
import type { Destino, MontosComprobante } from "../comprobante/index";
import { Money } from "../dinero/index";
import { EntradaReglasInvalidaError } from "./errores";
import { PARES_DESTINO, esMontosReal, leerArreglo, leerObjeto } from "./entrada";
import type { FilaEvaluable, ReglaAprendidaEvaluable } from "./tipos";

export interface PlanHistorial {
  readonly filaId: string;
  readonly reglaId: string;
  readonly destino: Destino;
  readonly montos: MontosComprobante;
}

const TIPO_DOC = /^[0-9A-Z]$/;
const NUMERO_DOC = /^[0-9A-Z-]{1,15}$/;
const ESPACIOS = /\s/g;
const MINUSCULA_ASCII = /[a-z]/g;
/** Cota previa a transformar un texto de identidad (la misma que la entrada de 011). */
const LARGO_MAX = 64;

const CLAVES_FILA = ["id", "proveedor", "comprobante", "montos", "origenUsd", "xml"];
const REQUERIDAS_FILA = ["id", "proveedor", "montos"];
const CLAVES_REGLA = ["id", "proveedor", "destino"];
const CLAVES_DOC = ["tipo", "numero"];
const CLAVES_OPCIONES = ["rHisActiva"];

function invalida(): never {
  throw new EntradaReglasInvalidaError();
}

/**
 * Clave `tipo:numero` normalizada como R-NEW (sin espacios y en mayúsculas ASCII). Un documento fuera de gramática no es un
 * error: no coincide con nada (una compra rara no detiene la descarga, D-4) y una regla así no se aplica.
 */
function claveDoc(o: unknown): string | null {
  const v = leerObjeto(o, CLAVES_DOC);
  const tipo = v.get("tipo");
  const numero = v.get("numero");
  if (typeof tipo !== "string" || typeof numero !== "string") return invalida();
  if (tipo.length > LARGO_MAX || numero.length > LARGO_MAX) return null;
  const n = numero.replace(ESPACIOS, "").replace(MINUSCULA_ASCII, (c) => c.toUpperCase());
  return TIPO_DOC.test(tipo) && NUMERO_DOC.test(n) ? `${tipo}:${n}` : null;
}

function esDestino(d: unknown): d is Destino {
  return PARES_DESTINO.some((p) => p.destino === d);
}

interface ReglaInterna {
  readonly id: string;
  readonly destino: Destino;
}

/**
 * Reglas por proveedor normalizado. Dos reglas que caen en el mismo proveedor son ambiguas y ninguna se aplica (falla
 * cerrado: la BD tiene una sola regla viva por proveedor y cliente, así que no debería ocurrir).
 */
function reglasPorProveedor(reglas: unknown): Map<string, ReglaInterna | null> {
  const porClave = new Map<string, ReglaInterna | null>();
  for (const o of leerArreglo(reglas)) {
    const v = leerObjeto(o, CLAVES_REGLA);
    const id = v.get("id");
    const destino = v.get("destino");
    if (typeof id !== "string" || id.length === 0 || !esDestino(destino)) invalida();
    const clave = claveDoc(v.get("proveedor"));
    if (clave === null) continue;
    porClave.set(clave, porClave.has(clave) ? null : Object.freeze({ id: id as string, destino: destino as Destino }));
  }
  return porClave;
}

interface FilaInterna {
  readonly id: string;
  readonly clave: string | null;
  readonly montos: MontosComprobante;
}

function leerFila(o: unknown): FilaInterna {
  const v = leerObjeto(o, CLAVES_FILA, REQUERIDAS_FILA);
  const id = v.get("id");
  const montos = v.get("montos");
  if (typeof id !== "string" || id.length === 0 || !esMontosReal(montos)) return invalida();
  return { id, clave: claveDoc(v.get("proveedor")), montos };
}

/** Suma de los tres BI (DG, DGNG, DNG) en la moneda de la fila. */
function biTotal(m: MontosComprobante): Money {
  return Money.suma(
    PARES_DESTINO.map((p) => m.obtener(p.bi)),
    m.moneda,
  );
}

/**
 * Qué filas mueve R-HIS (D-7): proveedor con regla (documento normalizado como R-NEW), BI total ≠ 0 y algún monto fuera del
 * destino de la regla (si ya está todo ahí, nada). Los montos son los de `cambiarDestino(montos, destino)`: los tres BI y los
 * tres IGV sumados en el par del destino, el resto igual y el total sin cambios. Con R-HIS apagado, nada. Las reglas llegan
 * vivas y activas. Valida toda la entrada antes de planificar (EntradaReglasInvalidaError, sin resultados parciales); no muta
 * lo recibido. Resultado en el orden de las filas.
 */
export function planificarHistorial(
  filas: readonly FilaEvaluable[],
  reglas: readonly ReglaAprendidaEvaluable[],
  opciones: { readonly rHisActiva: boolean },
): PlanHistorial[] {
  const rHisActiva = leerObjeto(opciones, CLAVES_OPCIONES).get("rHisActiva");
  if (typeof rHisActiva !== "boolean") invalida();
  const porProveedor = reglasPorProveedor(reglas);
  const internas = leerArreglo(filas).map(leerFila);
  if (!rHisActiva) return [];

  const plan: PlanHistorial[] = [];
  for (const fila of internas) {
    if (fila.clave === null) continue;
    const regla = porProveedor.get(fila.clave);
    if (regla === undefined || regla === null) continue;
    if (biTotal(fila.montos).esCero()) continue;
    const { montos, consolidados } = cambiarDestino(fila.montos, regla.destino);
    if (consolidados.length === 0) continue;
    plan.push(Object.freeze({ filaId: fila.id, reglaId: regla.id, destino: regla.destino, montos }));
  }
  return plan;
}
