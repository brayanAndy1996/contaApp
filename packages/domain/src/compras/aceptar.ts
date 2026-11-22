// Aceptar la sugerencia GUARDADA de una compra (spec 014, D-4, D-15, DU-6, DU-15, DU-22). Puro: sin IO. El hallazgo viene de
// `compra_hallazgo` (cadenas), no de una evaluación nueva, y se contrasta con la fila ACTUAL antes de aplicarse:
//  - pide confirmación (todo lo que sale de `evaluarReglas` sin XML que lo respalde, y R-GP, que siempre confirma): se
//    reconstruye el `Hallazgo` de 011 y lo aplica `aplicarSugerencia`, que re-evalúa la fila con el mismo entorno (la fila con su
//    XML vigente, `compra.xml`, y el historial de proveedores) y solo aplica si sale el mismo hallazgo; si no, `revisar_de_nuevo`.
//    R-GP exige XML (011): sin él en la fila el hallazgo no se reproduce nunca (defecto de 014/016 corregido en 021);
//    con `reglasApagadas` (021) la regla apagada no se reproduce: `revisar_de_nuevo` (H-T25-1);
//  - no pide confirmación (respaldada por el XML, DU-22): no hay XML con qué re-evaluar (llega con 016), así que se exige que
//    las `lecturas` guardadas sean las columnas de la fila actual y se aplica la sugerencia con los movimientos de 010.
// En masa (`enMasa`) solo entra lo que `sugerenciaEsMasiva` deja pasar (sin confirmación y sin dato); el resto es `no_masiva`.
import { COLUMNAS_COMPRA, MontosComprobante, cambiarDestino, moverMonto } from "../comprobante/index";
import type { ColumnaCompra, Destino } from "../comprobante/index";
import { DineroError, Money } from "../dinero/index";
import type { Moneda } from "../dinero/index";
import { ConfirmacionInvalidaError, ReglasError, SugerenciaObsoletaError, aplicarSugerencia } from "../reglas/index";
import type { CodigoRegla, CodigoReglaMotor, Confirmacion, Hallazgo, MontosParciales, Sugerencia } from "../reglas/index";
import type { ContextoGastos } from "../gastos/contexto";
import type { Senal } from "../gastos/puntaje";
import { DICCIONARIO_GLOSAS_BASE } from "../texto/index";
import { esEntero } from "../texto/entero";
import { proveedoresValidos, resumenXml } from "./evaluar";
import type { CompraEvaluable } from "./evaluar";
import { detallarHallazgo } from "./hallazgo-vista";
import type { DetalleHallazgo, HallazgoGuardado } from "./hallazgo-vista";

export type DatoAceptar = { readonly gravado: string } | { readonly destino: Destino };

export interface EntradaAceptar {
  /** La fila ACTUAL (su versión vigente). */
  readonly compra: CompraEvaluable;
  /** El hallazgo guardado de esa regla en la versión vigente, o `undefined` si ya no existe. */
  readonly hallazgo: HallazgoGuardado | undefined;
  /** Historial de proveedores del cliente en otros periodos (el mismo entorno con que se evaluó). */
  readonly proveedoresConocidos: readonly { tipo: string; numero: string }[];
  readonly confirmar: boolean;
  readonly dato: DatoAceptar | undefined;
  readonly enMasa: boolean;
  /**
   * `XML_SIMULADO_EN_REGLAS` (016, P-4): si el XML simulado de `compra.xml` entra en la re-evaluación; por defecto no, como en
   * `crearEvaluarCompras`. Debe ser el mismo valor con que se evaluó la compra.
   */
  readonly xmlSimuladoEnReglas?: boolean;
  /**
   * Reglas que el estudio apagó (021, RF-089, H-T25-1): lo guardado de una regla apagada ya no se acepta, con o sin XML y con o
   * sin confirmación (`revisar_de_nuevo`). Deben ser las mismas con que se evalúa (`EntornoReglas`). Por defecto, ninguna.
   */
  readonly reglasApagadas?: readonly CodigoReglaMotor[];
  /** Contexto de la R-GP completa (027, D-5): el mismo con que se evaluó; sin él, la R-GP de 011. */
  readonly gastos?: ContextoGastos;
}

