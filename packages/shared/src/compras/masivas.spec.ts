import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_ITEMS_MASIVA,
  masivaAceptarSchema,
  masivaClasificarSchema,
  masivaExcluirSchema,
  masivaRestaurarSchema,
} from "./index.js";

// Spec 014 · T2 (rojo). Cuerpos de las acciones masivas (D-15, DU-5, DU-6; CA-18). Contrato fijado por estas
// pruebas (plan 014, Contratos: HTTP; packages/shared/src/compras/, exportado por compras/index.ts):
//  - MAX_ITEMS_MASIVA = 5000.
//  - Cada cuerpo lleva `items`: arreglo de {compraId: uuid, versionBase: entero >= 1}, de 1 a 5000 elementos
//    (5001 se rechaza: 400), sin `compraId` repetido (aunque cambie el versionBase).
//  - masivaClasificarSchema {items, destino: "DG" | "DGNG" | "DNG"}; masivaAceptarSchema {items, regla}
//    (regla ∈ R-ISC | R-MIX | R-RED | R-NEW | R-GP; NO lleva `confirmar` ni `dato`: en masa solo se aceptan
//    las que no los piden, así que si llegan se descartan); masivaExcluirSchema {items, motivo?} (motivo hasta
//    200 caracteres); masivaRestaurarSchema {items}.
//  - Las claves desconocidas se descartan (z.object).
interface Esquema {
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
}
const ok = (s: Esquema, v: unknown) => s.safeParse(v).success;
const datos = (s: Esquema, v: unknown) => {
  const r = s.safeParse(v);
  expect(r.success).toBe(true);
  return r.data as Record<string, unknown>;
};
const items = (n: number, versionBase = 1) => Array.from({ length: n }, () => ({ compraId: randomUUID(), versionBase }));

const cuerpos = [
  ["clasificar", masivaClasificarSchema, { destino: "DNG" }],
  ["aceptar", masivaAceptarSchema, { regla: "R-RED" }],
  ["excluir", masivaExcluirSchema, { motivo: "consumo personal" }],
  ["restaurar", masivaRestaurarSchema, {}],
] as const;

describe("MAX_ITEMS_MASIVA", () => {
  it("es 5000", () => {
    expect(MAX_ITEMS_MASIVA).toBe(5000);
  });
});

describe.each(cuerpos)("masiva de %s: items", (_nombre, esquema, extra) => {
  const con = (its: unknown) => ({ ...extra, items: its });

  it("acepta una fila", () => {
    expect(ok(esquema, con(items(1)))).toBe(true);
  });

  it("acepta 12 filas (el caso de CA-18)", () => {
    expect(ok(esquema, con(items(12)))).toBe(true);
  });

  it("acepta exactamente 5.000 filas", () => {
    expect(ok(esquema, con(items(5000)))).toBe(true);
  });

  it("rechaza 5.001 filas (400)", () => {
    expect(ok(esquema, con(items(5001)))).toBe(false);
  });

  it("rechaza ids repetidos", () => {
    const [a, b] = items(2) as [{ compraId: string; versionBase: number }, { compraId: string; versionBase: number }];
    expect(ok(esquema, con([a, b, { ...a }]))).toBe(false);
  });

  it("rechaza el mismo id con otro versionBase", () => {
    const [a] = items(1) as [{ compraId: string; versionBase: number }];
    expect(ok(esquema, con([a, { compraId: a.compraId, versionBase: 2 }]))).toBe(false);
  });

  it("rechaza un repetido escondido entre muchas filas", () => {
    const filas = items(4999);
    expect(ok(esquema, con([...filas, { ...(filas[0] as object) }]))).toBe(false);
  });

  it("rechaza un compraId que no es uuid", () => {
    expect(ok(esquema, con([{ compraId: "123", versionBase: 1 }]))).toBe(false);
    expect(ok(esquema, con([{ compraId: "", versionBase: 1 }]))).toBe(false);
    expect(ok(esquema, con([{ compraId: 5, versionBase: 1 }]))).toBe(false);
  });

  it.each([0, -1, 1.5, "1", null, undefined])("rechaza un versionBase inválido (%j)", (v) => {
    expect(ok(esquema, con([{ compraId: randomUUID(), versionBase: v }]))).toBe(false);
  });

  it("rechaza una fila sin versionBase o sin compraId", () => {
    expect(ok(esquema, con([{ compraId: randomUUID() }]))).toBe(false);
    expect(ok(esquema, con([{ versionBase: 1 }]))).toBe(false);
  });

  it("rechaza items que no es arreglo o falta", () => {
    expect(ok(esquema, con("x"))).toBe(false);
    expect(ok(esquema, con(null))).toBe(false);
    expect(ok(esquema, con({}))).toBe(false);
    expect(ok(esquema, extra)).toBe(false);
  });

  it("descarta claves desconocidas del cuerpo y de cada fila", () => {
    const d = datos(esquema, { ...extra, tenantId: randomUUID(), items: [{ compraId: randomUUID(), versionBase: 1, clienteId: randomUUID() }] });
    expect(d).not.toHaveProperty("tenantId");
    expect(Object.keys((d.items as object[])[0] as object).sort()).toEqual(["compraId", "versionBase"]);
  });

  it("conserva el orden de las filas", () => {
    const filas = items(5);
    const d = datos(esquema, con(filas));
    expect((d.items as { compraId: string }[]).map((i) => i.compraId)).toEqual(filas.map((i) => i.compraId));
  });
});

describe("masiva de clasificar: destino", () => {
  it.each(["DG", "DGNG", "DNG"])("acepta %j", (destino) => {
    expect(ok(masivaClasificarSchema, { items: items(1), destino })).toBe(true);
  });
  it.each(["XX", "dg", "", null, undefined, 1])("rechaza %j", (destino) => {
    expect(ok(masivaClasificarSchema, { items: items(1), destino })).toBe(false);
  });
});

describe("masiva de aceptar: regla, sin confirmar ni dato", () => {
  it.each(["R-ISC", "R-MIX", "R-RED", "R-NEW", "R-GP"])("acepta la regla %s", (regla) => {
    expect(ok(masivaAceptarSchema, { items: items(1), regla })).toBe(true);
  });
  it.each(["R-HIS", "r-red", "", null, undefined])("rechaza la regla %j", (regla) => {
    expect(ok(masivaAceptarSchema, { items: items(1), regla })).toBe(false);
  });
  it("descarta confirmar y dato si llegan (en masa nunca hay confirmación ni dato)", () => {
    const d = datos(masivaAceptarSchema, { items: items(1), regla: "R-RED", confirmar: true, dato: { gravado: "8.97" } });
    expect(d).not.toHaveProperty("confirmar");
    expect(d).not.toHaveProperty("dato");
  });
});

describe("masiva de excluir: motivo", () => {
  it("el motivo es opcional", () => {
    expect(ok(masivaExcluirSchema, { items: items(1) })).toBe(true);
  });
  it("200 caracteres sí, 201 no", () => {
    expect(ok(masivaExcluirSchema, { items: items(1), motivo: "a".repeat(200) })).toBe(true);
    expect(ok(masivaExcluirSchema, { items: items(1), motivo: "a".repeat(201) })).toBe(false);
  });
  it("un motivo que no es texto se rechaza", () => {
    expect(ok(masivaExcluirSchema, { items: items(1), motivo: 5 })).toBe(false);
  });
});
