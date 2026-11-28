import { deflateSync, zipSync } from "fflate";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { capturarSync, esperarError, fixture, sinSecretos } from "./pruebas/ayudas-http.js";
import { MIB, bombaDeflate, datosCompresibles, marcarCifrado, picoRssMiB } from "./pruebas/ayudas-txt.js";
import { zipManual, zipRegistroReal, type EntradaZipManual } from "./pruebas/zip-manual.js";
import { TOPE_ZIP_DESCOMPRIMIDO, extraerTxtDeZip } from "./zip-seguro.js";

// Spec 041 · T15e (CA-10, CA-13). El ZIP REAL del registro presentado (servicio 5.51 → 5.32), observado en la corrida de
// contrato, NO es «una sola entrada plana». Estructura (nombres sin dígitos reales), `PK\x07\x08` al inicio, EOCD al final, sin
// ZIP64, sin cifrado, sin descriptor de datos, banderas 0x0800, TRES entradas en el directorio central:
//   (1) `LE#/LE#.txt` con datos (deflate); (2) OTRA `LE#/LE#.txt` vacía (stored, tamaños 0, CRC 0); (3) `LE#/` (directorio).
// Decisión de lectura: (a) se ignoran las entradas de directorio y las de archivo vacías (método 0, tamaños 0, CRC 0);
// (b) exactamente UNA entrada con datos y extensión `.txt`; (c) el NOMBRE de TODAS las entradas (también las ignoradas) se
// valida: sin `..`, ruta absoluta, `\`, `:`, NUL ni controles, a lo sumo UN nivel de carpeta, ≤ 255 bytes, y el directorio, si
// hay, es prefijo del archivo con datos; (d) a lo sumo 8 entradas en el directorio central; (e) siguen los topes (64 MiB por
// parte, 256 MiB acumulados, 200:1), el CRC, solo métodos 0 y 8, sin cifrado ni ZIP64 y los duplicados CON datos se rechazan.
// Todo rechazo es `ErrorPortalSire("zip_invalido")`.
const TXT = fixture("compras-registro-202610-pen.txt");
const B = "LE20700000002202610";
const ARCHIVO = `${B}/${B}.txt`;
const VACIO = new Uint8Array(0);

const datos = (nombre = ARCHIVO, contenido: Uint8Array = TXT, extra: Partial<EntradaZipManual> = {}): EntradaZipManual => ({
  nombre,
  datos: contenido,
  metodo: 8,
  ...extra,
});
const vacia = (nombre = ARCHIVO, extra: Partial<EntradaZipManual> = {}): EntradaZipManual => ({
  nombre,
  datos: VACIO,
  metodo: 0,
  ...extra,
});
const carpeta = (nombre = `${B}/`): EntradaZipManual => ({ nombre, datos: VACIO, metodo: 0 });
/** ZIP con las entradas dadas y la firma `PK\x07\x08` del archivo real. */
const armar = (entradas: EntradaZipManual[], firmaInicio = true): Uint8Array => zipManual(entradas, { firmaInicio });

