import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ACCIONES_AUDITORIA } from "./acciones.js";
import {
  consultaAuditoriaSchema,
  consultaOpcionesAuditoriaSchema,
  opcionesAuditoriaSchema,
  rangoLima,
} from "./consulta.js";
import * as raiz from "../index.js";

// Spec 031 · T2 (rojo). Consulta de auditoría con filtros (D-2, CA-2, CA-7; plan, Contratos: Shared).
// Contrato fijado por estas pruebas (packages/shared/src/auditoria/consulta.ts, exportado desde el índice de `shared`):
//  consultaAuditoriaSchema (estricto) = { usuarioId?: uuid, clienteId?: uuid, accion?: 1–10 de ACCIONES_AUDITORIA sin repetir
//    (un string suelto se toma como lista de uno), desde?/hasta?: AAAA-MM-DD de calendario real, desde ≤ hasta, cursor?: string }
//  consultaOpcionesAuditoriaSchema (estricto) = { q?: string 1–60, clienteId?: uuid }
//  opcionesAuditoriaSchema = { miembros: {id, nombre, activo}[], clientes: {id, ruc, razonSocial, archivado}[] }
//  rangoLima(desde?, hasta?) → { desde: Date | null, hastaExclusivo: Date | null } con UTC−05:00 fijo.
const ok = (v: unknown) => consultaAuditoriaSchema.safeParse(v).success;
const okOpc = (v: unknown) => consultaOpcionesAuditoriaSchema.safeParse(v).success;

