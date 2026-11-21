// Evaluación de reglas de una compra (spec 014, D-4, nota [014]). Adapta `evaluarReglas` de 011 a la forma que se guarda en
// `compra_hallazgo` (montos como cadenas) y que `packages/db` recibe inyectada como `Evaluar`. Es el ÚNICO lugar donde se
// convierte un `Hallazgo` a JSON: lo usan el persistidor de la descarga (worker) y las acciones del usuario (backend), así que
// ninguna versión nueva se re-evalúa con otra regla. Puro: sin IO.
//
// Una compra que las reglas no aceptan (p. ej. una DUA con número de 12 dígitos) NO tumba nada: la evaluación devuelve `[]` y la
// fila queda sin hallazgos (D-4). Nada de lo evaluado se registra: el error se descarta sin mensaje.
import { MontosComprobante } from "../comprobante/index";
import type { ColumnaCompra } from "../comprobante/index";
import { DICCIONARIO_GLOSAS_BASE } from "../texto/index";
import { DineroError } from "../dinero/index";
import { ReglasError, cumpleModoEstandar } from "../reglas/index";
// Interno del paquete (como prevalidar): fuera de la superficie pública fijada por R2b-1.
import { crearEvaluadorReglas } from "../reglas/motor";
import type {
  CodigoReglaMotor,
  ContextoReglas,
  DocProveedor,
  FilaEvaluable,
  Hallazgo,
  PerfilCliente,
  ResumenXml,
  Sugerencia,
} from "../reglas/index";
import { aResumenXml } from "../ubl/index";
import type { DetalleXml } from "../ubl/index";

const TIPO_DOC = /^[0-9A-Z]$/;
const NUMERO_DOC = /^[0-9A-Z-]{1,15}$/;
const ESPACIOS = /\s/g;
const MINUSCULA_ASCII = /[a-z]/g;

/** Hallazgo tal como se guarda: sugerencia y lecturas con los montos como cadenas decimales. */
export interface HallazgoJson {
  readonly regla: string;
  readonly sugerencia: unknown;
  readonly lecturas: Record<string, string>;
  readonly requiereConfirmacion: boolean;
}

/** Origen del XML guardado (016, `documento_xml.origen`). */
export type OrigenXml = "simulado" | "real" | "subido";

/** XML vigente de la compra (016): el `detalle` jsonb guardado, opaco para `packages/db`. */
export interface XmlEvaluable {
  readonly origen: OrigenXml;
  readonly detalle: DetalleXml;
}

/** Opciones de la evaluación (016, P-4). */
export interface OpcionesEvaluar {
  /** `XML_SIMULADO_EN_REGLAS`: si el XML simulado entra en las reglas (por defecto no). */
  readonly xmlSimuladoEnReglas: boolean;
  /** Reglas apagadas por el estudio (021, RF-089). */
  readonly reglasApagadas?: readonly CodigoReglaMotor[];
  /** Proveedores con regla aprendida: cuentan como conocidos, no son R-NEW (021, D-7), y R-STD no los sugiere (025, D-8). */
  readonly proveedoresConRegla?: readonly { tipo: string; numero: string }[];
  /** Perfil fiscal del cliente (025, D-8, D-9): si cumple U-4, R-STD sugiere DNG. Sin él, sin R-STD. */
  readonly perfil?: PerfilCliente;
}

/** Lo que la evaluación necesita de una compra (estructural: `packages/db` no depende de este paquete). */
export interface CompraEvaluable {
  readonly docTipo: string;
  readonly docNumero: string;
  readonly tipoDoc: string;
  readonly serie: string;
  readonly numero: string;
  readonly moneda: "PEN" | "USD";
  readonly clasificada: boolean;
  /** Las 10 columnas y el total como cadenas decimales. */
  readonly montos: Readonly<Record<ColumnaCompra | "total", string>>;
  /** XML vigente (016); sin él (`undefined` o `null`, como lo entrega `packages/db`), la evaluación de 014. */
  readonly xml?: XmlEvaluable | null;
}

const enMayusculas = (s: string): string => s.replace(MINUSCULA_ASCII, (c) => c.toUpperCase());

/**
 * Los proveedores del historial en la gramática de `DocProveedor`. `evaluarReglas` rechaza TODO el contexto si uno solo no la
 * cumple, así que uno fuera de gramática (guardado antes, con otro formato) se omite en vez de dejar a todo el periodo sin
 * hallazgos.
 */
