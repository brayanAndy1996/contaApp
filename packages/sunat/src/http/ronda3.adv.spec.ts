/**
 * Spec 041 · T15e · Ronda adversarial 3 (CA-10), ACOTADA a la relajación del lector de ZIP (commit fcdd773):
 * entradas ignoradas (carpeta y archivo vacío), una sola entrada con datos `.txt`, validación de nombres de todas.
 * Cada prueba arma ZIP a mano en memoria (sin disco ni red) y agrupa variantes: la aserción final lista las variantes
 * ACEPTADAS que debían rechazarse, para que el reporte diga exactamente cuál pasa. Todo rechazo debe ser
 * `ErrorPortalSire("zip_invalido")` sin contenido del TXT ni dígitos de los nombres en el error.
 */
import { crc32 } from "node:zlib";
import { deflateSync } from "fflate";
import { describe, expect, it } from "vitest";
import { esperarError, sinSecretos } from "./pruebas/ayudas-http.js";
import { MIB, bombaDeflate, utf8 } from "./pruebas/ayudas-txt.js";
import { extraerTxtDeZip } from "./zip-seguro.js";

const B = "LE20700000002202610";
const ARCHIVO = `${B}/${B}.txt`;
const CANARIO = "CANARIO-R3-NO-IMPRIMIR|98765432101|fila";
const TXT = utf8(`${CANARIO}\n`.repeat(64));
const OCULTO = utf8("OCULTO-CANARIO-R3|98765432101|nunca-se-lee\n".repeat(8));
const FUGAS = ["CANARIO", "98765432101", "20700000002", "202610", "OCULTO"];
const PK0708 = new Uint8Array([0x50, 0x4b, 0x07, 0x08]);
const VACIO = new Uint8Array(0);

// ── Armado de bajo nivel: cada campo de la cabecera local y de la central se puede falsear por separado ─────────────
interface Campos {
  crc: number;
  comp: number;
  desc: number;
}
interface E {
  nombre: string;
  metodo: number;
  /** Bytes que siguen a la cabecera local (ya comprimidos). */
  cuerpo: Uint8Array;
  central: Campos;
  local?: Partial<Campos> & { extra?: Uint8Array; banderas?: number; nombre?: string };
  banderas?: number;
  /** Bytes tras el cuerpo (p. ej. un descriptor de datos). */
  tras?: Uint8Array;
  /** No escribe cabecera local: reutiliza el desplazamiento de la entrada de ese índice. */
  compartirCon?: number;
  /** No escribe cabecera local: el central apunta a este desplazamiento (relativo al inicio del archivo). */
  inicioLocal?: number;
}
interface Op {
  prefijo?: Uint8Array;
  huecoAntesCentral?: Uint8Array;
  /** Bytes tras el directorio central y antes del EOCD (fuera de `largoCentral`). */
  trasCentral?: Uint8Array;
  comentario?: Uint8Array;
  total?: number;
  deltaLargoCentral?: number;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function registroCentral(e: E, inicioLocal: number): Buffer {
  const n = Buffer.from(e.nombre, "utf8");
  const c = Buffer.alloc(46 + n.length);
  c.writeUInt32LE(0x02014b50, 0);
  c.writeUInt16LE(20, 4);
  c.writeUInt16LE(20, 6);
  c.writeUInt16LE(e.banderas ?? 0x0800, 8);
  c.writeUInt16LE(e.metodo, 10);
  c.writeUInt16LE(0x0021, 14);
  c.writeUInt32LE(e.central.crc >>> 0, 16);
  c.writeUInt32LE(e.central.comp, 20);
  c.writeUInt32LE(e.central.desc, 24);
  c.writeUInt16LE(n.length, 28);
  c.writeUInt32LE(inicioLocal, 42);
  n.copy(c, 46);
  return c;
}

function armar(entradas: E[], op: Op = {}): Uint8Array {
  const partes: Buffer[] = [];
  const prefijo = Buffer.from(op.prefijo ?? PK0708);
  partes.push(prefijo);
  let off = prefijo.length;
  const offs: number[] = [];
  entradas.forEach((e, i) => {
    if (e.compartirCon !== undefined) {
      offs[i] = offs[e.compartirCon] as number;
      return;
    }
    if (e.inicioLocal !== undefined) {
      offs[i] = e.inicioLocal;
      return;
    }
    const n = Buffer.from(e.local?.nombre ?? e.nombre, "utf8");
    const extra = Buffer.from(e.local?.extra ?? VACIO);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0);
    l.writeUInt16LE(20, 4);
    l.writeUInt16LE(e.local?.banderas ?? e.banderas ?? 0x0800, 6);
    l.writeUInt16LE(e.metodo, 8);
    l.writeUInt16LE(0x0021, 12);
    l.writeUInt32LE((e.local?.crc ?? e.central.crc) >>> 0, 14);
    l.writeUInt32LE(e.local?.comp ?? e.central.comp, 18);
    l.writeUInt32LE(e.local?.desc ?? e.central.desc, 22);
    l.writeUInt16LE(n.length, 26);
    l.writeUInt16LE(extra.length, 28);
    offs[i] = off;
    const tras = Buffer.from(e.tras ?? VACIO);
    partes.push(l, n, extra, Buffer.from(e.cuerpo), tras);
    off += l.length + n.length + extra.length + e.cuerpo.length + tras.length;
  });
  if (op.huecoAntesCentral) {
    partes.push(Buffer.from(op.huecoAntesCentral));
    off += op.huecoAntesCentral.length;
  }
  const inicioCentral = off;
  const central = Buffer.concat(entradas.map((e, i) => registroCentral(e, offs[i] as number)));
  partes.push(central);
  if (op.trasCentral) partes.push(Buffer.from(op.trasCentral));
  const comentario = Buffer.from(op.comentario ?? VACIO);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(op.total ?? entradas.length, 8);
  fin.writeUInt16LE(op.total ?? entradas.length, 10);
  fin.writeUInt32LE(central.length + (op.deltaLargoCentral ?? 0), 12);
  fin.writeUInt32LE(inicioCentral, 16);
  fin.writeUInt16LE(comentario.length, 20);
  partes.push(fin, comentario);
  return new Uint8Array(Buffer.concat(partes));
}

