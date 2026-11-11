import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ACCIONES_AUDITORIA } from "./acciones.js";
import { cambiosClienteAuditoriaSchema, filaAuditoriaSchema, paginaAuditoriaSchema } from "./esquemas.js";
import * as raiz from "../index.js";

// Spec 017 · T1 (rojo). Fila y página de la consulta de auditoría (P-2, CA-14; plan, Contratos: shared y HTTP).
// Contrato fijado por estas pruebas (packages/shared/src/auditoria/esquemas.ts, exportado desde el índice de `shared`):
//  filaAuditoriaSchema = { id: uuid, ocurridaEn: ISO, accion: ACCIONES_AUDITORIA,
//    actor: { tipo: "usuario" | "trabajo" | "sistema", autor: Autor | null, trabajoId: uuid | null },
//    cliente: { id: uuid, ruc: string, razonSocial: string } | null, entidad: string, entidadId: uuid, datos: objeto }
//  paginaAuditoriaSchema = { items: filaAuditoria[] (≤ 50), siguiente: string (cursor opaco) | null }
//  - Las claves desconocidas (tenantId, usuario_id crudo) se descartan.
const autor = { id: randomUUID(), nombre: "Ana Pérez", activo: true };
const fila = (extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  ocurridaEn: "2026-11-11T15:30:00.000Z",
  accion: "cliente.editado",
  actor: { tipo: "usuario", autor, trabajoId: null },
  cliente: { id: randomUUID(), ruc: "20100070970", razonSocial: "SAN JUAN SAC" },
  entidad: "cliente",
  entidadId: randomUUID(),
  datos: { cambios: { razon_social: ["VIEJA SAC", "SAN JUAN SAC"] } },
  objetivo: null,
  ...extra,
});
const ok = (v: unknown) => filaAuditoriaSchema.safeParse(v).success;

describe("filaAuditoriaSchema", () => {
  it("acepta una fila de usuario y devuelve los mismos datos", () => {
    const f = fila();
    const r = filaAuditoriaSchema.safeParse(f);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(f);
  });

  it("acepta cada acción del catálogo", () => {
    for (const accion of ACCIONES_AUDITORIA) expect(ok(fila({ accion })), accion).toBe(true);
  });

  it("acepta un actor de trabajo (con el usuario que lo lanzó) y uno de sistema", () => {
    expect(ok(fila({ actor: { tipo: "trabajo", autor, trabajoId: randomUUID() } }))).toBe(true);
    expect(ok(fila({ actor: { tipo: "trabajo", autor: null, trabajoId: randomUUID() } }))).toBe(true);
    expect(ok(fila({ actor: { tipo: "sistema", autor: null, trabajoId: null } }))).toBe(true);
  });

  it("acepta un actor con autor desconocido (nombre null) y una fila sin cliente (sesión, miembros)", () => {
    expect(ok(fila({ actor: { tipo: "usuario", autor: { id: randomUUID(), nombre: null, activo: false }, trabajoId: null } }))).toBe(true);
    expect(ok(fila({ accion: "sesion.ingreso", cliente: null, entidad: "sesion", datos: {} }))).toBe(true);
  });

  it("los datos son un objeto: un arreglo, un texto o null se rechazan", () => {
    for (const datos of [[], "texto", null, 5]) expect(ok(fila({ datos })), JSON.stringify(datos)).toBe(false);
  });

  it.each([
    ["acción fuera del catálogo", { accion: "cliente.borrado" }],
    ["tipo de actor desconocido", { actor: { tipo: "robot", autor: null, trabajoId: null } }],
    ["id no es uuid", { id: "1" }],
    ["fecha no es ISO", { ocurridaEn: "ayer" }],
    ["entidadId no es uuid", { entidadId: "x" }],
    ["trabajoId no es uuid", { actor: { tipo: "trabajo", autor: null, trabajoId: "x" } }],
    ["autor sin activo", { actor: { tipo: "usuario", autor: { id: randomUUID(), nombre: "Ana" }, trabajoId: null } }],
    ["cliente sin ruc", { cliente: { id: randomUUID(), razonSocial: "X" } }],
    ["cliente sin id", { cliente: { ruc: "20100070970", razonSocial: "X" } }],
  ])("rechaza %s", (_n, extra) => {
    expect(ok(fila(extra))).toBe(false);
  });

  it.each(["id", "ocurridaEn", "accion", "actor", "cliente", "entidad", "entidadId", "datos"])("exige %s", (campo) => {
    const f: Record<string, unknown> = fila();
    delete f[campo];
    expect(ok(f)).toBe(false);
  });

  it("descarta claves ajenas (tenantId, usuarioId crudo)", () => {
    const r = filaAuditoriaSchema.safeParse(fila({ tenantId: randomUUID(), usuarioId: randomUUID() }));
    expect(r.success).toBe(true);
    expect(r.data as Record<string, unknown>).not.toHaveProperty("tenantId");
    expect(r.data as Record<string, unknown>).not.toHaveProperty("usuarioId");
  });
});