export function proveedoresValidos(conocidos: readonly { tipo: string; numero: string }[]): DocProveedor[] {
  const vistos = new Set<string>();
  const salida: DocProveedor[] = [];
  for (const c of conocidos) {
    const numero = enMayusculas(c.numero.replace(ESPACIOS, ""));
    if (!TIPO_DOC.test(c.tipo) || !NUMERO_DOC.test(numero)) continue;
    const clave = `${c.tipo}:${numero}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    salida.push({ tipo: c.tipo, numero });
  }
  return salida;
}

function sugerenciaJson(s: Sugerencia | null): unknown {
  if (s === null) return null;
  switch (s.tipo) {
    case "mover":
      return { tipo: "mover", origen: s.origen, destino: s.destino, monto: s.monto.toString() };
    case "separar":
      return {
        tipo: "separar",
        columnaBi: s.columnaBi,
        min: s.min.toString(),
        max: s.max.toString(),
        estimado: s.estimado.toString(),
        exacto: s.exacto === null ? null : s.exacto.toString(),
      };
    case "ajustar":
      return {
        tipo: "ajustar",
        valores: Object.fromEntries(Object.entries(s.valores).map(([k, v]) => [k, v.toString()])),
      };
    case "clasificar":
      return { tipo: "clasificar" };
    case "excluir":
      return { tipo: "excluir", palabra: s.palabra, categoria: s.categoria };
  }
}

/** `Hallazgo` de 011 → la forma que guarda `compra_hallazgo`. */
export function hallazgoAJson(h: Hallazgo): HallazgoJson {
  return {
    regla: h.regla,
    sugerencia: sugerenciaJson(h.sugerencia),
    lecturas: Object.fromEntries(Object.entries(h.lecturas).map(([k, v]) => [k, v.toString()])),
    requiereConfirmacion: h.requiereConfirmacion,
  };
}

/**
 * Resumen del XML para las reglas (016, D-7, P-4): solo si el origen no es `simulado` o la bandera está activa. Un `detalle`
 * guardado con un monto ilegible se ignora (la fila se evalúa como sin XML) en vez de dejarla sin hallazgos; cualquier otro
 * error es un defecto de programa y se propaga.
 */
export function resumenXml(c: CompraEvaluable, opciones: Pick<OpcionesEvaluar, "xmlSimuladoEnReglas">): ResumenXml | null {
  const xml = c.xml;
  if (xml === undefined || xml === null) return null;
  if (xml.origen === "simulado" && !opciones.xmlSimuladoEnReglas) return null;
  try {
    return aResumenXml(xml.detalle);
  } catch (e) {
    if (e instanceof DineroError) return null;
    throw e;
  }
}

/**
 * Evaluación de una compra por llamada sobre un único entorno (el historial de proveedores del cliente y el diccionario base).
 * Se guarda UN hallazgo por regla y versión (la tabla lo exige): si una regla marca varios destinos de la misma compra queda
 * el primero, en el orden del dominio (DG, DGNG, DNG). Un R-NEW resuelto (la fila ya está `clasificada`) no reaparece (D-4).
 * Con XML (016): la fila lleva `xml: aResumenXml(detalle)` si el origen no es `simulado` o `xmlSimuladoEnReglas` está activa;
 * un XML ajeno o en otra moneda no respalda nada (011 lo deja como aviso). 021: `reglasApagadas` no se evalúan y
 * `proveedoresConRegla` cuentan como conocidos (sin R-NEW). 025: con `perfil` que cumple U-4, R-STD sugiere DNG a los
 * proveedores sin regla y se omite en filas clasificadas.
 */
export function crearEvaluarCompras(
  proveedoresConocidos: readonly { tipo: string; numero: string }[],
  opciones: OpcionesEvaluar = { xmlSimuladoEnReglas: false },
): (c: CompraEvaluable) => HallazgoJson[] {
  const conRegla = opciones.proveedoresConRegla ?? [];
  const contexto: ContextoReglas = {
    // Un proveedor con regla aprendida no es nuevo (021, D-7): se suma al historial, normalizado igual.
    proveedoresConocidos: proveedoresValidos([...proveedoresConocidos, ...conRegla]),
    proveedoresIsc: [],
    diccionario: DICCIONARIO_GLOSAS_BASE,
    ...(opciones.reglasApagadas === undefined ? {} : { reglasApagadas: [...opciones.reglasApagadas] }),
    // 025 (D-8): con perfil, el modo estándar y los proveedores con regla (que R-STD no sugiere); sin él, el contexto de 021.
    ...(opciones.perfil === undefined
      ? {}
      : { modoEstandar: cumpleModoEstandar(opciones.perfil), proveedoresConRegla: proveedoresValidos(conRegla) }),
  };
  // El contexto se valida UNA vez, aquí (T25c): un contexto inválido (p. ej. un código apagado desconocido) es un defecto del
  // llamador y falla aquí (EntradaReglasInvalidaError) en vez de dejar cada compra sin hallazgos en silencio; cada compra solo
  // valida su fila, así que el costo por fila no depende de cuántos proveedores y reglas tenga el contexto.
  const evaluarReglas = crearEvaluadorReglas(contexto);
  return (c) => {
    try {
      const fila: FilaEvaluable = {
        id: "fila",
        proveedor: { tipo: c.docTipo, numero: c.docNumero },
        comprobante: { tipo: c.tipoDoc, serie: c.serie, numero: c.numero },
        montos: MontosComprobante.desde(c.moneda, c.montos),
      };
      const xml = resumenXml(c, opciones);
      const resultado = evaluarReglas([xml === null ? fila : { ...fila, xml }]);
      const porRegla = new Map<string, HallazgoJson>();
      for (const h of resultado.hallazgos) {
        // R-NEW y R-STD resueltos por el contador (la fila ya está `clasificada`) no reaparecen (D-4; 025, D-8).
        if ((h.regla === "R-NEW" || h.regla === "R-STD") && c.clasificada) continue;
        if (!porRegla.has(h.regla)) porRegla.set(h.regla, hallazgoAJson(h));
      }
      return [...porRegla.values()];
    } catch (e) {
      // Solo una compra que las reglas o el dinero no aceptan queda sin hallazgos (D-4); un defecto de programa se propaga.
      if (e instanceof ReglasError || e instanceof DineroError) return [];
      throw e;
    }
  };
}
