import { randomBytes } from "node:crypto";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { capturarSync, esperarError, fixture, sinSecretos } from "./pruebas/ayudas-http.js";
import {
  MIB,
  bombaDeflate,
  datosCompresibles,
  marcarCifrado,
  picoRssMiB,
  utf8,
  zipCrudo,
} from "./pruebas/ayudas-txt.js";
import { RAZON_MAX_ZIP, TOPE_ZIP_COMPRIMIDO, TOPE_ZIP_DESCOMPRIMIDO, extraerTxtDeZip } from "./zip-seguro.js";

// Contrato de `zip-seguro.ts` (plan 041, «zip-seguro.ts»; spec CA-10):
//  - `extraerTxtDeZip(zip: Uint8Array): Uint8Array` es SÍNCRONA y sin IO: devuelve los bytes del único TXT del ZIP.
//  - Topes (constantes exportadas): TOPE_ZIP_COMPRIMIDO = 32 MiB, TOPE_ZIP_DESCOMPRIMIDO = 64 MiB (total), RAZON_MAX_ZIP = 200.
//  - Todo rechazo es `ErrorPortalSire("zip_invalido")` (que además es `ErrorPortal`): más de 1 entrada o ninguna, entrada
//    que no termina en `.txt`, ruta en el nombre (`/`, `\`, `..`), entrada cifrada, ZIP corrupto o truncado, comprimido
//    > 32 MiB, descomprimido > 64 MiB (se cuenta al descomprimir; la cabecera del ZIP puede mentir) o razón > 200:1.
//  - Sin superar ~2× el tope (128 MiB) en memoria, aunque el ZIP sea una bomba deflate de 1 GiB.
//  - El mensaje del error es fijo: no lleva nombres de entrada ni bytes.
const TXT = fixture("compras-propuesta-202610.txt");
const NOMBRE = "20700000002-20261101-1030-propuesta.txt";

function rechaza(zip: Uint8Array): unknown {
  return capturarSync(() => extraerTxtDeZip(zip));
}

