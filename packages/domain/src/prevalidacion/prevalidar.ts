// prevalidar (plan 012, Contratos y «Orden de prevalidar»; D1, D4, D11, D13, D16, D17, D18).
// (1) Entrada estricta leída una vez a copias congeladas. (2) Formato con seleccionarFormato.
// (3) Estructura, fecha, TC, cuadre, IGV y origenUsd de cada fila generable. (4) Duplicados.
// (5) SIN_FILAS. (6) Si hay `reglas`, evaluarReglas solo sobre las filas sin error de estructura:
// R-MIX y R-RED como sugerencia de su error, R-ISC, R-NEW y R-GP como avisos. El bloqueo nunca
// depende de `reglas` (D19): si una regla falla en una fila, esa fila se queda sin sugerencias ni
// avisos y conserva sus errores; solo un contexto de reglas malformado lanza. El contexto se lee y
// se valida una sola vez, a una copia congelada, y cada fila se evalúa sobre esa copia (H-012-40,
// H-012-60): el coste es lineal y una relectura del contexto no puede cambiar lo evaluado.
import { validarRuc } from "@contapp/shared";
import { seleccionarFormato } from "../formatos/registro";
import type { RegistroFormatos } from "../formatos/registro";
import type { CabeceraTxt, FormatoTxt } from "../formatos/tipos";
import { validarContexto, validarFilas } from "../reglas/entrada";
import type { ContextoInterno, FilaInterna } from "../reglas/entrada";
import { evaluarFila } from "../reglas/motor";
import { ORDEN_REGLAS } from "../reglas/tipos";
import type { Entero } from "../texto/entero";
import type { ContextoReglas, FilaEvaluable, Hallazgo, OrigenUsd } from "../reglas/index";
import { validarAritmetica } from "./aritmetica";
import { buscarDuplicados } from "./duplicados";
import { compararErrores, compararTexto, esVentaCopia, invalida, leerCabecera, leerFilasDe, leerObjeto } from "./entrada";
import type { FilaCopia, FilaTxt } from "./entrada";
import { crearError } from "./errores";
import { CODIGOS_ESTRUCTURA, validarCabecera, validarEstructura } from "./estructura";
import { SIN_FILAS, rucInvalido } from "./explicaciones";
import { erroresDeVentaCopia } from "./ventas";
import type {
  AvisoPrevalidacion,
  CodigoAvisoPrevalidacion,
  ContextoPrevalidacion,
  ContextoPrevalidacionVentas,
  ErrorPrevalidacion,
  FilaReemplazo,
  FilaReemplazoVenta,
  ResultadoPrevalidacion,
} from "./tipos";

const CLAVES_CONTEXTO = ["cabecera", "reglas", "registro"];
const REQUERIDAS_CONTEXTO = ["cabecera"];

/** Resultado y filas que irían al TXT (para generarTxt, que serializa esas mismas copias). */
export interface Prevalidado {
  readonly resultado: ResultadoPrevalidacion;
  readonly generables: readonly FilaTxt[];
}

/** La fila tal como la recibe evaluarReglas (011), construida desde la copia. */
function evaluable(f: FilaCopia, origen: OrigenUsd | null): FilaEvaluable {
  return {
    id: f.id,
    proveedor: { tipo: f.proveedor.tipo, numero: f.proveedor.numero },
    comprobante: { tipo: f.comprobante.tipo, serie: f.comprobante.serie, numero: f.comprobante.numero },
    montos: f.montos,
    ...(origen === null ? {} : { origenUsd: origen }),
    ...(f.xml === null ? {} : { xml: f.xml }),
  };
}

const claveError = (filaId: string, codigo: string, destino: string | null): string =>
  JSON.stringify([filaId, codigo, destino]);

/**
 * Reparte los hallazgos: R-MIX al error IGV de su destino; R-RED al CUADRE de la fila o, si no lo
 * hay, a su CONVERSION_USD; R-ISC, R-NEW y R-GP a avisos. Un hallazgo sin su error se descarta.
 */
