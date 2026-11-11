import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { autorSchema } from "./autor.js";
import * as raiz from "./index.js";

// Spec 017 · T1 (rojo). Autor con nombre (D-12, CA-13; plan, Contratos: shared).
// Contrato fijado por estas pruebas (packages/shared/src/autor.ts, exportado desde el índice de `shared`):
//  autorSchema = { id: uuid, nombre: string | null, activo: boolean }
//  - `nombre: null` es «Usuario desconocido» (id que no es miembro del estudio): la clave es obligatoria, el valor puede ser null.
//  - `activo: false` con nombre = miembro desactivado («Nombre (inactivo)»).
//  - Las claves desconocidas (correo, rol, hash) se descartan: el autor nunca filtra más que id, nombre y activo.
const ok = (v: unknown) => autorSchema.safeParse(v).success;

describe("autorSchema", () => {
  it("acepta un miembro activo y devuelve los mismos datos", () => {
    const a = { id: randomUUID(), nombre: "Ana Pérez", activo: true };
    const r = autorSchema.safeParse(a);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(a);
  });

  it("acepta un miembro desactivado con su nombre", () => {
    expect(ok({ id: randomUUID(), nombre: "Luis Ríos", activo: false })).toBe(true);
  });

  it("nombre null es el usuario desconocido (un id ajeno al estudio)", () => {
    expect(ok({ id: randomUUID(), nombre: null, activo: false })).toBe(true);
  });

  it.each([
    ["id no es uuid", { id: "pepe", nombre: "Ana", activo: true }],
    ["sin id", { nombre: "Ana", activo: true }],
    ["nombre ausente (debe ser texto o null explícito)", { id: randomUUID(), activo: true }],
    ["nombre no es texto", { id: randomUUID(), nombre: 7, activo: true }],
    ["activo no es booleano", { id: randomUUID(), nombre: "Ana", activo: "si" }],
    ["sin activo", { id: randomUUID(), nombre: "Ana" }],
  ])("rechaza %s", (_n, v) => {
    expect(ok(v)).toBe(false);
  });

  it("descarta correo, rol y cualquier otra clave", () => {
    const r = autorSchema.safeParse({ id: randomUUID(), nombre: "Ana", activo: true, correo: "ana@estudio.pe", rol: "dueno", tenantId: randomUUID() });
    expect(r.success).toBe(true);
    expect(Object.keys(r.data ?? {}).sort()).toEqual(["activo", "id", "nombre"]);
  });

  it("se exporta desde el índice de shared", () => {
    expect((raiz as Record<string, unknown>).autorSchema).toBe(autorSchema);
  });
});
