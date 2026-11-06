// Spec 012 (T5, rojo): empaquetado ZIP en memoria con SHA-256 (D6, D7; CA-10).
// Contrato: `empaquetar(txt, { nombreTxt, nombreZip }, fecha)` devuelve
// `{ zip, nombreZip, sha256Txt, sha256Zip }` (hex en minúsculas) con una sola entrada llamada
// `nombreTxt`; es determinista (la fecha es un parámetro, sin Date.now()) y valida otra vez los
// dos nombres con `validarNombreArchivo` de domain y que `nombreZip` sea el base de `nombreTxt` + .zip.
// Todo error es EmpaquetadoInvalidoError (sin los valores recibidos en el mensaje).
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { EmpaquetadoInvalidoError, empaquetar } from "./index.js";

const TXT_NOMBRE = "CONTAPP-PROVISIONAL-20700000002-202610-RCE.txt";
const ZIP_NOMBRE = "CONTAPP-PROVISIONAL-20700000002-202610-RCE.zip";
const NOMBRES = { nombreTxt: TXT_NOMBRE, nombreZip: ZIP_NOMBRE };
const FECHA = new Date("2026-10-27T16:00:00Z");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** TXT de prueba: líneas CRLF y todos los valores de byte (0x00-0xFF), como saldría en latin1. */
function txtDePrueba(): Uint8Array {
  const todos = Uint8Array.from({ length: 256 }, (_, i) => i);
  const lineas = new TextEncoder().encode("202610|01|F001|123|05/10/2026|6|20100070970||PEN||100.00|18.00|118.00\r\n");
  const out = new Uint8Array(lineas.length * 2 + todos.length);
  out.set(lineas, 0);
  out.set(todos, lineas.length);
  out.set(lineas, lineas.length + todos.length);
  return out;
}

