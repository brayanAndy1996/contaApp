// R-RED (RF-083; spec D-6, CA-6; plan 011, Decisiones: "R-RED" y "Ratificación de contratos").
// Precedencia: origenUsd → XML válido (columna sin umbral, o total si Σ = xml.total) → umbral
// 0.01 × componentes ≠ 0 sin respaldo. Ningún error de rango de 010 sale de aquí: degrada a
// hallazgo sin sugerencia.
import { COLUMNAS_COMPRA, convertirAPen } from "../comprobante/index";
import type { ColumnaCompra, MontosComprobante } from "../comprobante/index";
import {
  ComprobanteDescuadradoError,
  Money,
  MontoFueraDeRangoError,
  TOLERANCIA_CUADRE,
  verificarCuadre,
} from "../dinero/index";
import type { ResultadoCuadre, TipoCambio } from "../dinero/index";
import { crearHallazgo } from "./entrada";
import type { FilaInterna, XmlInterno } from "./entrada";
import { RED_FUERA_DE_RANGO, SUFIJO_RED_XML, red, redUsd } from "./explicaciones";
import type { Hallazgo, MontosParciales, OrigenUsd } from "./tipos";

/** Grupo comparable con el XML: monto del XML ↔ columnas del SIRE. */
interface GrupoXml {
  readonly xml: "gravado" | "igv" | "noGravado" | "isc" | "icbper";
  readonly columnas: readonly ColumnaCompra[];
}

const GRUPOS_XML: readonly GrupoXml[] = Object.freeze([
    { xml: "gravado", columnas: ["biDg", "biDgng", "biDng"] },
    { xml: "igv", columnas: ["igvDg", "igvDgng", "igvDng"] },
    { xml: "noGravado", columnas: ["noGravado"] },
    { xml: "isc", columnas: ["isc"] },
    { xml: "icbper", columnas: ["icbper"] },
  ]);

/** R-RED lee todas las columnas y el total (obsolescencia, CA-9). */
function lecturasDe(m: MontosComprobante): MontosParciales {
  const l: Partial<Record<ColumnaCompra | "total", Money>> = {};
  for (const c of COLUMNAS_COMPRA) l[c] = m.obtener(c);
  l.total = m.total;
  return l;
}

function hallazgo(
  fila: FilaInterna,
  explicacion: string,
  valores: MontosParciales | null,
  respaldada: boolean,
): Hallazgo {
  return crearHallazgo({
    filaId: fila.id,
    regla: "R-RED",
    destino: null,
    explicacion,
    sugerencia: valores === null ? null : { tipo: "ajustar", valores },
    requiereConfirmacion: !(respaldada && valores !== null),
    dato: null,
    lecturas: lecturasDe(fila.montos),
  });
}

/** TC con tres decimales ("3.750"): el texto exacto de 1.00 × tc, completado con ceros. */
function textoTc(tc: TipoCambio): string {
  const [entero, decimales = ""] = Money.desde("1.00", "USD").por(tc).toString().split(".");
  return `${entero}.${decimales.padEnd(3, "0")}`;
}

/** El origen USD no cuadra: se explica su propio descuadre (en su moneda), sin sugerencia. */
function descuadreOrigen(fila: FilaInterna, origen: MontosComprobante): Hallazgo {
  try {
    const c = verificarCuadre(origen, TOLERANCIA_CUADRE);
    return hallazgo(fila, red(c.sumaComponentes, c.total), null, false);
  } catch (e) {
    if (e instanceof MontoFueraDeRangoError) return hallazgo(fila, RED_FUERA_DE_RANGO, null, false);
    throw e;
  }
}

