import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  avisoNotificacionSchema,
  marcarLeidasSchema,
  noLeidasSchema,
  notificacionSchema,
  paginaNotificacionesSchema,
  TIPOS_NOTIFICACION,
} from "./esquemas.js";
import * as raiz from "../index.js";

// Spec 017 · T1 (rojo). Notificaciones y aviso en vivo (D-8, D-11, D-12; P-3, P-5; CA-12; plan, Contratos: shared, HTTP y Aviso en vivo).
// Contrato fijado por estas pruebas (packages/shared/src/notificaciones/esquemas.ts, exportado desde el índice de `shared`):
//  notificacionSchema = { id: uuid, tipo, creadaEn: ISO, leidaEn: ISO | null, cliente: { id, razonSocial } | null,
//    trabajoId: uuid | null, params } con `params` DISCRIMINADO por `tipo` y cada variante ESTRICTA:
//      credencial_invalida → { credencial: "sol" | "sire_api" }
//      trabajo_terminado   → { tipoTrabajo: string, estado: "completado" | "error", motivo: MotivoTrabajo | null }
//      plan_limite         → { recurso: "rucs" | "usuarios", umbral: 90 | 100, usado: entero ≥ 0, limite: entero ≥ 0 }
//    (claves extra o params de otro tipo = rechazo; `tipo` desconocido = rechazo)
//  TIPOS_NOTIFICACION incluye esos tres tipos.
//  paginaNotificacionesSchema = { items: notificacion[] (≤ 50), siguiente: string (cursor opaco) | null }
//  noLeidasSchema = { noLeidas: entero 0..100 } (100 se muestra «99+»)
//  marcarLeidasSchema = { hasta: ISO } ESTRICTO (usuarioId, tenantId o cualquier clave extra = rechazo; D-11)
//  avisoNotificacionSchema = { evento: "notificacion", destinatarios: uuid[1..200] } ESTRICTO, sin contenido (solo Redis)
const base = (extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  tipo: "credencial_invalida",
  creadaEn: "2026-11-11T15:30:00.000Z",
  leidaEn: null,
  cliente: { id: randomUUID(), razonSocial: "SAN JUAN SAC" },
  trabajoId: null,
  params: { credencial: "sol" },
  ...extra,
});
const ok = (v: unknown) => notificacionSchema.safeParse(v).success;

