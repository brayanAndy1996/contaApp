// prevalidar (plan 012, Contratos y «Orden de prevalidar»; D1, D4, D11, D13, D16, D17, D18).
// (1) Entrada estricta leída una vez a copias congeladas. (2) Formato con seleccionarFormato.
// (3) Estructura, fecha, TC, cuadre, IGV y origenUsd de cada fila generable. (4) Duplicados.
// (5) SIN_FILAS. (6) Si hay `reglas`, evaluarReglas solo sobre las filas sin error de estructura:
// R-MIX y R-RED como sugerencia de su error, R-ISC, R-NEW y R-GP como avisos. El bloqueo nunca
// depende de `reglas` (D19): si una regla falla en una fila, esa fila se queda sin sugerencias ni
// avisos y conserva sus errores; solo un contexto de reglas malformado lanza.
import { validarRuc } from "@contapp/shared";
import { seleccionarFormato } from "../formatos/registro";
import type { RegistroFormatos } from "../formatos/registro";
import type { CabeceraTxt, FormatoTxt } from "../formatos/tipos";
import { validarContexto } from "../reglas/entrada";
import { evaluarReglas } from "../reglas/index";
import type { Entero } from "../texto/entero";
import type { ContextoReglas, FilaEvaluable, Hallazgo, OrigenUsd } from "../reglas/index";
import { validarAritmetica } from "./aritmetica";
import { buscarDuplicados } from "./duplicados";
import { compararTexto, invalida, leerCabecera, leerFilas, leerObjeto } from "./entrada";
import type { FilaCopia } from "./entrada";
import { crearError } from "./errores";
import { CODIGOS_ESTRUCTURA, validarCabecera, validarEstructura } from "./estructura";
import { SIN_FILAS, rucInvalido } from "./explicaciones";
import type {
  AvisoPrevalidacion,
  CodigoAvisoPrevalidacion,
  ContextoPrevalidacion,
  ErrorPrevalidacion,
  FilaReemplazo,
  ResultadoPrevalidacion,
} from "./tipos";

const CLAVES_CONTEXTO = ["cabecera", "reglas", "registro"];
const REQUERIDAS_CONTEXTO = ["cabecera"];

/** Resultado y filas que irían al TXT (para generarTxt, que serializa esas mismas copias). */
export interface Prevalidado {
  readonly resultado: ResultadoPrevalidacion;
  readonly generables: readonly FilaCopia[];
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

/**
 * `filaId: null` primero; luego filaId, código y campo (`null` primero), por unidades de código.
 * Ids y nombres de campo nunca son "", así que `null` → "" los deja primero.
 */
function compararErrores(a: ErrorPrevalidacion, b: ErrorPrevalidacion): -1 | 0 | 1 {
  return (
    compararTexto(a.filaId ?? "", b.filaId ?? "") ||
    compararTexto(a.codigo, b.codigo) ||
    compararTexto(a.campo ?? "", b.campo ?? "")
  );
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

/** Hallazgos de una sola fila; si alguna regla falla con ella, ninguno (D19). */
function hallazgosDeFila(f: FilaEvaluable, reglas: ContextoReglas): readonly Hallazgo[] {
  try {
    return evaluarReglas([f], reglas).hallazgos;
  } catch {
    // MontoFueraDeRangoError, EntradaReglasInvalidaError de la fila (patrón más laxo que 011) u
    // otro: el aviso se omite y el bloqueo no cambia.
    return [];
  }
}

/**
 * Hallazgos de evaluarReglas aislados por fila (D19). Un contexto malformado lanza
 * EntradaReglasInvalidaError, como siempre. Si el lote entero falla, se evalúa fila a fila en
 * orden de id, que es el orden de salida de evaluarReglas (id → regla → destino).
 */
function hallazgosAislados(evaluables: readonly FilaEvaluable[], reglas: ContextoReglas): readonly Hallazgo[] {
  validarContexto(reglas);
  try {
    return evaluarReglas(evaluables, reglas).hallazgos;
  } catch {
    return [...evaluables].sort((a, b) => compararTexto(a.id, b.id)).flatMap((f) => hallazgosDeFila(f, reglas));
  }
}

/**
 * Prevalida copias ya leídas con un formato ya elegido. Filas generables: las no excluidas, más las
 * excluidas si el formato las incluye (D14); solo esas se validan y van al TXT.
 */
export function prevalidarCopia(
  filas: readonly FilaCopia[],
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
 * FormatoNoVigenteError. Un dato corregible nunca lanza: es un ErrorPrevalidacion.
 */
export function prevalidar(filas: readonly FilaReemplazo[], contexto: ContextoPrevalidacion): ResultadoPrevalidacion {
  const ctx = leerContexto(contexto);
  const copias = leerFilas(filas);
  const cabecera = leerCabecera(ctx.cabecera);
  const formato = seleccionarFormato(cabecera.libro, cabecera.periodo, ctx.registro);
  return prevalidarCopia(copias, cabecera, formato, ctx.reglas).resultado;
}
