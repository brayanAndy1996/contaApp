import { describe, expect, it } from "vitest";
import { informeImportacionVentasSchema, vistaPreviaVentasSchema } from "./esquemas.js";

// Spec 013 (D6; CA-10; plan: Rutas, `POST /importar/vista-previa` y `/confirmar`). Contrato fijado por estas
// pruebas, con el patrón de 007b (`importacion/esquemas.ts`): las respuestas nunca devuelven el contenido
// crudo de una celda.
//  - vistaPreviaVentasSchema: { filas: [{ n >= 1, estado: 'valida'|'error', motivos: MotivoFila[],
//    advertencias: AdvertenciaFila[] (T20a, D22) }], validas >= 0, conError >= 0, conAdvertencia >= 0 }. `motivos` es una lista cerrada de códigos (incluye 'celda_peligrosa',
//    el de una celda con fórmula); ningún campo admite texto libre ni el valor de una celda.
//  - informeImportacionVentasSchema (respuesta 201 de confirmar): { propuestaId (uuid), recibidas, nuevas,
//    iguales, distintas } enteros >= 0. Una fila ilegible rechaza todo el archivo (D3): no hay filas parciales.
//  - Claves desconocidas descartadas: ni `valor`, ni `celda`, ni `contenido`, ni el archivo sobreviven.
const U = "01920000-0000-7000-8000-0000000000a1";
const FORMULA = "=HYPERLINK(\"http://x\",\"CANARIO\")";
const PELIGROSAS = [FORMULA, "+cmd|' /C calc'!A0", "-2+3", "@SUM(1+1)", "=1+1", "\t=1+1"];

const vistaOk = {
  filas: [
    { n: 1, estado: "valida", motivos: [], advertencias: [] },
    { n: 2, estado: "error", motivos: ["celda_peligrosa"], advertencias: [] },
  ],
  validas: 1,
  conError: 1,
  conAdvertencia: 0,
};
const informeOk = { propuestaId: U, recibidas: 3, nuevas: 1, iguales: 1, distintas: 1 };

describe("vistaPreviaVentasSchema", () => {
  it("acepta una vista previa con errores por fila y la devuelve igual", () => {
    const r = vistaPreviaVentasSchema.safeParse(vistaOk);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(vistaOk);
  });

  it("acepta un archivo sin filas", () => {
    expect(vistaPreviaVentasSchema.safeParse({ filas: [], validas: 0, conError: 0, conAdvertencia: 0 }).success).toBe(true);
  });

  it("los motivos son una lista cerrada: `celda_peligrosa` vale; texto libre no", () => {
    const motivo = (m: unknown) =>
      vistaPreviaVentasSchema.safeParse({
        filas: [{ n: 1, estado: "error", motivos: [m], advertencias: [] }],
        validas: 0,
        conError: 1,
        conAdvertencia: 0,
      }).success;
    expect(motivo("celda_peligrosa")).toBe(true);
    for (const malo of ["texto libre", "", FORMULA, ...PELIGROSAS, "B001-290 mal", 1, null, {}]) {
      expect(motivo(malo), JSON.stringify(malo)).toBe(false);
    }
  });

  it.each([
    ["n = 0", { n: 0, estado: "valida", motivos: [] }],
    ["n decimal", { n: 1.5, estado: "valida", motivos: [] }],
    ["n texto", { n: "1", estado: "valida", motivos: [] }],
    ["estado desconocido", { n: 1, estado: "ok", motivos: [] }],
    ["sin motivos", { n: 1, estado: "valida" }],
    ["motivos no es lista", { n: 1, estado: "valida", motivos: "celda_peligrosa" }],
  ])("rechaza una fila con %s", (_c, fila) => {
    expect(vistaPreviaVentasSchema.safeParse({ filas: [fila], validas: 0, conError: 0 }).success).toBe(false);
  });

  it("rechaza contadores negativos, decimales o que no son números", () => {
    for (const v of [-1, 1.5, "1", null, NaN]) {
      expect(vistaPreviaVentasSchema.safeParse({ ...vistaOk, validas: v }).success, `validas=${String(v)}`).toBe(false);
      expect(vistaPreviaVentasSchema.safeParse({ ...vistaOk, conError: v }).success, `conError=${String(v)}`).toBe(false);
    }
  });

  it("ningún campo admite el contenido crudo de una celda con fórmula: se descarta o se rechaza", () => {
    for (const peligrosa of PELIGROSAS) {
      const entrada = {
        filas: [
          {
            n: 2,
            estado: "error",
            motivos: ["celda_peligrosa"],
            advertencias: [],
            valor: peligrosa,
            celda: peligrosa,
            contenido: peligrosa,
            serie: peligrosa,
            numero: peligrosa,
            clave: peligrosa,
            docContraparte: peligrosa,
            columna: peligrosa,
            raw: peligrosa,
          },
        ],
        validas: 0,
        conError: 1,
        conAdvertencia: 0,
        archivo: peligrosa,
        contenido: peligrosa,
      };
      const r = vistaPreviaVentasSchema.safeParse(entrada);
      if (r.success) {
        const texto = JSON.stringify(r.data);
        expect(texto, `se coló ${JSON.stringify(peligrosa)}`).not.toContain(peligrosa);
        expect(texto).not.toContain("CANARIO");
      }
    }
  });

  it("no deja pasar claves del archivo ni de otros estudios", () => {
    const r = vistaPreviaVentasSchema.safeParse({ ...vistaOk, tenantId: "t", clienteId: "c", buffer: "AAAA" });
    expect(r.success).toBe(true);
    expect(r.data).toEqual(vistaOk);
  });

  it("exige filas, validas, conError y conAdvertencia", () => {
    for (const campo of ["filas", "validas", "conError", "conAdvertencia"] as const) {
      const resto: Record<string, unknown> = { ...vistaOk };
      delete resto[campo];
      expect(vistaPreviaVentasSchema.safeParse(resto).success, campo).toBe(false);
    }
  });
});

