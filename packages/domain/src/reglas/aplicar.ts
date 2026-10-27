// aplicarSugerencia / aplicarMasivo (plan 011, Decisiones: "Obsolescencia" y "Ratificación de
// contratos", Aplicar). Puras: nunca tocan los montos recibidos; los movimientos son los de 010.
// T9: mover (R-ISC) y separar (R-MIX) con sus pruebas; T10 completa y prueba el resto.
// T13 (ronda adversarial 1): la sugerencia recibida no se cree; se contrasta con la regla, el
// destino y las lecturas (pruebas R1b-1 a R1b-5 de ronda1b.adv.spec.ts).
// T15 (ronda adversarial 2): con el entorno de evaluarReglas (filas y contexto, con el XML) la fila
// se re-evalúa con los montos actuales y solo se aplica el mismo hallazgo. Sin entorno se contrasta
// además la explicación y el `ajustar` de R-RED, pero el respaldo del XML no se puede probar: el
// backend (014) debe pasar siempre el entorno.
import { COLUMNAS_COMPRA, MontosComprobante, cambiarDestino, moverMonto } from "../comprobante/index";
import type { ColumnaCompra, Destino } from "../comprobante/index";
import {
  DineroError,
  Money,
  MontoFueraDeRangoError,
  TASA_IGV_10,
  TASA_IGV_18,
  TOLERANCIA_CUADRE,
  verificarCuadre,
} from "../dinero/index";
import type { Moneda, ResultadoCuadre } from "../dinero/index";
import {
  PARES_DESTINO,
  esMoneyReal,
  esMontosReal,
  leerArreglo,
  leerObjeto,
  validarContexto,
  validarFilas,
} from "./entrada";
import type { ContextoInterno, FilaInterna, ParDestino } from "./entrada";
import {
  ISC_XML_EXACTO,
  SUFIJO_RED_XML,
  iscSinXml,
  marcaIscConXml,
  mix,
  red,
  redUsd,
  sufijoMixExacto,
} from "./explicaciones";
import { evaluarFila } from "./motor";
import { COLUMNAS_RED_XML, valoresPorUmbral } from "./r-red";
import { enRango, rangoGravado } from "./rango";
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

/** `dato` que produce cada regla (el de R-MIX depende de `exacto`: ver coherenciaSeparar). */
const DATO_DE_REGLA: ReadonlyMap<CodigoRegla, DatoRequerido | null> = new Map<CodigoRegla, DatoRequerido | null>([
  ["R-ISC", null],
  ["R-RED", null],
  ["R-NEW", "destino"],
  ["R-GP", null],
]);

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

/** Misma moneda y mismo monto (sin MonedaDistintaError: un Money de otra moneda es falsificado). */
const iguales = (a: Money, b: Money): boolean => a.moneda === b.moneda && a.igual(b);

/** Par BI/IGV del destino del hallazgo; R-ISC y R-MIX siempre tienen destino. */
function parDe(destino: Destino | null): ParDestino {
  const par = PARES_DESTINO.find((p) => p.destino === destino);
  return par ?? invalida();
}

// ---------------------------------------------------------------- sin entorno (T13 + T15)
/**
 * Forma de la sugerencia según su regla y su destino (R1b-3) y columnas que la regla leyó: sin
 * una de ellas no se puede comprobar la vigencia y la sugerencia es obsoleta (R1b-4).
 */
function exigirLecturas(h: HallazgoLeido): void {
  const s = h.sugerencia;
  let requeridas: readonly string[] = [];
  if (s.tipo === "mover") {
    const par = parDe(h.destino);
    if (s.origen !== par.bi || s.destino !== "isc") invalida();
    // Con el ISC del XML la regla también leyó isc y las BI de los otros destinos (R1b-1).
    requeridas = h.lecturas.has("isc") ? [par.igv, "isc", ...COLUMNAS_BI] : [par.bi, par.igv];
  } else if (s.tipo === "separar") {
    const par = parDe(h.destino);
    if (s.columnaBi !== par.bi) invalida();
    if (s.exacto !== null && !h.explicacion.endsWith(sufijoMixExacto(s.exacto))) invalida();
    // El exacto del XML exige "único destino con BI ≠ 0": también leyó las otras BI (R2a-3).
    requeridas = s.exacto === null ? [par.bi, par.igv] : [par.igv, ...COLUMNAS_BI];
  } else {
    if (h.destino !== null) invalida();
    if (s.tipo === "ajustar") requeridas = CLAVES_LECTURA;
  }
  if (s.tipo !== "separar" && h.dato !== DATO_DE_REGLA.get(h.regla)) invalida();
  for (const k of requeridas) if (!h.lecturas.has(k)) throw new SugerenciaObsoletaError();
}

