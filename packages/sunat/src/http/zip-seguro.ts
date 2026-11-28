/**
 * Lectura segura del ZIP que devuelve el SIRE (plan 041, «zip-seguro.ts» y «Decisiones de la ronda 3 · ZIP del registro»;
 * spec CA-10, CA-13). Síncrona y sin IO.
 *
 * No se confía en nada del ZIP. El directorio central trae a lo sumo 8 entradas; las de directorio (`X/`, método 0,
 * tamaños 0) y las de archivo vacías (método 0, tamaños 0, CRC 0) se ignoran, pero el NOMBRE de todas se valida (sin
 * `..`, rutas absolutas, `\`, `:`, NUL ni controles, a lo sumo una carpeta, ≤ 255 bytes, UTF-8 válido) y todas viven en
 * la carpeta del archivo con datos. Debe haber exactamente UNA entrada con datos, `.txt`, sin cifrar, con método «stored»
 * o «deflate»; si está en una carpeta, la carpeta figura como entrada de directorio o se llama igual que el archivo sin
 * `.txt` (estructura real `LE#/LE#.txt`). Se descomprime por streaming (`fflate` `Inflate`, en trozos pequeños) contando
 * los bytes reales: el tamaño declarado solo sirve para rechazar antes y como tope de lo que se acepta producir.
 * Memoria: el destino se reserva una sola vez con el tamaño declarado ya acotado (≤ 64 MiB y ≤ 200 × comprimido) y
 * cada trozo de entrada produce como mucho ~4 MiB, así que una bomba de 1 GiB nunca llega a la memoria.
 *
 * Los nombres solo se leen para validarlos: nunca se usan como ruta ni se escribe nada a disco.
 * Todo rechazo es `ErrorPortalSire("zip_invalido")` con mensaje fijo: ni nombres de entrada ni bytes.
 */
import { crc32 } from "node:zlib";
import { Inflate } from "fflate";
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

/** Entrada comprimida que se entrega a `Inflate` en cada paso: deflate no pasa de ~1032:1, o sea ≤ ~4 MiB por paso. */
const TROZO_INFLATE = 4 * 1024;

const FIRMA_LOCAL = 0x04034b50;
const FIRMA_CENTRAL = 0x02014b50;
const FIRMA_FIN = 0x06054b50;
const LARGO_FIN = 22;
const LARGO_CENTRAL = 46;
const LARGO_LOCAL = 30;
const MAX_COMENTARIO = 0xffff;
/** Bits de cifrado: 0 (tradicional), 6 (fuerte) y 13 (directorio central cifrado). */
const BANDERAS_CIFRADO = (1 << 0) | (1 << 6) | (1 << 13);
const METODO_STORED = 0;
const METODO_DEFLATE = 8;
const MAX_LARGO_NOMBRE = 255;
/** Id del campo extra ZIP64. */
const EXTRA_ZIP64 = 0x0001;

const decodificador = new TextDecoder("utf-8", { fatal: true });

/** Señal interna para cortar la descompresión desde `ondata`; nunca sale de este módulo. */
class Excedido extends Error {}

function invalido(): ErrorPortalSire {
  return new ErrorPortalSire("zip_invalido");
}

type Clase = "directorio" | "vacia" | "datos";

interface EntradaCentral {
  nombreBytes: Uint8Array;
  /** Nombre ya validado (solo para comparar; nunca se usa como ruta). */
  nombre: string;
  clase: Clase;
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
  const finCentral = buscarFinDirectorio(zip, dv);
  const entradas = leerDirectorioCentral(zip, dv, finCentral, tope);
  const entrada = elegirEntradaConDatos(entradas);
  // Las ignoradas también deben tener cabecera local coherente (mismo nombre y método, sin cifrar, dentro del archivo).
  for (const e of entradas) if (e !== entrada) ubicarDatos(zip, dv, e, finCentral.inicioCentral);
  const datos = ubicarDatos(zip, dv, entrada, finCentral.inicioCentral);
  const salida = entrada.metodo === METODO_STORED ? copiarStored(datos, entrada) : inflar(datos, entrada);
  if ((crc32(salida) >>> 0) !== entrada.crc) throw invalido();
  return salida;
}

interface FinDirectorio {
  inicioCentral: number;
  largoCentral: number;
  total: number;
}

