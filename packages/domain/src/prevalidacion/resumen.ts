// Resumen de cambios entre el periodo original y el vigente (D12, D14; CA-8; plan, «resumirCambios»
// y Ratificación 13). Empareja por `id`, cuenta por el estado de la fila vigente y calcula el
// impacto en IGV por destino, en PEN, sin prorrata. Las USD se convierten con convertirAPen de 010.
import { COLUMNAS_COMPRA, convertirAPen } from "../comprobante/index";
import type { Destino, MontosComprobante } from "../comprobante/index";
import { Money } from "../dinero/index";
import { PARES_DESTINO } from "../reglas/entrada";
import type { Entero } from "../texto/entero";
import { tipoCambioDe } from "./aritmetica";
import { compararTexto, invalida, leerFilas } from "./entrada";
import type { FilaCopia, OrigenUsdCopia } from "./entrada";
import type { FilaReemplazo, ResumenCambios } from "./tipos";

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

// ---------------------------------------------------------------- API pública
/**
 * Conteos de modificadas, excluidas y agregadas, e impacto en IGV por destino (vigente − original),
 * en PEN. Lanza EntradaPrevalidacionInvalidaError ante una forma imposible: una fila del original
 * que no está en estado `original`, un id del original ausente en el vigente, una `agregada` con id
 * del original o una vigente no agregada con un id que no está en el original.
 */
export function resumirCambios(original: readonly FilaReemplazo[], vigente: readonly FilaReemplazo[]): ResumenCambios {
  const originales = leerFilas(original);
  const vigentes = leerFilas(vigente);
  const porId = new Map<string, FilaCopia>();
  for (const f of originales) {
    if (f.estado !== "original") invalida();
    porId.set(f.id, f);
  }

  let modificadas: Entero = 0;
  let excluidas: Entero = 0;
  let agregadas: Entero = 0;
  const emparejados = new Set<string>();
  const suman: FilaCopia[] = [];
  for (const v of vigentes) {
    const o = porId.get(v.id);
    if (v.estado === "agregada") {
      if (o !== undefined) invalida();
      agregadas++;
      suman.push(v);
      continue;
    }
    if (o === undefined) invalida();
    emparejados.add(v.id);
    if (v.estado === "excluida") {
      excluidas++;
      continue;
    }
    if (difiere(o, v)) modificadas++;
    suman.push(v);
  }
  if (emparejados.size !== porId.size) invalida();

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
  for (const f of suman) acumular(f, false);
  for (const f of originales) acumular(f, true);

  // Una sola suma por destino (y otra para el total): el rango solo se comprueba en el resultado.
  return Object.freeze({
    modificadas,
    excluidas,
    agregadas,
    impactoIgv: Object.freeze({
      DG: Money.suma(igv.DG, "PEN"),
      DGNG: Money.suma(igv.DGNG, "PEN"),
      DNG: Money.suma(igv.DNG, "PEN"),
      total: Money.suma([...igv.DG, ...igv.DGNG, ...igv.DNG], "PEN"),
    }),
    filasSinConvertir: Object.freeze([...sinConvertir].sort(compararTexto)),
  });
}