const crcDe = (d: Uint8Array): number => crc32(d) >>> 0;
function datos(nombre = ARCHIVO, contenido: Uint8Array = TXT, extra: Partial<E> = {}): E {
  const cuerpo = deflateSync(contenido);
  return { nombre, metodo: 8, cuerpo, central: { crc: crcDe(contenido), comp: cuerpo.length, desc: contenido.length }, ...extra };
}
function stored(nombre = ARCHIVO, contenido: Uint8Array = TXT, extra: Partial<E> = {}): E {
  return { nombre, metodo: 0, cuerpo: contenido, central: { crc: crcDe(contenido), comp: contenido.length, desc: contenido.length }, ...extra };
}
function vacia(nombre = ARCHIVO, extra: Partial<E> = {}): E {
  return { nombre, metodo: 0, cuerpo: VACIO, central: { crc: 0, comp: 0, desc: 0 }, ...extra };
}
const carpeta = (nombre = `${B}/`): E => vacia(nombre);
/** La estructura real: datos, la misma ruta vacía y la carpeta. */
const real = (d: E = datos()): E[] => [d, vacia(), carpeta()];

/** Descriptor de datos (`PK\x07\x08` + CRC + tamaños). */
function descriptor(c: Campos): Uint8Array {
  const d = Buffer.alloc(16);
  d.writeUInt32LE(0x08074b50, 0);
  d.writeUInt32LE(c.crc >>> 0, 4);
  d.writeUInt32LE(c.comp, 8);
  d.writeUInt32LE(c.desc, 12);
  return d;
}

/**
 * Corre cada variante: si se rechaza, exige `zip_invalido` limpio (sin canarios); si se acepta, la anota. Devuelve las
 * variantes ACEPTADAS.
 */
function aceptadas(casos: Array<[string, Uint8Array, number?]>): string[] {
  const ok: string[] = [];
  for (const [nombre, zip, tope] of casos) {
    let e: unknown;
    try {
      if (tope === undefined) extraerTxtDeZip(zip);
      else extraerTxtDeZip(zip, tope);
      ok.push(nombre);
      continue;
    } catch (x) {
      e = x;
    }
    esperarError(e, "ErrorPortalSire", "zip_invalido");
    sinSecretos(e, FUGAS);
  }
  return ok;
}

