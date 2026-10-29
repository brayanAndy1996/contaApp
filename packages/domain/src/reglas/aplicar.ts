// aplicarSugerencia / aplicarMasivo (plan 011, Decisiones: "Obsolescencia" y "Ratificación de
// contratos", Aplicar). Puras: nunca tocan los montos recibidos; los movimientos son los de 010.
// T9: mover (R-ISC) y separar (R-MIX) con sus pruebas; T10 completa y prueba el resto.
// T13 (ronda adversarial 1): la sugerencia recibida no se cree; se contrasta con la regla, el
// destino y las lecturas (pruebas R1b-1 a R1b-5 de ronda1b.adv.spec.ts).
// T15 (ronda adversarial 2): con el entorno de evaluarReglas (filas y contexto, con el XML) la fila
// se re-evalúa con los montos actuales y solo se aplica el mismo hallazgo. T15b: el entorno es
// obligatorio (sin él no se puede probar el respaldo del XML); la re-evaluación sustituye a las
// comprobaciones de lecturas, vigencia y coherencia de T13.
import { COLUMNAS_COMPRA, MontosComprobante, cambiarDestino, moverMonto } from "../comprobante/index";
import type { ColumnaCompra, Destino } from "../comprobante/index";
import { DineroError, Money } from "../dinero/index";
import type { Moneda } from "../dinero/index";
import { esMoneyReal, esMontosReal, leerArreglo, leerObjeto, validarContexto, validarFilas } from "./entrada";
import type { ContextoInterno, FilaInterna } from "./entrada";
import { evaluarFila } from "./motor";
import {
  ConfirmacionInvalidaError,
  EntradaReglasInvalidaError,
  ReglasError,
  SugerenciaObsoletaError,
} from "./errores";
import { ORDEN_REGLAS } from "./tipos";
import type {
  CodigoRegla,
  Confirmacion,
  ContextoReglas,
  DatoRequerido,
  EntornoEvaluacion,
  EntradaMasiva,
  FilaEvaluable,
  Hallazgo,
  ResultadoAplicar,
  ResultadoMasivo,
} from "./tipos";

const CLAVES_HALLAZGO = [
  "filaId",
  "regla",
  "destino",
  "explicacion",
  "sugerencia",
  "requiereConfirmacion",
  "dato",
  "lecturas",
];
const CLAVES_LECTURA: readonly string[] = [...COLUMNAS_COMPRA, "total"];
const COLUMNAS_BI: readonly string[] = ["biDg", "biDgng", "biDng"];
const DESTINOS: readonly string[] = ["DG", "DGNG", "DNG"];
const ID_FILA = /^[A-Za-z0-9_-]{1,64}$/;

/** Tipo de sugerencia que corresponde a cada regla. */
const TIPO_DE_REGLA: ReadonlyMap<CodigoRegla, string> = new Map<CodigoRegla, string>([
  ["R-ISC", "mover"],
  ["R-MIX", "separar"],
  ["R-RED", "ajustar"],
  ["R-NEW", "clasificar"],
  ["R-GP", "excluir"],
]);

function invalida(): never {
  throw new EntradaReglasInvalidaError();
}

/** Money real en cualquier moneda soportada; si no, EntradaReglasInvalidaError. */
function moneyReal(x: unknown): Money {
  if (!esMoneyReal(x)) invalida();
  return x as Money;
}

function columna(x: unknown, permitidas: readonly string[]): ColumnaCompra {
  if (typeof x !== "string" || !permitidas.includes(x)) invalida();
  return x as ColumnaCompra;
}

/** Columnas (y total) con Money reales; copia en un Map. */
function leerParciales(o: unknown): Map<string, Money> {
  const salida = new Map<string, Money>();
  for (const [k, v] of leerObjeto(o, CLAVES_LECTURA, [])) salida.set(k, moneyReal(v));
  return salida;
}

type SugerenciaLeida =
  | { tipo: "mover"; origen: ColumnaCompra; destino: ColumnaCompra; monto: Money }
  | { tipo: "separar"; columnaBi: ColumnaCompra; min: Money; max: Money; estimado: Money; exacto: Money | null }
  | { tipo: "ajustar"; valores: Map<string, Money> }
  | { tipo: "clasificar" }
  | { tipo: "excluir"; palabra: string; categoria: string };