/** (1) origenUsd: manda la conversión por componente de 010 (D7), aunque la fila PEN cuadre. */
function porOrigenUsd(fila: FilaInterna, origen: OrigenUsd): Hallazgo | null {
  let esperado: MontosComprobante;
  try {
    esperado = convertirAPen(origen.montos, origen.tipoCambio);
  } catch (e) {
    if (e instanceof ComprobanteDescuadradoError) return descuadreOrigen(fila, origen.montos);
    if (e instanceof MontoFueraDeRangoError) return hallazgo(fila, redUsd(textoTc(origen.tipoCambio)), null, false);
    throw e;
  }
  const valores: Partial<Record<ColumnaCompra | "total", Money>> = {};
  let difiere = false;
  for (const c of COLUMNAS_COMPRA) {
    if (!fila.montos.obtener(c).igual(esperado.obtener(c))) {
      valores[c] = esperado.obtener(c);
      difiere = true;
    }
  }
  if (!fila.montos.total.igual(esperado.total)) {
    valores.total = esperado.total;
    difiere = true;
  }
  return difiere ? hallazgo(fila, redUsd(textoTc(origen.tipoCambio)), valores, true) : null;
}

/**
 * (2) XML válido: si `xml.total = total`, un solo grupo difiere en exactamente `dif` y cae en una
 * sola columna → esa columna (sin umbral); si `xml.total ≠ total` y `Σ = xml.total` → total.
 */
function valoresPorXml(m: MontosComprobante, xml: XmlInterno, c: ResultadoCuadre): MontosParciales | null {
  if (!xml.total.igual(m.total)) {
    return c.sumaComponentes.igual(xml.total) ? { total: c.sumaComponentes } : null;
  }
  const difieren = GRUPOS_XML.filter((g) => {
    const sire = Money.suma(
      g.columnas.map((col) => m.obtener(col)),
      m.moneda,
    );
    return !xml[g.xml].igual(sire);
  });
  if (difieren.length !== 1) return null;
  const grupo = difieren[0] as GrupoXml;
  const sire = Money.suma(
    grupo.columnas.map((col) => m.obtener(col)),
    m.moneda,
  );
  if (!xml[grupo.xml].restar(sire).igual(c.diferencia)) return null;
  const columnas = grupo.columnas.length === 1 ? grupo.columnas : grupo.columnas.filter((col) => !m.obtener(col).esCero());
  if (columnas.length !== 1) return null;
  const col = columnas[0] as ColumnaCompra;
  return { [col]: m.obtener(col).sumar(c.diferencia) };
}

/** (3) Sin respaldo: |dif| ≤ 0.01 × componentes ≠ 0 (mínimo 1) → total = Σ. */
function valoresPorUmbral(m: MontosComprobante, c: ResultadoCuadre): MontosParciales | null {
  const centimo = Money.desde("0.01", m.moneda);
  let umbral = Money.cero(m.moneda);
  for (const x of m.componentes()) if (!x.esCero()) umbral = umbral.sumar(centimo);
  if (umbral.esCero()) umbral = centimo;
  return c.diferencia.abs().comparar(umbral) <= 0 ? { total: c.sumaComponentes } : null;
}

/** R-RED de una fila; null si no hay descuadre (ni diferencia con la conversión de origenUsd). */
export function evaluarRed(fila: FilaInterna): Hallazgo | null {
  if (fila.origenUsd !== null) return porOrigenUsd(fila, fila.origenUsd);
  const m = fila.montos;
  let c: ResultadoCuadre;
  try {
    c = verificarCuadre(m, TOLERANCIA_CUADRE);
  } catch (e) {
    // Σ o total − Σ exceden NUMERIC(14,2): no cuadra y no hay cifra que mostrar ni sugerir.
    if (e instanceof MontoFueraDeRangoError) return hallazgo(fila, RED_FUERA_DE_RANGO, null, false);
    throw e;
  }
  if (c.cuadra) return null;
  const base = red(c.sumaComponentes, c.total);
  if (fila.xml === null) return hallazgo(fila, base, valoresPorUmbral(m, c), false);
  let valores: MontosParciales | null;
  try {
    valores = valoresPorXml(m, fila.xml, c);
  } catch (e) {
    // Una suma parcial de columnas de signos mezclados puede salir de rango: sin sugerencia.
    if (e instanceof MontoFueraDeRangoError) valores = null;
    else throw e;
  }
  return hallazgo(fila, valores === null ? base : base + SUFIJO_RED_XML, valores, true);
}
