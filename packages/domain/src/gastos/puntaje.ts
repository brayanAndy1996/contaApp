// Spec 027 (R-2, R-3, R-5; CA-1, CA-2, CA-5, CA-6; plan, Contratos: domain `puntaje.ts`): puntaje de sospecha de gasto no
// deducible. Enteros, sin montos; el resultado solo lleva la palabra del diccionario, la categoría, conteos y códigos fijos
// (nunca texto de la glosa). Determinista: no depende del orden de ítems, palabras, CIIU ni historial. Puro: sin IO ni reloj.
import { invalida, leerArreglo, leerObjeto } from "../reglas/estricto";
import type { DocProveedor } from "../reglas/tipos";
import { esMinoristaORestaurante, esRubroConsumoPersonal, grupoCiiu } from "./ciiu";
import { claveDocumento, contextoGastosInterno, normalizarDocumento } from "./contexto";
import type { ContextoGastos, ContextoGastosInterno } from "./contexto";
import { esDiaNoLaborable, esFechaIso } from "./feriados";
import { categoriasPermitidas } from "./matriz";

export type CodigoSenal = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7";

export interface Senal {
  readonly codigo: CodigoSenal;
  /** Entero; S7 resta. */
  readonly puntos: number;
  /** S1: la palabra elegida. */
  readonly palabra?: string;
  /** S1: la categoría de su palabra; S3: la categoría no permitida elegida. */
  readonly categoria?: string;
  /** S1: ítems con palabra («n de m»). */
  readonly items?: { readonly coinciden: number; readonly total: number };
}

export interface EntradaGasto {
  /** Descripción de cada ítem del XML. */
  readonly glosas: readonly string[];
  /** `IssueDate` AAAA-MM-DD, o null. */
  readonly fechaEmision: string | null;
  readonly proveedor: DocProveedor;
  /** Proveedor nuevo para el cliente (el criterio de R-NEW). */
  readonly esNuevo: boolean;
}

export interface ResultadoGasto {
  /** Suma de los puntos de `senales` (puede ser negativo). */
  readonly puntaje: number;
  /** Solo las que puntúan, en orden S1…S7. */
  readonly senales: readonly Senal[];
  /** La de S1 (menor en orden de código entre los ítems coincidentes) o null. */
  readonly palabra: string | null;
  readonly categoria: string | null;
}

/** Pesos fijos de R-3 (solo el umbral se configura). */
export const PESOS = Object.freeze({
  S1_ITEM: 3,
  S1_TOPE: 6,
  S2: 3,
  S3: 2,
  S4: 1,
  S5: 1,
  S6: 4,
  S7: -4,
  S6_EXCLUIDAS_12: 2,
  S7_ACEPTADAS_6: 3,
});

const CLAVES_ENTRADA = ["glosas", "fechaEmision", "proveedor", "esNuevo"];

const menor = (a: string | null, b: string): string => (a === null || b < a ? b : a);

/**
 * Puntaje con el contexto ya validado e indexado (lo usa la R-GP con el contexto de `evaluarReglas`). `fechaEmision` ya es una
 * fecha válida o null; `claveProveedor` es `tipo:NUMERO` normalizado.
 */