describe("notificacionSchema", () => {
  it("acepta credencial_invalida y devuelve los mismos datos", () => {
    const n = base();
    const r = notificacionSchema.safeParse(n);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(n);
  });

  it("acepta trabajo_terminado, completado (motivo null) y con error (motivo de la lista)", () => {
    const trabajoId = randomUUID();
    expect(ok(base({ tipo: "trabajo_terminado", trabajoId, params: { tipoTrabajo: "sire.propuesta.descargar", estado: "completado", motivo: null } }))).toBe(true);
    expect(ok(base({ tipo: "trabajo_terminado", trabajoId, params: { tipoTrabajo: "sire.propuesta.descargar", estado: "error", motivo: "sunat_no_responde" } }))).toBe(true);
  });

  it("acepta plan_limite al 90 % y al 100 %, sin cliente (P-5)", () => {
    for (const umbral of [90, 100])
      expect(ok(base({ tipo: "plan_limite", cliente: null, params: { recurso: "rucs", umbral, usado: 9, limite: 10 } })), String(umbral)).toBe(true);
    expect(ok(base({ tipo: "plan_limite", cliente: null, params: { recurso: "usuarios", umbral: 100, usado: 5, limite: 5 } }))).toBe(true);
  });

  it("leída lleva su instante", () => {
    expect(ok(base({ leidaEn: "2026-11-11T16:00:00.000Z" }))).toBe(true);
  });

  it("rechaza params de otro tipo", () => {
    expect(ok(base({ tipo: "credencial_invalida", params: { recurso: "rucs", umbral: 90, usado: 9, limite: 10 } }))).toBe(false);
    expect(ok(base({ tipo: "plan_limite", params: { credencial: "sol" } }))).toBe(false);
    expect(ok(base({ tipo: "trabajo_terminado", params: { credencial: "sol" } }))).toBe(false);
  });

  it("rechaza claves extra en params (nunca viaja un secreto, RUC ni razón social)", () => {
    expect(ok(base({ params: { credencial: "sol", claveSol: "centinela" } }))).toBe(false);
    expect(ok(base({ tipo: "plan_limite", params: { recurso: "rucs", umbral: 90, usado: 9, limite: 10, ruc: "20100070970" } }))).toBe(false);
    expect(ok(base({ tipo: "trabajo_terminado", params: { tipoTrabajo: "x", estado: "error", motivo: null, razonSocial: "SAN JUAN SAC" } }))).toBe(false);
  });

  it.each([
    ["tipo desconocido", { tipo: "otra_cosa" }],
    ["tipo ausente", { tipo: undefined }],
    ["credencial desconocida", { params: { credencial: "token" } }],
    ["trabajo cancelado no avisa", { tipo: "trabajo_terminado", params: { tipoTrabajo: "x", estado: "cancelado", motivo: null } }],
    ["trabajo sin tipoTrabajo", { tipo: "trabajo_terminado", params: { estado: "completado", motivo: null } }],
    ["umbral 80", { tipo: "plan_limite", params: { recurso: "rucs", umbral: 80, usado: 8, limite: 10 } }],
    ["recurso desconocido", { tipo: "plan_limite", params: { recurso: "gb", umbral: 90, usado: 9, limite: 10 } }],
    ["usado negativo", { tipo: "plan_limite", params: { recurso: "rucs", umbral: 90, usado: -1, limite: 10 } }],
    ["usado decimal", { tipo: "plan_limite", params: { recurso: "rucs", umbral: 90, usado: 9.5, limite: 10 } }],
    ["params ausente", { params: undefined }],
    ["id no es uuid", { id: "1" }],
    ["creadaEn no es ISO", { creadaEn: "ayer" }],
    ["leidaEn no es ISO", { leidaEn: "ayer" }],
    ["trabajoId no es uuid", { trabajoId: "x" }],
    ["cliente sin razón social", { cliente: { id: randomUUID() } }],
  ])("rechaza %s", (_n, extra) => {
    expect(ok(base(extra))).toBe(false);
  });

  it.each(["id", "tipo", "creadaEn", "leidaEn", "cliente", "trabajoId", "params"])("exige %s", (campo) => {
    const n: Record<string, unknown> = base();
    delete n[campo];
    expect(ok(n)).toBe(false);
  });

  it("descarta claves ajenas de la fila (tenantId, usuarioId del destinatario, claveDedupe)", () => {
    const r = notificacionSchema.safeParse(base({ tenantId: randomUUID(), usuarioId: randomUUID(), claveDedupe: "credencial_invalida:x:y" }));
    expect(r.success).toBe(true);
    for (const k of ["tenantId", "usuarioId", "claveDedupe"]) expect(r.data as Record<string, unknown>).not.toHaveProperty(k);
  });
});

describe("TIPOS_NOTIFICACION", () => {
  it("incluye los tres tipos de R1", () => {
    for (const t of ["credencial_invalida", "trabajo_terminado", "plan_limite"]) expect(TIPOS_NOTIFICACION).toContain(t);
  });
});

describe("paginaNotificacionesSchema", () => {
  it("acepta una página con cursor, la última sin cursor y 50 filas", () => {
    expect(paginaNotificacionesSchema.safeParse({ items: [base()], siguiente: "eyJhIjoxfQ" }).success).toBe(true);
    expect(paginaNotificacionesSchema.safeParse({ items: [], siguiente: null }).success).toBe(true);
    expect(paginaNotificacionesSchema.safeParse({ items: Array.from({ length: 50 }, () => base()), siguiente: null }).success).toBe(true);
  });

  it("rechaza 51 filas, un cursor que no es texto y la falta de siguiente", () => {
    expect(paginaNotificacionesSchema.safeParse({ items: Array.from({ length: 51 }, () => base()), siguiente: null }).success).toBe(false);
    expect(paginaNotificacionesSchema.safeParse({ items: [], siguiente: 1 }).success).toBe(false);
    expect(paginaNotificacionesSchema.safeParse({ items: [] }).success).toBe(false);
  });
});

