import { describe, expect, it } from "vitest";
import {
  ESTADOS_TRABAJO,
  MOTIVOS_TRABAJO,
  PRIORIDADES,
  eventoTrabajoSchema,
  listarTrabajosQuery,
  trabajoVistaSchema,
} from "./index.js";

// Contrato (plan 008, shared/trabajos/esquemas.ts), CA-5, CA-6, CA-16:
//  - ESTADOS_TRABAJO, MOTIVOS_TRABAJO, PRIORIDADES: tuplas `as const` con estos valores exactos.
//  - trabajoVistaSchema = z.object({ id, tipo, clienteId, estado, posicion: entero >= 1 | null,
//    intentos: entero >= 0, motivo: Motivo | null, creadoEn, iniciadoEn | null, terminadoEn | null,
//    creadoPor: { usuarioId } | null }). Fechas = cadenas ISO 8601 (viajan por JSON/SSE).
//    Las claves desconocidas se DESCARTAN: nunca salen tenantId, ruc, parametros, resultado, etc.
//  - eventoTrabajoSchema = trabajoVistaSchema (un evento SSE `trabajo` por cambio de estado).
//  - listarTrabajosQuery = z.object({ clienteId?: uuid, estado?: Estado }); descarta claves
//    desconocidas; un clienteId mal formado NO parsea (el controlador lo convierte en 404).
const uuid = (n: number): string =>
  `0190a000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const vista = (
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: uuid(1),
  tipo: "prueba.eco",
  clienteId: uuid(2),
  estado: "en_cola",
  posicion: 3,
  intentos: 0,
  motivo: null,
  creadoEn: "2026-10-27T15:00:00.000Z",
  iniciadoEn: null,
  terminadoEn: null,
  creadoPor: { usuarioId: uuid(3) },
  ...extra,
});

describe("catalogos de estados, motivos y prioridades", () => {
  it("ESTADOS_TRABAJO tiene los cinco estados, en orden", () => {
    expect([...ESTADOS_TRABAJO]).toEqual([
      "en_cola",
      "ejecutando",
      "completado",
      "error",
      "cancelado",
    ]);
  });

  it("MOTIVOS_TRABAJO son codigos (nunca mensajes) y son exactamente los del plan", () => {
    expect([...MOTIVOS_TRABAJO]).toEqual([
      "sunat_no_responde",
      "credencial_invalida",
      "datos_invalidos",
      "portal_cambio",
      "interrumpido",
      "acceso_retirado",
      "cancelado_usuario",
      "error_interno",
    ]);
    for (const m of MOTIVOS_TRABAJO) expect(m).toMatch(/^[a-z_]+$/);
  });

  it("PRIORIDADES: interactivo primero, luego programado", () => {
    expect([...PRIORIDADES]).toEqual(["interactivo", "programado"]);
  });
});

describe("trabajoVistaSchema", () => {
  it("acepta una vista en cola con posicion", () => {
    const v = vista();
    expect(trabajoVistaSchema.parse(v)).toEqual(v);
  });

  it.each(ESTADOS_TRABAJO)("acepta el estado %s", (estado) => {
    expect(trabajoVistaSchema.safeParse(vista({ estado })).success).toBe(true);
  });

  it.each(MOTIVOS_TRABAJO)("acepta el motivo %s", (motivo) => {
    expect(
      trabajoVistaSchema.safeParse(
        vista({ estado: "error", posicion: null, motivo }),
      ).success,
    ).toBe(true);
  });

  it("acepta un trabajo terminado con todas las fechas y sin creador (programado)", () => {
    const v = vista({
      estado: "completado",
      posicion: null,
      intentos: 1,
      iniciadoEn: "2026-10-27T15:00:05.000Z",
      terminadoEn: "2026-10-27T15:00:09.000Z",
      creadoPor: null,
    });
    expect(trabajoVistaSchema.parse(v)).toEqual(v);
  });

  it("rechaza un estado o un motivo fuera del catalogo", () => {
    for (const estado of ["EN_COLA", "pendiente", "", null, 1]) {
      expect(
        trabajoVistaSchema.safeParse(vista({ estado })).success,
        String(estado),
      ).toBe(false);
    }
    for (const motivo of ["timeout", "", "Error: ECONNRESET", 5]) {
      expect(
        trabajoVistaSchema.safeParse(vista({ motivo })).success,
        String(motivo),
      ).toBe(false);
    }
  });

  it("rechaza ids que no son UUID, fechas que no son ISO y numeros invalidos", () => {
    const malas: Record<string, unknown>[] = [
      { id: "no-uuid" },
      { clienteId: "123" },
      { creadoPor: { usuarioId: "x" } },
      { creadoEn: "ayer" },
      { iniciadoEn: "2026-13-45" },
      { posicion: 0 },
      { posicion: -1 },
      { posicion: 1.5 },
      { intentos: -1 },
      { intentos: 1.2 },
      { tipo: "" },
    ];
    for (const m of malas) {
      expect(
        trabajoVistaSchema.safeParse(vista(m)).success,
        JSON.stringify(m),
      ).toBe(false);
    }
  });

  it("exige todas las claves de la vista (sin ellas no es una vista)", () => {
    for (const k of Object.keys(vista())) {
      const v = vista();
      delete v[k];
      expect(trabajoVistaSchema.safeParse(v).success, k).toBe(false);
    }
  });

  it("descarta claves desconocidas: tenantId, ruc, parametros, resultado, secretos", () => {
    const salida = trabajoVistaSchema.parse(
      vista({
        tenantId: uuid(9),
        tenant_id: uuid(9),
        ruc: "20123456789",
        parametros: { claveSol: "CANARIO-SOL-1" },
        resultado: { token: "CANARIO-TOKEN-1" },
        claveDedupe: "abc",
      }),
    );
    expect(Object.keys(salida).sort()).toEqual(Object.keys(vista()).sort());
    expect(JSON.stringify(salida)).not.toMatch(/CANARIO|20123456789/);
  });

  it("descarta claves desconocidas tambien dentro de creadoPor", () => {
    const salida = trabajoVistaSchema.parse(
      vista({
        creadoPor: { usuarioId: uuid(3), correo: "x@y.pe", rol: "dueno" },
      }),
    );
    expect(salida.creadoPor).toEqual({ usuarioId: uuid(3) });
  });
});

describe("eventoTrabajoSchema", () => {
  it("es la misma forma que la vista (un evento por cambio de estado)", () => {
    const v = vista({
      estado: "ejecutando",
      posicion: null,
      intentos: 1,
      iniciadoEn: "2026-10-27T15:00:05.000Z",
    });
    expect(eventoTrabajoSchema.parse(v)).toEqual(trabajoVistaSchema.parse(v));
    expect(eventoTrabajoSchema.safeParse(vista({ estado: "x" })).success).toBe(
      false,
    );
  });

  it("descarta lo que no es de la vista", () => {
    const salida = eventoTrabajoSchema.parse(
      vista({ tenantId: uuid(9), ruc: "20123456789" }),
    );
    expect(salida).not.toHaveProperty("tenantId");
    expect(salida).not.toHaveProperty("ruc");
  });
});

describe("listarTrabajosQuery", () => {
  it("acepta una consulta vacia", () => {
    expect(listarTrabajosQuery.parse({})).toEqual({});
  });

  it("acepta clienteId y estado validos", () => {
    expect(
      listarTrabajosQuery.parse({ clienteId: uuid(2), estado: "error" }),
    ).toEqual({
      clienteId: uuid(2),
      estado: "error",
    });
  });

  it("descarta claves desconocidas (tenantId, limit, usuarioId)", () => {
    const salida = listarTrabajosQuery.parse({
      clienteId: uuid(2),
      tenantId: uuid(9),
      usuarioId: uuid(8),
      limit: 100000,
    });
    expect(salida).toEqual({ clienteId: uuid(2) });
  });

  it("no parsea un clienteId mal formado ni un estado fuera del catalogo", () => {
    expect(listarTrabajosQuery.safeParse({ clienteId: "abc" }).success).toBe(
      false,
    );
    expect(listarTrabajosQuery.safeParse({ clienteId: "" }).success).toBe(
      false,
    );
    expect(
      listarTrabajosQuery.safeParse({ clienteId: ["x", "y"] }).success,
    ).toBe(false);
    expect(listarTrabajosQuery.safeParse({ estado: "pendiente" }).success).toBe(
      false,
    );
  });
});