export type RechazoAceptar =
  | "revisar_de_nuevo"
  | "requiere_dato"
  | "requiere_confirmacion"
  | "no_masiva";

export type ResultadoAceptar =
  | {
      readonly ok: true;
      /** Las 10 columnas y el total como cadenas. */
      readonly montos: Record<ColumnaCompra | "total", string>;
      /** R-GP: la sugerencia excluye la fila. */
      readonly excluir: boolean;
      /** R-NEW: la sugerencia clasifica la fila. */
      readonly clasifica: boolean;
    }
  | { readonly ok: false; readonly rechazo: RechazoAceptar; readonly dato?: "gravado" | "destino" };

/** Tipo de sugerencia que corresponde a cada regla (011). */
const TIPO_DE_REGLA: Readonly<Record<string, string>> = {
  "R-ISC": "mover",
  "R-MIX": "separar",
  "R-RED": "ajustar",
  "R-NEW": "clasificar",
  "R-GP": "excluir",
  "R-STD": "clasificar",
};
const COLUMNAS_BI: readonly string[] = ["biDg", "biDgng", "biDng"];
const DESTINOS: readonly string[] = ["DG", "DGNG", "DNG"];

const rechazo = (r: RechazoAceptar, dato?: "gravado" | "destino"): ResultadoAceptar =>
  dato === undefined ? { ok: false, rechazo: r } : { ok: false, rechazo: r, dato };

const registro = (v: unknown): Readonly<Record<string, unknown>> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Readonly<Record<string, unknown>>) : null;

/** Lo guardado no se puede leer: la sugerencia ya no sirve. */
function ilegible(): never {
  throw new SugerenciaObsoletaError();
}

function dinero(v: unknown, moneda: Moneda): Money {
  if (typeof v !== "string") return ilegible();
  return Money.desde(v, moneda);
}

function columna(v: unknown, permitidas: readonly string[] = COLUMNAS_COMPRA): ColumnaCompra {
  if (typeof v !== "string" || !permitidas.includes(v)) return ilegible();
  return v as ColumnaCompra;
}

function parciales(v: unknown, moneda: Moneda): Record<string, Money> {
  const o = registro(v);
  if (o === null) return ilegible();
  const salida: Record<string, Money> = {};
  for (const [k, x] of Object.entries(o)) {
    if (k !== "total") columna(k);
    salida[k] = dinero(x, moneda);
  }
  return salida;
}

/** JSON guardado → `Sugerencia` de 011 (la inversa de `sugerenciaJson`). */
function aSugerencia(j: unknown, moneda: Moneda, regla: string): Sugerencia {
  const o = registro(j);
  if (o === null || o.tipo !== TIPO_DE_REGLA[regla]) return ilegible();
  switch (o.tipo) {
    case "mover":
      return { tipo: "mover", origen: columna(o.origen), destino: columna(o.destino), monto: dinero(o.monto, moneda) };
    case "separar":
      return {
        tipo: "separar",
        columnaBi: columna(o.columnaBi, COLUMNAS_BI),
        min: dinero(o.min, moneda),
        max: dinero(o.max, moneda),
        estimado: dinero(o.estimado, moneda),
        exacto: o.exacto === null ? null : dinero(o.exacto, moneda),
      };
    case "ajustar":
      return { tipo: "ajustar", valores: parciales(o.valores, moneda) as MontosParciales };
    case "clasificar":
      return { tipo: "clasificar" };
    default:
      return sugerenciaExcluir(o);
  }
}

const textoONulo = (v: unknown): v is string | null => v === null || typeof v === "string";

/**
 * R-GP guardada: la de 027 (palabra y categoría o null, puntaje y señales, que la re-evaluación compara) o la de 011 (sin
 * puntaje ni señales, que se sigue leyendo).
 */