describe("noLeidasSchema", () => {
  it.each([0, 1, 99, 100])("acepta %i", (n) => {
    expect(noLeidasSchema.safeParse({ noLeidas: n }).success).toBe(true);
  });
  it.each([-1, 101, 1.5, "3", null, undefined])("rechaza %j", (n) => {
    expect(noLeidasSchema.safeParse({ noLeidas: n }).success).toBe(false);
  });
  it("exige la clave", () => {
    expect(noLeidasSchema.safeParse({}).success).toBe(false);
  });
});

describe("marcarLeidasSchema", () => {
  it("acepta un instante ISO y devuelve solo hasta", () => {
    const r = marcarLeidasSchema.safeParse({ hasta: "2026-11-11T16:00:00.000Z" });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ hasta: "2026-11-11T16:00:00.000Z" });
  });

  it.each([{ usuarioId: randomUUID() }, { tenantId: randomUUID() }, { clienteId: randomUUID() }, { ids: [] }])("rechaza la clave extra %j (400, nunca cambia el actor)", (extra) => {
    expect(marcarLeidasSchema.safeParse({ hasta: "2026-11-11T16:00:00.000Z", ...extra }).success).toBe(false);
  });

  it.each([{}, { hasta: "ayer" }, { hasta: 1731340800000 }, { hasta: null }])("rechaza %j", (v) => {
    expect(marcarLeidasSchema.safeParse(v).success).toBe(false);
  });
});

describe("avisoNotificacionSchema", () => {
  const aviso = (extra: Record<string, unknown> = {}) => ({ evento: "notificacion", destinatarios: [randomUUID()], ...extra });
  const okA = (v: unknown) => avisoNotificacionSchema.safeParse(v).success;

  it("acepta un aviso con 1 y con 200 destinatarios", () => {
    expect(okA(aviso())).toBe(true);
    expect(okA(aviso({ destinatarios: Array.from({ length: 200 }, () => randomUUID()) }))).toBe(true);
  });

  it("rechaza 0 y 201 destinatarios", () => {
    expect(okA(aviso({ destinatarios: [] }))).toBe(false);
    expect(okA(aviso({ destinatarios: Array.from({ length: 201 }, () => randomUUID()) }))).toBe(false);
  });

  it("rechaza destinatarios que no son uuid, otro evento y la falta de campos", () => {
    expect(okA(aviso({ destinatarios: ["x"] }))).toBe(false);
    expect(okA(aviso({ evento: "trabajo" }))).toBe(false);
    expect(okA({ destinatarios: [randomUUID()] })).toBe(false);
    expect(okA({ evento: "notificacion" })).toBe(false);
  });

  it("no admite otras claves: el aviso viaja sin contenido (tipo, params, tenantId, razón social)", () => {
    for (const extra of [{ tipo: "plan_limite" }, { params: {} }, { tenantId: randomUUID() }, { razonSocial: "SAN JUAN SAC" }, { contenido: "x" }])
      expect(okA(aviso(extra)), JSON.stringify(extra)).toBe(false);
  });
});

describe("índice de shared", () => {
  it("exporta los esquemas de notificaciones", () => {
    const r = raiz as Record<string, unknown>;
    expect(r.notificacionSchema).toBe(notificacionSchema);
    expect(r.noLeidasSchema).toBe(noLeidasSchema);
    expect(r.marcarLeidasSchema).toBe(marcarLeidasSchema);
    expect(r.avisoNotificacionSchema).toBe(avisoNotificacionSchema);
    expect(r.paginaNotificacionesSchema).toBe(paginaNotificacionesSchema);
  });
});
