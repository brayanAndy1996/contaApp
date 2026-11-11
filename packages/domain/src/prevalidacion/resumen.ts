// Resumen de cambios entre el periodo original y el vigente (D12, D14; CA-8; plan, «resumirCambios»
// y Ratificación 13). Empareja por `id`, cuenta por el estado de la fila vigente y calcula el
// impacto en IGV por destino, en PEN, sin prorrata. Las USD se convierten con convertirAPen de 010.
import { COLUMNAS_COMPRA, convertirAPen } from "../comprobante/index";
import type { Destino, MontosComprobante } from "../comprobante/index";
import { MontoFueraDeRangoError, Money, redondearSunat } from "../dinero/index";
import { PARES_DESTINO } from "../reglas/entrada";
import type { Entero } from "../texto/entero";
import { tipoCambioDe } from "./aritmetica";
import { compararTexto, invalida, leerCabecera, leerFilas, leerFilasVenta } from "./entrada";
import type { FilaCopia, FilaVentaCopia, OrigenUsdCopia } from "./entrada";
import type { CabeceraTxt } from "../formatos/tipos";
import type { FilaReemplazo, FilaReemplazoVenta, ResumenCambios, ResumenCambiosVentas } from "./tipos";

// ---------------------------------------------------------------- «difiere»
/**
 * TC válido completado con ceros a 3 decimales, como texto (`3.3` → `3.300`, `3` → `3.000`). La
 * gramática de TipoCambio no admite ceros a la izquierda en la parte entera, así que dos TC con el
 * mismo valor dan el mismo texto.
 */
function tcCanonico(tc: string): string {
  const [entero, decimales = ""] = tc.split(".");
  return `${entero}.${decimales.padEnd(3, "0")}`;
}

/** TC por valor; si alguno es inválido (o `null`), por texto. */
function mismoTc(a: string | null, b: string | null): boolean {
  if (a === null || b === null || tipoCambioDe(a) === null || tipoCambioDe(b) === null) return a === b;
  return tcCanonico(a) === tcCanonico(b);
}

/** Misma moneda, mismas columnas y mismo total (Money.igual). */
function mismosMontos(a: MontosComprobante, b: MontosComprobante): boolean {
  if (a.moneda !== b.moneda) return false;
  return COLUMNAS_COMPRA.every((c) => a.obtener(c).igual(b.obtener(c))) && a.total.igual(b.total);
}

function mismoOrigen(a: OrigenUsdCopia | null, b: OrigenUsdCopia | null): boolean {
  if (a === null || b === null) return a === b;
  return mismosMontos(a.montos, b.montos) && mismoTc(a.tipoCambio, b.tipoCambio);
}

/** Datos literales de la línea del TXT: comprobante, documento, razón social y fecha. */
function literales(f: FilaCopia): readonly string[] {
  const { comprobante: c, proveedor: p } = f;
  // Razón social ausente y "" dan la misma línea (H-012-4, H-012-27).
  return [c.tipo, c.serie, c.numero, p.tipo, p.numero, p.razonSocial ?? "", f.fechaEmision];
}

/** Cambia algún dato que va a la línea del TXT (Ratificación 13). El `xml` no cuenta. */
function difiere(o: FilaCopia, v: FilaCopia): boolean {
  const lo = literales(o);
  const lv = literales(v);
  const mismosLiterales = lo.every((x, i) => x === lv[i]);
  return !(
    mismosLiterales &&
    mismosMontos(o.montos, v.montos) &&
    mismoTc(o.tipoCambio, v.tipoCambio) &&
    mismoOrigen(o.origenUsd, v.origenUsd)
  );
}

// ---------------------------------------------------------------- impacto en PEN
/**
 * Montos en PEN de la fila, o `null` si es USD y no convierte: sin TC, TC inválido, montos
 * descuadrados o resultado fuera de NUMERIC(14,2). Con un MontosComprobante USD real y un
 * TipoCambio real, esos son los únicos errores posibles de convertirAPen.
 */