function sugerenciaExcluir(o: Readonly<Record<string, unknown>>): Sugerencia {
  if (!textoONulo(o.palabra) || !textoONulo(o.categoria)) return ilegible();
  if (o.puntaje === undefined && o.senales === undefined) return { tipo: "excluir", palabra: o.palabra, categoria: o.categoria };
  if (!esEntero(o.puntaje) || !Array.isArray(o.senales)) return ilegible();
  // Las señales las valida y normaliza `aplicarSugerencia` al compararlas con la re-evaluación.
  return { tipo: "excluir", palabra: o.palabra, categoria: o.categoria, puntaje: o.puntaje, senales: o.senales as Senal[] };
}

const salida = (m: MontosComprobante, excluir: boolean, clasifica: boolean): ResultadoAceptar => {
  const j = m.toJSON();
  return { ok: true, montos: { ...j.columnas, total: j.total }, excluir, clasifica };
};

/** Confirmación para `aplicarSugerencia`: solo el dato que la regla pide (R-MIX el gravado, R-NEW el destino). */
function confirmacionDe(regla: string, dato: DatoAceptar | undefined, moneda: Moneda): Confirmacion | undefined {
  if (dato === undefined) return undefined;
  if (regla === "R-MIX" && "gravado" in dato) return { gravado: Money.desde(dato.gravado, moneda) };
  if (regla === "R-NEW" && "destino" in dato) return { destino: dato.destino };
  return undefined;
}

function conReevaluacion(e: EntradaAceptar, h: HallazgoGuardado, d: DetalleHallazgo): ResultadoAceptar {
  const c = e.compra;
  const montos = MontosComprobante.desde(c.moneda, c.montos);
  const xml = resumenXml(c, { xmlSimuladoEnReglas: e.xmlSimuladoEnReglas === true });
  const hallazgo: Hallazgo = {
    filaId: "fila",
    regla: h.regla as CodigoRegla,
    destino: d.destino,
    explicacion: d.explicacion,
    sugerencia: aSugerencia(h.sugerencia, c.moneda, h.regla),
    requiereConfirmacion: true,
    dato: d.dato,
    lecturas: parciales(h.lecturas, c.moneda) as MontosParciales,
  };
  const r = aplicarSugerencia(montos, hallazgo, confirmacionDe(h.regla, e.dato, c.moneda), {
    filas: [
      {
        id: "fila",
        proveedor: { tipo: c.docTipo, numero: c.docNumero },
        comprobante: { tipo: c.tipoDoc, serie: c.serie, numero: c.numero },
        montos,
        // El XML vigente de la compra, como en la evaluación (016): R-GP y el resto de lo respaldado por XML lo necesitan.
        ...(xml === null ? {} : { xml }),
      },
    ],
    contexto: {
      proveedoresConocidos: proveedoresValidos(e.proveedoresConocidos),
      proveedoresIsc: [],
      diccionario: DICCIONARIO_GLOSAS_BASE,
      // La regla apagada no se evalúa: la re-evaluación no la reproduce y la sugerencia queda obsoleta (011, motor).
      ...(e.reglasApagadas === undefined ? {} : { reglasApagadas: [...e.reglasApagadas] }),
      ...(e.gastos === undefined ? {} : { gastos: e.gastos }),
    },
  });
  return salida(r.montos, r.excluir, h.regla === "R-NEW");
}

