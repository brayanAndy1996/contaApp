// Spec 014 T18 · correcciones de la ronda adversarial que viven en los esquemas (rojo hasta T20).
//  - H-014-3: la razón social al agregar, el motivo de exclusión (individual y masivo) y la búsqueda `q` del listado no admiten
//    caracteres de control (categoría Unicode Cc: C0, DEL y C1). PostgreSQL rechaza el NUL en `text` y la ruta respondía 500
//    `error_interno`; con el esquema la ruta responde 400. Tabulación y saltos de línea no se fijan aquí: la spec no los decide.
//  - DU-23 (usuario 2026-11-07): reabrir lleva el estado que vio quien lo pide, `reabrirPeriodoSchema` = { estadoVisto }, y solo
//    admite `revisado` o `generado` (no se reabre un periodo que ya está abierto).
import { describe, expect, it } from "vitest";
import * as compras from "./index.js";
import { agregarCompraSchema, excluirCompraSchema, listarComprasSchema, masivaExcluirSchema } from "./index.js";

const CONTROLES: [string, string][] = [
  ["NUL (U+0000)", "\u0000"],
  ["SOH (U+0001)", "\u0001"],
  ["BEL (U+0007)", "\u0007"],
  ["backspace (U+0008)", "\u0008"],
  ["tabulación vertical (U+000B)", "\u000b"],
  ["salto de página (U+000C)", "\u000c"],
  ["ESC (U+001B)", "\u001b"],
  ["US (U+001F)", "\u001f"],
  ["DEL (U+007F)", "\u007f"],
  ["NEL, de control C1 (U+0085)", "\u0085"],
  ["APC, de control C1 (U+009F)", "\u009f"],
];
const NORMALES = [
  "ACME SAC",
  "Distribuidora Peña & Hijos S.A.C.",
  "Ñandú «Perú» — 'sucursal' \"2\" ✔",
  "<b>HTML</b> =1+1 se guarda tal cual (texto no confiable)",
];

const alta = (razonSocial: string) => ({
  tipo: "01",
  serie: "F001",
  numero: "1",
  proveedor: { tipo: "6", numero: "20100070970", razonSocial },
  fecha: "2026-10-15",
  moneda: "PEN",
  montos: { biDg: "100.00", igvDg: "18.00" },
});
const ITEMS = [{ compraId: "0198f6c0-0000-7000-8000-000000000001", versionBase: 1 }];

describe("H-014-3 · la razón social de una compra agregada no admite caracteres de control", () => {
  it.each(CONTROLES)("%s: rechazado, al inicio, en medio y al final", (_n, c) => {
    for (const rs of [`${c}ACME SAC`, `ACME${c} SAC`, `ACME SAC${c}`]) {
      const r = agregarCompraSchema.safeParse(alta(rs));
      expect(r.success, JSON.stringify(rs)).toBe(false);
    }
  });

  it("el rechazo cuelga de proveedor.razonSocial", () => {
    const r = agregarCompraSchema.safeParse(alta("ACME\u0000 SAC"));
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.join(".") === "proveedor.razonSocial")).toBe(true);
  });

  it("caso feliz: tildes, ñ, comillas, emoji, HTML y fórmulas se aceptan tal cual", () => {
    for (const rs of NORMALES) {
      const r = agregarCompraSchema.safeParse(alta(rs));
      expect(r.success, rs).toBe(true);
      expect(r.data?.proveedor.razonSocial).toBe(rs);
    }
  });

  it("las reglas anteriores siguen: vacía y de más de 100 caracteres se rechazan; 100 se aceptan", () => {
    expect(agregarCompraSchema.safeParse(alta("")).success).toBe(false);
    expect(agregarCompraSchema.safeParse(alta("a".repeat(101))).success).toBe(false);
    expect(agregarCompraSchema.safeParse(alta("a".repeat(100))).success).toBe(true);
  });
});