/** Lectura ya exigida por exigirLecturas. */
const lectura = (h: HallazgoLeido, k: string): Money => h.lecturas.get(k) as Money;

/** Las BI de los destinos distintos de `par` están en 0 ("único destino con BI ≠ 0"). */
const otrasBiEnCero = (h: HallazgoLeido, par: ParDestino): boolean =>
  COLUMNAS_BI.every((c) => c === par.bi || lectura(h, c).esCero());

/**
 * R-ISC: sin XML mueve toda la BI (IGV 0, con confirmación); con el ISC del XML (`isc` leído) el
 * monto cabe en la BI del único destino con BI ≠ 0 y no requiere confirmación. La explicación
 * es la del caso (R2a-2: un R-ISC sin XML con `isc` agregado a las lecturas conserva la suya).
 */
function coherenciaMover(h: HallazgoLeido, s: Extract<SugerenciaLeida, { tipo: "mover" }>): void {
  const par = parDe(h.destino);
  const bi = lectura(h, par.bi);
  const igv = lectura(h, par.igv);
  if (!h.lecturas.has("isc")) {
    if (!igv.esCero() || !iguales(s.monto, bi) || !h.requiereConfirmacion) invalida();
    if (h.explicacion !== iscSinXml(bi)) invalida();
    return;
  }
  const cabe =
    s.monto.moneda === bi.moneda &&
    !s.monto.esCero() &&
    s.monto.esNegativo() === bi.esNegativo() &&
    s.monto.abs().comparar(bi.abs()) <= 0;
  if (!otrasBiEnCero(h, par) || !cabe || h.requiereConfirmacion) invalida();
  const esperada = igv.esCero() ? ISC_XML_EXACTO : marcaIscConXml(s.monto.sumar(lectura(h, "isc")));
  if (h.explicacion !== esperada) invalida();
}

/**
 * R-MIX (R1b-5): min, max y estimado son los de `rangoGravado` a 18 % de las lecturas; un exacto
 * (solo del XML: sin confirmación ni dato, único destino con BI ≠ 0) cae en el rango a 18 % o a
 * 10 % (D-7). La explicación empieza por la de R-MIX de esas lecturas.
 */
function coherenciaSeparar(h: HallazgoLeido, s: Extract<SugerenciaLeida, { tipo: "separar" }>): void {
  const par = parDe(h.destino);
  const bi = lectura(h, par.bi);
  const igv = lectura(h, par.igv);
  const r18 = rangoGravado(bi, igv, TASA_IGV_18);
  if (r18 === null || !iguales(s.min, r18.min) || !iguales(s.max, r18.max) || !iguales(s.estimado, r18.estimado)) {
    invalida();
  }
  if (!h.explicacion.startsWith(mix(igv, bi))) invalida();
  if (s.exacto === null) {
    if (h.dato !== "gravado" || !h.requiereConfirmacion) invalida();
    return;
  }
  if (h.dato !== null || h.requiereConfirmacion || s.exacto.moneda !== bi.moneda || !otrasBiEnCero(h, par)) {
    invalida();
  }
  const r10 = rangoGravado(bi, igv, TASA_IGV_10);
  if (!enRango(s.exacto, r18) && (r10 === null || !enRango(s.exacto, r10))) invalida();
}

/** Cuadre de 010; fuera de NUMERIC(14,2) R-RED no sugiere nada, así que la sugerencia es falsa. */
function cuadreDe(m: MontosComprobante): ResultadoCuadre {
  try {
    return verificarCuadre(m, TOLERANCIA_CUADRE);
  } catch (e) {
    if (e instanceof MontoFueraDeRangoError) invalida();
    throw e;
  }
}