interface HallazgoLeido {
  readonly filaId: string;
  readonly regla: CodigoRegla;
  readonly destino: Destino | null;
  readonly explicacion: string;
  readonly requiereConfirmacion: boolean;
  readonly dato: DatoRequerido | null;
  readonly lecturas: Map<string, Money>;
  readonly sugerencia: SugerenciaLeida;
}

function leerSugerencia(o: unknown, regla: CodigoRegla): SugerenciaLeida {
  if (typeof o !== "object" || o === null) return invalida();
  const tipo: unknown = (o as { tipo?: unknown }).tipo;
  if (tipo !== TIPO_DE_REGLA.get(regla)) invalida();
  switch (tipo) {
    case "mover": {
      const v = leerObjeto(o, ["tipo", "origen", "destino", "monto"]);
      return {
        tipo,
        origen: columna(v.get("origen"), COLUMNAS_COMPRA),
        destino: columna(v.get("destino"), COLUMNAS_COMPRA),
        monto: moneyReal(v.get("monto")),
      };
    }
    case "separar": {
      const v = leerObjeto(o, ["tipo", "columnaBi", "min", "max", "estimado", "exacto"]);
      const min = moneyReal(v.get("min"));
      const max = moneyReal(v.get("max"));
      const estimado = moneyReal(v.get("estimado"));
      const exacto = v.get("exacto") === null ? null : moneyReal(v.get("exacto"));
      return { tipo, columnaBi: columna(v.get("columnaBi"), COLUMNAS_BI), min, max, estimado, exacto };
    }
    case "ajustar": {
      const valores = leerParciales(leerObjeto(o, ["tipo", "valores"]).get("valores"));
      if (valores.size === 0) invalida();
      return { tipo, valores };
    }
    case "clasificar":
      leerObjeto(o, ["tipo"]);
      return { tipo };
    default: {
      const v = leerObjeto(o, ["tipo", "palabra", "categoria"]);
      const palabra = v.get("palabra");
      const categoria = v.get("categoria");
      if (typeof palabra !== "string" || typeof categoria !== "string") invalida();
      return { tipo: "excluir", palabra: palabra as string, categoria: categoria as string };
    }
  }
}

/** Forma del hallazgo (sin sugerencia o falsificado → EntradaReglasInvalidaError). */
function leerHallazgo(h: unknown): HallazgoLeido {
  const v = leerObjeto(h, CLAVES_HALLAZGO);
  const filaId = v.get("filaId");
  const regla = v.get("regla") as CodigoRegla;
  const destino = v.get("destino");
  const explicacion = v.get("explicacion");
  const dato = v.get("dato");
  if (typeof filaId !== "string" || !ID_FILA.test(filaId)) invalida();
  if (!ORDEN_REGLAS.includes(regla)) invalida();
  if (destino !== null && (typeof destino !== "string" || !DESTINOS.includes(destino))) invalida();
  if (typeof explicacion !== "string" || typeof v.get("requiereConfirmacion") !== "boolean") invalida();
  if (dato !== null && dato !== "gravado" && dato !== "destino") invalida();
  if (v.get("sugerencia") === null) invalida();
  const lecturas = leerParciales(v.get("lecturas"));
  return {
    filaId: filaId as string,
    regla,
    destino: destino as Destino | null,
    explicacion: explicacion as string,
    requiereConfirmacion: v.get("requiereConfirmacion") as boolean,
    dato: dato as DatoRequerido | null,
    lecturas,
    sugerencia: leerSugerencia(v.get("sugerencia"), regla),
  };
}

// ---------------------------------------------------------------- entorno (T15)
interface EntornoInterno {
  readonly filas: ReadonlyMap<string, FilaInterna>;
  readonly contexto: ContextoInterno;
}

/** Entorno validado como en evaluarReglas (contexto y después filas). */
function leerEntorno(e: unknown): EntornoInterno {
  const v = leerObjeto(e, ["filas", "contexto"]);
  const contexto = validarContexto(v.get("contexto") as ContextoReglas);
  const filas = new Map<string, FilaInterna>();
  for (const f of validarFilas(v.get("filas") as readonly FilaEvaluable[])) filas.set(f.id, f);
  return { filas, contexto };
}