// Spec 017 · T18a-servidor (P-4). `objetivo`: el autor AFECTADO por miembro.*, asignacion.* e invitacion.* (misma forma que
// `actor.autor`, D-12), o null cuando el sujeto no es otro usuario o no se conoce. Nunca lleva el correo de una invitación (D-5).
describe("filaAuditoriaSchema · objetivo", () => {
  it("acepta un autor (activo, inactivo o desconocido) o null", () => {
    expect(ok(fila({ objetivo: null }))).toBe(true);
    expect(ok(fila({ accion: "miembro.rol_cambiado", objetivo: autor }))).toBe(true);
    expect(ok(fila({ objetivo: { id: randomUUID(), nombre: "Baja Pérez", activo: false } }))).toBe(true);
    expect(ok(fila({ objetivo: { id: randomUUID(), nombre: null, activo: false } }))).toBe(true);
  });

  it("es obligatorio (null o autor) y no admite formas ajenas", () => {
    const sinObjetivo: Record<string, unknown> = fila();
    delete sinObjetivo.objetivo;
    expect(ok(sinObjetivo)).toBe(false);
    expect(ok(fila({ objetivo: "Ana" }))).toBe(false);
    expect(ok(fila({ objetivo: { id: "no-uuid", nombre: "Ana", activo: true } }))).toBe(false);
    expect(ok(fila({ objetivo: { id: randomUUID(), activo: true } }))).toBe(false);
  });

  it("descarta el correo de una invitación aunque llegue en el objetivo", () => {
    const r = filaAuditoriaSchema.safeParse(fila({ objetivo: { ...autor, correo: "x@y.pe", email: "x@y.pe" } }));
    expect(r.success).toBe(true);
    expect(JSON.stringify(r.data)).not.toContain("x@y.pe");
    expect(r.data?.objetivo).toEqual(autor);
  });
});

// `datos.cambios` de `cliente.editado`: { columna: [antes, despues] } con las columnas de datos y de perfil fiscal que fija el trigger.
describe("cambiosClienteAuditoriaSchema", () => {
  it("acepta pares [antes, después] de texto, booleano o null", () => {
    expect(cambiosClienteAuditoriaSchema.safeParse({ razon_social: ["VIEJA SAC", "NUEVA SAC"] }).success).toBe(true);
    expect(cambiosClienteAuditoriaSchema.safeParse({ ventas_exoneradas: [false, true], regimen: [null, "RER"] }).success).toBe(true);
  });

  it("rechaza un valor suelto, un par de otro largo o un objeto anidado", () => {
    expect(cambiosClienteAuditoriaSchema.safeParse({ razon_social: "NUEVA SAC" }).success).toBe(false);
    expect(cambiosClienteAuditoriaSchema.safeParse({ razon_social: ["A"] }).success).toBe(false);
    expect(cambiosClienteAuditoriaSchema.safeParse({ razon_social: ["A", "B", "C"] }).success).toBe(false);
    expect(cambiosClienteAuditoriaSchema.safeParse({ razon_social: [{ x: 1 }, "B"] }).success).toBe(false);
  });

  it("la fila cliente.editado conserva datos.cambios tal como llega", () => {
    const cambios = { zona: ["LIMA", "ICA"], razon_social: ["VIEJA SAC", "NUEVA SAC"] };
    const r = filaAuditoriaSchema.safeParse(fila({ datos: { cambios } }));
    expect(r.data?.datos).toEqual({ cambios });
    expect(cambiosClienteAuditoriaSchema.safeParse((r.data?.datos as { cambios: unknown }).cambios).success).toBe(true);
  });
});

describe("paginaAuditoriaSchema", () => {
  const f = fila();
  it("acepta una página con cursor y la última sin cursor", () => {
    expect(paginaAuditoriaSchema.safeParse({ items: [f], siguiente: "eyJhIjoxfQ" }).success).toBe(true);
    expect(paginaAuditoriaSchema.safeParse({ items: [], siguiente: null }).success).toBe(true);
  });

  it("admite hasta 50 filas, no 51 (CA-12)", () => {
    expect(paginaAuditoriaSchema.safeParse({ items: Array.from({ length: 50 }, () => fila()), siguiente: null }).success).toBe(true);
    expect(paginaAuditoriaSchema.safeParse({ items: Array.from({ length: 51 }, () => fila()), siguiente: null }).success).toBe(false);
  });

  it("exige siguiente (null o texto) e items", () => {
    expect(paginaAuditoriaSchema.safeParse({ items: [f] }).success).toBe(false);
    expect(paginaAuditoriaSchema.safeParse({ siguiente: null }).success).toBe(false);
    expect(paginaAuditoriaSchema.safeParse({ items: [f], siguiente: 3 }).success).toBe(false);
  });
});

describe("índice de shared", () => {
  it("exporta el catálogo y los esquemas de auditoría", () => {
    const r = raiz as Record<string, unknown>;
    expect(r.ACCIONES_AUDITORIA).toBe(ACCIONES_AUDITORIA);
    expect(r.filaAuditoriaSchema).toBe(filaAuditoriaSchema);
    expect(r.paginaAuditoriaSchema).toBe(paginaAuditoriaSchema);
  });
});
