import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { previoArchivoSchema } from "./index.js";

// Spec 012b · T2 (rojo). `GET …/archivos/previo` (plan, Contratos: HTTP; D1, D12; CA-1, CA-5, CA-10, CA-15).
// Contrato fijado por estas pruebas (previoArchivoSchema, packages/shared/src/archivos/respuestas.ts):
//  { apto, generable, motivo, errores[], erroresOmitidos, avisos[], resumen, excluidas[], excluidasOmitidas,
//    formato{id,version,oficial}, estado{estado,por,en}, huella, ultimaVersion{version,generadoEn}|null,
//    reabiertoTrasUltima }
//  - motivo: "prevalidacion_fallida"|"formato_no_oficial"|"periodo_generado"|"cliente_archivado"|null (cerrado).
//  - errores[]: {filaId: string|null, codigo, campo: string|null, destino: "DG"|"DGNG"|"DNG"|null, explicacion,
//    diferencia: monto|null, excluible: boolean}. `excluible` es obligatorio. Hasta 1.000 elementos.
//  - avisos[]: {filaId: string|null, codigo: R-ISC|R-NEW|R-GP|SALTO_CORRELATIVIDAD|RAZON_SOCIAL_RECORTADA, explicacion}.
//  - resumen: {modificadas, excluidas, agregadas (enteros >= 0), impactoIgv{DG,DGNG,DNG: monto|null, total: monto},
//    filasSinConvertir: string[]}. Ventas manda DG, DGNG y DNG en null. Montos SOLO como cadenas decimales de NUMERIC(14,2).
//  - excluidas[]: {filaId, comprobante, motivo} (ventas excluidas, D12); hasta 1.000.
//  - huella: 64 hexadecimales en minúscula. estado.por: uuid|null; estado.en: ISO|null. ultimaVersion nullable.
const HUELLA = "b".repeat(64);

const resumen = (extra: Record<string, unknown> = {}) => ({
  modificadas: 2,
  excluidas: 1,
  agregadas: 0,
  impactoIgv: { DG: "1.50", DGNG: "0.00", DNG: "0.00", total: "1.50" },
  filasSinConvertir: [],
  ...extra,
});

const error = (extra: Record<string, unknown> = {}) => ({
  filaId: randomUUID(),
  codigo: "IGV",
  campo: "igvDg",
  destino: "DG",
  explicacion: "1.61 no es 18 % ni 10 % de 21.48",
  diferencia: null,
  excluible: false,
  ...extra,
});

const previo = (extra: Record<string, unknown> = {}) => ({
  apto: true,
  generable: true,
  motivo: null,
  errores: [],
  erroresOmitidos: 0,
  avisos: [],
  resumen: resumen(),
  excluidas: [],
  excluidasOmitidas: 0,
  formato: { id: "provisional-rce", version: "1", oficial: false },
  estado: { estado: "abierto", por: null, autor: null, en: null },
  huella: HUELLA,
  ultimaVersion: null,
  reabiertoTrasUltima: false,
  ...extra,
});

const ok = (v: unknown) => previoArchivoSchema.safeParse(v).success;

describe("previoArchivoSchema: forma general", () => {
  it("acepta un previo apto y devuelve los mismos datos", () => {
    const p = previo();
    const r = previoArchivoSchema.safeParse(p);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(p);
  });

  it("acepta un previo con errores, avisos, excluidas, estado marcado y última versión (mixta, San Juan, boleta 291)", () => {
    const porId = randomUUID();
    const p = previo({
      apto: false,
      generable: false,
      motivo: "prevalidacion_fallida",
      errores: [error({ codigo: "CUADRE", campo: null, destino: null, diferencia: "-0.01", excluible: true })],
      erroresOmitidos: 3,
      avisos: [
        { filaId: randomUUID(), codigo: "R-ISC", explicacion: "San Juan: ISC" },
        { filaId: null, codigo: "SALTO_CORRELATIVIDAD", explicacion: "Falta B001-291" },
      ],
      excluidas: [{ filaId: randomUUID(), comprobante: "F001-1", motivo: "Llegó mal del SIRE" }],
      excluidasOmitidas: 2,
      estado: { estado: "revisado", por: porId, autor: { id: porId, nombre: "Ana Pérez", activo: true }, en: "2026-11-10T10:00:00.000Z" },
      ultimaVersion: { version: 2, generadoEn: "2026-11-09T10:00:00.000Z" },
      reabiertoTrasUltima: true,
    });
    expect(ok(p)).toBe(true);
  });

  it("acepta el resumen de ventas con DG, DGNG y DNG en null", () => {
    expect(ok(previo({ resumen: resumen({ impactoIgv: { DG: null, DGNG: null, DNG: null, total: "0.00" } }) }))).toBe(true);
  });

  it("falta cualquiera de los campos obligatorios -> rechazo", () => {
    for (const k of Object.keys(previo())) {
      const resto = Object.fromEntries(Object.entries(previo()).filter(([c]) => c !== k));
      expect(ok(resto), `sin ${k}`).toBe(false);
    }
  });
});