/**
 * R-RED (R2a-1), según su explicación: sin respaldo, solo total = Σ dentro del umbral y con
 * confirmación (D-6); con XML, total = Σ o una sola columna que deja la fila cuadrada; con
 * origenUsd (la conversión no se puede comprobar sin el entorno), la fila PEN queda cuadrada.
 */
function coherenciaAjustar(h: HallazgoLeido, valores: Map<string, Money>, montos: MontosComprobante): void {
  const c = cuadreDe(montos);
  const base = red(c.sumaComponentes, c.total);
  const total = valores.get("total");
  const soloTotal = valores.size === 1 && total !== undefined && iguales(total, c.sumaComponentes);
  if (h.explicacion === base) {
    if (!h.requiereConfirmacion || !soloTotal || valoresPorUmbral(montos, c) === null) invalida();
    return;
  }
  if (h.requiereConfirmacion) invalida();
  if (h.explicacion === base + SUFIJO_RED_XML) {
    if (soloTotal) return;
    const [col, v] = [...valores][0] as [string, Money];
    if (valores.size !== 1 || !COLUMNAS_RED_XML.includes(col as ColumnaCompra)) invalida();
    if (!iguales(v, montos.obtener(col as ColumnaCompra).sumar(c.diferencia))) invalida();
    return;
  }
  if (montos.moneda !== "PEN" || !h.explicacion.startsWith(redUsd(""))) invalida();
  if (!cuadreDe(ajustar(montos, valores)).diferencia.esCero()) invalida();
}

/** CA-9: si alguna columna leída al evaluar cambió → SugerenciaObsoletaError. */
function verificarVigencia(montos: MontosComprobante, lecturas: Map<string, Money>): void {
  for (const [k, leido] of lecturas) {
    const actual = k === "total" ? montos.total : montos.obtener(k as ColumnaCompra);
    if (!actual.igual(leido)) throw new SugerenciaObsoletaError();
  }
}

// ---------------------------------------------------------------- con entorno (T15)
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

/** Con entorno, re-evaluación; sin él, forma, lecturas, vigencia y coherencia (T13, T15). */
function contrastar(h: HallazgoLeido, montos: MontosComprobante, entorno: EntornoInterno | null): void {
  if (entorno !== null) {
    reevaluar(h, montos, entorno);
    return;
  }
  exigirLecturas(h);
  verificarVigencia(montos, h.lecturas);
  const s = h.sugerencia;
  if (s.tipo === "mover") coherenciaMover(h, s);
  if (s.tipo === "separar") coherenciaSeparar(h, s);
  if (s.tipo === "ajustar") coherenciaAjustar(h, s.valores, montos);
}

function aplicarContrastado(
  montos: MontosComprobante,
  h: Hallazgo,
  c: Confirmacion | undefined,
  entorno: EntornoInterno | null,
): ResultadoAplicar {
  const leido = leerHallazgo(h);
  if (!esMontosReal(montos)) invalida();
  contrastar(leido, montos, entorno);
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
 * exacto exige `{ gravado }` en [min, max]; R-NEW exige `{ destino }`. Con `entorno` (lo que
 * recibió evaluarReglas) re-evalúa la fila con `montos` y exige el mismo hallazgo (T15): 014 debe
 * pasarlo siempre. Los errores de 010 se propagan sin envolver.
 */
export function aplicarSugerencia(
  montos: MontosComprobante,
  h: Hallazgo,
  c?: Confirmacion,
  entorno?: EntornoEvaluacion,
): ResultadoAplicar {
  return aplicarContrastado(montos, h, c, entorno === undefined ? null : leerEntorno(entorno));
}

/**
 * Aplica en el orden recibido y encadena por filaId (la segunda usa los montos de la primera).
 * Dato requerido sin confirmación → `requiere_dato`; ReglasError o DineroError → su `codigo`;
 * otro error es un defecto y se propaga. Con `entorno`, cada hallazgo se re-evalúa con los montos
 * encadenados (T15); un entorno inválido aborta la llamada.
 */
export function aplicarMasivo(entradas: readonly EntradaMasiva[], entorno?: EntornoEvaluacion): ResultadoMasivo {
  const leido = entorno === undefined ? null : leerEntorno(entorno);
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