describe("consultaAuditoriaSchema · forma válida", () => {
  it("acepta la consulta vacía (sin filtros)", () => {
    expect(ok({})).toBe(true);
  });

  it("acepta todos los filtros juntos y devuelve los mismos valores", () => {
    const usuarioId = randomUUID();
    const clienteId = randomUUID();
    const r = consultaAuditoriaSchema.safeParse({
      usuarioId,
      clienteId,
      accion: ["cliente.editado", "periodo.estado_cambiado"],
      desde: "2026-11-01",
      hasta: "2026-11-27",
      cursor: "abc",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toMatchObject({
      usuarioId,
      clienteId,
      accion: ["cliente.editado", "periodo.estado_cambiado"],
      desde: "2026-11-01",
      hasta: "2026-11-27",
      cursor: "abc",
    });
  });

  it("toma una acción única (string suelto, como llega de la URL) como lista de uno", () => {
    const r = consultaAuditoriaSchema.safeParse({ accion: "cliente.editado" });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.accion).toEqual(["cliente.editado"]);
  });

  it("acepta cada acción del catálogo vigente, también `credencial.descifrada`", () => {
    for (const accion of ACCIONES_AUDITORIA) expect(ok({ accion }), accion).toBe(true);
    expect(ok({ accion: ["credencial.descifrada"] })).toBe(true);
  });

  it("acepta exactamente 10 acciones distintas", () => {
    expect(ok({ accion: ACCIONES_AUDITORIA.slice(0, 10) })).toBe(true);
  });

  it("acepta un solo extremo de fechas", () => {
    expect(ok({ desde: "2026-11-01" })).toBe(true);
    expect(ok({ hasta: "2026-11-01" })).toBe(true);
  });

  it("acepta desde = hasta (un día) y el 29 de febrero de un año bisiesto", () => {
    expect(ok({ desde: "2026-11-27", hasta: "2026-11-27" })).toBe(true);
    expect(ok({ desde: "2028-02-29", hasta: "2028-02-29" })).toBe(true);
  });

  it("acepta los UUID en mayúsculas", () => {
    expect(ok({ usuarioId: randomUUID().toUpperCase(), clienteId: randomUUID().toUpperCase() })).toBe(true);
  });
});

describe("consultaAuditoriaSchema · CA-7 rechaza (400 sin tocar la BD)", () => {
  it("UUID mal formado en usuarioId y clienteId", () => {
    for (const malo of ["", "123", "no-es-uuid", "00000000-0000-0000-0000-00000000000", `${randomUUID()}x`, "' OR 1=1 --"]) {
      expect(ok({ usuarioId: malo }), `usuarioId=${malo}`).toBe(false);
      expect(ok({ clienteId: malo }), `clienteId=${malo}`).toBe(false);
    }
  });

  it("arreglos u objetos donde va un UUID (qs: usuarioId[]=…, usuarioId[a]=…)", () => {
    expect(ok({ usuarioId: [randomUUID()] })).toBe(false);
    expect(ok({ usuarioId: [randomUUID(), randomUUID()] })).toBe(false);
    expect(ok({ clienteId: { $ne: randomUUID() } })).toBe(false);
    expect(ok({ desde: ["2026-11-01"] })).toBe(false);
    expect(ok({ hasta: { a: "2026-11-01" } })).toBe(false);
    expect(ok({ cursor: ["a", "b"] })).toBe(false);
  });

  it("acción fuera del catálogo (sola o junto a una válida)", () => {
    expect(ok({ accion: "cliente.inventada" })).toBe(false);
    expect(ok({ accion: ["cliente.editado", "cliente.inventada"] })).toBe(false);
    expect(ok({ accion: "" })).toBe(false);
    expect(ok({ accion: "CLIENTE.EDITADO" })).toBe(false);
    expect(ok({ accion: { a: "cliente.editado" } })).toBe(false);
  });

  it("lista de acciones vacía", () => {
    expect(ok({ accion: [] })).toBe(false);
  });

  it("11 acciones (más de 10)", () => {
    expect(ok({ accion: ACCIONES_AUDITORIA.slice(0, 11) })).toBe(false);
  });

  it("acciones repetidas", () => {
    expect(ok({ accion: ["cliente.editado", "cliente.editado"] })).toBe(false);
    expect(ok({ accion: ["cliente.editado", "periodo.estado_cambiado", "cliente.editado"] })).toBe(false);
  });

  it("fecha inexistente en el calendario", () => {
    for (const mala of ["2026-02-30", "2026-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "2026-11-00", "2026-11-32"]) {
      expect(ok({ desde: mala }), `desde=${mala}`).toBe(false);
      expect(ok({ hasta: mala }), `hasta=${mala}`).toBe(false);
    }
  });

  it("fecha con formato distinto de AAAA-MM-DD", () => {
    for (const mala of ["", "2026-2-3", "27/11/2026", "20261127", "2026-11-27T00:00:00Z", "2026-11-27 ", "hoy", "26-11-27"]) {
      expect(ok({ desde: mala }), `desde=${mala}`).toBe(false);
      expect(ok({ hasta: mala }), `hasta=${mala}`).toBe(false);
    }
  });

  it("desde posterior a hasta", () => {
    expect(ok({ desde: "2026-11-28", hasta: "2026-11-27" })).toBe(false);
    expect(ok({ desde: "2027-01-01", hasta: "2026-12-31" })).toBe(false);
  });

  it("clave desconocida (estricto): tenantId, limite, usuario_id crudo, cualquier otra", () => {
    expect(ok({ tenantId: randomUUID() })).toBe(false);
    expect(ok({ limite: 5 })).toBe(false);
    expect(ok({ limite: "5" })).toBe(false);
    expect(ok({ usuario_id: randomUUID() })).toBe(false);
    expect(ok({ q: "x" })).toBe(false);
    expect(ok({ usuarioId: randomUUID(), otra: "cosa" })).toBe(false);
  });

  it("comillas y `;` no pasan donde va un UUID, una acción o una fecha", () => {
    for (const hostil of ["'", "\"", "'; DROP TABLE auditoria; --", "x';--", "a;b", "\\'"]) {
      expect(ok({ usuarioId: hostil }), `usuarioId=${hostil}`).toBe(false);
      expect(ok({ clienteId: hostil }), `clienteId=${hostil}`).toBe(false);
      expect(ok({ accion: hostil }), `accion=${hostil}`).toBe(false);
      expect(ok({ accion: [hostil] }), `accion[]=${hostil}`).toBe(false);
      expect(ok({ desde: hostil }), `desde=${hostil}`).toBe(false);
      expect(ok({ hasta: hostil }), `hasta=${hostil}`).toBe(false);
    }
  });

  it("el cursor es un string opaco: comillas y `;` pasan tal cual (se validan al decodificar, no aquí)", () => {
    const r = consultaAuditoriaSchema.safeParse({ cursor: "'; DROP TABLE x; --" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.cursor).toBe("'; DROP TABLE x; --");
  });

  it("no cambia con una entrada que es null, un número o un arreglo", () => {
    expect(consultaAuditoriaSchema.safeParse(null).success).toBe(false);
    expect(consultaAuditoriaSchema.safeParse(5).success).toBe(false);
    expect(consultaAuditoriaSchema.safeParse([]).success).toBe(false);
  });
});

describe("rangoLima (D-2, CA-2)", () => {
  it("`desde` es las 00:00 de Lima (UTC−05:00) de ese día", () => {
    expect(rangoLima("2026-11-27", undefined).desde?.toISOString()).toBe("2026-11-27T05:00:00.000Z");
  });

  it("`hasta` es exclusivo: las 00:00 de Lima del día siguiente", () => {
    expect(rangoLima(undefined, "2026-11-27").hastaExclusivo?.toISOString()).toBe("2026-11-28T05:00:00.000Z");
  });

  it("devuelve Date reales en ambos extremos y null donde falta el filtro", () => {
    const completo = rangoLima("2026-11-01", "2026-11-27");
    expect(completo.desde).toBeInstanceOf(Date);
    expect(completo.hastaExclusivo).toBeInstanceOf(Date);
    expect(rangoLima()).toEqual({ desde: null, hastaExclusivo: null });
    expect(rangoLima(undefined, undefined)).toEqual({ desde: null, hastaExclusivo: null });
    expect(rangoLima("2026-11-01", undefined).hastaExclusivo).toBeNull();
    expect(rangoLima(undefined, "2026-11-01").desde).toBeNull();
  });

  it("un día completo: de 05:00Z a 05:00Z del día siguiente (24 h)", () => {
    const r = rangoLima("2026-11-27", "2026-11-27");
    expect(r.desde?.toISOString()).toBe("2026-11-27T05:00:00.000Z");
    expect(r.hastaExclusivo?.toISOString()).toBe("2026-11-28T05:00:00.000Z");
    expect(r.hastaExclusivo!.getTime() - r.desde!.getTime()).toBe(24 * 3600 * 1000);
  });

  it("borde de milisegundo: 23:59:59.999 de `hasta` (Lima) entra y las 00:00 siguientes no", () => {
    const r = rangoLima("2026-11-01", "2026-11-27");
    const ultimoMs = new Date("2026-11-28T04:59:59.999Z"); // 23:59:59.999 Lima del 27
    const siguiente = new Date("2026-11-28T05:00:00.000Z"); // 00:00 Lima del 28
    expect(ultimoMs.getTime()).toBeLessThan(r.hastaExclusivo!.getTime());
    expect(siguiente.getTime()).toBe(r.hastaExclusivo!.getTime());
    // 00:00:00.000 Lima de `desde` entra; 1 ms antes no.
    expect(new Date("2026-11-01T05:00:00.000Z").getTime()).toBe(r.desde!.getTime());
    expect(new Date("2026-11-01T04:59:59.999Z").getTime()).toBeLessThan(r.desde!.getTime());
  });

  it("cambio de mes: `hasta` el 30 de noviembre termina el 1 de diciembre 00:00 Lima", () => {
    expect(rangoLima(undefined, "2026-11-30").hastaExclusivo?.toISOString()).toBe("2026-12-01T05:00:00.000Z");
    expect(rangoLima(undefined, "2026-01-31").hastaExclusivo?.toISOString()).toBe("2026-02-01T05:00:00.000Z");
  });

  it("cambio de año: `hasta` el 31 de diciembre termina el 1 de enero 00:00 Lima", () => {
    expect(rangoLima(undefined, "2026-12-31").hastaExclusivo?.toISOString()).toBe("2027-01-01T05:00:00.000Z");
  });

  it("febrero: bisiesto (2028) y no bisiesto (2026)", () => {
    expect(rangoLima(undefined, "2028-02-28").hastaExclusivo?.toISOString()).toBe("2028-02-29T05:00:00.000Z");
    expect(rangoLima(undefined, "2028-02-29").hastaExclusivo?.toISOString()).toBe("2028-03-01T05:00:00.000Z");
    expect(rangoLima(undefined, "2026-02-28").hastaExclusivo?.toISOString()).toBe("2026-03-01T05:00:00.000Z");
  });

  it("el offset es fijo −05:00 todo el año (Perú no tiene horario de verano)", () => {
    for (const dia of ["2026-01-15", "2026-03-29", "2026-07-01", "2026-10-25", "2026-12-25"]) {
      expect(rangoLima(dia, undefined).desde?.toISOString(), dia).toBe(`${dia}T05:00:00.000Z`);
    }
  });
});

describe("consultaOpcionesAuditoriaSchema (D-6)", () => {
  it("acepta la consulta vacía, `q` y `clienteId`", () => {
    const clienteId = randomUUID();
    expect(okOpc({})).toBe(true);
    expect(okOpc({ q: "san juan" })).toBe(true);
    expect(okOpc({ clienteId })).toBe(true);
    const r = consultaOpcionesAuditoriaSchema.safeParse({ q: "2010", clienteId });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ q: "2010", clienteId });
  });

  it("`q` de 1 a 60 caracteres: 1 y 60 pasan; vacío y 61 no", () => {
    expect(okOpc({ q: "a" })).toBe(true);
    expect(okOpc({ q: "a".repeat(60) })).toBe(true);
    expect(okOpc({ q: "" })).toBe(false);
    expect(okOpc({ q: "a".repeat(61) })).toBe(false);
  });

  it("`q` con comodines, comillas y `;` es texto válido (la BD los escapa o los parametriza)", () => {
    for (const q of ["100%", "a_b", "O'Brien", "x;y", "\\"]) expect(okOpc({ q }), q).toBe(true);
  });

  it("`q` no admite arreglos ni objetos", () => {
    expect(okOpc({ q: ["a", "b"] })).toBe(false);
    expect(okOpc({ q: { a: "b" } })).toBe(false);
  });

  it("`clienteId` mal formado o en forma de arreglo", () => {
    expect(okOpc({ clienteId: "no-es-uuid" })).toBe(false);
    expect(okOpc({ clienteId: "" })).toBe(false);
    expect(okOpc({ clienteId: [randomUUID()] })).toBe(false);
  });

  it("estricto: clave desconocida (tenantId, limite, usuarioId, accion) da error", () => {
    expect(okOpc({ tenantId: randomUUID() })).toBe(false);
    expect(okOpc({ limite: 5 })).toBe(false);
    expect(okOpc({ usuarioId: randomUUID() })).toBe(false);
    expect(okOpc({ accion: "cliente.editado" })).toBe(false);
    expect(okOpc({ q: "a", otra: "x" })).toBe(false);
  });
});

describe("opcionesAuditoriaSchema (D-6)", () => {
  const miembro = (extra: Record<string, unknown> = {}) => ({ id: randomUUID(), nombre: "Ana Pérez", activo: true, ...extra });
  const cliente = (extra: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    ruc: "20100070970",
    razonSocial: "SAN JUAN SAC",
    archivado: false,
    ...extra,
  });
  const okSalida = (v: unknown) => opcionesAuditoriaSchema.safeParse(v).success;

  it("acepta miembros activos e inactivos y clientes archivados o no", () => {
    expect(okSalida({ miembros: [], clientes: [] })).toBe(true);
    expect(
      okSalida({
        miembros: [miembro(), miembro({ activo: false })],
        clientes: [cliente(), cliente({ archivado: true })],
      }),
    ).toBe(true);
  });

  it("devuelve los mismos datos", () => {
    const m = miembro({ activo: false });
    const c = cliente({ archivado: true });
    const r = opcionesAuditoriaSchema.safeParse({ miembros: [m], clientes: [c] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ miembros: [m], clientes: [c] });
  });

  it("exige `activo` y `archivado` booleanos, ids UUID y las dos listas", () => {
    expect(okSalida({ miembros: [miembro({ activo: "si" })], clientes: [] })).toBe(false);
    expect(okSalida({ miembros: [miembro({ id: "x" })], clientes: [] })).toBe(false);
    expect(okSalida({ miembros: [], clientes: [cliente({ archivado: undefined })] })).toBe(false);
    expect(okSalida({ miembros: [], clientes: [cliente({ id: "x" })] })).toBe(false);
    expect(okSalida({ miembros: [] })).toBe(false);
    expect(okSalida({ clientes: [] })).toBe(false);
  });

  it("descarta lo que no es del contrato (correo, tenantId): nunca sale por esta forma", () => {
    const r = opcionesAuditoriaSchema.safeParse({
      miembros: [miembro({ email: "ana@estudio.pe", tenantId: randomUUID() })],
      clientes: [cliente({ tenantId: randomUUID() })],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.miembros[0]).not.toHaveProperty("email");
    expect(r.data.miembros[0]).not.toHaveProperty("tenantId");
    expect(r.data.clientes[0]).not.toHaveProperty("tenantId");
  });
});

describe("exportación desde el índice de `shared`", () => {
  it("expone los esquemas y `rangoLima`", () => {
    expect(raiz.consultaAuditoriaSchema).toBe(consultaAuditoriaSchema);
    expect(raiz.consultaOpcionesAuditoriaSchema).toBe(consultaOpcionesAuditoriaSchema);
    expect(raiz.opcionesAuditoriaSchema).toBe(opcionesAuditoriaSchema);
    expect(raiz.rangoLima).toBe(rangoLima);
  });
});