describe("informeImportacionVentasSchema", () => {
  it("acepta el informe de confirmar y lo devuelve igual", () => {
    const r = informeImportacionVentasSchema.safeParse(informeOk);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(informeOk);
  });

  it("acepta 0 en todos los contadores (repetir los mismos datos da 0 nuevas)", () => {
    expect(
      informeImportacionVentasSchema.safeParse({ propuestaId: U, recibidas: 2, nuevas: 0, iguales: 2, distintas: 0 }).success,
    ).toBe(true);
  });

  it("propuestaId debe ser uuid", () => {
    for (const malo of ["no-uuid", "", 5, null, FORMULA]) {
      expect(informeImportacionVentasSchema.safeParse({ ...informeOk, propuestaId: malo }).success, JSON.stringify(malo)).toBe(false);
    }
  });

  it.each(["recibidas", "nuevas", "iguales", "distintas"])("%s: entero >= 0", (campo) => {
    for (const v of [-1, 1.5, "1", null, NaN, Infinity]) {
      expect(informeImportacionVentasSchema.safeParse({ ...informeOk, [campo]: v }).success, `${campo}=${String(v)}`).toBe(false);
    }
  });

  it("exige todos los campos", () => {
    for (const campo of Object.keys(informeOk)) {
      const resto: Record<string, unknown> = { ...informeOk };
      delete resto[campo];
      expect(informeImportacionVentasSchema.safeParse(resto).success, campo).toBe(false);
    }
  });

  it("ningún campo admite el contenido crudo de una celda: se descarta o se rechaza", () => {
    for (const peligrosa of PELIGROSAS) {
      const r = informeImportacionVentasSchema.safeParse({
        ...informeOk,
        valor: peligrosa,
        celda: peligrosa,
        contenido: peligrosa,
        archivo: peligrosa,
        noImportadas: [{ n: 2, motivo: peligrosa, valor: peligrosa }],
      });
      if (r.success) {
        expect(JSON.stringify(r.data), JSON.stringify(peligrosa)).not.toContain(peligrosa);
        expect(r.data).toEqual(informeOk);
      }
    }
  });
});
