/**
 * Lectura segura del ZIP que devuelve el SIRE (plan 041, «zip-seguro.ts» y «Decisiones de la ronda 3 · ZIP del registro»;
 * spec CA-10, CA-13). Síncrona y sin IO.
 *
 * No se confía en nada del ZIP. El archivo debe ser CONTIGUO: [`PK\x07\x08` opcional][cabeceras locales con sus datos, en
 * el orden del directorio central, sin huecos ni solapes][directorio central][un único EOCD con su comentario y nada
 * después]. El directorio central trae a lo sumo 8 entradas; las de directorio (`X/`, método 0, tamaños 0, CRC 0) y las
 * de archivo vacías (método 0, tamaños 0, CRC 0) se ignoran, pero el NOMBRE de todas se valida (solo `[A-Za-z0-9._-]`, a
 * lo sumo una carpeta, sin segmentos vacíos, que empiecen o terminen con `.` ni reservados de Windows, ≤ 255 bytes; los
 * archivos terminan en `.txt`) y todas viven en la carpeta del archivo con datos. La cabecera local de CADA entrada
 * coincide con la central (nombre, método, tamaños y CRC; sin ZIP64). Debe haber exactamente UNA entrada con datos, sin
 * cifrar, con método «stored» o «deflate»; si está en una carpeta, la carpeta figura como entrada de directorio o se llama
 * igual que el archivo sin `.txt` (estructura real `LE#/LE#.txt`).
 *
 * Deflate: el flujo debe consumir EXACTAMENTE el tamaño comprimido declarado (sin cola tras el bloque final) y producir
 * exactamente lo declarado. Memoria: lo producido se acota (`maxOutputLength`) al declarado, que ya pasó por los topes
 * (≤ 64 MiB y ≤ 200 × comprimido), así que una bomba de 1 GiB nunca llega a la memoria.
 *
 * Los nombres solo se leen para validarlos: nunca se usan como ruta ni se escribe nada a disco.
 * Todo rechazo es `ErrorPortalSire("zip_invalido")` con mensaje fijo: ni nombres de entrada ni bytes.
 */
import { crc32, inflateRawSync } from "node:zlib";
import { ErrorPortalSire } from "../errores.js";

const MIB = 1024 * 1024;
/** Tope de bytes del ZIP recibido (CA-10). */
export const TOPE_ZIP_COMPRIMIDO = 32 * MIB;
/** Tope de bytes descomprimidos POR PARTE (CA-10); se cuenta al descomprimir. */
export const TOPE_ZIP_DESCOMPRIMIDO = 64 * MIB;
/** Tope de bytes descomprimidos ACUMULADOS entre todas las partes de un periodo (CA-10, decisión del usuario). */
export const TOPE_ZIP_DESCOMPRIMIDO_TOTAL = 256 * MIB;
/** Razón máxima descomprimido / comprimido (CA-10). */
export const RAZON_MAX_ZIP = 200;
/** Tope de entradas en el directorio central (ronda 3: el registro real trae 3). */
export const MAX_ENTRADAS_ZIP = 8;

/** Trozo de salida del motor de inflado. */
const TROZO_INFLATE = 64 * 1024;

const FIRMA_LOCAL = 0x04034b50;
const FIRMA_CENTRAL = 0x02014b50;
const FIRMA_FIN = 0x06054b50;
/** Marca de ZIP «dividido» que trae el archivo real al inicio; también es la firma del descriptor de datos. */
const FIRMA_MARCA = 0x08074b50;
const LARGO_FIN = 22;
const LARGO_CENTRAL = 46;
const LARGO_LOCAL = 30;
const LARGO_DESCRIPTOR = 16;
const MAX_COMENTARIO = 0xffff;
/** Bits de cifrado: 0 (tradicional), 6 (fuerte) y 13 (directorio central cifrado). */
const BANDERAS_CIFRADO = (1 << 0) | (1 << 6) | (1 << 13);
/** Bit 3: CRC y tamaños en un descriptor de datos tras el cuerpo. */
const BANDERA_DESCRIPTOR = 1 << 3;
const METODO_STORED = 0;
const METODO_DEFLATE = 8;
const MAX_LARGO_NOMBRE = 255;
/** Id del campo extra ZIP64. */
const EXTRA_ZIP64 = 0x0001;
const TAMANO_ZIP64 = 0xffffffff;

