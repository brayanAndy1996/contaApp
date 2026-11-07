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
import { evaluarReglas } from "../reglas/index";
import type { ContextoReglas, DocProveedor, Hallazgo, Sugerencia } from "../reglas/index";

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
 * Evaluación de una compra por llamada sobre un único entorno (el historial de proveedores del cliente y el diccionario base).
 * Se guarda UN hallazgo por regla y versión (la tabla lo exige): si una regla marca varios destinos de la misma compra queda
 * el primero, en el orden del dominio (DG, DGNG, DNG). Un R-NEW resuelto (la fila ya está `clasificada`) no reaparece (D-4).
 */
export function crearEvaluarCompras(
  proveedoresConocidos: readonly { tipo: string; numero: string }[],
): (c: CompraEvaluable) => HallazgoJson[] {
  const contexto: ContextoReglas = {
    proveedoresConocidos: proveedoresValidos(proveedoresConocidos),
    proveedoresIsc: [],
    diccionario: DICCIONARIO_GLOSAS_BASE,
  };
  return (c) => {
    try {
      const resultado = evaluarReglas(
        [
          {
            id: "fila",
            proveedor: { tipo: c.docTipo, numero: c.docNumero },
            comprobante: { tipo: c.tipoDoc, serie: c.serie, numero: c.numero },
            montos: MontosComprobante.desde(c.moneda, c.montos),
          },
        ],
        contexto,
      );
      const porRegla = new Map<string, HallazgoJson>();
      for (const h of resultado.hallazgos) {
        if (h.regla === "R-NEW" && c.clasificada) continue;
        if (!porRegla.has(h.regla)) porRegla.set(h.regla, hallazgoAJson(h));
      }
      return [...porRegla.values()];
    } catch {
      return [];
    }
  };
}
