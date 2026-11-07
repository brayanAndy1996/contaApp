import { describe, expect, it } from "vitest";
import * as esquemas from "./esquemas.js";
import { MOTIVOS_ADVERTENCIA_VENTA, MOTIVOS_FILA_VENTA, vistaPreviaVentasSchema } from "./esquemas.js";

// Spec 013 (D6; CA-10; plan: Rutas, `POST /importar/vista-previa` y `/confirmar`). Contrato fijado por estas
// pruebas, con el patrón de 007b (`importacion/esquemas.ts`): las respuestas nunca devuelven el contenido
// crudo de una celda.
//  - vistaPreviaVentasSchema: { filas: [{ n >= 1, estado: 'valida'|'error', motivos: MotivoFila[],
//    advertencias: AdvertenciaFila[] (T20a, D22) }], validas >= 0, conError >= 0, conAdvertencia >= 0 }. `motivos` es una lista cerrada de códigos (incluye 'celda_peligrosa',
//    el de una celda con fórmula); ningún campo admite texto libre ni el valor de una celda.
//  - T22a (T22, punto 2): `informeImportacionVentasSchema` se ELIMINA (nadie lo usa y su forma no es la del 201
//    real, que es `{ propuesta: PropuestaVentasDto }`). Los motivos `descuadre`, `tipo_cambio_requerido` y
//    `duplicado_en_archivo` salen de MOTIVOS_FILA_VENTA: los dos primeros viven solo como advertencias (D22) y el
//    tercero no existe desde D18. Una fila ilegible rechaza todo el archivo (D3): no hay filas parciales.
//  - Claves desconocidas descartadas: ni `valor`, ni `celda`, ni `contenido`, ni el archivo sobreviven.
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

describe("T22a: esquemas y motivos sin uso", () => {
  it("`informeImportacionVentasSchema` ya no existe en shared", () => {
    expect(esquemas).not.toHaveProperty("informeImportacionVentasSchema");
  });

  it.each(["descuadre", "tipo_cambio_requerido", "duplicado_en_archivo"])(
    "`%s` no es un motivo de error de fila",
    (motivo) => {
      expect(MOTIVOS_FILA_VENTA as readonly string[]).not.toContain(motivo);
    },
  );

  it("los motivos de error vivos siguen siendo la lista cerrada de siempre, en orden", () => {
    expect([...MOTIVOS_FILA_VENTA]).toEqual([
      "campo_obligatorio",
      "tipo_invalido",
      "serie_invalida",
      "numero_invalido",
      "fecha_invalida",
      "moneda_invalida",
      "tipo_cambio_invalido",
      "documento_invalido",
      "monto_invalido",
      "celda_peligrosa",
    ]);
  });

  it("`descuadre` y `tipo_cambio_requerido` solo quedan como advertencias", () => {
    expect([...MOTIVOS_ADVERTENCIA_VENTA]).toEqual(["descuadre", "tipo_cambio_requerido"]);
    for (const motivo of ["descuadre", "tipo_cambio_requerido"]) {
      expect(vistaPreviaVentasSchema.safeParse({
        filas: [{ n: 1, estado: "error", motivos: [motivo], advertencias: [] }],
        validas: 0, conError: 1, conAdvertencia: 0,
      }).success, motivo).toBe(false);
    }
  });
});
