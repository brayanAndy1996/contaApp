// Puente entre los datos planos de la demo (strings) y el dominio real de ContApp.
// Todo cálculo de dinero, reglas, prevalidación y TXT lo hace @contapp/domain: aquí solo se
// convierten formas. Nunca se usa `number` para montos.
import {
  COLUMNAS_COMPRA,
  DICCIONARIO_GLOSAS_BASE,
  Money,
  MontosComprobante,
  TOLERANCIA_CUADRE,
  TipoCambio,
  aplicarSugerencia,
  cambiarDestino,
  evaluarReglas,
  generarTxt,
  prevalidar,
  resumirCambios,
  verificarCuadre,
} from "@contapp/domain";
import type {
  ColumnaCompra,
  Confirmacion,
  ContextoReglas,
  Destino,
  EntornoEvaluacion,
  FilaEvaluable,
  FilaReemplazo,
  Hallazgo,
  ResultadoPrevalidacion,
  ResumenCambios,
  ResumenXml,
} from "@contapp/domain";
import type { FilaCompra, MontosPlanos, XmlDemo } from "../datos/tipos";

export { COLUMNAS_COMPRA };
export type { ColumnaCompra, Destino, Hallazgo, ResultadoPrevalidacion, ResumenCambios };

export const ETIQUETA_COLUMNA: Record<ColumnaCompra | "total", string> = {
  biDg: "BI DG",
  igvDg: "IGV DG",
  biDgng: "BI DGNG",
  igvDgng: "IGV DGNG",
  biDng: "BI DNG",
  igvDng: "IGV DNG",
  noGravado: "No gravado",
  isc: "ISC",
  icbper: "ICBPER",
  otrosTributos: "Otros trib.",
  total: "Total",
};

// ---------------------------------------------------------------- montos
export function aMontos(p: MontosPlanos, moneda: "PEN" | "USD" = "PEN"): MontosComprobante {
  const v: Partial<Record<ColumnaCompra, string>> & { total: string } = { total: p.total };
  for (const c of COLUMNAS_COMPRA) v[c] = p[c];
  return MontosComprobante.desde(moneda, v);
}

export function aPlanos(m: MontosComprobante): MontosPlanos {
  const j = m.toJSON();
  return { ...j.columnas, total: j.total };
}

export function cero(): MontosPlanos {
  const p = { total: "0.00" } as MontosPlanos;
  for (const c of COLUMNAS_COMPRA) p[c] = "0.00";
  return p;
}

/** Normaliza lo que escribe el usuario a un string canónico de 2 decimales; null si no es válido. */
export function normalizarMonto(texto: string): string | null {
  const t = texto.trim().replace(/,/g, "");
  if (!/^-?\d{1,11}(\.\d{0,2})?$/.test(t)) return null;
  try {
    const [ent, dec = ""] = t.split(".");
    return Money.desde(`${ent}.${dec.padEnd(2, "0")}`, "PEN").toString();
  } catch {
    return null;
  }
}

/** Σ componentes (sin total) con Money. */
export function sumaComponentes(p: MontosPlanos): string {
  return Money.suma(
    COLUMNAS_COMPRA.map((c) => Money.desde(p[c], "PEN")),
    "PEN",
  ).toString();
}

export function cuadre(p: MontosPlanos): { cuadra: boolean; diferencia: string } {
  const r = verificarCuadre(aMontos(p), TOLERANCIA_CUADRE);
  return { cuadra: r.cuadra, diferencia: r.diferencia.toString() };
}

/** Suma de strings monetarios (siempre con Money). */
export function sumar(valores: readonly string[]): string {
  return Money.suma(
    valores.map((v) => Money.desde(v, "PEN")),
    "PEN",
  ).toString();
}

export function restar(a: string, b: string): string {
  return Money.desde(a, "PEN").restar(Money.desde(b, "PEN")).toString();
}

export function esCero(v: string): boolean {
  return Money.desde(v, "PEN").esCero();
}

