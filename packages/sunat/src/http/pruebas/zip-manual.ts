/**
 * Armado a mano de ZIP con rarezas que `zipSync` de fflate no produce (spec 041, CA-10/CA-13). Solo pruebas.
 * Sirve para el servidor falso («archivo raro») y para las pruebas del diagnóstico de la estructura de un ZIP rechazado.
 */
import { crc32 } from "node:zlib";
import { deflateSync } from "fflate";

export interface EntradaZipManual {
  nombre: string;
  datos: Uint8Array;
  /** 8 (deflate) por defecto; 0 = stored. */
  metodo?: 0 | 8;
  /** Bit 3: CRC y tamaños van DESPUÉS de los datos (la cabecera local los lleva en 0). */
  descriptor?: boolean;
  /** Banderas extra a sumar a las generales (p. ej. 0x0001 para marcarla «cifrada» sin cifrar nada). */
  banderasExtra?: number;
  /** Sobrescribe el CRC declarado SOLO de esta entrada (la local y la central). */
  crc?: number;
  /** Nivel de deflate (por defecto el de fflate, 6). */
  nivel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  /**
   * Flujo deflate ya armado (p. ej. una bomba): se escribe tal cual, con su CRC y su tamaño; `datos` se ignora. Con
   * `tamanoDeclarado` la cabecera MIENTE sobre el tamaño descomprimido.
   */
  crudo?: { deflate: Uint8Array; tamano: number; crc: number; tamanoDeclarado?: number };
}

export interface OpcionesZipManual {
  /** Sobrescribe el CRC declarado (en la central y la local) de todas las entradas. */
  crc?: number;
  /** Antepone la firma `PK\x07\x08` (marca de ZIP «dividido») que trae el archivo real; los desplazamientos la cuentan. */
  firmaInicio?: boolean;
}

