/**
 * Lectura segura del ZIP que devuelve el SIRE (plan 041, «zip-seguro.ts»; spec CA-10). Síncrona y sin IO.
 *
 * No se confía en nada del ZIP: se exige exactamente UNA entrada `.txt` de nombre plano, sin cifrar, con método
 * «stored» o «deflate», y se descomprime por streaming (`fflate` `Inflate`, en trozos pequeños) contando los bytes
 * reales: el tamaño declarado en la cabecera solo sirve para rechazar antes y como tope de lo que se acepta producir.
 * Memoria: el destino se reserva una sola vez con el tamaño declarado ya acotado (≤ 64 MiB y ≤ 200 × comprimido) y
 * cada trozo de entrada produce como mucho ~4 MiB, así que una bomba de 1 GiB nunca llega a la memoria.
 *
 * Todo rechazo es `ErrorPortalSire("zip_invalido")` con mensaje fijo: ni nombres de entrada ni bytes.
 */
import { crc32 } from "node:zlib";
import { Inflate } from "fflate";
import { ErrorPortalSire } from "../errores.js";

const MIB = 1024 * 1024;
/** Tope de bytes del ZIP recibido (CA-10). */
export const TOPE_ZIP_COMPRIMIDO = 32 * MIB;
/** Tope de bytes descomprimidos (CA-10); se cuenta al descomprimir. */
export const TOPE_ZIP_DESCOMPRIMIDO = 64 * MIB;
/** Razón máxima descomprimido / comprimido (CA-10). */
export const RAZON_MAX_ZIP = 200;

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

const decodificador = new TextDecoder("utf-8", { fatal: true });

/** Señal interna para cortar la descompresión desde `ondata`; nunca sale de este módulo. */
class Excedido extends Error {}

function invalido(): ErrorPortalSire {
  return new ErrorPortalSire("zip_invalido");
}

interface EntradaCentral {
  nombre: Uint8Array;
  metodo: number;
  crc: number;
  comprimido: number;
  descomprimido: number;
  inicioLocal: number;
}

/** Devuelve los bytes del único TXT del ZIP o lanza `ErrorPortalSire("zip_invalido")`. */
export function extraerTxtDeZip(zip: Uint8Array): Uint8Array {
  if (!(zip instanceof Uint8Array) || zip.length < LARGO_FIN || zip.length > TOPE_ZIP_COMPRIMIDO) throw invalido();
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const finCentral = buscarFinDirectorio(zip, dv);
  const entrada = leerEntradaCentral(zip, dv, finCentral);
  validarNombre(entrada.nombre);
  const datos = ubicarDatos(zip, dv, entrada, finCentral.inicioCentral);
  const salida =
    entrada.metodo === METODO_STORED ? copiarStored(datos, entrada) : inflar(datos, entrada);
  if ((crc32(salida) >>> 0) !== entrada.crc) throw invalido();
  return salida;
}

interface FinDirectorio {
  inicioCentral: number;
  largoCentral: number;
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
    if (disco !== 0 || discoCentral !== 0 || enDisco !== 1 || total !== 1) throw invalido();
    if (inicioCentral + largoCentral > i) throw invalido();
    return { inicioCentral, largoCentral };
  }
  throw invalido();
}

function leerEntradaCentral(zip: Uint8Array, dv: DataView, fin: FinDirectorio): EntradaCentral {
  const o = fin.inicioCentral;
  if (fin.largoCentral < LARGO_CENTRAL || dv.getUint32(o, true) !== FIRMA_CENTRAL) throw invalido();
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
  // Una sola entrada: el directorio central es exactamente su registro.
  if (LARGO_CENTRAL + largoNombre + largoExtra + largoComentario !== fin.largoCentral) throw invalido();
  if ((banderas & BANDERAS_CIFRADO) !== 0 || discoInicio !== 0) throw invalido();
  if (metodo !== METODO_STORED && metodo !== METODO_DEFLATE) throw invalido();
  // ZIP64 (0xFFFFFFFF) no cabe en los topes; el declarado se acota antes de reservar nada.
  if (descomprimido > TOPE_ZIP_DESCOMPRIMIDO || comprimido >= zip.length) throw invalido();
  if (descomprimido > RAZON_MAX_ZIP * Math.max(comprimido, 1)) throw invalido();
  const nombre = zip.subarray(o + LARGO_CENTRAL, o + LARGO_CENTRAL + largoNombre);
  return { nombre, metodo, crc, comprimido, descomprimido, inicioLocal };
}

/** Nombre plano `*.txt`: UTF-8 válido, sin rutas, unidades, «..» ni caracteres de control. */
function validarNombre(bytes: Uint8Array): void {
  if (bytes.length === 0 || bytes.length > MAX_LARGO_NOMBRE) throw invalido();
  let nombre: string;
  try {
    nombre = decodificador.decode(bytes);
  } catch {
    throw invalido();
  }
  if (/[\u0000-\u001f\u007f/\\:]/.test(nombre) || nombre.includes("..")) throw invalido();
  if (!/^[^.].*\.txt$/i.test(nombre)) throw invalido();
}

/** Cabecera local coherente con la central (mismo nombre y método, sin cifrar) y datos dentro del archivo. */
function ubicarDatos(zip: Uint8Array, dv: DataView, e: EntradaCentral, inicioCentral: number): Uint8Array {
  const o = e.inicioLocal;
  if (o + LARGO_LOCAL > inicioCentral || dv.getUint32(o, true) !== FIRMA_LOCAL) throw invalido();
  const banderas = dv.getUint16(o + 6, true);
  const metodo = dv.getUint16(o + 8, true);
  const largoNombre = dv.getUint16(o + 26, true);
  const largoExtra = dv.getUint16(o + 28, true);
  if ((banderas & BANDERAS_CIFRADO) !== 0 || metodo !== e.metodo || largoNombre !== e.nombre.length) throw invalido();
  const nombreLocal = zip.subarray(o + LARGO_LOCAL, o + LARGO_LOCAL + largoNombre);
  for (let i = 0; i < largoNombre; i += 1) if (nombreLocal[i] !== e.nombre[i]) throw invalido();
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
  const limite = Math.min(e.descomprimido, TOPE_ZIP_DESCOMPRIMIDO, RAZON_MAX_ZIP * datos.length);
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