/** Texto canónico de un hallazgo leído: Money con su moneda (toJSON) y cada Map por clave. */
function canonico(h: HallazgoLeido): string {
  return JSON.stringify(h, (_k, v: unknown) =>
    v instanceof Map ? [...(v as Map<string, Money>)].sort(([a], [b]) => (a < b ? -1 : 1)) : v,
  );
}

/**
 * CA-9 de raíz (R2a-1 a R2a-3): la fila re-evaluada con los montos actuales debe dar el mismo
 * hallazgo (explicación, sugerencia, confirmación, dato y lecturas) para esa regla y destino;
 * si no, la sugerencia recibida es obsoleta (o falsa).
 */
function reevaluar(h: HallazgoLeido, montos: MontosComprobante, entorno: EntornoInterno): void {
  const fila = entorno.filas.get(h.filaId);
  if (fila === undefined) invalida();
  if (fila.montos.moneda !== montos.moneda) throw new SugerenciaObsoletaError();
  const actual = evaluarFila({ ...fila, montos }, entorno.contexto).find(
    (x) => x.regla === h.regla && x.destino === h.destino && x.sugerencia !== null,
  );
  if (actual === undefined || canonico(leerHallazgo(actual)) !== canonico(h)) {
    throw new SugerenciaObsoletaError();
  }
}

// ---------------------------------------------------------------- aplicar
/**
 * Gravado de la confirmación: un Money real (si no, ConfirmacionInvalidaError) en la moneda de
 * la fila (si no, MonedaDistintaError de 010).
 */
function gravadoConfirmado(c: Confirmacion | undefined, moneda: Moneda): Money | null {
  if (c === undefined) return null;
  if (typeof c !== "object" || c === null || !Object.hasOwn(c, "gravado")) {
    throw new ConfirmacionInvalidaError();
  }
  const g: unknown = (c as { gravado: unknown }).gravado;
  if (!esMoneyReal(g)) throw new ConfirmacionInvalidaError();
  return Money.suma([g], moneda);
}

function destinoConfirmado(c: Confirmacion | undefined): Destino {
  if (typeof c !== "object" || c === null || !Object.hasOwn(c, "destino")) {
    throw new ConfirmacionInvalidaError();
  }
  const d: unknown = (c as { destino: unknown }).destino;
  if (typeof d !== "string" || !DESTINOS.includes(d)) throw new ConfirmacionInvalidaError();
  return d as Destino;
}

/** R-MIX: gravado en `columnaBi`, el resto (|BI| − gravado, con signo) a noGravado. */
function separar(
  montos: MontosComprobante,
  s: Extract<SugerenciaLeida, { tipo: "separar" }>,
  c: Confirmacion | undefined,
): MontosComprobante {
  const confirmado = gravadoConfirmado(c, montos.moneda);
  let gravado: Money;
  if (confirmado === null) {
    if (s.exacto === null) throw new ConfirmacionInvalidaError();
    gravado = s.exacto;
  } else {
    const dentro = confirmado.comparar(s.min) >= 0 && confirmado.comparar(s.max) <= 0;
    const esExacto = s.exacto !== null && confirmado.igual(s.exacto);
    if (!dentro && !esExacto) throw new ConfirmacionInvalidaError();
    gravado = confirmado;
  }
  // Rango y exacto ya contrastados con las lecturas: |gravado| < |BI|, así que el resto ≠ 0.
  return moverMonto(montos, s.columnaBi, "noGravado", montos.obtener(s.columnaBi).restar(gravado));
}

/** R-RED: reemplaza columnas y total por los valores sugeridos. */
function ajustar(montos: MontosComprobante, valores: Map<string, Money>): MontosComprobante {
  const nuevo: Partial<Record<ColumnaCompra, string>> & { total: string } = { total: montos.total.toString() };
  for (const c of COLUMNAS_COMPRA) nuevo[c] = montos.obtener(c).toString();
  for (const [k, v] of valores) {
    const s = Money.suma([v], montos.moneda).toString();
    if (k === "total") nuevo.total = s;
    else nuevo[k as ColumnaCompra] = s;
  }
  return MontosComprobante.desde(montos.moneda, nuevo);
}