export function puntuarValidado(
  glosas: readonly string[],
  fechaEmision: string | null,
  claveProveedor: string,
  esNuevo: boolean,
  ctx: ContextoGastosInterno,
): ResultadoGasto {
  const senales: Senal[] = [];

  // Un solo recorrido de las coincidencias (sin materializarlas, H-027-2-7). S1: +3 por ítem coincidente, tope +6; la palabra menor en
  // orden de código (R-2). S3: +2 una vez si alguna categoría coincidente no está permitida; la menor de ellas. Sin CIIU del cliente solo
  // cuentan las quitadas por el ajuste (R-13), así que una categoría de fuera de las 6 (diccionario de 011) no suma.
  const acc: {
    palabra: string | null;
    categoria: string | null;
    prohibida: string | null;
    items: number;
    ultimo: number;
    vista: string | null;
  } = { palabra: null, categoria: null, prohibida: null, items: 0, ultimo: -1, vista: null };
  // Las permitidas del CIIU se calculan con la primera coincidencia.
  let permitidas: ReadonlySet<string> | null | undefined;
  ctx.diccionario.recorrerCoincidencias(glosas, (item, p, c) => {
    if (item !== acc.ultimo) {
      // Dentro de un ítem llegan en orden de código: solo la primera puede ser la menor.
      acc.items++;
      acc.ultimo = item;
      if (acc.palabra === null || p < acc.palabra) {
        acc.palabra = p;
        acc.categoria = c;
      }
    }
    // Una categoría ya mirada no cambia S3 (con miles de coincidencias de la misma categoría, una comparación por cada una).
    if (c === acc.vista) return;
    acc.vista = c;
    if (permitidas === undefined) permitidas = ctx.ciiuCliente === null ? null : categoriasPermitidas(ctx.ciiuCliente, ctx);
    if (permitidas === null ? ctx.quitadas.includes(c) : !permitidas.has(c)) acc.prohibida = menor(acc.prohibida, c);
  });
  const { palabra, categoria, prohibida, items } = acc;
  if (palabra !== null) {
    senales.push({
      codigo: "S1",
      puntos: Math.min(items * PESOS.S1_ITEM, PESOS.S1_TOPE),
      palabra,
      ...(categoria === null ? {} : { categoria }),
      items: { coinciden: items, total: glosas.length },
    });
  }

  // S2: rubro de consumo personal del proveedor con otro grupo CIIU que el cliente.
  const ciiuProveedor = ctx.ciiuDe.get(claveProveedor) ?? null;
  if (
    ciiuProveedor !== null &&
    ctx.ciiuCliente !== null &&
    esRubroConsumoPersonal(ciiuProveedor) &&
    grupoCiiu(ciiuProveedor) !== grupoCiiu(ctx.ciiuCliente)
  ) {
    senales.push({ codigo: "S2", puntos: PESOS.S2 });
  }

  if (prohibida !== null) senales.push({ codigo: "S3", puntos: PESOS.S3, categoria: prohibida });

  // S4: emitida en día no laborable por un minorista o restaurante.
  if (fechaEmision !== null && ciiuProveedor !== null && esMinoristaORestaurante(ciiuProveedor) && esDiaNoLaborable(fechaEmision)) {
    senales.push({ codigo: "S4", puntos: PESOS.S4 });
  }

  // S5: proveedor nuevo (aunque R-NEW esté apagada).
  if (esNuevo) senales.push({ codigo: "S5", puntos: PESOS.S5 });

  // S6 y S7: historial del proveedor; nunca a la vez (si S6 aplica, S7 no).
  const h = ctx.historialDe.get(claveProveedor);
  if (h !== undefined) {
    if (h.excluidas12 >= PESOS.S6_EXCLUIDAS_12) {
      senales.push({ codigo: "S6", puntos: PESOS.S6 });
    } else if (h.aceptadas6 >= PESOS.S7_ACEPTADAS_6 && h.excluidas6 === 0) {
      senales.push({ codigo: "S7", puntos: PESOS.S7 });
    }
  }

  const puntaje = senales.reduce((a, s) => a + s.puntos, 0);
  return Object.freeze({
    puntaje,
    senales: Object.freeze(senales.map(congelarSenal)),
    palabra,
    categoria,
  });
}

function congelarSenal(s: Senal): Senal {
  if (s.items !== undefined) Object.freeze(s.items);
  return Object.freeze(s);
}

/**
 * Puntaje de sospecha de una compra (R-3). Valida la entrada y el contexto (EntradaReglasInvalidaError, como
 * `validarContextoGastos`); no muta nada y no lee reloj (la fecha es la de emisión).
 */
export function puntuarGastoPersonal(entrada: EntradaGasto, ctx: ContextoGastos): ResultadoGasto {
  const v = leerObjeto(entrada, CLAVES_ENTRADA);
  const glosas = leerArreglo(v.get("glosas"));
  for (const g of glosas) if (typeof g !== "string") invalida();
  const fecha = v.get("fechaEmision");
  if (fecha !== null && (typeof fecha !== "string" || !esFechaIso(fecha))) invalida();
  const esNuevo = v.get("esNuevo");
  if (typeof esNuevo !== "boolean") invalida();
  const proveedor = normalizarDocumento(v.get("proveedor"));
  const interno = contextoGastosInterno(ctx);
  return puntuarValidado(glosas as string[], fecha as string | null, claveDocumento(proveedor), esNuevo as boolean, interno);
}
