// Descompresión defensiva de un `.zip` en memoria (spec 007b, D7; plan: Decisiones "Lector propio mínimo").
// Pura: sin disco, sin red, sin logs. Todo tope se comprueba antes de reservar memoria: número de entradas,
// tamaño declarado (por entrada y total) y tamaño real acumulado mientras se descomprime por trozos.
import { Inflate } from "fflate";
import { ErrorArchivo, LIMITES } from "./tipos.js";

/** Un `.xlsx` real trae decenas de entradas; miles son un ataque (o un archivo que no es una planilla). */
export const MAX_ENTRADAS = 500;
/** Trozo de entrada comprimida por paso: acota lo que un solo paso puede expandir (~1.000:1 en DEFLATE). */
const TROZO = 1024;

const FIRMA_FIN = 0x06054b50;
const FIRMA_CENTRAL = 0x02014b50;
const FIRMA_LOCAL = 0x04034b50;

interface Entrada {
  nombre: string;
  metodo: number;
  comprimido: number;
  declarado: number;
  offsetLocal: number;
}

const invalido = (): never => {
  throw new ErrorArchivo("archivo_invalido");
};

/** Rutas aceptadas: relativas, con `/`, sin `..`, `\`, `:`, controles ni segmentos vacíos. */
function rutaSegura(nombre: string): boolean {
  if (nombre.length === 0 || nombre.length > 260) return false;
  if (/[\\:\u0000-\u001f\u007f]/.test(nombre)) return false;
  if (nombre.startsWith("/")) return false;
  const segmentos = nombre.split("/");
  // Un directorio termina en "/": el último segmento vacío es válido solo en ese caso.
  return segmentos.every(
    (s, i) =>
      s !== ".." && s !== "." && (s !== "" || i === segmentos.length - 1),
  );
}

function leerDirectorio(datos: Uint8Array, dv: DataView): Entrada[] {
  // Fin del directorio central: últimos 22 B + comentario de hasta 65.535 B.
  const desde = Math.max(0, datos.length - 22 - 0xffff);
  let fin = -1;
  for (let i = datos.length - 22; i >= desde; i--) {
    if (dv.getUint32(i, true) === FIRMA_FIN) {
      fin = i;
      break;
    }
  }
  if (fin < 0) invalido();
  const total = dv.getUint16(fin + 10, true);
  const tamano = dv.getUint32(fin + 12, true);
  const offset = dv.getUint32(fin + 16, true);
  // ZIP64 y multivolumen no tienen cabida en una planilla de 2 MB.
  if (
    total === 0xffff ||
    offset === 0xffffffff ||
    dv.getUint16(fin + 4, true) !== 0
  )
    invalido();
  if (total === 0 || total > MAX_ENTRADAS) invalido();
  if (offset + tamano > fin) invalido();

  const decodificador = new TextDecoder("utf-8", { fatal: true });
  const entradas: Entrada[] = [];
  const nombres = new Set<string>();
  let declaradoTotal = 0;
  let p = offset;
  for (let k = 0; k < total; k++) {
    if (p + 46 > fin || dv.getUint32(p, true) !== FIRMA_CENTRAL) invalido();
    const banderas = dv.getUint16(p + 8, true);
    const metodo = dv.getUint16(p + 10, true);
    const comprimido = dv.getUint32(p + 20, true);
    const declarado = dv.getUint32(p + 24, true);
    const largoNombre = dv.getUint16(p + 28, true);
    const largoExtra = dv.getUint16(p + 30, true);
    const largoComentario = dv.getUint16(p + 32, true);
    const offsetLocal = dv.getUint32(p + 42, true);
    if (p + 46 + largoNombre > fin) invalido();
    let nombre = "";
    try {
      nombre = decodificador.decode(
        datos.subarray(p + 46, p + 46 + largoNombre),
      );
    } catch {
      invalido();
    }
    if ((banderas & 0x1) !== 0) invalido(); // cifrada
    if (metodo !== 0 && metodo !== 8) invalido();
    if (!rutaSegura(nombre) || nombres.has(nombre)) invalido();
    if (declarado > LIMITES.maxDescomprimido) invalido();
    declaradoTotal += declarado;
    if (declaradoTotal > LIMITES.maxDescomprimido) invalido();
    if (metodo === 0 && comprimido !== declarado) invalido();
    nombres.add(nombre);
    entradas.push({ nombre, metodo, comprimido, declarado, offsetLocal });
    p += 46 + largoNombre + largoExtra + largoComentario;
  }
  return entradas;
}

/** Descomprime una entrada sin superar ni su tamaño declarado ni lo que queda del tope total. */
function descomprimir(
  datos: Uint8Array,
  dv: DataView,
  e: Entrada,
  restante: number,
): Uint8Array {
  const o = e.offsetLocal;
  if (o + 30 > datos.length || dv.getUint32(o, true) !== FIRMA_LOCAL)
    invalido();
  const inicio =
    o + 30 + dv.getUint16(o + 26, true) + dv.getUint16(o + 28, true);
  if (inicio + e.comprimido > datos.length) invalido();
  const cuerpo = datos.subarray(inicio, inicio + e.comprimido);
  const tope = Math.min(e.declarado, restante);
  if (e.metodo === 0) {
    if (cuerpo.length > tope) invalido();
    return cuerpo;
  }

  // Se reserva solo lo declarado (ya acotado); un byte más de lo declarado aborta.
  const salida = new Uint8Array(tope);
  let escritos = 0;
  let excedido = false;
  let terminado = false;
  const inflador = new Inflate((trozo, final) => {
    if (escritos + trozo.length > tope) {
      excedido = true;
      throw new ErrorArchivo("archivo_invalido");
    }
    salida.set(trozo, escritos);
    escritos += trozo.length;
    if (final) terminado = true;
  });
  try {
    for (let i = 0; i < cuerpo.length; i += TROZO) {
      const fin = Math.min(i + TROZO, cuerpo.length);
      inflador.push(cuerpo.subarray(i, fin), fin === cuerpo.length);
    }
    if (cuerpo.length === 0) inflador.push(new Uint8Array(0), true);
  } catch {
    invalido();
  }
  if (excedido || !terminado || escritos !== e.declarado) invalido();
  return salida;
}

/**
 * Abre el `.zip` y devuelve las entradas que cumplen `conservar` (las demás se descomprimen solo para contar
 * su tamaño real y se descartan). Lanza `ErrorArchivo("archivo_invalido")` ante cualquier anomalía.
 */
export function abrirZip(
  datos: Uint8Array,
  conservar: (nombre: string) => boolean,
): Map<string, Uint8Array> {
  if (datos.length < 22) invalido();
  const dv = new DataView(datos.buffer, datos.byteOffset, datos.byteLength);
  const entradas = leerDirectorio(datos, dv);
  const resultado = new Map<string, Uint8Array>();
  let real = 0;
  for (const e of entradas) {
    const bytes = descomprimir(datos, dv, e, LIMITES.maxDescomprimido - real);
    real += bytes.length;
    if (real > LIMITES.maxDescomprimido) invalido();
    if (conservar(e.nombre)) resultado.set(e.nombre, bytes);
  }
  return resultado;
}