describe("ronda 3 · lector de ZIP relajado (CA-10, T15e)", () => {
  it("A1 · datos ocultos en una entrada que el central declara vacía: la local o el descriptor dicen otra cosa", () => {
    const tam = { crc: crcDe(OCULTO), comp: OCULTO.length, desc: OCULTO.length };
    const casos: Array<[string, Uint8Array]> = [
      // La central dice 0/0/0; la local declara el tamaño real y los bytes están ahí.
      ["vacía: local declara tamaños y trae datos", armar([datos(), vacia(ARCHIVO, { cuerpo: OCULTO, local: tam }), carpeta()])],
      // La central dice 0/0/0 y la local también, pero tras la cabecera local van datos que nadie reclama.
      ["vacía: bytes tras la cabecera local sin declarar", armar([datos(), vacia(ARCHIVO, { cuerpo: OCULTO }), carpeta()])],
      // Bit 3 (descriptor) en la vacía: la local en 0, el descriptor declara datos.
      [
        "vacía con bit 3 y descriptor que declara datos",
        armar([datos(), vacia(ARCHIVO, { banderas: 0x0808, cuerpo: OCULTO, tras: descriptor(tam) }), carpeta()]),
      ],
      // La carpeta «vacía» con cabecera local que declara contenido.
      ["carpeta: local declara tamaños y trae datos", armar([datos(), vacia(), vacia(`${B}/`, { cuerpo: OCULTO, local: tam })])],
      // La local de la vacía declara un CRC distinto de 0.
      ["vacía: CRC local distinto de 0", armar([datos(), vacia(ARCHIVO, { local: { crc: 0xdeadbeef } }), carpeta()])],
    ];
    expect(aceptadas(casos)).toEqual([]);
  });

  it("A2 · cabecera local de la entrada CON datos incoherente con la central (tamaños, CRC, ZIP64 local)", () => {
    const d = datos();
    const zip64 = Buffer.concat([u16(0x0001), u16(16), Buffer.alloc(16)]);
    const casos: Array<[string, Uint8Array]> = [
      ["local declara 1 GiB descomprimido", armar(real({ ...d, local: { desc: 1024 * MIB } }))],
      ["local declara otro tamaño comprimido", armar(real({ ...d, local: { comp: d.central.comp + 1000 } }))],
      ["local declara otro CRC", armar(real({ ...d, local: { crc: (d.central.crc ^ 0xffffffff) >>> 0 } }))],
      ["local trae campo extra ZIP64", armar(real({ ...d, local: { extra: zip64, comp: 0xffffffff, desc: 0xffffffff } }))],
      ["vacía con campo extra ZIP64 solo en la local", armar([d, vacia(ARCHIVO, { local: { extra: zip64 } }), carpeta()])],
    ];
    expect(aceptadas(casos)).toEqual([]);
  });

  it("A3 · bytes antepuestos que no son PK\\x07\\x08 (políglota HTML + ZIP, marca seguida de basura)", () => {
    const html = utf8(`<html><body>${CANARIO}</body></html>`);
    const casos: Array<[string, Uint8Array]> = [
      ["HTML antepuesto", armar(real(), { prefijo: html })],
      ["PK\\x07\\x08 seguido de basura", armar(real(), { prefijo: Buffer.concat([PK0708, Buffer.from(OCULTO)]) })],
      ["PK\\x07\\x08 seguido de un descriptor completo falso", armar(real(), { prefijo: descriptor({ crc: 1, comp: 2, desc: 3 }) })],
    ];
    expect(aceptadas(casos)).toEqual([]);
  });

  it("A4 · huecos y directorio central oculto: bytes no reclamados y un 4.º registro fuera de largoCentral", () => {
    const oculto = registroCentral(datos(`${B}/otro.txt`, OCULTO), 4);
    const casos: Array<[string, Uint8Array]> = [
      ["hueco con datos entre la última local y el central", armar(real(), { huecoAntesCentral: OCULTO })],
      ["registro central oculto entre el central y el EOCD", armar(real(), { trasCentral: oculto })],
      ["basura entre el central y el EOCD", armar(real(), { trasCentral: OCULTO })],
    ];
    expect(aceptadas(casos)).toEqual([]);
    // Contador mentiroso / truncado (deben seguir rechazándose).
    const mentiras: Array<[string, Uint8Array]> = [
      ["total 2 con 3 registros", armar(real(), { total: 2 })],
      ["total 4 con 3 registros", armar(real(), { total: 4 })],
      ["largoCentral corto", armar(real(), { deltaLargoCentral: -1 })],
      ["largoCentral largo", armar(real(), { deltaLargoCentral: 46 })],
      ["9 entradas reales", armar([datos(), ...Array.from({ length: 8 }, () => vacia())])],
    ];
    expect(aceptadas(mentiras)).toEqual([]);
  });

  it("A5 · entradas solapadas: vacía que reutiliza la cabecera local de la de datos; «zip quine» de dos con datos", () => {
    const casos: Array<[string, Uint8Array]> = [
      // Datos stored: la vacía (método 0, mismo nombre) apunta a la MISMA cabecera local que la de datos.
      ["vacía comparte cabecera local con la de datos (stored)", armar([stored(), vacia(ARCHIVO, { compartirCon: 0 }), carpeta()])],
      // La carpeta apunta DENTRO de los datos stored, donde el TXT trae una cabecera local falsa con su nombre.
      [
        "carpeta apunta a una cabecera local embebida en los datos stored",
        (() => {
          const n = Buffer.from(`${B}/`, "utf8");
          const falsa = Buffer.alloc(30 + n.length);
          falsa.writeUInt32LE(0x04034b50, 0);
          falsa.writeUInt16LE(0x0800, 6);
          falsa.writeUInt16LE(n.length, 26);
          n.copy(falsa, 30);
          const contenido = Buffer.concat([Buffer.from(TXT), falsa]);
          const inicioDatos = PK0708.length + 30 + Buffer.byteLength(ARCHIVO);
          return armar([stored(ARCHIVO, contenido), vacia(), { ...carpeta(), inicioLocal: inicioDatos + TXT.length }]);
        })(),
      ],
      ["quine: dos entradas con datos en el mismo offset", armar([datos(), { ...datos(), compartirCon: 0 }, carpeta()])],
    ];
    expect(aceptadas(casos)).toEqual([]);
  });

  it("A6 · basura tras el fin del flujo deflate: datos ocultos y lavado de la razón 200:1 con una bomba en la carpeta", () => {
    const d = datos();
    const conCola = Buffer.concat([Buffer.from(d.cuerpo), Buffer.from(OCULTO)]);
    const b = bombaDeflate(16); // ~1000:1 real
    const relleno = Math.ceil(b.tamano / 200) - b.deflate.length;
    const lavada = Buffer.concat([b.deflate, Buffer.alloc(relleno, 0x41)]);
    const bomba: E = { nombre: ARCHIVO, metodo: 8, cuerpo: lavada, central: { crc: b.crc, comp: lavada.length, desc: b.tamano } };
    const casos: Array<[string, Uint8Array]> = [
      ["deflate + cola de bytes ocultos dentro del comprimido declarado", armar(real({ ...d, cuerpo: conCola, central: { ...d.central, comp: conCola.length } }))],
      ["bomba 1000:1 rellenada hasta 200:1 exacto", armar(real(bomba))],
    ];
    expect(aceptadas(casos)).toEqual([]);
    // Control: la bomba sin relleno sí se rechaza por la razón; mentir el tamaño dentro de la carpeta también.
    const sinRelleno: E = { ...bomba, cuerpo: b.deflate, central: { ...bomba.central, comp: b.deflate.length } };
    const mentira: E = { ...sinRelleno, central: { ...sinRelleno.central, desc: MIB } };
    expect(aceptadas([["bomba sin relleno", armar(real(sinRelleno))], ["bomba con tamaño mentido", armar(real(mentira))]])).toEqual([]);
  });

  it("A7 · nombres: barras Unicode, bidi, %2e%2e, espacios/puntos finales, ADS NTFS y reservados de Windows", () => {
    const solo = (nombre: string): Uint8Array => armar([datos(nombre)]);
    const conCarpeta = (c: string, a: string): Uint8Array => armar([datos(`${c}/${a}`), vacia(`${c}/${a}`), carpeta(`${c}/`)]);
    const casos: Array<[string, Uint8Array]> = [
      ["U+FF0F barra de ancho completo", solo(`${B}／${B}.txt`)],
      ["U+2215 barra de división", solo(`${B}∕${B}.txt`)],
      ["U+2044 barra de fracción", solo(`${B}⁄${B}.txt`)],
      ["U+FF3C barra invertida de ancho completo", solo(`${B}＼${B}.txt`)],
      ["U+FF0E U+FF0E punto de ancho completo", conCarpeta("．．", "x.txt")],
      ["U+202E bidi override (se ve .exe)", solo(`${B}‮exe.txt`)],
      ["U+2028 separador de línea", solo(`${B} .txt`)],
      ["U+FEFF dentro del nombre", conCarpeta(B, `﻿${B}.txt`)],
      ["%2e%2e en la carpeta", conCarpeta("%2e%2e", "x.txt")],
      ["carpeta con espacio final", conCarpeta(`${B} `, `${B}.txt`)],
      ["carpeta con punto final", conCarpeta(`${B}.`, `${B}.txt`)],
      ["ADS NTFS a.txt:x", solo("a.txt:x.txt")],
      ["reservado CON", conCarpeta("CON", "CON.txt")],
      ["reservado NUL en la vacía", armar([datos(), vacia(`${B}/NUL`), carpeta()])],
      ["vacía ejecutable en la carpeta", armar([datos(), vacia(`${B}/${B}.exe`), carpeta()])],
    ];
    expect(aceptadas(casos)).toEqual([]);
  });

  it("A8 · NFC/NFD y orden: carpeta y archivo «iguales» solo tras normalizar se rechazan; el orden de la vacía no cambia nada", () => {
    const nfc = "LEÁ";
    const nfd = "LEÁ";
    const casos: Array<[string, Uint8Array]> = [
      ["carpeta NFC, archivo NFD (sin entrada de carpeta)", armar([datos(`${nfc}/${nfd}.txt`)])],
      ["entrada de carpeta NFD, datos en carpeta NFC", armar([datos(`${nfc}/${nfc}.txt`), carpeta(`${nfd}/`)])],
      ["vacía en carpeta NFD, datos en NFC", armar([datos(`${nfc}/${nfc}.txt`), vacia(`${nfd}/${nfc}.txt`)])],
      ["vacía con mayúsculas distintas en la carpeta", armar([datos(), vacia(`${B.toLowerCase()}/${B}.txt`), carpeta()])],
    ];
    expect(aceptadas(casos)).toEqual([]);
    // Vacía antes o después de la de datos, carpeta primero o al final: el mismo TXT siempre.
    const ordenes = [
      [datos(), vacia(), carpeta()],
      [vacia(), datos(), carpeta()],
      [carpeta(), vacia(), datos()],
      [vacia(), carpeta(), datos()],
    ];
    for (const o of ordenes) expect(Buffer.from(extraerTxtDeZip(armar(o))).equals(Buffer.from(TXT))).toBe(true);
    // Control del armador (si esto falla, las demás pruebas no prueban nada): datos stored y sin la marca PK\x07\x08.
    expect(Buffer.from(extraerTxtDeZip(armar(real(stored())))).equals(Buffer.from(TXT))).toBe(true);
    expect(Buffer.from(extraerTxtDeZip(armar(real(), { prefijo: VACIO }))).equals(Buffer.from(TXT))).toBe(true);
  });

  it("A9 · varios EOCD: comentario con un EOCD falso embebido, EOCD duplicado y comentario enorme con firma dentro", () => {
    const base = armar(real());
    const finReal = Buffer.from(base.subarray(base.length - 22));
    const conComentario = (comentario: Uint8Array): Uint8Array => {
      const z = Buffer.from(base);
      z.writeUInt16LE(comentario.length, z.length - 2);
      return new Uint8Array(Buffer.concat([z, Buffer.from(comentario)]));
    };
    // Un segundo EOCD válido al final: el lector toma el último sin advertir la ambigüedad.
    const casos: Array<[string, Uint8Array]> = [
      ["comentario que termina en una copia exacta del EOCD", conComentario(finReal)],
      ["comentario de 65 535 bytes cuyo final es un EOCD", conComentario(Buffer.concat([Buffer.alloc(0xffff - 22, 0x20), finReal]))],
      ["dos EOCD seguidos (sin comentario)", new Uint8Array(Buffer.concat([Buffer.from(base), finReal]))],
    ];
    expect(aceptadas(casos)).toEqual([]);
  });

  it("A10 · extensión de la entrada con datos: .txt con espacio, .txt.exe, punto final, ZWSP, NBSP, x cirílica y datos en la carpeta", () => {
    const con = (archivo: string): Uint8Array => armar([datos(`${B}/${archivo}`), carpeta()]);
    const casos: Array<[string, Uint8Array]> = [
      [".txt con espacio final", con(`${B}.txt `)],
      [".txt.exe", con(`${B}.txt.exe`)],
      [".txt.", con(`${B}.txt.`)],
      [".txt + ZWSP", con(`${B}.txt​`)],
      [".txt + NBSP", con(`${B}.txt `)],
      [".tхt (x cirílica)", con(`${B}.tхt`)],
      ["solo .txt", con(".txt")],
      ["datos en la entrada de carpeta", armar([datos(`${B}/`), datos()])],
    ];
    expect(aceptadas(casos)).toEqual([]);
  });
});