function repartir(errores: ErrorPrevalidacion[], hallazgos: readonly Hallazgo[]): AvisoPrevalidacion[] {
  const indice = new Map<string, Entero>();
  errores.forEach((e, i) => {
    if (e.filaId !== null) indice.set(claveError(e.filaId, e.codigo, e.destino), i);
  });
  const adjuntar = (h: Hallazgo, claves: readonly string[]): void => {
    for (const clave of claves) {
      const i = indice.get(clave);
      if (i === undefined) continue;
      errores[i] = Object.freeze({ ...(errores[i] as ErrorPrevalidacion), sugerencia: h });
      return;
    }
  };
  const avisos: AvisoPrevalidacion[] = [];
  for (const h of hallazgos) {
    if (h.regla === "R-MIX") adjuntar(h, [claveError(h.filaId, "IGV", h.destino)]);
    else if (h.regla === "R-RED") {
      adjuntar(h, [claveError(h.filaId, "CUADRE", null), claveError(h.filaId, "CONVERSION_USD", null)]);
    } else {
      // Lo que queda son R-ISC, R-NEW y R-GP: avisan y nunca bloquean (D11).
      avisos.push(
        Object.freeze({
          filaId: h.filaId,
          codigo: h.regla as CodigoAvisoPrevalidacion,
          explicacion: h.explicacion,
          hallazgo: h,
        }),
      );
    }
  }
  return avisos;
}

/** Hallazgos de una sola fila sobre el contexto ya validado; si alguna regla falla con ella, ninguno (D19). */
function hallazgosDeFila(f: FilaEvaluable, contexto: ContextoInterno): readonly Hallazgo[] {
  try {
    // validarFilas devuelve una fila por cada una recibida, o lanza.
    return evaluarFila(validarFilas([f])[0] as FilaInterna, contexto);
  } catch {
    // EntradaReglasInvalidaError de la fila (patrón más laxo que 011, H-012-21), MontoFueraDeRangoError
    // u otro: el aviso se omite y el bloqueo no cambia. El contexto ya no se lee aquí, así que un
    // contexto malformado nunca llega a este catch (H-012-40).
    return [];
  }
}

/**
 * Hallazgos de evaluarReglas aislados por fila (D19). El contexto se valida una vez y lanza
 * EntradaReglasInvalidaError si está malformado, como siempre. Luego cada fila se valida y se evalúa
 * sola sobre la copia validada (ninguna regla depende de otra fila), en orden de id. Dentro de la
 * fila, evaluarFila da cada regla en el orden DG, DGNG, DNG, así que un orden estable por
 * ORDEN_REGLAS deja el orden de salida de evaluarReglas (id → regla → destino): cuando ninguna fila
 * falla, el resultado es el del lote.
 */
function hallazgosAislados(evaluables: readonly FilaEvaluable[], reglas: ContextoReglas): readonly Hallazgo[] {
  const contexto = validarContexto(reglas);
  const porRegla = (a: Hallazgo, b: Hallazgo): Entero => ORDEN_REGLAS.indexOf(a.regla) - ORDEN_REGLAS.indexOf(b.regla);
  return [...evaluables]
    .sort((a, b) => compararTexto(a.id, b.id))
    .flatMap((f) => [...hallazgosDeFila(f, contexto)].sort(porRegla));
}

/**
 * Prevalida copias ya leídas con un formato ya elegido. Filas generables: las no excluidas, más las
 * excluidas si el formato las incluye (D14); solo esas se validan y van al TXT. Las de ventas (012b)
 * se validan con erroresDeVentaCopia y nunca llevan `reglas`.
 */