describe("previoArchivoSchema: motivo cerrado", () => {
  it("acepta los cuatro motivos y null", () => {
    for (const motivo of ["prevalidacion_fallida", "formato_no_oficial", "periodo_generado", "cliente_archivado", null]) {
      expect(ok(previo({ motivo })), String(motivo)).toBe(true);
    }
  });

  it("rechaza cualquier otro motivo", () => {
    for (const motivo of ["resumen_cambiado", "estado_invalido", "", "PERIODO_GENERADO", 1, undefined]) {
      expect(ok(previo({ motivo })), String(motivo)).toBe(false);
    }
  });
});

describe("previoArchivoSchema: montos solo como cadenas", () => {
  it("rechaza un number en cualquier monto del resumen y en la diferencia de un error", () => {
    expect(ok(previo({ resumen: resumen({ impactoIgv: { DG: 1.5, DGNG: "0.00", DNG: "0.00", total: "1.50" } }) }))).toBe(false);
    expect(ok(previo({ resumen: resumen({ impactoIgv: { DG: "1.50", DGNG: "0.00", DNG: "0.00", total: 1.5 } }) }))).toBe(false);
    expect(ok(previo({ errores: [error({ diferencia: 0.01 })] }))).toBe(false);
  });

  it("rechaza cadenas que no son NUMERIC(14,2): 3 decimales, científica, espacios y separadores", () => {
    for (const total of ["0.005", "1e3", " 1.50", "1,000.00", "", "01.50", "1.", ".5"]) {
      expect(ok(previo({ resumen: resumen({ impactoIgv: { DG: "0.00", DGNG: "0.00", DNG: "0.00", total } }) })), total).toBe(false);
    }
  });

  it("acepta montos negativos (el impacto puede restar)", () => {
    expect(ok(previo({ resumen: resumen({ impactoIgv: { DG: "-3.20", DGNG: "0.00", DNG: "0.00", total: "-3.20" } }) }))).toBe(true);
  });

  it("los conteos son enteros no negativos", () => {
    for (const k of ["modificadas", "excluidas", "agregadas"]) {
      for (const v of [-1, 1.5, "2", null]) expect(ok(previo({ resumen: resumen({ [k]: v }) })), `${k}=${String(v)}`).toBe(false);
    }
  });
});

describe("previoArchivoSchema: errores y excluidas acotados", () => {
  it("acepta 1.000 errores y rechaza 1.001", () => {
    expect(ok(previo({ errores: Array.from({ length: 1000 }, () => error()) }))).toBe(true);
    expect(ok(previo({ errores: Array.from({ length: 1001 }, () => error()) }))).toBe(false);
  });

  it("acepta 1.000 excluidas y rechaza 1.001", () => {
    const e = () => ({ filaId: randomUUID(), comprobante: "F001-1", motivo: "x" });
    expect(ok(previo({ excluidas: Array.from({ length: 1000 }, e) }))).toBe(true);
    expect(ok(previo({ excluidas: Array.from({ length: 1001 }, e) }))).toBe(false);
  });

  it("erroresOmitidos y excluidasOmitidas son enteros no negativos", () => {
    for (const k of ["erroresOmitidos", "excluidasOmitidas"]) {
      expect(ok(previo({ [k]: 0 }))).toBe(true);
      expect(ok(previo({ [k]: 25000 }))).toBe(true);
      for (const v of [-1, 0.5, "1", null]) expect(ok(previo({ [k]: v })), `${k}=${String(v)}`).toBe(false);
    }
  });

  it("cada error exige `excluible` booleano", () => {
    const sin = Object.fromEntries(Object.entries(error()).filter(([c]) => c !== "excluible"));
    expect(ok(previo({ errores: [sin] }))).toBe(false);
    expect(ok(previo({ errores: [error({ excluible: "true" })] }))).toBe(false);
    expect(ok(previo({ errores: [error({ excluible: true })] }))).toBe(true);
  });

  it("cada excluida exige filaId, comprobante y motivo", () => {
    const base = { filaId: randomUUID(), comprobante: "B001-290", motivo: "Descuadrada en el SIRE" };
    expect(ok(previo({ excluidas: [base] }))).toBe(true);
    for (const k of Object.keys(base)) {
      const resto = Object.fromEntries(Object.entries(base).filter(([c]) => c !== k));
      expect(ok(previo({ excluidas: [resto] })), `sin ${k}`).toBe(false);
    }
  });

  it("el destino de un error es DG, DGNG, DNG o null", () => {
    for (const destino of ["DG", "DGNG", "DNG", null]) expect(ok(previo({ errores: [error({ destino })] }))).toBe(true);
    expect(ok(previo({ errores: [error({ destino: "XX" })] }))).toBe(false);
  });

  it("el código de un aviso es cerrado", () => {
    for (const codigo of ["R-ISC", "R-NEW", "R-GP", "SALTO_CORRELATIVIDAD", "RAZON_SOCIAL_RECORTADA"]) {
      expect(ok(previo({ avisos: [{ filaId: null, codigo, explicacion: "x" }] })), codigo).toBe(true);
    }
    expect(ok(previo({ avisos: [{ filaId: null, codigo: "R-XX", explicacion: "x" }] }))).toBe(false);
  });
});