/** Un segmento: solo `[A-Za-z0-9._-]`, sin `.` inicial ni final. */
const SEGMENTO = /^[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/;
/** Nombres reservados de Windows, con o sin extensión. */
const RESERVADO_WINDOWS = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function invalido(): ErrorPortalSire {
  return new ErrorPortalSire("zip_invalido");
}

type Clase = "directorio" | "vacia" | "datos";

interface EntradaCentral {
  nombreBytes: Uint8Array;
  /** Nombre ya validado (solo para comparar; nunca se usa como ruta). */
  nombre: string;
  clase: Clase;
  banderas: number;
  metodo: number;
  crc: number;
  comprimido: number;
  descomprimido: number;
  inicioLocal: number;
  /** Tope efectivo de bytes descomprimidos para esta entrada. */
  tope: number;
}

/**
 * Devuelve los bytes del único TXT con datos del ZIP o lanza `ErrorPortalSire("zip_invalido")`. `topeDescomprimido`
 * acota aún más lo que se acepta producir (el cliente pasa lo que queda del tope acumulado del periodo); nunca pasa de
 * 64 MiB.
 */
export function extraerTxtDeZip(zip: Uint8Array, topeDescomprimido: number = TOPE_ZIP_DESCOMPRIMIDO): Uint8Array {
  if (!(zip instanceof Uint8Array) || zip.length < LARGO_FIN || zip.length > TOPE_ZIP_COMPRIMIDO) throw invalido();
  const tope = Number.isFinite(topeDescomprimido) ? Math.max(0, Math.min(topeDescomprimido, TOPE_ZIP_DESCOMPRIMIDO)) : 0;
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const inicioArchivo = inicioDeCabeceras(dv);
  const finCentral = buscarFinDirectorio(zip, dv);
  const entradas = leerDirectorioCentral(zip, dv, finCentral, tope);
  const entrada = elegirEntradaConDatos(entradas);
  const datos = recorrerCabecerasLocales(zip, dv, entradas, inicioArchivo, finCentral.inicioCentral);
  const salida = entrada.metodo === METODO_STORED ? copiarStored(datos, entrada) : inflar(datos, entrada);
  if ((crc32(salida) >>> 0) !== entrada.crc) throw invalido();
  return salida;
}

/** El archivo empieza con la primera cabecera local, o con la marca `PK\x07\x08` seguida INMEDIATAMENTE de ella. */
function inicioDeCabeceras(dv: DataView): number {
  const inicio = dv.getUint32(0, true) === FIRMA_MARCA ? 4 : 0;
  if (dv.byteLength < inicio + 4 || dv.getUint32(inicio, true) !== FIRMA_LOCAL) throw invalido();
  return inicio;
}

interface FinDirectorio {
  inicioCentral: number;
  largoCentral: number;
  total: number;
}

/**
 * Registro de fin del directorio central: exactamente UNO termina justo al final del archivo (con su comentario), el
 * comentario no trae otra firma de EOCD y el directorio central termina justo donde empieza el EOCD.
 */
function buscarFinDirectorio(zip: Uint8Array, dv: DataView): FinDirectorio {
  const ultimo = zip.length - LARGO_FIN;
  const primero = Math.max(0, ultimo - MAX_COMENTARIO);
  let encontrado = -1;
  for (let i = ultimo; i >= primero; i -= 1) {
    if (dv.getUint32(i, true) !== FIRMA_FIN) continue;
    if (i + LARGO_FIN + dv.getUint16(i + 20, true) !== zip.length) continue;
    if (encontrado >= 0) throw invalido();
    encontrado = i;
  }
  if (encontrado < 0) throw invalido();
  const i = encontrado;
  for (let p = i + LARGO_FIN; p + 4 <= zip.length; p += 1) if (dv.getUint32(p, true) === FIRMA_FIN) throw invalido();
  const disco = dv.getUint16(i + 4, true);
  const discoCentral = dv.getUint16(i + 6, true);
  const enDisco = dv.getUint16(i + 8, true);
  const total = dv.getUint16(i + 10, true);
  const largoCentral = dv.getUint32(i + 12, true);
  const inicioCentral = dv.getUint32(i + 16, true);
  // 0xFFFF / 0xFFFFFFFF (ZIP64) quedan fuera por el tope de entradas y por el límite del archivo.
  if (disco !== 0 || discoCentral !== 0 || enDisco !== total || total < 1 || total > MAX_ENTRADAS_ZIP) throw invalido();
  if (inicioCentral + largoCentral !== i) throw invalido();
  return { inicioCentral, largoCentral, total };
}

/** Lee las `total` entradas del directorio central, que debe ocuparlo exactamente; clasifica y valida cada una. */
function leerDirectorioCentral(zip: Uint8Array, dv: DataView, fin: FinDirectorio, tope: number): EntradaCentral[] {
  const entradas: EntradaCentral[] = [];
  const limite = fin.inicioCentral + fin.largoCentral;
  let o = fin.inicioCentral;
  for (let n = 0; n < fin.total; n += 1) {
    if (o + LARGO_CENTRAL > limite || dv.getUint32(o, true) !== FIRMA_CENTRAL) throw invalido();
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
    const finRegistro = o + LARGO_CENTRAL + largoNombre + largoExtra + largoComentario;
    if (finRegistro > limite) throw invalido();
    if ((banderas & BANDERAS_CIFRADO) !== 0 || discoInicio !== 0) throw invalido();
    if (metodo !== METODO_STORED && metodo !== METODO_DEFLATE) throw invalido();
    const inicioNombre = o + LARGO_CENTRAL;
    if (tieneExtraZip64(dv, inicioNombre + largoNombre, largoExtra)) throw invalido();
    const nombreBytes = zip.subarray(inicioNombre, inicioNombre + largoNombre);
    const nombre = decodificarNombre(nombreBytes);
    const clase = clasificar(nombre, metodo, crc, comprimido, descomprimido);
    validarRuta(nombre, clase);
    if (clase === "datos") {
      // ZIP64 (0xFFFFFFFF) no cabe en los topes; el declarado se acota antes de reservar nada.
      if (descomprimido > tope || comprimido >= zip.length) throw invalido();
      if (descomprimido > RAZON_MAX_ZIP * Math.max(comprimido, 1)) throw invalido();
    }
    entradas.push({ nombreBytes, nombre, clase, banderas, metodo, crc, comprimido, descomprimido, inicioLocal, tope });
    o = finRegistro;
  }
  if (o !== limite) throw invalido();
  return entradas;
}

function tieneExtraZip64(dv: DataView, inicio: number, largo: number): boolean {
  let p = inicio;
  const fin = inicio + largo;
  while (p + 4 <= fin) {
    if (dv.getUint16(p, true) === EXTRA_ZIP64) return true;
    p += 4 + dv.getUint16(p + 2, true);
  }
  return false;
}

function clasificar(nombre: string, metodo: number, crc: number, comprimido: number, descomprimido: number): Clase {
  const sinBytes = metodo === METODO_STORED && comprimido === 0 && descomprimido === 0 && crc === 0;
  if (!sinBytes) return "datos";
  return nombre.endsWith("/") ? "directorio" : "vacia";
}

/** 1..255 bytes, todos de `[A-Za-z0-9._/-]` (ASCII: sin barras ni puntos Unicode, bidi, espacios ni controles). */
function decodificarNombre(bytes: Uint8Array): string {
  if (bytes.length === 0 || bytes.length > MAX_LARGO_NOMBRE) throw invalido();
  let nombre = "";
  for (const b of bytes) {
    const ok =
      (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2e || b === 0x5f || b === 0x2d || b === 0x2f;
    if (!ok) throw invalido();
    nombre += String.fromCharCode(b);
  }
  return nombre;
}

/**
 * Ruta relativa de a lo sumo una carpeta: sin `/` inicial ni segmentos vacíos, que empiecen o terminen con `.` (cubre `.`
 * y `..`) o reservados de Windows. Directorio: `X/`. Archivo: `nombre.txt` o `X/nombre.txt` (`.txt` en minúscula).
 */
function validarRuta(nombre: string, clase: Clase): void {
  const ruta = clase === "directorio" ? nombre.slice(0, -1) : nombre;
  const segmentos = ruta.split("/");
  const maxSegmentos = clase === "directorio" ? 1 : 2;
  if (segmentos.length > maxSegmentos) throw invalido();
  for (const s of segmentos) if (!SEGMENTO.test(s) || s.includes("..") || RESERVADO_WINDOWS.test(s)) throw invalido();
  if (clase !== "directorio" && !ruta.endsWith(".txt")) throw invalido();
}

function carpetaDe(nombre: string): string {
  const i = nombre.lastIndexOf("/");
  return i < 0 ? "" : nombre.slice(0, i + 1);
}

/**
 * Exactamente una entrada con datos y `.txt`; las ignoradas viven en su misma carpeta (el directorio, si hay, es su
 * prefijo). Sin entrada de directorio, la carpeta debe llamarse como el archivo sin `.txt` (`LE#/LE#.txt`).
 */
function elegirEntradaConDatos(entradas: readonly EntradaCentral[]): EntradaCentral {
  const conDatos = entradas.filter((e) => e.clase === "datos");
  if (conDatos.length !== 1) throw invalido();
  const d = conDatos[0] as EntradaCentral;
  const carpeta = carpetaDe(d.nombre);
  let carpetaDeclarada = false;
  for (const e of entradas) {
    if (e.clase === "directorio") {
      if (e.nombre !== carpeta) throw invalido();
      carpetaDeclarada = true;
    } else if (carpetaDe(e.nombre) !== carpeta) {
      throw invalido();
    }
  }
  if (carpeta !== "" && !carpetaDeclarada) {
    const archivo = d.nombre.slice(carpeta.length);
    if (carpeta.slice(0, -1) !== archivo.slice(0, -".txt".length)) throw invalido();
  }
  return d;
}

/**
 * Recorre las cabeceras locales en el orden del directorio central: cada una empieza donde termina la anterior (la
 * primera en `inicio`) y la última termina justo en el directorio central. Devuelve el cuerpo de la entrada con datos.
 */
function recorrerCabecerasLocales(
  zip: Uint8Array,
  dv: DataView,
  entradas: readonly EntradaCentral[],
  inicio: number,
  inicioCentral: number,
): Uint8Array {
  let cursor = inicio;
  let datos: Uint8Array | undefined;
  for (const e of entradas) {
    if (e.inicioLocal !== cursor) throw invalido();
    const { cuerpo, fin } = leerCabeceraLocal(zip, dv, e, inicioCentral);
    if (e.clase === "datos") datos = cuerpo;
    cursor = fin;
  }
  if (cursor !== inicioCentral || datos === undefined) throw invalido();
  return datos;
}

/**
 * Cabecera local idéntica a la central: firma, nombre, método, CRC y tamaños, sin cifrar, sin ZIP64. Con descriptor de
 * datos (bit 3, solo la entrada con datos): la local lleva ceros o lo mismo que la central, y el descriptor firmado que
 * sigue al cuerpo coincide con la central. Devuelve el cuerpo y dónde termina la entrada.
 */
function leerCabeceraLocal(
  zip: Uint8Array,
  dv: DataView,
  e: EntradaCentral,
  inicioCentral: number,
): { cuerpo: Uint8Array; fin: number } {
  const o = e.inicioLocal;
  if (o + LARGO_LOCAL > inicioCentral || dv.getUint32(o, true) !== FIRMA_LOCAL) throw invalido();
  const banderas = dv.getUint16(o + 6, true);
  const metodo = dv.getUint16(o + 8, true);
  const crc = dv.getUint32(o + 14, true);
  const comprimido = dv.getUint32(o + 18, true);
  const descomprimido = dv.getUint32(o + 22, true);
  const largoNombre = dv.getUint16(o + 26, true);
  const largoExtra = dv.getUint16(o + 28, true);
  if ((banderas & BANDERAS_CIFRADO) !== 0 || metodo !== e.metodo || largoNombre !== e.nombreBytes.length) throw invalido();
  if (comprimido === TAMANO_ZIP64 || descomprimido === TAMANO_ZIP64) throw invalido();
  const inicioCuerpo = o + LARGO_LOCAL + largoNombre + largoExtra;
  if (inicioCuerpo > inicioCentral) throw invalido();
  const nombreLocal = zip.subarray(o + LARGO_LOCAL, o + LARGO_LOCAL + largoNombre);
  for (let i = 0; i < largoNombre; i += 1) if (nombreLocal[i] !== e.nombreBytes[i]) throw invalido();
  if (tieneExtraZip64(dv, o + LARGO_LOCAL + largoNombre, largoExtra)) throw invalido();

  const conDescriptor = (banderas & BANDERA_DESCRIPTOR) !== 0;
  if (conDescriptor !== ((e.banderas & BANDERA_DESCRIPTOR) !== 0)) throw invalido();
  const igualCentral = crc === e.crc && comprimido === e.comprimido && descomprimido === e.descomprimido;
  if (conDescriptor) {
    // Las ignoradas no pueden diferir su CRC ni sus tamaños.
    if (e.clase !== "datos") throw invalido();
    if (!igualCentral && (crc !== 0 || comprimido !== 0 || descomprimido !== 0)) throw invalido();
  } else if (!igualCentral) {
    throw invalido();
  }
  const finCuerpo = inicioCuerpo + e.comprimido;
  const fin = conDescriptor ? finCuerpo + LARGO_DESCRIPTOR : finCuerpo;
  if (fin > inicioCentral) throw invalido();
  if (conDescriptor) {
    const d = finCuerpo;
    if (
      dv.getUint32(d, true) !== FIRMA_MARCA ||
      dv.getUint32(d + 4, true) !== e.crc ||
      dv.getUint32(d + 8, true) !== e.comprimido ||
      dv.getUint32(d + 12, true) !== e.descomprimido
    ) {
      throw invalido();
    }
  }
  return { cuerpo: zip.subarray(inicioCuerpo, finCuerpo), fin };
}

function copiarStored(datos: Uint8Array, e: EntradaCentral): Uint8Array {
  if (e.comprimido !== e.descomprimido) throw invalido();
  return datos.slice();
}

/**
 * Deflate acotado: lo producido nunca pasa de lo declarado, del tope ni de la razón máxima (el motor corta al
 * excederlo); el flujo debe terminar (bloque final) consumiendo EXACTAMENTE los bytes comprimidos declarados y producir
 * exactamente lo declarado. Así la razón 200:1 se mide sobre lo realmente consumido.
 */
function inflar(datos: Uint8Array, e: EntradaCentral): Uint8Array {
  if (datos.length === 0) throw invalido();
  const limite = Math.min(e.descomprimido, e.tope, RAZON_MAX_ZIP * datos.length);
  let salida: Buffer;
  let consumidos: number;
  try {
    const r = inflateRawSync(datos, { info: true, maxOutputLength: Math.max(1, limite), chunkSize: TROZO_INFLATE }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    salida = r.buffer;
    consumidos = r.engine.bytesWritten;
  } catch {
    // Excedido, flujo corrupto o truncado: el mismo error fijo (la causa no se adjunta).
    throw invalido();
  }
  if (consumidos !== datos.length || salida.length !== e.descomprimido || salida.length > limite) throw invalido();
  // Una salida chica puede vivir en el pool compartido de `Buffer`: se copia para no exponer bytes ajenos.
  const propio = salida.byteOffset === 0 && salida.byteLength === salida.buffer.byteLength;
  return propio ? new Uint8Array(salida.buffer, 0, salida.length) : new Uint8Array(salida);
}