/** Registro de fin del directorio central: debe terminar justo al final del archivo (sin basura ni truncado). */
function buscarFinDirectorio(zip: Uint8Array, dv: DataView): FinDirectorio {
  const ultimo = zip.length - LARGO_FIN;
  const primero = Math.max(0, ultimo - MAX_COMENTARIO);
  for (let i = ultimo; i >= primero; i -= 1) {
    if (dv.getUint32(i, true) !== FIRMA_FIN) continue;
    if (i + LARGO_FIN + dv.getUint16(i + 20, true) !== zip.length) continue;
    const disco = dv.getUint16(i + 4, true);
    const discoCentral = dv.getUint16(i + 6, true);
    const enDisco = dv.getUint16(i + 8, true);
    const total = dv.getUint16(i + 10, true);
    const largoCentral = dv.getUint32(i + 12, true);
    const inicioCentral = dv.getUint32(i + 16, true);
    // 0xFFFF / 0xFFFFFFFF (ZIP64) quedan fuera por el tope de entradas y por el límite del archivo.
    if (disco !== 0 || discoCentral !== 0 || enDisco !== total || total < 1 || total > MAX_ENTRADAS_ZIP) throw invalido();
    if (inicioCentral + largoCentral > i) throw invalido();
    return { inicioCentral, largoCentral, total };
  }
  throw invalido();
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
    entradas.push({ nombreBytes, nombre, clase, metodo, crc, comprimido, descomprimido, inicioLocal, tope });
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

/** UTF-8 válido, 1..255 bytes, sin NUL, controles (C0, DEL, C1), `\` ni `:`. */
function decodificarNombre(bytes: Uint8Array): string {
  if (bytes.length === 0 || bytes.length > MAX_LARGO_NOMBRE) throw invalido();
  let nombre: string;
  try {
    nombre = decodificador.decode(bytes);
  } catch {
    throw invalido();
  }
  if (/[\u0000-\u001f\u007f-\u009f\\:]/.test(nombre) || nombre.includes("..")) throw invalido();
  return nombre;
}

/**
 * Ruta relativa de a lo sumo una carpeta: sin `/` inicial, sin segmentos vacíos ni que empiecen con `.` (cubre `.` y
 * `..`). Directorio: `X/`. Archivo: `nombre` o `X/nombre`.
 */
function validarRuta(nombre: string, clase: Clase): void {
  const ruta = clase === "directorio" ? nombre.slice(0, -1) : nombre;
  const segmentos = ruta.split("/");
  const maxSegmentos = clase === "directorio" ? 1 : 2;
  if (segmentos.length > maxSegmentos) throw invalido();
  for (const s of segmentos) if (s.length === 0 || s.startsWith(".")) throw invalido();
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
  if (!/\.txt$/i.test(d.nombre)) throw invalido();
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

/** Cabecera local coherente con la central (mismo nombre y método, sin cifrar) y datos dentro del archivo. */
function ubicarDatos(zip: Uint8Array, dv: DataView, e: EntradaCentral, inicioCentral: number): Uint8Array {
  const o = e.inicioLocal;
  if (o + LARGO_LOCAL > inicioCentral || dv.getUint32(o, true) !== FIRMA_LOCAL) throw invalido();
  const banderas = dv.getUint16(o + 6, true);
  const metodo = dv.getUint16(o + 8, true);
  const largoNombre = dv.getUint16(o + 26, true);
  const largoExtra = dv.getUint16(o + 28, true);
  if ((banderas & BANDERAS_CIFRADO) !== 0 || metodo !== e.metodo || largoNombre !== e.nombreBytes.length) throw invalido();
  const nombreLocal = zip.subarray(o + LARGO_LOCAL, o + LARGO_LOCAL + largoNombre);
  for (let i = 0; i < largoNombre; i += 1) if (nombreLocal[i] !== e.nombreBytes[i]) throw invalido();
  const inicio = o + LARGO_LOCAL + largoNombre + largoExtra;
  const fin = inicio + e.comprimido;
  if (fin > inicioCentral) throw invalido();
  return zip.subarray(inicio, fin);
}

function copiarStored(datos: Uint8Array, e: EntradaCentral): Uint8Array {
  if (e.comprimido !== e.descomprimido) throw invalido();
  return datos.slice();
}

/**
 * Deflate por trozos: corta en cuanto lo producido supera lo declarado, el tope total o la razón máxima; al final
 * exige que el flujo haya terminado y que lo producido sea exactamente lo declarado.
 */
function inflar(datos: Uint8Array, e: EntradaCentral): Uint8Array {
  if (datos.length === 0) throw invalido();
  const limite = Math.min(e.descomprimido, e.tope, RAZON_MAX_ZIP * datos.length);
  const salida = new Uint8Array(e.descomprimido);
  let escritos = 0;
  let terminado = false;
  const inflador = new Inflate();
  inflador.ondata = (trozo, final) => {
    if (escritos + trozo.length > limite) throw new Excedido();
    salida.set(trozo, escritos);
    escritos += trozo.length;
    if (final) terminado = true;
  };
  try {
    for (let i = 0; i < datos.length; i += TROZO_INFLATE) {
      const fin = Math.min(i + TROZO_INFLATE, datos.length);
      inflador.push(datos.subarray(i, fin), fin === datos.length);
    }
  } catch {
    // Excedido, flujo corrupto o truncado: el mismo error fijo (la causa no se adjunta).
    throw invalido();
  }
  if (!terminado || escritos !== e.descomprimido) throw invalido();
  return salida;
}
