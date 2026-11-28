/**
 * Diagnóstico de la ESTRUCTURA de un ZIP que el lector rechaza (spec 041, CA-10 y CA-13). Solo pruebas: se usa desde la
 * prueba de contrato y NO toca producción. El lector (`extraerTxtDeZip`) solo dice `zip_invalido`; aquí se lee el mismo
 * archivo por separado y se deduce el motivo comparando su estructura con las reglas de `zip-seguro.ts`.
 *
 * Regla de oro: se informa la FORMA del archivo, nunca su contenido. Del ZIP salen la firma (4 bytes en hex), el tamaño,
 * el fin de directorio central, ZIP64, los campos de cada entrada del directorio central y el nombre con TODA secuencia
 * de 4+ dígitos tapada (`#`; los nombres traen el RUC) y con un alfabeto cerrado. Del TXT no sale nada.
 */
import { crc32 } from "node:zlib";
import { Inflate } from "fflate";
import { RAZON_MAX_ZIP, TOPE_ZIP_COMPRIMIDO, TOPE_ZIP_DESCOMPRIMIDO, extraerTxtDeZip } from "../zip-seguro.js";

const FIRMA_LOCAL = 0x04034b50;
const FIRMA_CENTRAL = 0x02014b50;
const FIRMA_FIN = 0x06054b50;
const FIRMA_LOCALIZADOR_ZIP64 = 0x07064b50;
const LARGO_FIN = 22;
const LARGO_CENTRAL = 46;
const LARGO_LOCAL = 30;
const MAX_COMENTARIO = 0xffff;
/** Las mismas banderas de cifrado que `zip-seguro.ts`: bits 0, 6 y 13. */
const BANDERAS_CIFRADO = (1 << 0) | (1 << 6) | (1 << 13);
const MAX_LARGO_NOMBRE = 255;
/** Entradas del directorio central que se leen (y de ahí, las que se imprimen: `MAX_ENTRADAS_IMPRESAS`). */
const MAX_ENTRADAS_LEIDAS = 64;
export const MAX_ENTRADAS_IMPRESAS = 20;
const MAX_LARGO_NOMBRE_IMPRESO = 80;
/** Bytes iniciales que se miran para decidir si «parece texto plano». */
const BYTES_TEXTO_PLANO = 64;

export interface EntradaZipEstructura {
  /** 1, 2, 3… en el orden del directorio central. */
  indice: number;
  /** Solo la extensión (minúsculas, hasta 5 caracteres alfanuméricos), «-» si no tiene o «?» si es rara. */
  extension: string;
  /** El nombre contiene `/`. */
  conRuta: boolean;
  /** El nombre termina en `/`. */
  esDirectorio: boolean;
  largoNombre: number;
  /** Nombre con alfabeto cerrado y toda secuencia de 4+ dígitos reemplazada por `#`. Nunca el nombre real. */
  nombre: string;
  metodo: number;
  banderas: number;
  cifrado: boolean;
  descriptor: boolean;
  utf8: boolean;
  comprimido: number;
  descomprimido: number;
  crc: number;
  /** Tamaños o desplazamiento saturados (0xFFFFFFFF) o campo extra ZIP64 (id 0x0001). */
  zip64: boolean;
  /** Uso interno del deducir motivos; no se imprime. */
  interno: { nombreBytes: Uint8Array; largoExtra: number; largoComentario: number; discoInicio: number; inicioLocal: number };
}

export interface FinDirectorio {
  posicion: number;
  /** El registro termina justo al final del archivo (sin basura ni comentario inconsistente). */
  alFinal: boolean;
  disco: number;
  discoCentral: number;
  enDisco: number;
  total: number;
  largoCentral: number;
  inicioCentral: number;
}