function aplicarContrastado(
  montos: MontosComprobante,
  h: Hallazgo,
  c: Confirmacion | undefined,
  entorno: EntornoInterno,
): ResultadoAplicar {
  const leido = leerHallazgo(h);
  if (!esMontosReal(montos)) invalida();
  reevaluar(leido, montos, entorno);
  const s = leido.sugerencia;
  let nuevos: MontosComprobante;
  switch (s.tipo) {
    case "mover":
      nuevos = moverMonto(montos, s.origen, s.destino, s.monto);
      break;
    case "separar":
      nuevos = separar(montos, s, c);
      break;
    case "ajustar":
      nuevos = ajustar(montos, s.valores);
      break;
    case "clasificar":
      nuevos = cambiarDestino(montos, destinoConfirmado(c)).montos;
      break;
    default:
      return Object.freeze({ montos, excluir: true });
  }
  return Object.freeze({ montos: nuevos, excluir: false });
}

/**
 * Aplica la sugerencia del hallazgo a `montos` (que deben ser los evaluados: CA-9). R-MIX sin
 * exacto exige `{ gravado }` en [min, max]; R-NEW exige `{ destino }`. `entorno` (obligatorio: lo
 * que recibió evaluarReglas, con el XML) sirve para re-evaluar la fila con `montos` y exigir el
 * mismo hallazgo (T15); sin él o inválido → EntradaReglasInvalidaError. Los errores de 010 se
 * propagan sin envolver.
 */
export function aplicarSugerencia(
  montos: MontosComprobante,
  h: Hallazgo,
  c: Confirmacion | undefined,
  entorno: EntornoEvaluacion,
): ResultadoAplicar {
  return aplicarContrastado(montos, h, c, leerEntorno(entorno));
}

/**
 * Aplica en el orden recibido y encadena por filaId (la segunda usa los montos de la primera).
 * Dato requerido sin confirmación → `requiere_dato`; ReglasError o DineroError → su `codigo`;
 * otro error es un defecto y se propaga. Cada hallazgo se re-evalúa con los montos encadenados y
 * el `entorno` obligatorio (T15); sin él o inválido, la llamada aborta con EntradaReglasInvalidaError.
 */
export function aplicarMasivo(entradas: readonly EntradaMasiva[], entorno: EntornoEvaluacion): ResultadoMasivo {
  const leido = leerEntorno(entorno);
  const vigentes = new Map<string, MontosComprobante>();
  const aplicadas: { filaId: string; montos: MontosComprobante; excluir: boolean }[] = [];
  const rechazadas: { filaId: string; regla: CodigoRegla; codigo: string }[] = [];
  for (const e of leerArreglo(entradas)) {
    const v = leerObjeto(e, ["montos", "hallazgo", "confirmacion"], ["montos", "hallazgo"]);
    const h = v.get("hallazgo") as Hallazgo;
    const c = v.get("confirmacion") as Confirmacion | undefined;
    const filaId: unknown = typeof h === "object" && h !== null ? h.filaId : undefined;
    const regla: unknown = typeof h === "object" && h !== null ? h.regla : undefined;
    if (typeof filaId !== "string" || !ORDEN_REGLAS.includes(regla as CodigoRegla)) invalida();
    const id = filaId as string;
    const r = regla as CodigoRegla;
    if (h.dato !== null && c === undefined) {
      rechazadas.push(Object.freeze({ filaId: id, regla: r, codigo: "requiere_dato" }));
      continue;
    }
    try {
      const res = aplicarContrastado(vigentes.get(id) ?? (v.get("montos") as MontosComprobante), h, c, leido);
      vigentes.set(id, res.montos);
      aplicadas.push(Object.freeze({ filaId: id, montos: res.montos, excluir: res.excluir }));
    } catch (err) {
      if (!(err instanceof ReglasError) && !(err instanceof DineroError)) throw err;
      rechazadas.push(Object.freeze({ filaId: id, regla: r, codigo: err.codigo }));
    }
  }
  return Object.freeze({ aplicadas: Object.freeze(aplicadas), rechazadas: Object.freeze(rechazadas) });
}