export function prevalidarCopia(
  filas: readonly FilaTxt[],
  cabecera: CabeceraTxt,
  formato: FormatoTxt,
  reglas: ContextoReglas | null,
): Prevalidado {
  const errores: ErrorPrevalidacion[] = [];
  if (!validarRuc(cabecera.rucDeclarante)) {
    errores.push(
      crearError({ filaId: null, codigo: "RUC_INVALIDO", campo: "rucDeclarante", explicacion: rucInvalido("rucDeclarante") }),
    );
  }
  errores.push(...validarCabecera(cabecera, formato));
  const generables = Object.freeze(filas.filter((f) => f.estado !== "excluida" || formato.incluyeExcluidas));
  if (generables.length === 0) {
    errores.push(crearError({ filaId: null, codigo: "SIN_FILAS", campo: null, explicacion: SIN_FILAS }));
  }
  const evaluables: FilaEvaluable[] = [];
  for (const f of generables) {
    if (esVentaCopia(f)) {
      errores.push(...erroresDeVentaCopia(f, formato, cabecera));
      continue;
    }
    const estructura = validarEstructura(f, formato, cabecera);
    const aritmetica = validarAritmetica(f);
    errores.push(...estructura, ...aritmetica.errores);
    if (!estructura.some((e) => CODIGOS_ESTRUCTURA.has(e.codigo))) evaluables.push(evaluable(f, aritmetica.origen));
  }
  errores.push(...buscarDuplicados(generables));
  const avisos = reglas === null ? [] : repartir(errores, hallazgosAislados(evaluables, reglas));
  errores.sort(compararErrores);
  const resultado: ResultadoPrevalidacion = Object.freeze({
    apto: errores.length === 0,
    errores: Object.freeze(errores),
    avisos: Object.freeze(avisos),
    formato: Object.freeze({ id: formato.id, version: formato.version, oficial: formato.oficial }),
  });
  return Object.freeze({ resultado, generables });
}

/**
 * Contexto con forma válida: `cabecera` obligatoria; `reglas` y `registro` opcionales. `reglas:
 * null` es forma imposible (H-012-22): no apaga en silencio los avisos; `undefined` = sin reglas.
 */
export function leerContexto(o: unknown): {
  cabecera: unknown;
  reglas: ContextoReglas | null;
  registro: RegistroFormatos | undefined;
} {
  const v = leerObjeto(o, CLAVES_CONTEXTO, REQUERIDAS_CONTEXTO);
  const reglas = v.get("reglas");
  if (reglas === null) invalida();
  return {
    cabecera: v.get("cabecera"),
    reglas: reglas === undefined ? null : (reglas as ContextoReglas),
    registro: v.get("registro") as RegistroFormatos | undefined,
  };
}

/**
 * Decide si el periodo puede generarse y lista las filas por corregir. Pura y determinista; no muta
 * la entrada. Forma imposible → EntradaPrevalidacionInvalidaError; periodo sin versión vigente →
 * FormatoNoVigenteError. Un dato corregible nunca lanza: es un ErrorPrevalidacion. El libro sale de
 * `cabecera.libro` (012b): las filas del otro libro, o `reglas` con ventas, son forma imposible.
 */
export function prevalidar(filas: readonly FilaReemplazoVenta[], contexto: ContextoPrevalidacionVentas): ResultadoPrevalidacion;
export function prevalidar(filas: readonly FilaReemplazo[], contexto: ContextoPrevalidacion): ResultadoPrevalidacion;
export function prevalidar(
  filas: readonly FilaReemplazo[] | readonly FilaReemplazoVenta[],
  contexto: ContextoPrevalidacion | ContextoPrevalidacionVentas,
): ResultadoPrevalidacion {
  const ctx = leerContexto(contexto);
  const cabecera = leerCabecera(ctx.cabecera);
  if (cabecera.libro === "ventas" && ctx.reglas !== null) invalida();
  const copias = leerFilasDe(cabecera.libro, filas);
  const formato = seleccionarFormato(cabecera.libro, cabecera.periodo, ctx.registro);
  return prevalidarCopia(copias, cabecera, formato, ctx.reglas).resultado;
}