function rechaza(zip: Uint8Array, tope?: number): unknown {
  return capturarSync(() => (tope === undefined ? extraerTxtDeZip(zip) : extraerTxtDeZip(zip, tope)));
}
function seRechaza(zip: Uint8Array, tope?: number): void {
  esperarError(rechaza(zip, tope), "ErrorPortalSire", "zip_invalido");
}
function igual(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

describe("extraerTxtDeZip · estructura REAL del registro presentado (CA-10, CA-13)", () => {
  it("la construcción sintética es la real: firma PK\\x07\\x08, EOCD al final y 3 entradas en el directorio central", () => {
    const z = zipRegistroReal(B, TXT);
    expect(Array.from(z.slice(0, 4))).toEqual([0x50, 0x4b, 0x07, 0x08]);
    const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
    expect(dv.getUint32(z.length - 22, true)).toBe(0x06054b50);
    expect(dv.getUint16(z.length - 22 + 10, true)).toBe(3);
  });

  it("3 entradas (datos deflate + misma ruta vacía + carpeta) con la firma PK\\x07\\x08: devuelve el TXT exacto", () => {
    const r = extraerTxtDeZip(zipRegistroReal(B, TXT));
    expect(igual(r, TXT)).toBe(true);
  });

  it("la misma estructura SIN la firma PK\\x07\\x08: devuelve el TXT exacto", () => {
    const r = extraerTxtDeZip(zipRegistroReal(B, TXT, { firmaInicio: false }));
    expect(igual(r, TXT)).toBe(true);
  });

  it("con el TXT del USD y con el TXT de solo encabezado también", () => {
    for (const f of ["compras-registro-202610-usd.txt", "compras-registro-202610-solo-encabezado.txt"]) {
      const t = fixture(f);
      expect(igual(extraerTxtDeZip(zipRegistroReal(B, t)), t)).toBe(true);
    }
  });

  it("el orden de las entradas del directorio central no importa", () => {
    expect(igual(extraerTxtDeZip(armar([carpeta(), vacia(), datos()])), TXT)).toBe(true);
    expect(igual(extraerTxtDeZip(armar([vacia(), carpeta(), datos()])), TXT)).toBe(true);
  });

  it("el archivo con datos dentro de la carpeta, sin la entrada vacía ni la de directorio", () => {
    expect(igual(extraerTxtDeZip(armar([datos()])), TXT)).toBe(true);
  });

  it("archivo con datos + carpeta, sin la entrada vacía; y archivo con datos + vacía, sin la carpeta", () => {
    expect(igual(extraerTxtDeZip(armar([datos(), carpeta()])), TXT)).toBe(true);
    expect(igual(extraerTxtDeZip(armar([datos(), vacia()])), TXT)).toBe(true);
  });

  it("el archivo de datos puede ir STORED (método 0) además de deflate", () => {
    expect(igual(extraerTxtDeZip(armar([datos(ARCHIVO, TXT, { metodo: 0 }), vacia(), carpeta()])), TXT)).toBe(true);
  });

  it("exactamente 8 entradas en el directorio central pasan (la real + 5 archivos vacíos de otro nombre)", () => {
    const extra = [1, 2, 3, 4, 5].map((n) => vacia(`${B}/vacio${n}.txt`));
    const z = armar([datos(), vacia(), carpeta(), ...extra]);
    expect(new DataView(z.buffer, z.byteOffset, z.byteLength).getUint16(z.length - 22 + 10, true)).toBe(8);
    expect(igual(extraerTxtDeZip(z), TXT)).toBe(true);
  });

  it("el nombre del archivo con datos de 255 bytes pasa (la carpeta y el archivo cuentan por separado)", () => {
    const base = "L".repeat(120);
    const nombre = `${base}/${"a".repeat(255 - 121 - 4)}.txt`;
    expect(Buffer.byteLength(nombre)).toBe(255);
    expect(igual(extraerTxtDeZip(armar([datos(nombre), vacia(nombre), carpeta(`${base}/`)])), TXT)).toBe(true);
  });
});

describe("extraerTxtDeZip · variantes que siguen RECHAZADAS con la estructura de carpeta (CA-10)", () => {
  it("dos entradas con datos (distinto nombre)", () => {
    seRechaza(armar([datos(), datos(`${B}/otro.txt`), carpeta()]));
  });

  it("dos entradas con datos y el MISMO nombre (duplicado CON datos)", () => {
    seRechaza(armar([datos(), datos(), carpeta()]));
    seRechaza(armar([datos(), datos(), vacia(), carpeta()]));
  });

  it("la entrada vacía con otro nombre y la de datos en otra carpeta", () => {
    seRechaza(armar([datos(`OTRA/${B}.txt`), vacia(), carpeta()]));
    seRechaza(armar([datos(`OTRA/${B}.txt`), vacia(`${B}/otro.txt`), carpeta()]));
  });

  it("directorio que NO es prefijo del archivo con datos", () => {
    seRechaza(armar([datos(), vacia(), carpeta("OTRA/")]));
    seRechaza(armar([datos(), carpeta(`${B}x/`)]));
    seRechaza(armar([datos(), carpeta("L/")]));
  });

  it("dos niveles de carpeta (aunque la carpeta sea prefijo del archivo)", () => {
    const n = `${B}/sub/${B}.txt`;
    seRechaza(armar([datos(n), vacia(n), carpeta(`${B}/sub/`)]));
    seRechaza(armar([datos(n), vacia(n), carpeta(`${B}/`)]));
    seRechaza(armar([datos(n)]));
  });

  it("más de 8 entradas en el directorio central (9)", () => {
    const extra = [1, 2, 3, 4, 5, 6].map((n) => vacia(`${B}/vacio${n}.txt`));
    const z = armar([datos(), vacia(), carpeta(), ...extra]);
    expect(new DataView(z.buffer, z.byteOffset, z.byteLength).getUint16(z.length - 22 + 10, true)).toBe(9);
    seRechaza(z);
  });

  it("muchas entradas de directorio (tope de entradas, no de datos)", () => {
    seRechaza(armar([datos(), ...Array.from({ length: 12 }, (_, n) => carpeta(`${B}/d${n}/`))]));
  });

  it("carpeta sola, sin archivo", () => {
    seRechaza(armar([carpeta()]));
  });

  it("carpeta y archivo vacío, ninguna entrada con datos", () => {
    seRechaza(armar([vacia(), carpeta()]));
    seRechaza(armar([vacia()]));
  });

  it("la entrada «vacía» con tamaño 0 pero CRC distinto de 0 no se ignora (y sigue siendo un 2.º archivo)", () => {
    seRechaza(armar([datos(), vacia(ARCHIVO, { crc: 0x12345678 }), carpeta()]));
    seRechaza(armar([datos(), vacia(`${B}/otro.txt`, { crc: 1 }), carpeta()]));
  });

  it("la entrada «vacía» con tamaño 0 pero método deflate no se ignora", () => {
    seRechaza(armar([datos(), vacia(ARCHIVO, { metodo: 8 }), carpeta()]));
    seRechaza(armar([datos(), vacia(`${B}/otro.txt`, { metodo: 8 }), carpeta()]));
  });

  it("la entrada de directorio con datos (un «directorio» que trae bytes) no se ignora", () => {
    seRechaza(armar([datos(), { nombre: `${B}/`, datos: TXT, metodo: 0 }]));
    seRechaza(armar([datos(), { nombre: `${B}/`, datos: TXT, metodo: 8 }]));
  });

  it.each([`${B}.csv`, `${B}.txt.exe`, `${B}.xml`, `${B}.zip`, B])("entrada con datos de extensión distinta de .txt: %s", (arch) => {
    const n = `${B}/${arch}`;
    seRechaza(armar([datos(n), vacia(n), carpeta()]));
    seRechaza(armar([datos(n)]));
  });

  it("CRC falso en la entrada de datos (estructura real)", () => {
    seRechaza(armar([datos(ARCHIVO, TXT, { crc: 0x12345678 }), vacia(), carpeta()]));
    seRechaza(armar([datos(ARCHIVO, TXT, { crc: (crc32(TXT) ^ 1) >>> 0 }), vacia(), carpeta()]));
  });

  it("tamaño descomprimido declarado falso en la entrada de datos (más chico y más grande)", () => {
    const deflate = deflateSync(TXT);
    const crudo = (tamanoDeclarado: number) => ({ deflate, tamano: TXT.length, crc: crc32(TXT) >>> 0, tamanoDeclarado });
    for (const falso of [TXT.length - 1, TXT.length + 1, TXT.length + 1000, 1]) {
      seRechaza(armar([datos(ARCHIVO, VACIO, { crudo: crudo(falso) }), vacia(), carpeta()]));
    }
  });

  it("control: el mismo flujo crudo con el tamaño declarado VERDADERO sí se lee (el rechazo anterior viene del tamaño falso)", () => {
    const crudo = { deflate: deflateSync(TXT), tamano: TXT.length, crc: crc32(TXT) >>> 0 };
    expect(igual(extraerTxtDeZip(armar([datos(ARCHIVO, VACIO, { crudo }), vacia(), carpeta()])), TXT)).toBe(true);
  });

  it("entrada de datos cifrada", () => {
    seRechaza(marcarCifrado(zipRegistroReal(B, TXT)));
  });

  it("entrada de datos con método distinto de 0 y 8 (p. ej. bzip2 = 12)", () => {
    const z = new Uint8Array(zipRegistroReal(B, TXT));
    const dv = new DataView(z.buffer);
    for (let i = 0; i + 12 <= z.length; i += 1) {
      if (dv.getUint32(i, true) === 0x02014b50 && dv.getUint16(i + 10, true) === 8) dv.setUint16(i + 10, 12, true);
      if (dv.getUint32(i, true) === 0x04034b50 && dv.getUint16(i + 8, true) === 8) dv.setUint16(i + 8, 12, true);
    }
    seRechaza(z);
  });

  it("ZIP truncado en la estructura real (sin EOCD)", () => {
    const z = zipRegistroReal(B, TXT);
    seRechaza(z.slice(0, z.length - 10));
    seRechaza(z.slice(0, Math.floor(z.length / 2)));
  });

  it("el error no revela los nombres de las entradas aunque sean hostiles", () => {
    const e = rechaza(armar([datos(`secreto-CANARIO-carpeta/../${B}.txt`), vacia(), carpeta()]));
    esperarError(e, "ErrorPortalSire", "zip_invalido");
    sinSecretos(e, ["secreto-CANARIO-carpeta"]);
  });
});

// Un nombre hostil en CADA posición: el archivo con datos (y su gemelo vacío), solo el archivo vacío ignorado, o solo la
// entrada de directorio ignorada. El nombre de TODAS las entradas se valida, incluidas las que luego se ignoran.
describe("extraerTxtDeZip · nombres hostiles en cualquier entrada, también en las ignoradas (CA-10)", () => {
  const hostiles: Array<[string, string, string]> = [
    // [descripción, nombre de archivo, nombre de directorio]
    ["segmento «..»", `../${B}.txt`, "../"],
    ["«..» dentro de la ruta", `${B}/../${B}.txt`, `${B}/../`],
    ["ruta absoluta", `/${B}/${B}.txt`, `/${B}/`],
    ["comienza con barra", `/${B}.txt`, "/"],
    ["barra invertida", `${B}\\${B}.txt`, `${B}\\`],
    ["letra de unidad «C:»", `C:/${B}.txt`, "C:/"],
    ["dos puntos en el nombre", `${B}/${B}:1.txt`, `${B}:/`],
    ["NUL", `${B}/${B}\u0000.txt`, `${B}\u0000/`],
    ["carácter de control (BEL)", `${B}/${B}\u0007.txt`, `${B}\u0007/`],
    ["salto de línea", `${B}/${B}\n.txt`, `${B}\n/`],
    ["DEL (0x7f)", `${B}/${B}\u007f.txt`, `${B}\u007f/`],
    ["nombre de más de 255 bytes", `${B}/${"a".repeat(260)}.txt`, `${B}/${"a".repeat(260)}/`],
  ];

  it.each(hostiles)("%s en el archivo con datos (y en su gemelo vacío)", (_d, archivo) => {
    seRechaza(armar([datos(archivo), vacia(archivo), carpeta()]));
    seRechaza(armar([datos(archivo)]));
  });

  it.each(hostiles)("%s solo en el archivo VACÍO ignorado", (_d, archivo) => {
    seRechaza(armar([datos(), vacia(archivo), carpeta()]));
  });

  it.each(hostiles)("%s solo en la entrada de DIRECTORIO ignorada", (_d, _a, dir) => {
    seRechaza(armar([datos(), vacia(), carpeta(dir)]));
  });

  it("nombre que no es UTF-8 válido en una entrada ignorada", () => {
    const z = new Uint8Array(armar([datos(), vacia(), carpeta(`${B}X/`)]));
    // «X» (0x58) del directorio pasa a 0xFF (inválido en UTF-8) en la cabecera local y en la central.
    const marca = Buffer.from(`${B}X/`, "utf8");
    let n = 0;
    for (let i = 0; i + marca.length <= z.length; i += 1) {
      if (Buffer.from(z.subarray(i, i + marca.length)).equals(marca)) {
        z[i + B.length] = 0xff;
        n += 1;
      }
    }
    expect(n).toBeGreaterThanOrEqual(2);
    seRechaza(z);
  });

  it("«..» sigue rechazado sin la firma de inicio y con un ZIP de una sola entrada", () => {
    seRechaza(armar([datos(`../${B}.txt`), vacia(`../${B}.txt`), carpeta("../")], false));
    seRechaza(zipSync({ [`../${B}.txt`]: TXT }));
  });
});

describe("extraerTxtDeZip · bomba deflate de 1 GiB con la estructura de carpeta (CA-10: memoria acotada)", () => {
  // `picoRssMiB` es el máximo del proceso: estas pruebas van primero para que el pico previo sea bajo.
  const TOPE_MEMORIA_MIB = 2 * 64 + 64;
  const conBomba = (mib: number, tamanoDeclarado?: number): Uint8Array => {
    const b = bombaDeflate(mib);
    return zipRegistroReal(B, VACIO, { crudo: { deflate: b.deflate, tamano: b.tamano, crc: b.crc, tamanoDeclarado } });
  };

  it("bomba de 1 GiB en ~1 MiB con cabecera honesta, dentro de la carpeta", () => {
    const z = conBomba(1024);
    expect(z.length).toBeLessThan(2 * MIB);
    const antes = picoRssMiB();
    seRechaza(z);
    expect(picoRssMiB() - antes).toBeLessThan(TOPE_MEMORIA_MIB);
  });

  it("bomba de 1 GiB cuya cabecera MIENTE sobre el tamaño descomprimido, dentro de la carpeta", () => {
    const z = conBomba(1024, 100);
    const antes = picoRssMiB();
    seRechaza(z);
    expect(picoRssMiB() - antes).toBeLessThan(TOPE_MEMORIA_MIB);
  });

  it("70 MiB de ceros en ~70 KiB (razón ~1000:1) dentro de la carpeta", () => {
    seRechaza(conBomba(70));
  });
});

describe("extraerTxtDeZip · topes con la estructura de carpeta (CA-10)", () => {
  it("razón > 200:1 aunque el total sea pequeño (10 MiB de ceros)", () => {
    seRechaza(zipRegistroReal(B, new Uint8Array(10 * MIB)));
  });

  it("descomprimido: exactamente 64 MiB pasa; 64 MiB + 1 byte no", () => {
    const justo = datosCompresibles(TOPE_ZIP_DESCOMPRIMIDO);
    expect(extraerTxtDeZip(zipRegistroReal(B, justo, { nivel: 1 })).length).toBe(TOPE_ZIP_DESCOMPRIMIDO);
    seRechaza(zipRegistroReal(B, datosCompresibles(TOPE_ZIP_DESCOMPRIMIDO + 1), { nivel: 1 }));
  });

  it("tope acumulado (lo que queda del periodo): pasa justo y falla con 1 byte menos", () => {
    const d = datosCompresibles(2 * MIB);
    const z = zipRegistroReal(B, d);
    expect(extraerTxtDeZip(z, 2 * MIB).length).toBe(2 * MIB);
    expect(extraerTxtDeZip(z, 3 * MIB).length).toBe(2 * MIB);
    seRechaza(z, 2 * MIB - 1);
    seRechaza(z, MIB);
    seRechaza(z, 0);
  });

  it("el tope pasado nunca supera 64 MiB aunque se pida más", () => {
    seRechaza(zipRegistroReal(B, datosCompresibles(TOPE_ZIP_DESCOMPRIMIDO + 1), { nivel: 1 }), 512 * MIB);
  });
});