export interface EstructuraZip {
  bytes: number;
  /** Los 4 primeros bytes en hexadecimal (menos si el archivo es más corto). */
  firma: string;
  /** Empieza por `PK\x03\x04`. */
  esZip: boolean;
  /** Los primeros 64 bytes son solo caracteres imprimibles (más tab, CR y LF). */
  textoPlano: boolean;
  /** Se encontró un registro de fin de directorio central (EOCD). */
  eocd: boolean;
  fin: FinDirectorio | null;
  zip64: boolean;
  /** Entradas que dice el EOCD (`null` sin EOCD). */
  entradasDeclaradas: number | null;
  /** Entradas leídas del directorio central (hasta `MAX_ENTRADAS_LEIDAS`). */
  entradas: EntradaZipEstructura[];
}

export interface DiagnosticoZip {
  estructura: EstructuraZip;
  /** Lo que lanzó el lector (clase y detalle con alfabeto cerrado); `null` si lo leyó bien. */
  rechazo: { clase: string; detalle: string } | null;
  /** Motivos deducidos de la estructura, en el orden en que `zip-seguro.ts` los evalúa (el primero es el que corta). */
  motivos: string[];
  /** Rarezas que NO rechazan por sí solas (p. ej. el descriptor de datos). */
  observaciones: string[];
}

const hex = (n: number, digitos: number): string => n.toString(16).padStart(digitos, "0");

/** Cierra el alfabeto (todo lo demás pasa a «?»), tapa las secuencias de 4+ dígitos y acota el largo. */
export function nombreSeguro(bytes: Uint8Array): string {
  const texto = new TextDecoder("utf-8").decode(bytes);
  return texto
    .replace(/[^A-Za-z0-9._\- /]/g, "?")
    .replace(/\d{4,}/g, "#")
    .slice(0, MAX_LARGO_NOMBRE_IMPRESO);
}