function montosEnPen(f: FilaCopia): MontosComprobante | null {
  if (f.montos.moneda === "PEN") return f.montos;
  const tc = f.tipoCambio === null ? null : tipoCambioDe(f.tipoCambio);
  if (tc === null) return null;
  try {
    return convertirAPen(f.montos, tc);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- emparejar
interface FilaResumible {
  readonly id: string;
  readonly estado: string;
}

interface Emparejado<T> {
  readonly excluidas: Entero;
  readonly agregadas: Entero;
  /** Las vigentes no excluidas, con su original (`null` si es agregada). */
  readonly suman: readonly { readonly vigente: T; readonly original: T | null }[];
}

/**
 * Empareja por `id` y cuenta por el estado de la vigente. Forma imposible → invalida: una original
 * que no está `original`, un id original ausente en la vigente, una agregada con id original o una
 * vigente no agregada sin original.
 */
function emparejar<T extends FilaResumible>(originales: readonly T[], vigentes: readonly T[]): Emparejado<T> {
  const porId = new Map<string, T>();
  for (const f of originales) {
    if (f.estado !== "original") invalida();
    porId.set(f.id, f);
  }
  let excluidas: Entero = 0;
  let agregadas: Entero = 0;
  const emparejados = new Set<string>();
  const suman: { vigente: T; original: T | null }[] = [];
  for (const v of vigentes) {
    const o = porId.get(v.id);
    if (v.estado === "agregada") {
      if (o !== undefined) invalida();
      agregadas++;
      suman.push({ vigente: v, original: null });
      continue;
    }
    if (o === undefined) invalida();
    emparejados.add(v.id);
    if (v.estado === "excluida") {
      excluidas++;
      continue;
    }
    suman.push({ vigente: v, original: o });
  }
  if (emparejados.size !== porId.size) invalida();
  return { excluidas, agregadas, suman };
}

// ---------------------------------------------------------------- API pública
/**
 * Conteos de modificadas, excluidas y agregadas, e impacto en IGV por destino (vigente − original),
 * en PEN. Lanza EntradaPrevalidacionInvalidaError ante una forma imposible: una fila del original
 * que no está en estado `original`, un id del original ausente en el vigente, una `agregada` con id
 * del original, una vigente no agregada con un id que no está en el original, o un impacto (por
 * destino o total) que excede NUMERIC(14,2) (D22). Con `cabecera` de ventas (012b) resume ventas:
 * filas del otro libro (o de ventas sin la cabecera) son forma imposible.
 */
export function resumirCambios(
  original: readonly FilaReemplazoVenta[],
  vigente: readonly FilaReemplazoVenta[],
  cabecera: CabeceraTxt,
): ResumenCambiosVentas;
export function resumirCambios(original: readonly FilaReemplazo[], vigente: readonly FilaReemplazo[]): ResumenCambios;
export function resumirCambios(
  original: readonly FilaReemplazo[] | readonly FilaReemplazoVenta[],
  vigente: readonly FilaReemplazo[] | readonly FilaReemplazoVenta[],
  cabecera?: CabeceraTxt,
): ResumenCambios | ResumenCambiosVentas {
  const libro = cabecera === undefined ? "compras" : leerCabecera(cabecera).libro;
  if (libro === "ventas") return resumirCopiasVentas(leerFilasVenta(original), leerFilasVenta(vigente));
  return resumirCopias(leerFilas(original), leerFilas(vigente));
}

/** resumirCambios de compras sobre copias ya leídas (prepararArchivo lee una sola vez). */
export function resumirCopias(originales: readonly FilaCopia[], vigentes: readonly FilaCopia[]): ResumenCambios {
  const { excluidas, agregadas, suman } = emparejar(originales, vigentes);
  let modificadas: Entero = 0;
  for (const { vigente, original } of suman) if (original !== null && difiere(original, vigente)) modificadas++;

  const igv: Record<Destino, Money[]> = { DG: [], DGNG: [], DNG: [] };
  const sinConvertir = new Set<string>();
  const acumular = (f: FilaCopia, resta: boolean): void => {
    const m = montosEnPen(f);
    if (m === null) {
      sinConvertir.add(f.id);
      return;
    }
    for (const par of PARES_DESTINO) {
      const x = m.obtener(par.igv);
      igv[par.destino].push(resta ? x.negar() : x);
    }
  };
  for (const { vigente } of suman) acumular(vigente, false);
  for (const f of originales) acumular(f, true);

  return Object.freeze({
    modificadas,
    excluidas,
    agregadas,
    impactoIgv: impactoEnRango(igv),
    filasSinConvertir: Object.freeze([...sinConvertir].sort(compararTexto)),
  });
}

// ---------------------------------------------------------------- ventas (012b)
/**
 * IGV de la venta en PEN, o `null` si es USD y no convierte (sin TC, TC inválido o fuera de
 * NUMERIC(14,2)). En USD, `redondearSunat(igv × tc)` por columna (010 D7), como resumirVentas (013):
 * no exige que la venta cuadre.
 */
function igvVentaEnPen(f: FilaVentaCopia): Money | null {
  if (f.moneda === "PEN") return f.montos.igv;
  const tc = f.tipoCambio === null ? null : tipoCambioDe(f.tipoCambio);
  if (tc === null) return null;
  try {
    // redondearSunat conserva la moneda (USD): se reexpresa en PEN por su cadena canónica.
    return Money.desde(redondearSunat(f.montos.igv.por(tc)).toString(), "PEN");
  } catch {
    // Con un Money y un TipoCambio reales solo puede exceder NUMERIC(14,2).
    return null;
  }
}

/**
 * Resumen de ventas sobre copias ya leídas: no hay modificadas (ventas no se edita) y el impacto es
 * solo el total: Σ IGV de las vigentes no excluidas − Σ IGV de las originales, en PEN. Una excluida
 * resta su IGV; la USD sin TC va a `filasSinConvertir` y no suma en ningún lado.
 */
export function resumirCopiasVentas(
  originales: readonly FilaVentaCopia[],
  vigentes: readonly FilaVentaCopia[],
): ResumenCambiosVentas {
  const { excluidas, agregadas, suman } = emparejar(originales, vigentes);
  const igv: Money[] = [];
  const sinConvertir = new Set<string>();
  const acumular = (f: FilaVentaCopia, resta: boolean): void => {
    const x = igvVentaEnPen(f);
    if (x === null) sinConvertir.add(f.id);
    else igv.push(resta ? x.negar() : x);
  };
  for (const { vigente } of suman) acumular(vigente, false);
  for (const f of originales) acumular(f, true);
  return Object.freeze({
    modificadas: 0,
    excluidas,
    agregadas,
    impactoIgv: Object.freeze({ total: sumaEnRango(igv) }),
    filasSinConvertir: Object.freeze([...sinConvertir].sort(compararTexto)),
  });
}

/**
 * Una sola suma por destino (y otra para el total): el rango solo se comprueba en el resultado. Si
 * alguna sale de NUMERIC(14,2), no hay Money que devolver y un IGV de ese tamaño no es un dato que el
 * contador corrija: lanza EntradaPrevalidacionInvalidaError, no un error de dinero (D22, H-012-28).
 */
type ImpactoIgv = { readonly DG: Money; readonly DGNG: Money; readonly DNG: Money; readonly total: Money };

function impactoEnRango(igv: Record<Destino, Money[]>): ImpactoIgv {
  return Object.freeze({
    DG: sumaEnRango(igv.DG),
    DGNG: sumaEnRango(igv.DGNG),
    DNG: sumaEnRango(igv.DNG),
    total: sumaEnRango([...igv.DG, ...igv.DGNG, ...igv.DNG]),
  });
}

/** Money.suma en PEN; fuera de NUMERIC(14,2) es forma imposible (D22). */
function sumaEnRango(lista: readonly Money[]): Money {
  try {
    return Money.suma(lista, "PEN");
  } catch (e) {
    if (e instanceof MontoFueraDeRangoError) invalida();
    throw e;
  }
}