describe("extraerTxtDeZip · caso feliz", () => {
  it("un único TXT: devuelve sus bytes exactos", () => {
    const r = extraerTxtDeZip(zipSync({ [NOMBRE]: TXT }));
    expect(Buffer.from(r).equals(Buffer.from(TXT))).toBe(true);
  });

  it("TXT con BOM: conserva el BOM (lo quita leerTxt, no el ZIP)", () => {
    const ventas = fixture("ventas-propuesta-202610.txt");
    const r = extraerTxtDeZip(zipSync({ "LE20700000002202611001404001EXP2.txt": ventas }));
    expect(Array.from(r.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(r.length).toBe(ventas.length);
  });

  it("los topes son 32 MiB, 64 MiB y 200:1", () => {
    expect(TOPE_ZIP_COMPRIMIDO).toBe(32 * MIB);
    expect(TOPE_ZIP_DESCOMPRIMIDO).toBe(64 * MIB);
    expect(RAZON_MAX_ZIP).toBe(200);
  });
});

describe("extraerTxtDeZip · estructura (CA-10)", () => {
  it("ninguna entrada", () => {
    esperarError(rechaza(zipSync({})), "ErrorPortalSire", "zip_invalido");
  });

  it("más de una entrada", () => {
    esperarError(rechaza(zipSync({ "a.txt": TXT, "b.txt": TXT })), "ErrorPortalSire", "zip_invalido");
  });

  it.each(["datos.csv", "datos", "datos.txt.exe", "datos.zip", "datos.xml"])("entrada que no es .txt: %s", (nombre) => {
    esperarError(rechaza(zipSync({ [nombre]: TXT })), "ErrorPortalSire", "zip_invalido");
  });

  it.each(["sub/datos.txt", "../datos.txt", "..\\datos.txt", "/datos.txt", "C:\\datos.txt", "a\\b.txt"])(
    "ruta en el nombre: %s",
    (nombre) => {
      esperarError(rechaza(zipSync({ [nombre]: TXT })), "ErrorPortalSire", "zip_invalido");
    },
  );

  it("nombre con carácter de control", () => {
    esperarError(rechaza(zipSync({ "da\u0000tos.txt": TXT })), "ErrorPortalSire", "zip_invalido");
  });

  it("entrada cifrada", () => {
    esperarError(rechaza(marcarCifrado(zipSync({ [NOMBRE]: TXT }))), "ErrorPortalSire", "zip_invalido");
  });

  it("ZIP vacío (0 bytes) y bytes que no son un ZIP", () => {
    esperarError(rechaza(new Uint8Array(0)), "ErrorPortalSire", "zip_invalido");
    esperarError(rechaza(utf8("esto no es un zip, es texto plano de prueba")), "ErrorPortalSire", "zip_invalido");
    esperarError(rechaza(new Uint8Array(randomBytes(4096))), "ErrorPortalSire", "zip_invalido");
  });

  it("ZIP truncado (sin directorio central)", () => {
    const z = zipSync({ [NOMBRE]: TXT });
    esperarError(rechaza(z.slice(0, Math.floor(z.length / 2))), "ErrorPortalSire", "zip_invalido");
    esperarError(rechaza(z.slice(0, z.length - 10)), "ErrorPortalSire", "zip_invalido");
  });

  it("flujo deflate corrupto dentro de un ZIP bien formado", () => {
    const z = zipSync({ [NOMBRE]: [TXT, { level: 6 }] });
    const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
    const inicio = 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
    const fin = inicio + dv.getUint32(18, true);
    const roto = new Uint8Array(z);
    roto.fill(0xff, inicio, Math.min(fin, inicio + 64)); // BTYPE=11 reservado: deflate inválido
    esperarError(rechaza(roto), "ErrorPortalSire", "zip_invalido");
  });

  it("el error no revela el nombre de la entrada ni su contenido", () => {
    const e = rechaza(zipSync({ "secreto-CANARIO-nombre.csv": utf8("contenido-CANARIO-fila") }));
    esperarError(e, "ErrorPortalSire", "zip_invalido");
    sinSecretos(e, ["secreto-CANARIO-nombre", "contenido-CANARIO-fila"]);
  });
});

describe("extraerTxtDeZip · bomba deflate de 1 GiB (CA-10: memoria acotada)", () => {
  // `picoRssMiB` es el máximo del proceso: estas pruebas van primero para que el pico previo sea bajo.
  const TOPE_MEMORIA_MIB = 2 * 64 + 64; // ~2× el tope descomprimido + margen del motor

  it("bomba de 1 GiB en ~1 MiB con cabecera honesta", () => {
    const b = bombaDeflate(1024);
    expect(b.deflate.length).toBeLessThan(2 * MIB);
    expect(b.tamano).toBe(1024 * MIB);
    const antes = picoRssMiB();
    esperarError(rechaza(zipCrudo(NOMBRE, b)), "ErrorPortalSire", "zip_invalido");
    expect(picoRssMiB() - antes).toBeLessThan(TOPE_MEMORIA_MIB);
  });

  it("bomba de 1 GiB cuya cabecera MIENTE sobre el tamaño descomprimido", () => {
    const b = bombaDeflate(1024);
    const antes = picoRssMiB();
    esperarError(rechaza(zipCrudo(NOMBRE, b, 100)), "ErrorPortalSire", "zip_invalido");
    expect(picoRssMiB() - antes).toBeLessThan(TOPE_MEMORIA_MIB);
  });

  it("70 MiB de ceros en ~70 KiB (razón de ~1000:1)", () => {
    esperarError(rechaza(zipCrudo(NOMBRE, bombaDeflate(70))), "ErrorPortalSire", "zip_invalido");
  });
});

describe("extraerTxtDeZip · topes (CA-10)", () => {
  it("razón > 200:1 aunque el total sea pequeño (10 MiB de ceros)", () => {
    esperarError(rechaza(zipSync({ [NOMBRE]: new Uint8Array(10 * MIB) })), "ErrorPortalSire", "zip_invalido");
  });

  it("razón mayor de 200:1 se rechaza y ~50:1 pasa, con el mismo tamaño total", () => {
    const total = 4 * MIB;
    esperarError(rechaza(zipSync({ [NOMBRE]: [datosCompresibles(total, 800 * 1024), { level: 6 }] })), "ErrorPortalSire", "zip_invalido");
    const bueno = datosCompresibles(total, 60 * 1024);
    expect(extraerTxtDeZip(zipSync({ [NOMBRE]: [bueno, { level: 6 }] })).length).toBe(total);
  });

  it("descomprimido: exactamente 64 MiB pasa; 64 MiB + 1 byte no (razón bajo 200:1)", () => {
    const justo = datosCompresibles(TOPE_ZIP_DESCOMPRIMIDO);
    expect(extraerTxtDeZip(zipSync({ [NOMBRE]: [justo, { level: 1 }] })).length).toBe(TOPE_ZIP_DESCOMPRIMIDO);
    const pasado = datosCompresibles(TOPE_ZIP_DESCOMPRIMIDO + 1);
    esperarError(rechaza(zipSync({ [NOMBRE]: [pasado, { level: 1 }] })), "ErrorPortalSire", "zip_invalido");
  });

  it("comprimido: 30 MiB pasa; más de 32 MiB no (datos aleatorios guardados sin comprimir)", () => {
    const ok = new Uint8Array(randomBytes(30 * MIB));
    expect(extraerTxtDeZip(zipSync({ [NOMBRE]: [ok, { level: 0 }] })).length).toBe(30 * MIB);
    const grande = new Uint8Array(randomBytes(32 * MIB + 1024));
    const z = zipSync({ [NOMBRE]: [grande, { level: 0 }] });
    expect(z.length).toBeGreaterThan(TOPE_ZIP_COMPRIMIDO);
    esperarError(rechaza(z), "ErrorPortalSire", "zip_invalido");
  });
});