function extensionDe(bytes: Uint8Array): string {
  const texto = new TextDecoder("utf-8").decode(bytes);
  const base = texto.slice(texto.lastIndexOf("/") + 1);
  const punto = base.lastIndexOf(".");
  if (punto < 0 || punto === base.length - 1) return "-";
  const ext = base.slice(punto + 1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext.replace(/\d{4,}/g, "#") : "?";
}

/** Los primeros 64 bytes son todos imprimibles (0x20-0x7e) o tab, CR, LF. No se imprime ninguno. */
export function pareceTextoPlano(b: Uint8Array): boolean {
  const n = Math.min(b.length, BYTES_TEXTO_PLANO);
  if (n === 0) return false;
  for (let i = 0; i < n; i += 1) {
    const c = b[i] ?? 0;
    if (!(c === 9 || c === 10 || c === 13 || (c >= 0x20 && c <= 0x7e))) return false;
  }
  return true;
}

function buscarFin(zip: Uint8Array, dv: DataView): FinDirectorio | null {
  if (zip.length < LARGO_FIN) return null;
  const ultimo = zip.length - LARGO_FIN;
  const primero = Math.max(0, ultimo - MAX_COMENTARIO);
  let candidato: number | null = null;
  let alFinal = false;
  for (let i = ultimo; i >= primero; i -= 1) {
    if (dv.getUint32(i, true) !== FIRMA_FIN) continue;
    if (i + LARGO_FIN + dv.getUint16(i + 20, true) === zip.length) {
      candidato = i;
      alFinal = true;
      break;
    }
    candidato ??= i;
  }
  if (candidato === null) return null;
  const i = candidato;
  return {
    posicion: i,
    alFinal,
    disco: dv.getUint16(i + 4, true),
    discoCentral: dv.getUint16(i + 6, true),
    enDisco: dv.getUint16(i + 8, true),
    total: dv.getUint16(i + 10, true),
    largoCentral: dv.getUint32(i + 12, true),
    inicioCentral: dv.getUint32(i + 16, true),
  };
}

function tieneCampoZip64(dv: DataView, desde: number, largo: number): boolean {
  let p = desde;
  const hasta = desde + largo;
  while (p + 4 <= hasta) {
    if (dv.getUint16(p, true) === 0x0001) return true;
    p += 4 + dv.getUint16(p + 2, true);
  }
  return false;
}

function leerEntradas(zip: Uint8Array, dv: DataView, fin: FinDirectorio): EntradaZipEstructura[] {
  const entradas: EntradaZipEstructura[] = [];
  let o = fin.inicioCentral;
  const cuantas = Math.min(fin.total, MAX_ENTRADAS_LEIDAS);
  for (let n = 0; n < cuantas; n += 1) {
    if (o + LARGO_CENTRAL > fin.posicion || dv.getUint32(o, true) !== FIRMA_CENTRAL) break;
    const banderas = dv.getUint16(o + 8, true);
    const metodo = dv.getUint16(o + 10, true);
    const crc = dv.getUint32(o + 16, true);
    const comprimido = dv.getUint32(o + 20, true);
    const descomprimido = dv.getUint32(o + 24, true);
    const largoNombre = dv.getUint16(o + 28, true);
    const largoExtra = dv.getUint16(o + 30, true);
    const largoComentario = dv.getUint16(o + 32, true);
    const discoInicio = dv.getUint16(o + 34, true);
    const inicioLocal = dv.getUint32(o + 42, true);
    const siguiente = o + LARGO_CENTRAL + largoNombre + largoExtra + largoComentario;
    if (siguiente > fin.posicion) break;
    const nombreBytes = zip.subarray(o + LARGO_CENTRAL, o + LARGO_CENTRAL + largoNombre);
    const texto = new TextDecoder("utf-8").decode(nombreBytes);
    entradas.push({
      indice: n + 1,
      extension: extensionDe(nombreBytes),
      conRuta: texto.includes("/"),
      esDirectorio: texto.endsWith("/"),
      largoNombre,
      nombre: nombreSeguro(nombreBytes),
      metodo,
      banderas,
      cifrado: (banderas & 1) !== 0,
      descriptor: (banderas & (1 << 3)) !== 0,
      utf8: (banderas & (1 << 11)) !== 0,
      comprimido,
      descomprimido,
      crc,
      zip64:
        comprimido === 0xffffffff ||
        descomprimido === 0xffffffff ||
        inicioLocal === 0xffffffff ||
        tieneCampoZip64(dv, o + LARGO_CENTRAL + largoNombre, largoExtra),
      interno: { nombreBytes, largoExtra, largoComentario, discoInicio, inicioLocal },
    });
    o = siguiente;
  }
  return entradas;
}

/** Estructura del archivo (nunca su contenido). Total: no lanza con ningún byte de entrada. */
export function analizarZip(zip: Uint8Array): EstructuraZip {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const fin = buscarFin(zip, dv);
  const entradas = fin === null ? [] : leerEntradas(zip, dv, fin);
  const localizador = fin !== null && fin.posicion >= 20 && dv.getUint32(fin.posicion - 20, true) === FIRMA_LOCALIZADOR_ZIP64;
  const saturado = fin !== null && (fin.total === 0xffff || fin.largoCentral === 0xffffffff || fin.inicioCentral === 0xffffffff);
  return {
    bytes: zip.length,
    firma: [...zip.subarray(0, 4)].map((b) => hex(b, 2)).join(""),
    esZip: zip.length >= 4 && dv.getUint32(0, true) === FIRMA_LOCAL,
    textoPlano: pareceTextoPlano(zip),
    eocd: fin !== null,
    fin,
    zip64: localizador || saturado || entradas.some((e) => e.zip64),
    entradasDeclaradas: fin === null ? null : fin.total,
    entradas,
  };
}

// ── Motivo del rechazo: se deduce comparando la estructura con las reglas de zip-seguro.ts ──────────────────

/** Deflate por trozos con tope; devuelve cuántos bytes produjo y el CRC corrido, sin conservar nada. */
function inflarContando(datos: Uint8Array, limite: number): { escritos: number; crc: number; terminado: boolean } | null {
  let escritos = 0;
  let crc = 0;
  let terminado = false;
  const inflador = new Inflate();
  inflador.ondata = (trozo, final) => {
    if (escritos + trozo.length > limite) throw new Error("excedido");
    escritos += trozo.length;
    crc = crc32(trozo, crc) >>> 0;
    if (final) terminado = true;
  };
  try {
    for (let i = 0; i < datos.length; i += 4096) {
      const hasta = Math.min(i + 4096, datos.length);
      inflador.push(datos.subarray(i, hasta), hasta === datos.length);
    }
  } catch {
    return null;
  }
  return { escritos, crc, terminado };
}

function motivosDeEntrada(zip: Uint8Array, dv: DataView, fin: FinDirectorio, e: EntradaZipEstructura, tope: number): string[] {
  const m: string[] = [];
  const x = e.interno;
  if (fin.largoCentral < LARGO_CENTRAL) m.push("directorio_central_mas_corto_que_una_entrada");
  if (LARGO_CENTRAL + e.largoNombre + x.largoExtra + x.largoComentario !== fin.largoCentral) {
    m.push("directorio_central_no_es_exactamente_una_entrada");
  }
  if ((e.banderas & BANDERAS_CIFRADO) !== 0) m.push("cifrado");
  if (x.discoInicio !== 0) m.push("disco_inicial_distinto_de_0");
  if (e.metodo !== 0 && e.metodo !== 8) m.push(`metodo_${e.metodo}_no_soportado`);
  if (e.descomprimido > tope) m.push("descomprimido_declarado_mayor_que_el_tope");
  if (e.comprimido >= zip.length) m.push("comprimido_declarado_mayor_que_el_archivo");
  if (e.descomprimido > RAZON_MAX_ZIP * Math.max(e.comprimido, 1)) m.push("razon_descomprimido_comprimido_mayor_que_200");

  // Nombre (validarNombre).
  if (x.nombreBytes.length === 0 || x.nombreBytes.length > MAX_LARGO_NOMBRE) {
    m.push("nombre_vacio_o_de_mas_de_255_bytes");
  } else {
    let nombre: string | null = null;
    try {
      nombre = new TextDecoder("utf-8", { fatal: true }).decode(x.nombreBytes);
    } catch {
      m.push("nombre_no_utf8");
    }
    if (nombre !== null) {
      if (nombre.endsWith("/")) m.push("nombre_es_directorio");
      else if (nombre.includes("/")) m.push("nombre_con_ruta");
      if (/[\u0000-\u001f\u007f\\:]/.test(nombre)) m.push("nombre_con_caracter_prohibido");
      if (nombre.includes("..")) m.push("nombre_con_doble_punto");
      if (!/^[^.].*\.txt$/i.test(nombre)) m.push(nombre.startsWith(".") ? "nombre_empieza_con_punto" : "nombre_no_termina_en_txt");
    }
  }

  // Cabecera local (ubicarDatos).
  const o = x.inicioLocal;
  if (o + LARGO_LOCAL > fin.inicioCentral || dv.getUint32(o, true) !== FIRMA_LOCAL) {
    m.push("cabecera_local_invalida");
    return m;
  }
  const banderasLocal = dv.getUint16(o + 6, true);
  const metodoLocal = dv.getUint16(o + 8, true);
  const largoNombreLocal = dv.getUint16(o + 26, true);
  const largoExtraLocal = dv.getUint16(o + 28, true);
  if ((banderasLocal & BANDERAS_CIFRADO) !== 0) m.push("cabecera_local_cifrada");
  if (metodoLocal !== e.metodo) m.push("cabecera_local_metodo_distinto_del_central");
  if (largoNombreLocal !== e.largoNombre) m.push("cabecera_local_nombre_de_otro_largo");
  else if (zip.subarray(o + LARGO_LOCAL, o + LARGO_LOCAL + largoNombreLocal).some((b, i) => b !== x.nombreBytes[i])) {
    m.push("cabecera_local_nombre_distinto");
  }
  const inicio = o + LARGO_LOCAL + largoNombreLocal + largoExtraLocal;
  const finDatos = inicio + e.comprimido;
  if (finDatos > fin.inicioCentral) {
    m.push("datos_fuera_del_directorio_central");
    return m;
  }

  // Datos: tamaños reales y CRC. Solo si los tamaños declarados caben en los topes (si no, el lector ya cortó antes).
  const datos = zip.subarray(inicio, finDatos);
  if (e.descomprimido > tope || e.comprimido >= zip.length || e.descomprimido > RAZON_MAX_ZIP * Math.max(e.comprimido, 1)) return m;
  if (e.metodo === 0) {
    if (e.comprimido !== e.descomprimido) m.push("stored_con_tamanos_distintos");
    else if ((crc32(datos) >>> 0) !== e.crc) m.push("crc_distinto_del_declarado");
  } else if (e.metodo === 8) {
    if (datos.length === 0) {
      m.push("deflate_sin_datos");
    } else {
      const r = inflarContando(datos, Math.min(e.descomprimido + 1, tope));
      if (r === null) m.push("deflate_corrupto_truncado_o_excede_lo_declarado");
      else {
        if (!r.terminado) m.push("deflate_sin_fin_de_flujo");
        if (r.escritos !== e.descomprimido) m.push(`descomprimido_real_${r.escritos > e.descomprimido ? "mayor" : "menor"}_que_el_declarado`);
        else if (r.crc !== e.crc) m.push("crc_distinto_del_declarado");
      }
    }
  }
  return m;
}

function deducirMotivos(zip: Uint8Array, est: EstructuraZip, tope: number): string[] {
  const m: string[] = [];
  if (zip.length < LARGO_FIN) m.push("menos_de_22_bytes");
  if (zip.length > TOPE_ZIP_COMPRIMIDO) m.push("mas_de_32_mib");
  const fin = est.fin;
  if (fin === null) {
    m.push("sin_eocd");
    return m;
  }
  if (!fin.alFinal) m.push("eocd_no_termina_al_final_del_archivo");
  if (fin.disco !== 0 || fin.discoCentral !== 0) m.push("multidisco");
  if (est.zip64) m.push("zip64");
  if (fin.total === 0) m.push("sin_entradas");
  else if ((fin.enDisco !== 1 || fin.total !== 1) && !(est.zip64 && fin.total === 0xffff)) m.push("mas_de_una_entrada");
  if (fin.inicioCentral + fin.largoCentral > fin.posicion) m.push("directorio_central_fuera_de_rango");
  const primera = est.entradas[0];
  if (primera === undefined) {
    m.push("directorio_central_sin_primera_entrada_legible");
    return m;
  }
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  m.push(...motivosDeEntrada(zip, dv, fin, primera, tope));
  return m;
}

function observacionesDe(est: EstructuraZip): string[] {
  const o: string[] = [];
  for (const e of est.entradas) {
    if (e.descriptor) o.push(`entrada_${e.indice}_con_descriptor_de_datos_no_rechaza_por_si_solo`);
    if (!e.utf8) o.push(`entrada_${e.indice}_sin_bandera_utf8_no_rechaza_por_si_solo`);
  }
  return o;
}

/**
 * Llama a `extraerTxtDeZip` con los bytes: si lo lee, `rechazo` es `null`; si lo rechaza, deduce el motivo con las reglas de
 * `zip-seguro.ts`. Si ninguna regla lo explica, el motivo es `no_deducido_por_la_prueba`.
 */
export function diagnosticarZip(zip: Uint8Array, topeDescomprimido: number = TOPE_ZIP_DESCOMPRIMIDO): DiagnosticoZip {
  const estructura = analizarZip(zip);
  let rechazo: DiagnosticoZip["rechazo"] = null;
  try {
    extraerTxtDeZip(zip, topeDescomprimido);
  } catch (causa) {
    const c = typeof causa === "object" && causa !== null ? (causa as Record<string, unknown>) : {};
    const clase = typeof c["name"] === "string" && /^[A-Za-z]{1,40}$/.test(c["name"]) ? c["name"] : "?";
    const detalle = typeof c["detalle"] === "string" && /^[a-z_]{1,40}$/.test(c["detalle"]) ? c["detalle"] : "?";
    rechazo = { clase, detalle };
  }
  if (rechazo === null) return { estructura, rechazo, motivos: [], observaciones: [] };
  const tope = Math.max(0, Math.min(topeDescomprimido, TOPE_ZIP_DESCOMPRIMIDO));
  const motivos = deducirMotivos(zip, estructura, tope);
  if (motivos.length === 0) motivos.push("no_deducido_por_la_prueba");
  return { estructura, rechazo, motivos, observaciones: observacionesDe(estructura) };
}

// ── Salida: líneas `[contrato-sire]` con la forma, nunca el contenido ───────────────────────────────────────

const si = (b: boolean): string => (b ? "sí" : "no");
const lista = (v: readonly string[]): string => (v.length === 0 ? "-" : v.join(","));

function textoFirma(e: EstructuraZip): string {
  return e.esZip ? `firma ${e.firma} (ZIP sí)` : `firma ${e.firma} (no es ZIP · texto plano ${si(e.textoPlano)})`;
}

function textoEntrada(x: EntradaZipEstructura): string {
  return (
    `ext ${x.extension} · ruta ${si(x.conRuta)} · directorio ${si(x.esDirectorio)} · nombre ${x.largoNombre} bytes «${x.nombre}» · ` +
    `método ${x.metodo} · banderas 0x${hex(x.banderas, 4)} (cifrado ${si(x.cifrado)}, descriptor de datos ${si(x.descriptor)}, UTF-8 ${si(x.utf8)}) · ` +
    `comprimido ${x.comprimido} · descomprimido ${x.descomprimido} · CRC 0x${hex(x.crc, 8)}` +
    (x.zip64 ? " · ZIP64 sí" : "")
  );
}

function textoDirectorio(e: EstructuraZip): string {
  const leidas = e.entradas.length;
  const declaradas = e.entradasDeclaradas;
  const entradas =
    declaradas === null ? "sin directorio central" : `entradas en el directorio central ${leidas}${leidas === declaradas ? "" : ` (declaradas ${declaradas})`}`;
  return `${textoFirma(e)} · ${e.bytes} bytes · EOCD ${si(e.eocd)}${e.fin === null ? "" : ` (al final del archivo ${si(e.fin.alFinal)})`} · ZIP64 ${si(e.zip64)} · ${entradas}`;
}

/** Líneas de un archivo rechazado: motivo, estructura y una línea por entrada. `p` ya lleva el prefijo y la moneda. */
export function lineasEstructura(p: string, n: number, d: DiagnosticoZip): string[] {
  const e = d.estructura;
  const l: string[] = [];
  const r = d.rechazo === null ? "el lector lo leyó" : `rechazado por el lector: ${d.rechazo.clase} ${d.rechazo.detalle}`;
  l.push(`${p}: archivo ${n} ${r} · motivo {${lista(d.motivos)}} · observaciones {${lista(d.observaciones)}}`);
  l.push(`${p}: archivo ${n} estructura: ${textoDirectorio(e)}`);
  for (const x of e.entradas.slice(0, MAX_ENTRADAS_IMPRESAS)) l.push(`${p}: archivo ${n} entrada ${x.indice}: ${textoEntrada(x)}`);
  const impresas = Math.min(e.entradas.length, MAX_ENTRADAS_IMPRESAS);
  const total = Math.max(e.entradasDeclaradas ?? 0, e.entradas.length);
  if (total > impresas) l.push(`${p}: archivo ${n} … ${total - impresas} entrada(s) más sin imprimir`);
  return l;
}

/** UNA línea con la estructura de la propuesta de compras (que sí se lee) como referencia comparativa, o su ausencia. */
export function lineaReferenciaPropuesta(p: string, e: EstructuraZip | null): string {
  if (e === null) {
    return `${p}: referencia propuesta de compras: sin estructura (no se descargó la propuesta de compras de este periodo antes, en esta corrida)`;
  }
  const entradas = e.entradas.slice(0, 5).map((x) => `[${x.indice}] ${textoEntrada(x)}`);
  return `${p}: referencia propuesta de compras: ${textoDirectorio(e)} · ${entradas.length === 0 ? "sin entradas leídas" : entradas.join(" | ")}`;
}