describe("H-014-3 · el motivo de exclusión no admite caracteres de control (individual y masiva)", () => {
  it.each(CONTROLES)("%s: rechazado en excluir y en la masiva de excluir", (_n, c) => {
    for (const motivo of [`${c}no es del giro`, `no es${c} del giro`, `no es del giro${c}`]) {
      expect(excluirCompraSchema.safeParse({ versionBase: 1, motivo }).success, `excluir ${JSON.stringify(motivo)}`).toBe(false);
      expect(masivaExcluirSchema.safeParse({ items: ITEMS, motivo }).success, `masiva ${JSON.stringify(motivo)}`).toBe(false);
    }
  });

  it("caso feliz: un motivo con tildes y comillas, o ausente, se acepta; el máximo sigue siendo 200", () => {
    for (const motivo of ["No es del giro: «gasto personal» — nº 3", "a".repeat(200)]) {
      expect(excluirCompraSchema.safeParse({ versionBase: 1, motivo }).data?.motivo).toBe(motivo);
      expect(masivaExcluirSchema.safeParse({ items: ITEMS, motivo }).data?.motivo).toBe(motivo);
    }
    expect(excluirCompraSchema.safeParse({ versionBase: 1 }).success).toBe(true);
    expect(masivaExcluirSchema.safeParse({ items: ITEMS }).success).toBe(true);
    expect(excluirCompraSchema.safeParse({ versionBase: 1, motivo: "a".repeat(201) }).success).toBe(false);
  });
});

describe("H-014-3 · la búsqueda q del listado no admite caracteres de control", () => {
  it.each(CONTROLES)("%s: rechazado", (_n, c) => {
    for (const q of [`${c}20100`, `AC${c}ME`, `ACME${c}`]) {
      expect(listarComprasSchema.safeParse({ q }).success, JSON.stringify(q)).toBe(false);
    }
  });

  it("caso feliz: prefijo de RUC, fragmento con tilde y serie-número se aceptan; el máximo sigue siendo 100", () => {
    for (const q of ["20100070970", "peña & hijos", "F001-123", "a".repeat(100)]) {
      expect(listarComprasSchema.safeParse({ q }).data?.q).toBe(q);
    }
    expect(listarComprasSchema.safeParse({}).success).toBe(true);
    expect(listarComprasSchema.safeParse({ q: "a".repeat(101) }).success).toBe(false);
  });
});

describe("DU-23 · reabrirPeriodoSchema: el estado que vio quien reabre", () => {
  const esquema = (): { safeParse: (v: unknown) => { success: boolean; data?: unknown } } => {
    const e = (compras as Record<string, unknown>).reabrirPeriodoSchema;
    expect(e, "@contapp/shared debe exportar reabrirPeriodoSchema (DU-23)").toBeDefined();
    return e as never;
  };

  it("acepta revisado y generado y conserva el valor", () => {
    for (const estadoVisto of ["revisado", "generado"]) {
      const r = esquema().safeParse({ estadoVisto });
      expect(r.success, estadoVisto).toBe(true);
      expect(r.data).toEqual({ estadoVisto });
    }
  });

  it("rechaza abierto (nada que reabrir), otro texto, número, null, mayúsculas y sin el campo", () => {
    const e = esquema();
    for (const v of [
      { estadoVisto: "abierto" },
      { estadoVisto: "cerrado" },
      { estadoVisto: "Revisado" },
      { estadoVisto: "" },
      { estadoVisto: 1 },
      { estadoVisto: null },
      { estadoVisto: ["revisado"] },
      {},
      { estado: "revisado" },
    ]) {
      expect(e.safeParse(v).success, JSON.stringify(v)).toBe(false);
    }
  });

  it("las claves desconocidas no viajan a los datos (un tenantId o usuarioId del cuerpo se descarta)", () => {
    const r = esquema().safeParse({ estadoVisto: "revisado", tenantId: "x", usuarioId: "y" });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ estadoVisto: "revisado" });
  });
});