function respaldada(e: EntradaAceptar, h: HallazgoGuardado, d: DetalleHallazgo): ResultadoAceptar {
  const c = e.compra;
  // Sin re-evaluación (no hay con qué), la regla apagada se contrasta aquí: el estudio ya no la quiere aplicar (H-T25-1).
  if (e.reglasApagadas?.includes(h.regla as CodigoReglaMotor) === true) return rechazo("revisar_de_nuevo");
  const montos = MontosComprobante.desde(c.moneda, c.montos);
  // Contraste con la fila actual: cada columna que la regla leyó sigue valiendo lo mismo.
  for (const [k, leida] of Object.entries(parciales(h.lecturas, c.moneda))) {
    const actual = k === "total" ? montos.total : montos.obtener(k as ColumnaCompra);
    if (!actual.igual(leida)) return rechazo("revisar_de_nuevo");
  }
  const s = aSugerencia(h.sugerencia, c.moneda, h.regla);
  switch (s.tipo) {
    case "mover":
      return salida(moverMonto(montos, s.origen, s.destino, s.monto), false, false);
    case "separar": {
      const confirmado = e.dato !== undefined && "gravado" in e.dato ? Money.desde(e.dato.gravado, c.moneda) : null;
      const gravado = confirmado ?? s.exacto;
      const valido =
        gravado !== null &&
        ((gravado.comparar(s.min) >= 0 && gravado.comparar(s.max) <= 0) || (s.exacto !== null && gravado.igual(s.exacto)));
      if (gravado === null || !valido) return rechazo("requiere_dato", "gravado");
      return salida(
        moverMonto(montos, s.columnaBi, "noGravado", montos.obtener(s.columnaBi).restar(gravado)),
        false,
        false,
      );
    }
    case "ajustar": {
      const nuevo: Partial<Record<ColumnaCompra, string>> & { total: string } = { total: montos.total.toString() };
      for (const col of COLUMNAS_COMPRA) nuevo[col] = montos.obtener(col).toString();
      for (const [k, v] of Object.entries(s.valores)) {
        if (k === "total") nuevo.total = (v as Money).toString();
        else nuevo[k as ColumnaCompra] = (v as Money).toString();
      }
      return salida(MontosComprobante.desde(c.moneda, nuevo), false, false);
    }
    case "clasificar": {
      // Sin dato (R-STD, 025): el destino es el del hallazgo; si no (R-NEW), el que eligió el contador.
      const elegido = e.dato !== undefined && "destino" in e.dato ? e.dato.destino : undefined;
      const destino = d.dato === null && d.destino !== null ? d.destino : elegido;
      if (destino === undefined || !DESTINOS.includes(destino)) return rechazo("requiere_dato", "destino");
      return salida(cambiarDestino(montos, destino).montos, false, true);
    }
    case "excluir":
      return salida(montos, true, false);
  }
}

/**
 * Aplica la sugerencia guardada. Rechazos (nunca lanza por datos): `revisar_de_nuevo` (no hay hallazgo, o la fila cambió desde
 * que se evaluó, o lo guardado es ilegible), `requiere_dato` (con el `dato` pedido: `gravado` o `destino`),
 * `requiere_confirmacion` (pide confirmar y no se confirmó) y `no_masiva` (en masa y no entra, DU-6). Un defecto de programa
 * sí se propaga.
 */
export function aceptarSugerenciaGuardada(e: EntradaAceptar): ResultadoAceptar {
  const h = e.hallazgo;
  if (h === undefined) return rechazo("revisar_de_nuevo");
  const d = detallarHallazgo(h);
  if (e.enMasa) {
    if (!d.masiva) return rechazo("no_masiva");
  } else if (h.sugerencia !== null) {
    if (d.dato !== null) {
      const traeDato = e.dato !== undefined && (d.dato === "gravado" ? "gravado" in e.dato : "destino" in e.dato);
      if (!traeDato) return rechazo("requiere_dato", d.dato);
    }
    if (h.requiereConfirmacion && !e.confirmar) return rechazo("requiere_confirmacion");
  }
  if (h.sugerencia === null) return rechazo("revisar_de_nuevo");
  try {
    return h.requiereConfirmacion ? conReevaluacion(e, h, d) : respaldada(e, h, d);
  } catch (err) {
    if (err instanceof ConfirmacionInvalidaError) return rechazo("requiere_dato", d.dato ?? "gravado");
    if (err instanceof SugerenciaObsoletaError || err instanceof ReglasError) return rechazo("revisar_de_nuevo");
    if (err instanceof DineroError) return rechazo("revisar_de_nuevo");
    throw err;
  }
}