export function comparar(a: string, b: string): -1 | 0 | 1 {
  return Money.desde(a, "PEN").comparar(Money.desde(b, "PEN"));
}

export function destinoDe(p: MontosPlanos): Destino | "MIXTO" | null {
  const activos = (["DG", "DGNG", "DNG"] as const).filter((d) => {
    const bi = d === "DG" ? p.biDg : d === "DGNG" ? p.biDgng : p.biDng;
    const igv = d === "DG" ? p.igvDg : d === "DGNG" ? p.igvDgng : p.igvDng;
    return !esCero(bi) || !esCero(igv);
  });
  if (activos.length === 0) return null;
  return activos.length === 1 ? activos[0]! : "MIXTO";
}

export function moverADestino(p: MontosPlanos, d: Destino): MontosPlanos {
  return aPlanos(cambiarDestino(aMontos(p), d).montos);
}

/** IGV total de la fila (DG + DGNG + DNG). */
export function igvTotal(p: MontosPlanos): string {
  return sumar([p.igvDg, p.igvDgng, p.igvDng]);
}

// ---------------------------------------------------------------- reglas
function resumenXml(f: FilaCompra, xml: XmlDemo): ResumenXml {
  const m = (s: string) => Money.desde(s, xml.moneda);
  return {
    proveedor: { tipo: "6", numero: f.proveedorRuc },
    comprobante: { tipo: f.tipo, serie: f.serie, numero: f.numero },
    moneda: xml.moneda,
    gravado: m(xml.gravado),
    igv: m(xml.igv),
    noGravado: m(xml.noGravado),
    isc: m(xml.isc),
    icbper: m(xml.icbper),
    total: m(xml.total),
    glosas: xml.items.map((i) => i.descripcion),
  };
}

function filaEvaluable(f: FilaCompra, xml: XmlDemo | null): FilaEvaluable {
  const base: FilaEvaluable = {
    id: f.id,
    proveedor: { tipo: "6", numero: f.proveedorRuc },
    comprobante: { tipo: f.tipo, serie: f.serie, numero: f.numero },
    montos: aMontos(f.montos),
    ...(f.usd ? { origenUsd: { montos: aMontos(f.usd.montos, "USD"), tipoCambio: TipoCambio.desde(f.usd.tipoCambio) } } : {}),
  };
  // Un XML en USD sobre una fila PEN es un aviso XML_MONEDA: se pasa solo si coincide la moneda.
  if (xml && xml.moneda === "PEN") return { ...base, xml: resumenXml(f, xml) };
  return base;
}

export interface Evaluacion {
  porFila: Map<string, Hallazgo[]>;
  entorno: EntornoEvaluacion;
  total: number;
}

export function evaluar(
  filas: readonly FilaCompra[],
  xmls: Readonly<Record<string, XmlDemo | undefined>>,
  conocidos: readonly string[],
  emisoresIsc: readonly string[],
): Evaluacion {
  const evaluables = filas.filter((f) => !f.excluida).map((f) => filaEvaluable(f, xmls[f.id] ?? null));
  const contexto: ContextoReglas = {
    proveedoresConocidos: conocidos.map((numero) => ({ tipo: "6", numero })),
    proveedoresIsc: emisoresIsc.map((numero) => ({ tipo: "6", numero })),
    diccionario: DICCIONARIO_GLOSAS_BASE,
  };
  const r = evaluarReglas(evaluables, contexto);
  const porFila = new Map<string, Hallazgo[]>();
  for (const h of r.hallazgos) {
    const lista = porFila.get(h.filaId) ?? [];
    lista.push(h);
    porFila.set(h.filaId, lista);
  }
  return { porFila, entorno: { filas: evaluables, contexto }, total: r.hallazgos.length };
}

export function claveHallazgo(h: Hallazgo): string {
  return `${h.filaId}:${h.regla}:${h.destino ?? "-"}`;
}

