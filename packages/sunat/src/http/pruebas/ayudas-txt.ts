/**
 * Ayudas de las pruebas de ZIP y TXT del SIRE (spec 041, T2). Solo pruebas. Editan los TXT sintéticos de
 * `fixtures/sire/http` por NOMBRE de columna; nunca traen datos de un archivo real.
 */
import { randomBytes } from "node:crypto";
import { deflateRawSync, constants, crc32 } from "node:zlib";
import { zipSync } from "fflate";

export interface TablaTxt {
  bom: boolean;
  /** `lineas[0]` es el encabezado; cada línea son sus celdas separadas por `|` (con el `|` final, una celda vacía de más). */
  lineas: string[][];
}

export function leerTabla(bytes: Uint8Array): TablaTxt {
  let t = Buffer.from(bytes).toString("utf8");
  const bom = t.startsWith("﻿");
  if (bom) t = t.slice(1);
  const lineas = t.split("\n");
  if (lineas[lineas.length - 1] === "") lineas.pop();
  return { bom, lineas: lineas.map((l) => l.split("|")) };
}

export function aBytes(t: TablaTxt): Uint8Array {
  const texto = t.lineas.map((c) => c.join("|")).join("\n") + "\n";
  return new Uint8Array(Buffer.from((t.bom ? "﻿" : "") + texto, "utf8"));
}

/** Índice de la primera columna con ese nombre EXACTO de encabezado. */
export function indiceColumna(t: TablaTxt, nombre: string): number {
  const i = (t.lineas[0] ?? []).indexOf(nombre);
  if (i < 0) throw new Error(`la columna ${nombre} no está en el fixture`);
  return i;
}

/** Copia el TXT cambiando el valor de una celda (`fila` cuenta desde 1 = primera fila de datos). */
export function conCelda(bytes: Uint8Array, fila: number, columna: string, valor: string): Uint8Array {
  const t = leerTabla(bytes);
  const i = indiceColumna(t, columna);
  const l = t.lineas[fila];
  if (l === undefined) throw new Error(`no hay fila ${fila}`);
  l[i] = valor;
  return aBytes(t);
}

/** Copia el TXT sin una columna (en el encabezado y en todas las filas). */
export function sinColumna(bytes: Uint8Array, columna: string): Uint8Array {
  const t = leerTabla(bytes);
  const i = indiceColumna(t, columna);
  for (const l of t.lineas) l.splice(i, 1);
  return aBytes(t);
}

/** Copia el TXT cambiando solo el encabezado. */
export function conEncabezado(bytes: Uint8Array, cambiar: (celdas: string[]) => string[]): Uint8Array {
  const t = leerTabla(bytes);
  t.lineas[0] = cambiar([...(t.lineas[0] ?? [])]);
  return aBytes(t);
}

/** Copia el TXT dejando solo las filas de datos indicadas (desde 1). */
export function soloFilas(bytes: Uint8Array, filas: readonly number[]): Uint8Array {
  const t = leerTabla(bytes);
  const cab = t.lineas[0] ?? [];
  t.lineas = [cab, ...filas.map((f) => t.lineas[f] ?? [])];
  return aBytes(t);
}

export function utf8(texto: string): Uint8Array {
  return new Uint8Array(Buffer.from(texto, "utf8"));
}

// ── Datos para topes de ZIP ─────────────────────────────────────────────────────────────────────────────────
export const MIB = 1024 * 1024;

/**
 * `total` bytes: en cada bloque de `bloque` bytes, 1 KiB aleatorio y el resto ceros. La razón de compresión sale
 * ≈ `bloque / 1,1 KiB`; con un bloque de 64 KiB queda muy por debajo de 200:1.
 */
export function datosCompresibles(total: number, bloque = 64 * 1024): Uint8Array {
  const d = new Uint8Array(total);
  for (let o = 0; o < total; o += bloque) d.set(randomBytes(Math.min(1024, total - o)), o);
  return d;
}

/** Pico de memoria residente del proceso en MiB (`maxRSS`, de por vida del proceso). */
export function picoRssMiB(): number {
  return process.resourceUsage().maxRSS / 1024;
}

// ── ZIP «crudo»: bomba deflate de 1 GiB en ~1 MiB, sin armarla en memoria ──────────────────────────────────
export interface BombaDeflate {
  /** Flujo deflate crudo (bloques sync-flush de 1 MiB de ceros + bloque final vacío). */
  deflate: Buffer;
  /** Bytes que producirá al descomprimirse. */
  tamano: number;
  crc: number;
}

/** `mib` MiB de ceros comprimidos en bloques independientes (razón ≈ 1000:1). */
export function bombaDeflate(mib: number): BombaDeflate {
  const ceros = Buffer.alloc(MIB);
  const bloque = deflateRawSync(ceros, { level: 9, finishFlush: constants.Z_SYNC_FLUSH });
  const partes: Buffer[] = [];
  let crc = 0;
  for (let i = 0; i < mib; i += 1) {
    partes.push(bloque);
    crc = crc32(ceros, crc);
  }
  partes.push(Buffer.from([0x03, 0x00])); // bloque final vacío (BFINAL=1, BTYPE=01, fin de bloque)
  return { deflate: Buffer.concat(partes), tamano: mib * MIB, crc };
}

/**
 * ZIP de una sola entrada con método 8 (deflate). `tamanoDeclarado` permite MENTIR en la cabecera sobre el tamaño
 * descomprimido (el adaptador no debe confiar en él).
 */
export function zipCrudo(nombre: string, b: BombaDeflate, tamanoDeclarado: number = b.tamano): Uint8Array {
  const n = Buffer.from(nombre, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(b.crc >>> 0, 14);
  local.writeUInt32LE(b.deflate.length, 18);
  local.writeUInt32LE(tamanoDeclarado, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(b.crc >>> 0, 16);
  central.writeUInt32LE(b.deflate.length, 20);
  central.writeUInt32LE(tamanoDeclarado, 24);
  central.writeUInt16LE(n.length, 28);
  const inicioCentral = local.length + n.length + b.deflate.length;
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(1, 8);
  fin.writeUInt16LE(1, 10);
  fin.writeUInt32LE(central.length + n.length, 12);
  fin.writeUInt32LE(inicioCentral, 16);
  return new Uint8Array(Buffer.concat([local, n, b.deflate, central, n, fin]));
}

/** Marca como «cifradas» (bit 0 de las banderas) la entrada del ZIP, en la cabecera local y en la central. */
export function marcarCifrado(zip: Uint8Array): Uint8Array {
  const c = new Uint8Array(zip);
  const dv = new DataView(c.buffer);
  for (let i = 0; i + 4 <= c.length; i += 1) {
    const sig = dv.getUint32(i, true);
    if (sig === 0x04034b50) dv.setUint16(i + 6, dv.getUint16(i + 6, true) | 1, true);
    if (sig === 0x02014b50) dv.setUint16(i + 8, dv.getUint16(i + 8, true) | 1, true);
  }
  return c;
}

/** ZIP normal de una sola entrada (nivel 6). */
export function zipSyncDe(nombre: string, contenido: Uint8Array): Uint8Array {
  return zipSync({ [nombre]: [contenido, { level: 6 }] });
}