/** ZIP de las entradas dadas, en ese orden, con cabeceras locales, directorio central y fin de directorio. */
export function zipManual(entradas: readonly EntradaZipManual[], opciones: OpcionesZipManual = {}): Uint8Array {
  const cuerpo: Buffer[] = [];
  const central: Buffer[] = [];
  const marca = opciones.firmaInicio === true ? Buffer.from([0x50, 0x4b, 0x07, 0x08]) : Buffer.alloc(0);
  if (marca.length > 0) cuerpo.push(marca);
  let desplazamiento = marca.length;
  for (const e of entradas) {
    const nombre = Buffer.from(e.nombre, "utf8");
    const metodo = e.crudo !== undefined ? 8 : (e.metodo ?? 8);
    const comprimido =
      e.crudo !== undefined
        ? Buffer.from(e.crudo.deflate)
        : Buffer.from(metodo === 8 ? deflateSync(e.datos, e.nivel === undefined ? undefined : { level: e.nivel }) : e.datos);
    const tamano = e.crudo !== undefined ? (e.crudo.tamanoDeclarado ?? e.crudo.tamano) : e.datos.length;
    const crc = opciones.crc ?? e.crc ?? (e.crudo !== undefined ? e.crudo.crc >>> 0 : crc32(e.datos) >>> 0);
    const conDescriptor = e.descriptor === true;
    const banderas = 0x0800 | (conDescriptor ? 0x0008 : 0) | (e.banderasExtra ?? 0);

    const local = Buffer.alloc(30 + nombre.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(banderas, 6);
    local.writeUInt16LE(metodo, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(conDescriptor ? 0 : crc, 14);
    local.writeUInt32LE(conDescriptor ? 0 : comprimido.length, 18);
    local.writeUInt32LE(conDescriptor ? 0 : tamano, 22);
    local.writeUInt16LE(nombre.length, 26);
    local.writeUInt16LE(0, 28);
    nombre.copy(local, 30);
    const inicioLocal = desplazamiento;
    cuerpo.push(local, comprimido);
    desplazamiento += local.length + comprimido.length;
    if (conDescriptor) {
      const d = Buffer.alloc(16);
      d.writeUInt32LE(0x08074b50, 0);
      d.writeUInt32LE(crc, 4);
      d.writeUInt32LE(comprimido.length, 8);
      d.writeUInt32LE(tamano, 12);
      cuerpo.push(d);
      desplazamiento += d.length;
    }

    const c = Buffer.alloc(46 + nombre.length);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(banderas, 8);
    c.writeUInt16LE(metodo, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(0x0021, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comprimido.length, 20);
    c.writeUInt32LE(tamano, 24);
    c.writeUInt16LE(nombre.length, 28);
    c.writeUInt32LE(inicioLocal, 42);
    nombre.copy(c, 46);
    central.push(c);
  }
  const directorio = Buffer.concat(central);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(entradas.length, 8);
  fin.writeUInt16LE(entradas.length, 10);
  fin.writeUInt32LE(directorio.length, 12);
  fin.writeUInt32LE(desplazamiento, 16);
  return new Uint8Array(Buffer.concat([...cuerpo, directorio, fin]));
}

/**
 * Contenido y nombres CANARIO del ZIP «raro» del servidor falso: la salida de la prueba no puede repetir ni el contenido
 * del TXT ni ninguna secuencia de 4+ dígitos de los nombres.
 */
export const ZIP_RARO = {
  contenido: "CANARIO-CONTENIDO-TXT-NO-IMPRIMIR|98765432101|CANARIO-FILA",
  /** Secuencias de 4+ dígitos que traen los nombres de las entradas (el RUC y dos fechas). */
  digitosEnNombres: ["20700000002", "20261101", "987654"],
  nombres: ["20700000002/20700000002-registro-pen-202610.txt", "LEEME-20261101-987654.txt"],
} as const;

/** 2 entradas, una con ruta, las dos con descriptor de datos (deflate la primera y stored la segunda): el lector la rechaza. */
export function zipRaro(): Uint8Array {
  const txt = (n: number): Uint8Array => Buffer.from(`${ZIP_RARO.contenido}\n`.repeat(n), "utf8");
  return zipManual([
    { nombre: ZIP_RARO.nombres[0], datos: txt(20), metodo: 8, descriptor: true },
    { nombre: ZIP_RARO.nombres[1], datos: txt(2), metodo: 0, descriptor: true },
  ]);
}

/** Opciones de `zipRegistroReal`. */
export interface OpcionesZipRegistro {
  /** Antepone `PK\x07\x08` (por defecto sí, como el archivo real). */
  firmaInicio?: boolean;
  /** Nivel de deflate del archivo con datos. */
  nivel?: EntradaZipManual["nivel"];
  /** Flujo deflate crudo (bomba) en lugar de `contenido`; ver `EntradaZipManual.crudo`. */
  crudo?: EntradaZipManual["crudo"];
}

/**
 * ZIP con la estructura REAL del registro presentado (servicio 5.51 → 5.32), observada en la corrida de contrato: UNA
 * carpeta `base/`, y en el directorio central, EN ESTE ORDEN: (1) `base/base.txt` con datos (deflate); (2) OTRA entrada
 * `base/base.txt` vacía (stored, tamaños 0, CRC 0); (3) la entrada de directorio `base/` (stored, tamaños 0). Sin cifrado,
 * sin ZIP64, sin descriptor de datos, banderas UTF-8, `PK\x07\x08` al inicio y EOCD al final.
 */
export function zipRegistroReal(base: string, contenido: Uint8Array, o: OpcionesZipRegistro = {}): Uint8Array {
  const vacio = new Uint8Array(0);
  return zipManual(
    [
      { nombre: `${base}/${base}.txt`, datos: contenido, metodo: 8, nivel: o.nivel, crudo: o.crudo },
      { nombre: `${base}/${base}.txt`, datos: vacio, metodo: 0 },
      { nombre: `${base}/`, datos: vacio, metodo: 0 },
    ],
    { firmaInicio: o.firmaInicio ?? true },
  );
}

/** Cuerpo que NO es un ZIP (como una página de error que llega con 200 y `application/zip`). */
export function noEsZip(): Uint8Array {
  return Buffer.from(`<html><body>${ZIP_RARO.contenido}</body></html>`, "utf8");
}