export function aplicar(
  f: FilaCompra,
  h: Hallazgo,
  confirmacion: Confirmacion | undefined,
  entorno: EntornoEvaluacion,
): { montos: MontosPlanos; excluir: boolean } {
  const r = aplicarSugerencia(aMontos(f.montos), h, confirmacion, entorno);
  return { montos: aPlanos(r.montos), excluir: r.excluir };
}

export function moneyDe(s: string): Money {
  return Money.desde(s, "PEN");
}

// ---------------------------------------------------------------- generación
function filaReemplazo(f: FilaCompra, original: FilaCompra | undefined, razonSocial: string, xml: XmlDemo | null): FilaReemplazo {
  let estado: FilaReemplazo["estado"] = "original";
  if (f.agregada) estado = "agregada";
  else if (f.excluida) estado = "excluida";
  else if (original && JSON.stringify(original.montos) !== JSON.stringify(f.montos)) estado = "modificada";
  const ev = filaEvaluable(f, xml);
  return {
    id: f.id,
    estado,
    comprobante: { tipo: f.tipo, serie: f.serie, numero: f.numero },
    proveedor: { tipo: "6", numero: f.proveedorRuc, razonSocial },
    fechaEmision: f.fecha,
    montos: aMontos(f.montos),
    tipoCambio: null,
    origenUsd: f.usd ? { montos: aMontos(f.usd.montos, "USD"), tipoCambio: f.usd.tipoCambio } : null,
    ...(ev.xml ? { xml: ev.xml } : {}),
  };
}

export interface EntradaGenerar {
  ruc: string;
  periodo: string;
  vigentes: readonly FilaCompra[];
  originales: readonly FilaCompra[];
  razonSocial: (ruc: string) => string;
  xmls: Readonly<Record<string, XmlDemo | undefined>>;
  conocidos: readonly string[];
  emisoresIsc: readonly string[];
}

function filasReemplazo(e: EntradaGenerar) {
  const porId = new Map(e.originales.map((f) => [f.id, f]));
  const vigentes = e.vigentes.map((f) => filaReemplazo(f, porId.get(f.id), e.razonSocial(f.proveedorRuc), e.xmls[f.id] ?? null));
  const originales = e.originales.map((f) => filaReemplazo(f, f, e.razonSocial(f.proveedorRuc), e.xmls[f.id] ?? null));
  return { vigentes, originales };
}

export function prevalidarPeriodo(e: EntradaGenerar): { resultado: ResultadoPrevalidacion; resumen: ResumenCambios } {
  const { vigentes, originales } = filasReemplazo(e);
  const contexto: ContextoReglas = {
    proveedoresConocidos: e.conocidos.map((numero) => ({ tipo: "6", numero })),
    proveedoresIsc: e.emisoresIsc.map((numero) => ({ tipo: "6", numero })),
    diccionario: DICCIONARIO_GLOSAS_BASE,
  };
  const resultado = prevalidar(vigentes, {
    cabecera: { rucDeclarante: e.ruc, periodo: e.periodo, libro: "compras" },
    reglas: contexto,
  });
  return { resultado, resumen: resumirCambios(originales, vigentes) };
}

export interface ArchivoGenerado {
  nombreTxt: string;
  nombreZip: string;
  lineas: number;
  txt: string;
  bytesTxt: Uint8Array;
  formato: string;
  provisional: boolean;
}

export function generarArchivo(e: EntradaGenerar): ArchivoGenerado {
  const { vigentes } = filasReemplazo(e);
  // El formato oficial de SUNAT aún no está cargado (spec 012): la demo usa el provisional.
  const r = generarTxt(vigentes, { rucDeclarante: e.ruc, periodo: e.periodo, libro: "compras" }, { permitirProvisional: true });
  return {
    nombreTxt: r.nombreTxt,
    nombreZip: r.nombreZip,
    lineas: r.lineas,
    // El formato provisional se codifica en latin1 (spec 012): se decodifica igual para mostrarlo.
    txt: new TextDecoder("latin1").decode(r.bytes),
    bytesTxt: r.bytes,
    formato: `${r.formato.id} v${r.formato.version}`,
    provisional: r.provisional,
  };
}
