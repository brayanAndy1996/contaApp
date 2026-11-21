// Deducción del destino por proveedor a partir del registro de compras presentado (spec 025, RF-112, HU-29; D-3, U-2, U-8;
// plan Contratos: domain). Puro: sin IO. Los montos solo deciden «≠ 0» con Money (el signo no importa: notas de crédito por
// valor absoluto); los conteos y el umbral son enteros (5·c ≥ 4·t), sin flotantes.
import type { Destino } from "../comprobante/index";
import { Money } from "../dinero/index";
import type { Entero } from "../texto/index";
import type { DocProveedor } from "./tipos";

/** Una fila del registro presentado (montos como cadenas decimales). */
export interface FilaHistorial {
  /** AAAAMM. */
  readonly periodo: string;
  /** Ausente (o vacío) = «6» (RUC). */
  readonly tipoDocProveedor?: string | null;
  readonly numeroDocProveedor: string;
  readonly razonSocial?: string | null;
  readonly tipoComprobante: string;
  /** Serie y número del comprobante: con ambos (no vacíos) el comprobante es identificable y cuenta una sola vez. */
  readonly serie?: string | null;
  readonly numero?: string | null;
  readonly biDg: string;
  readonly biDgng: string;
  readonly biDng: string;
}

export interface ConteosCandidata {
  readonly DG: Entero;
  readonly DGNG: Entero;
  readonly DNG: Entero;
  readonly mixto: Entero;
  /** DG + DGNG + DNG + mixto. */
  readonly total: Entero;
}

/** Conteos mutables mientras se acumula. */
type Conteos = { -readonly [K in keyof ConteosCandidata]: Entero };

export interface CandidataDeducida {
  readonly proveedor: DocProveedor;
  /** La del periodo más reciente, sin controles ni bidi y recortada a 200; null si no hay. */
  readonly razonSocial: string | null;
  /** null = sin criterio claro (U-8). */
  readonly destino: Destino | null;
  readonly conteos: ConteosCandidata;
  /** Periodos distintos en que aparece el proveedor. */
  readonly periodosConProveedor: Entero;
}

export interface ResultadoAprendizaje {
  /** Por tipo y número de documento (unidades de código). */
  readonly candidatas: readonly CandidataDeducida[];
  readonly descartadas: { readonly sinProveedor: Entero; readonly sinBase: Entero };
}

const DESTINOS: readonly Destino[] = ["DG", "DGNG", "DNG"];
const TIPO_DOC = /^[0-9A-Z]$/;
const NUMERO_DOC = /^[0-9A-Z-]{1,15}$/;
const ESPACIOS = /\s/g;
const MINUSCULA_ASCII = /[a-z]/g;
/** Controles (Cc), formato (Cf: incluye las marcas bidi) y sustitutos sueltos (Cs). */
const INVISIBLES = /[\p{Cc}\p{Cf}\p{Cs}]/gu;
const LARGO_MAX_RAZON = 200;

const enMayusculas = (s: string): string => s.replace(MINUSCULA_ASCII, (c) => c.toUpperCase());

/** Documento normalizado como la clave de R-NEW; null si no hay proveedor identificable. */
function proveedorDe(f: FilaHistorial): DocProveedor | null {
  const tipoCrudo = typeof f.tipoDocProveedor === "string" ? enMayusculas(f.tipoDocProveedor.replace(ESPACIOS, "")) : "";
  const tipo = tipoCrudo === "" ? "6" : tipoCrudo;
  const numero = typeof f.numeroDocProveedor === "string" ? enMayusculas(f.numeroDocProveedor.replace(ESPACIOS, "")) : "";
  if (numero === "-" || !TIPO_DOC.test(tipo) || !NUMERO_DOC.test(numero)) return null;
  return { tipo, numero };
}

function razonLimpia(r: string | null | undefined): string | null {
  if (typeof r !== "string") return null;
  const limpia = Array.from(r.replace(INVISIBLES, "").trim()).slice(0, LARGO_MAX_RAZON).join("").trim();
  return limpia === "" ? null : limpia;
}

interface Acumulado {
  readonly proveedor: DocProveedor;
  readonly conteos: Conteos;
  readonly periodos: Set<string>;
  razon: { periodo: string; texto: string } | null;
}

const comparar = (a: string, b: string): Entero => (a < b ? -1 : a > b ? 1 : 0);

/** Destino propuesto por U-2: al menos 2 y al menos 80 % del total, único (sin empate). */
function propuesto(c: Conteos): Destino | null {
  const cumplen = DESTINOS.filter((d) => c[d] >= 2 && 5 * c[d] >= 4 * c.total);
  return cumplen.length === 1 ? (cumplen[0] as Destino) : null;
}

/** Parte normalizada de la clave del comprobante (`trim` y mayúsculas ASCII); "" si falta. */
const parte = (v: unknown): string => (typeof v === "string" ? enMayusculas(v.trim()) : "");