describe("previoArchivoSchema: huella, estado, formato y última versión", () => {
  it("la huella son 64 hexadecimales en minúscula", () => {
    for (const huella of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "z".repeat(64), "", null]) {
      expect(ok(previo({ huella })), String(huella)).toBe(false);
    }
  });

  it("ultimaVersion es nullable y, si existe, trae version >= 1 y generadoEn ISO", () => {
    expect(ok(previo({ ultimaVersion: null }))).toBe(true);
    expect(ok(previo({ ultimaVersion: { version: 1, generadoEn: "2026-11-09T10:00:00.000Z" } }))).toBe(true);
    expect(ok(previo({ ultimaVersion: { version: 0, generadoEn: "2026-11-09T10:00:00.000Z" } }))).toBe(false);
    expect(ok(previo({ ultimaVersion: { version: 1, generadoEn: "ayer" } }))).toBe(false);
    expect(ok(previo({ ultimaVersion: { version: 1 } }))).toBe(false);
    expect(ok(previo({ ultimaVersion: undefined }))).toBe(false);
  });

  it("el estado del periodo es abierto, revisado o generado, con por y en nullables", () => {
    for (const estado of ["abierto", "revisado", "generado"]) {
      expect(ok(previo({ estado: { estado, por: null, autor: null, en: null } })), estado).toBe(true);
    }
    expect(ok(previo({ estado: { estado: "cerrado", por: null, en: null } }))).toBe(false);
    expect(ok(previo({ estado: { estado: "revisado", por: "no-uuid", en: null } }))).toBe(false);
    expect(ok(previo({ estado: { estado: "revisado", por: null, en: "ayer" } }))).toBe(false);
  });

  it("el formato trae id, version y oficial booleano", () => {
    expect(ok(previo({ formato: { id: "x", version: "1", oficial: true } }))).toBe(true);
    expect(ok(previo({ formato: { id: "x", version: "1" } }))).toBe(false);
    expect(ok(previo({ formato: { id: "x", version: "1", oficial: "no" } }))).toBe(false);
  });

  it("generable, apto y reabiertoTrasUltima son booleanos", () => {
    for (const k of ["apto", "generable", "reabiertoTrasUltima"]) {
      for (const v of ["true", 1, null]) expect(ok(previo({ [k]: v })), `${k}=${String(v)}`).toBe(false);
    }
  });
});

// Spec 017 · T1 (rojo). Autor con nombre en «revisado por» del previo (D-12, CA-13): `estado.por` conserva el id y se agrega
// `estado.autor` ({id, nombre, activo} o null si nadie marcó el periodo).
describe("previoArchivoSchema · estado.autor (017)", () => {
  const por = randomUUID();
  const en = "2026-11-10T10:00:00.000Z";
  const conEstado = (estado: Record<string, unknown>) => previo({ estado });
  it("conserva por y trae el autor", () => {
    const r = previoArchivoSchema.safeParse(conEstado({ estado: "revisado", por, autor: { id: por, nombre: "Ana Pérez", activo: true }, en }));
    expect(r.success).toBe(true);
    expect(r.data?.estado).toMatchObject({ por, autor: { id: por, nombre: "Ana Pérez", activo: true } });
  });
  it("acepta un autor inactivo o desconocido (nombre null)", () => {
    expect(ok(conEstado({ estado: "revisado", por, autor: { id: por, nombre: "Ana Pérez", activo: false }, en }))).toBe(true);
    expect(ok(conEstado({ estado: "revisado", por, autor: { id: por, nombre: null, activo: false }, en }))).toBe(true);
  });
  it("exige la clave autor y rechaza un autor mal formado", () => {
    expect(ok(conEstado({ estado: "revisado", por, en }))).toBe(false);
    expect(ok(conEstado({ estado: "revisado", por, autor: { id: "x", nombre: "Ana", activo: true }, en }))).toBe(false);
  });
});
