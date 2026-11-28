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
}

export interface OpcionesZipManual {
  /** Sobrescribe el CRC declarado (en la central y la local) de todas las entradas. */
  crc?: number;
}

/** ZIP de las entradas dadas, en ese orden, con cabeceras locales, directorio central y fin de directorio. */
export function zipManual(entradas: readonly EntradaZipManual[], opciones: OpcionesZipManual = {}): Uint8Array {
  const cuerpo: Buffer[] = [];
  const central: Buffer[] = [];
  let desplazamiento = 0;
  for (const e of entradas) {
    const nombre = Buffer.from(e.nombre, "utf8");
    const metodo = e.metodo ?? 8;
    const comprimido = Buffer.from(metodo === 8 ? deflateSync(e.datos) : e.datos);
    const crc = opciones.crc ?? crc32(e.datos) >>> 0;
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
    local.writeUInt32LE(conDescriptor ? 0 : e.datos.length, 22);
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
      d.writeUInt32LE(e.datos.length, 12);
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
    c.writeUInt32LE(e.datos.length, 24);
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

/** Cuerpo que NO es un ZIP (como una página de error que llega con 200 y `application/zip`). */
export function noEsZip(): Uint8Array {
  return Buffer.from(`<html><body>${ZIP_RARO.contenido}</body></html>`, "utf8");
}