describe("CA-10 · contenido del ZIP", () => {
  it("tiene una sola entrada llamada nombreTxt, idéntica al TXT byte por byte", () => {
    const txt = txtDePrueba();
    const { zip } = empaquetar(txt, NOMBRES, FECHA);
    const entradas = unzipSync(zip);
    expect(Object.keys(entradas)).toEqual([TXT_NOMBRE]);
    expect(Array.from(entradas[TXT_NOMBRE]!)).toEqual(Array.from(txt));
  });

  it("un TXT grande (1 MiB pseudoaleatorio, poco compresible) también vuelve idéntico", () => {
    const txt = new Uint8Array(1 << 20);
    let x = 123456789;
    for (let i = 0; i < txt.length; i++) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      txt[i] = x >>> 24;
    }
    const { zip } = empaquetar(txt, NOMBRES, FECHA);
    expect(Array.from(unzipSync(zip)[TXT_NOMBRE]!)).toEqual(Array.from(txt));
  });

  it("el ZIP empieza con la firma PK 03 04 y devuelve el nombreZip recibido", () => {
    const r = empaquetar(txtDePrueba(), NOMBRES, FECHA);
    expect(Array.from(r.zip.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(r.nombreZip).toBe(ZIP_NOMBRE);
  });

  it("el resultado tiene exactamente estas claves y zip es un Uint8Array puro", () => {
    const r = empaquetar(txtDePrueba(), NOMBRES, FECHA);
    expect(Object.keys(r).sort()).toEqual(["nombreZip", "sha256Txt", "sha256Zip", "zip"]);
    expect(Object.getPrototypeOf(r.zip)).toBe(Uint8Array.prototype);
  });

  it("no muta el TXT recibido ni comparte memoria con el zip devuelto", () => {
    const txt = txtDePrueba();
    const copia = Array.from(txt);
    const r1 = empaquetar(txt, NOMBRES, FECHA);
    expect(Array.from(txt)).toEqual(copia);
    r1.zip.fill(0);
    expect(Array.from(unzipSync(empaquetar(txt, NOMBRES, FECHA).zip)[TXT_NOMBRE]!)).toEqual(copia);
  });
});

describe("CA-10 · hashes SHA-256", () => {
  it("coinciden con un SHA-256 calculado aparte, en hexadecimal minúsculo de 64 caracteres", () => {
    const txt = txtDePrueba();
    const r = empaquetar(txt, NOMBRES, FECHA);
    expect(r.sha256Txt).toBe(sha256(txt));
    expect(r.sha256Zip).toBe(sha256(r.zip));
    expect(r.sha256Txt).toMatch(/^[0-9a-f]{64}$/);
    expect(r.sha256Zip).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sha256Txt es el de los bytes del TXT: cambia con un solo byte", () => {
    const a = txtDePrueba();
    const b = txtDePrueba();
    b[10] = (b[10]! + 1) & 0xff;
    expect(empaquetar(a, NOMBRES, FECHA).sha256Txt).not.toBe(empaquetar(b, NOMBRES, FECHA).sha256Txt);
  });
});

describe("D6 · determinismo", () => {
  it("la misma fecha da exactamente el mismo ZIP y los mismos hashes", () => {
    const a = empaquetar(txtDePrueba(), NOMBRES, FECHA);
    const b = empaquetar(txtDePrueba(), NOMBRES, new Date(FECHA.getTime()));
    expect(Array.from(a.zip)).toEqual(Array.from(b.zip));
    expect(a.sha256Zip).toBe(b.sha256Zip);
    expect(a.sha256Txt).toBe(b.sha256Txt);
  });

  it("otra fecha cambia el ZIP (sello de tiempo de la entrada) pero no el hash del TXT", () => {
    const a = empaquetar(txtDePrueba(), NOMBRES, FECHA);
    const b = empaquetar(txtDePrueba(), NOMBRES, new Date("2026-11-03T10:30:00Z"));
    expect(a.sha256Zip).not.toBe(b.sha256Zip);
    expect(a.sha256Txt).toBe(b.sha256Txt);
    expect(Array.from(unzipSync(b.zip)[TXT_NOMBRE]!)).toEqual(Array.from(unzipSync(a.zip)[TXT_NOMBRE]!));
  });

  it("no usa el reloj del sistema: cambiar la hora simulada no cambia el ZIP", () => {
    const a = empaquetar(txtDePrueba(), NOMBRES, FECHA);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2001-02-03T04:05:06Z"));
      const b = empaquetar(txtDePrueba(), NOMBRES, FECHA);
      expect(Array.from(b.zip)).toEqual(Array.from(a.zip));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("D6 · el ZIP no depende del huso horario del worker (T6)", () => {
  // fflate escribe el sello DOS con la hora local; el contrato (plan 012, Ratificación) es que el
  // sello lleve los campos UTC de `fecha`, para que el mismo instante dé los mismos bytes en
  // cualquier máquina.
  const conHuso = <T>(tz: string, f: () => T): T => {
    const antes = process.env.TZ;
    process.env.TZ = tz;
    try {
      return f();
    } finally {
      if (antes === undefined) delete process.env.TZ;
      else process.env.TZ = antes;
    }
  };

  it("el mismo instante da el mismo ZIP en Lima, Tokio y UTC", () => {
    const utc = conHuso("UTC", () => empaquetar(txtDePrueba(), NOMBRES, FECHA));
    const lima = conHuso("America/Lima", () => empaquetar(txtDePrueba(), NOMBRES, FECHA));
    const tokio = conHuso("Asia/Tokyo", () => empaquetar(txtDePrueba(), NOMBRES, FECHA));
    expect(lima.sha256Zip).toBe(utc.sha256Zip);
    expect(tokio.sha256Zip).toBe(utc.sha256Zip);
  });

  it("el sello DOS de la cabecera local lleva la fecha y la hora UTC de `fecha` (2026-10-27T16:00:00Z)", () => {
    const { zip } = conHuso("America/Lima", () => empaquetar(txtDePrueba(), NOMBRES, FECHA));
    const hora = zip[10]! | (zip[11]! << 8);
    const dia = zip[12]! | (zip[13]! << 8);
    expect(hora).toBe(16 << 11);
    expect(dia).toBe(((2026 - 1980) << 9) | (10 << 5) | 27);
  });

  it("una fecha fuera del rango DOS (antes de 1980 o desde 2108, en UTC) lanza EmpaquetadoInvalidoError", () => {
    expect(() => empaquetar(txtDePrueba(), NOMBRES, new Date("1979-12-31T23:59:59Z"))).toThrow(EmpaquetadoInvalidoError);
    expect(() => empaquetar(txtDePrueba(), NOMBRES, new Date("2108-01-01T00:00:00Z"))).toThrow(EmpaquetadoInvalidoError);
    expect(() => empaquetar(txtDePrueba(), NOMBRES, new Date("1980-01-01T00:00:00Z"))).not.toThrow();
  });
});

describe("D7 · nombres (EmpaquetadoInvalidoError)", () => {
  const lanza = (nombres: { nombreTxt: string; nombreZip: string }) => {
    expect(typeof EmpaquetadoInvalidoError).toBe("function");
    expect(() => empaquetar(txtDePrueba(), nombres, FECHA)).toThrow(EmpaquetadoInvalidoError);
  };
  const ok = NOMBRES;

  it.each([
    ["con ../ al inicio", "../CONTAPP-PROVISIONAL-20700000002-202610-RCE.txt"],
    ["con barra", "a/CONTAPP-PROVISIONAL-20700000002-202610-RCE.txt"],
    ["con barra invertida", "a\\CONTAPP-PROVISIONAL-20700000002-202610-RCE.txt"],
    ["con NUL", "CONTAPP-PROVISIONAL-20700000002-202610-RCE\u0000.txt"],
    ["con salto de línea", "CONTAPP-PROVISIONAL-20700000002-202610-RCE.txt\n"],
    ["con tabulación", "CONTAPP-PROVISIONAL-20700000002\t-202610-RCE.txt"],
    ["con RUC de 10 dígitos", "CONTAPP-PROVISIONAL-2070000000-202610-RCE.txt"],
    ["con RUC de 12 dígitos", "CONTAPP-PROVISIONAL-207000000021-202610-RCE.txt"],
    ["con periodo 202613", "CONTAPP-PROVISIONAL-20700000002-202613-RCE.txt"],
    ["con otra extensión", "CONTAPP-PROVISIONAL-20700000002-202610-RCE.csv"],
    ["vacío", ""],
  ])("rechaza un nombreTxt %s", (_n, nombreTxt) => {
    lanza({ ...ok, nombreTxt });
  });

  it.each([
    ["con ../", "../CONTAPP-PROVISIONAL-20700000002-202610-RCE.zip"],
    ["con barra", "x/CONTAPP-PROVISIONAL-20700000002-202610-RCE.zip"],
    ["con control", "CONTAPP-PROVISIONAL-20700000002-202610-RCE.zip\r"],
    ["con periodo mal formado", "CONTAPP-PROVISIONAL-20700000002-20261-RCE.zip"],
    ["vacío", ""],
  ])("rechaza un nombreZip %s", (_n, nombreZip) => {
    lanza({ ...ok, nombreZip });
  });

  it("rechaza un nombreZip válido que no corresponde al nombreTxt (otro periodo, otro RUC o extensión .txt)", () => {
    lanza({ ...ok, nombreZip: "CONTAPP-PROVISIONAL-20700000002-202611-RCE.zip" });
    lanza({ ...ok, nombreZip: "CONTAPP-PROVISIONAL-20100070970-202610-RCE.zip" });
    lanza({ ...ok, nombreZip: TXT_NOMBRE });
  });

  it("rechaza nombres que no son string, un TXT que no es Uint8Array y una fecha inválida", () => {
    lanza({ nombreTxt: 1 as unknown as string, nombreZip: ZIP_NOMBRE });
    lanza({ nombreTxt: TXT_NOMBRE, nombreZip: undefined as unknown as string });
    expect(() => empaquetar(null as unknown as Uint8Array, NOMBRES, FECHA)).toThrow(EmpaquetadoInvalidoError);
    expect(() => empaquetar("texto" as unknown as Uint8Array, NOMBRES, FECHA)).toThrow(EmpaquetadoInvalidoError);
    expect(() => empaquetar(txtDePrueba(), null as unknown as typeof NOMBRES, FECHA)).toThrow(EmpaquetadoInvalidoError);
    expect(() => empaquetar(txtDePrueba(), NOMBRES, new Date("no es fecha"))).toThrow(EmpaquetadoInvalidoError);
    expect(() => empaquetar(txtDePrueba(), NOMBRES, "2026-10-27" as unknown as Date)).toThrow(EmpaquetadoInvalidoError);
  });

  it("el mensaje del error no incluye los nombres recibidos", () => {
    let e: unknown;
    try {
      empaquetar(txtDePrueba(), { ...ok, nombreTxt: "../SECRETO.txt" }, FECHA);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(EmpaquetadoInvalidoError);
    expect((e as Error).message).not.toContain("SECRETO");
    expect((e as { codigo?: string }).codigo).toMatch(/^[A-Z_]+$/);
  });
});