/** Clave del comprobante (proveedor + tipo + serie + número); null si no es identificable (sin serie o sin número). */
function claveComprobante(proveedor: string, f: FilaHistorial): string | null {
  const serie = parte(f.serie);
  const numero = parte(f.numero);
  if (serie === "" || numero === "") return null;
  return JSON.stringify([proveedor, parte(f.tipoComprobante), serie, numero]);
}

/** Lo que una fila aporta a los conteos: el periodo, la clave de montos para desempatar y en qué destinos tiene base. */
interface Aporte {
  readonly acumulado: Acumulado;
  readonly periodo: string;
  readonly montos: string;
  readonly conBase: readonly boolean[];
}

/** Gana la fila del periodo más reciente; en el mismo periodo, la de mayor `biDg|biDgng|biDng` por unidades de código. */
const gana = (x: Aporte, y: Aporte): boolean =>
  comparar(x.periodo, y.periodo) > 0 || (x.periodo === y.periodo && comparar(x.montos, y.montos) > 0);

/**
 * Candidatas por proveedor (D-3): un comprobante con base ≠ 0 en un solo destino suma a ese destino; en dos o más, a `mixto`;
 * sin base no cuenta (`descartadas.sinBase`). Se cuentan COMPROBANTES (H-025-2-1): con serie y número, el mismo comprobante
 * (proveedor + tipo + serie + número) repetido en un periodo o en varios cuenta una vez, con la fila que gana según `gana`; sin
 * serie o sin número, cada fila cuenta por sí misma. `periodosConProveedor` y `razonSocial` salen de todas las filas. Sin
 * proveedor identificable (número vacío, «-» o fuera de la gramática de `DocProveedor`) no cuenta (`descartadas.sinProveedor`).
 * Un proveedor sin ningún comprobante contado no da candidata. No muta la entrada; el resultado no depende del orden de las filas.
 */
export function aprenderDeHistorial(filas: readonly FilaHistorial[]): ResultadoAprendizaje {
  const porClave = new Map<string, Acumulado>();
  const porComprobante = new Map<string, Aporte>();
  const sueltos: Aporte[] = [];
  let sinProveedor = 0;
  let sinBase = 0;
  for (const f of filas) {
    const proveedor = proveedorDe(f);
    if (proveedor === null) {
      sinProveedor += 1;
      continue;
    }
    const clave = `${proveedor.tipo}:${proveedor.numero}`;
    let a = porClave.get(clave);
    if (a === undefined) {
      a = { proveedor, conteos: { DG: 0, DGNG: 0, DNG: 0, mixto: 0, total: 0 }, periodos: new Set(), razon: null };
      porClave.set(clave, a);
    }
    a.periodos.add(f.periodo);
    const texto = razonLimpia(f.razonSocial);
    if (texto !== null) {
      const r = a.razon;
      // Periodo más reciente; en el mismo periodo, la mayor por unidades de código (determinista ante permutaciones).
      if (r === null || comparar(f.periodo, r.periodo) > 0 || (f.periodo === r.periodo && comparar(texto, r.texto) > 0)) {
        a.razon = { periodo: f.periodo, texto };
      }
    }
    // Todo monto se valida (un monto ilegible lanza aunque su fila sea un duplicado que no se cuenta).
    const aporte: Aporte = {
      acumulado: a,
      periodo: f.periodo,
      montos: `${f.biDg}|${f.biDgng}|${f.biDng}`,
      conBase: [f.biDg, f.biDgng, f.biDng].map((b) => !Money.desde(b, "PEN").esCero()),
    };
    const comprobante = claveComprobante(clave, f);
    if (comprobante === null) {
      sueltos.push(aporte);
      continue;
    }
    const previo = porComprobante.get(comprobante);
    if (previo === undefined || gana(aporte, previo)) porComprobante.set(comprobante, aporte);
  }
  for (const { acumulado, conBase } of [...sueltos, ...porComprobante.values()]) {
    const n = conBase.filter(Boolean).length;
    if (n === 0) {
      sinBase += 1;
      continue;
    }
    const c = acumulado.conteos;
    c.total += 1;
    if (n >= 2) c.mixto += 1;
    else c[DESTINOS[conBase.indexOf(true)] as Destino] += 1;
  }
  const candidatas: CandidataDeducida[] = [];
  for (const a of porClave.values()) {
    if (a.conteos.total === 0) continue;
    candidatas.push({
      proveedor: a.proveedor,
      razonSocial: a.razon?.texto ?? null,
      destino: propuesto(a.conteos),
      conteos: { ...a.conteos },
      periodosConProveedor: a.periodos.size,
    });
  }
  candidatas.sort(
    (x, y) => comparar(x.proveedor.tipo, y.proveedor.tipo) || comparar(x.proveedor.numero, y.proveedor.numero),
  );
  return { candidatas, descartadas: { sinProveedor, sinBase } };
}
