// Spec 023 (T21): ramas de la captura que agrega la corrección de la ronda 2. Las invariantes de punta a punta (con BD y
// portal) están en apps/worker/src/trabajos/procesadores/buzon-r2.int.spec.ts.
import { describe, expect, it } from "vitest";
import {
  CURSOR_RELLENO,
  TOPE_MENSAJES_CAPTURA,
  fechaMensaje,
  planificarCaptura,
  type EstadoCaptura,
  type MensajeListado,
} from "./index";

const msg = (id: string): MensajeListado => ({
  idSunat: id,
  asunto: "Boletín",
  remitente: "SUNAT",
  fecha: "2026-11-17T10:00:00.000Z",
  codigoTipo: null,
  leidoEnSunat: false,
  adjuntos: [],
});

const estado = (e: Partial<EstadoCaptura> = {}): EstadoCaptura => ({
  cursorPendiente: null,
  cursorActual: null,
  nuevosAcumulados: 0,
  paginasLeidas: 0,
  ...e,
});

describe("fechaMensaje (H-023-2-5)", () => {
  const ahora = new Date("2026-11-18T05:00:00.000Z");

  it("ISO 8601 con zona: la del portal", () => {
    expect(fechaMensaje("2026-11-17T10:00:00.000Z", ahora)).toEqual(
      new Date("2026-11-17T10:00:00.000Z"),
    );
    expect(fechaMensaje("2026-11-17T10:00-05:00", ahora)).toEqual(
      new Date("2026-11-17T15:00:00.000Z"),
    );
  });

  it("ilegible, sin zona, mes imposible o fuera de 1900..9999: la de captura (una copia de `ahora`)", () => {
    for (const f of [
      "17/11/2026 10:00",
      "ayer a las 10",
      "2026-11-17T10:00:00",
      "2026-13-40T10:00:00Z",
      "1800-01-01T00:00:00Z",
      "-100000-01-01T00:00:00.000Z",
      "+275760-09-13T00:00:00.000Z",
      "",
    ]) {
      const r = fechaMensaje(f, ahora);
      expect(r, f).toEqual(ahora);
      expect(r, f).not.toBe(ahora);
    }
  });
});

describe("planificarCaptura (ronda 2)", () => {
  it("cliente sin sincronizar: no se detiene en el primer conocido (H-023-2-1)", () => {
    const r = planificarCaptura(
      estado({ sincronizado: false }),
      { mensajes: [msg("a"), msg("b"), msg("c")], siguiente: null },
      new Set(["a"]),
    );
    expect(r.nuevos.map((m) => m.idSunat)).toEqual(["b", "c"]);
    expect(r.sincronizado).toBe(true);
  });

  it("los ids ya vistos en esta captura se saltan sin terminar (H-023-2-2)", () => {
    const r = planificarCaptura(
      estado({ sincronizado: true, vistos: new Set(["x"]) }),
      { mensajes: [msg("x"), msg("y")], siguiente: "c2" },
      new Set(["x"]),
    );
    expect(r.nuevos.map((m) => m.idSunat)).toEqual(["y"]);
    expect(r.actualizar).toEqual([]);
    expect(r.terminada).toBe(false);
  });

  it("una página que solo repite lo ya visto corta con relleno pendiente (el portal se repite)", () => {
    const r = planificarCaptura(
      estado({ cursorActual: "c2", vistos: new Set(["x", "y"]) }),
      { mensajes: [msg("x"), msg("y")], siguiente: "c3" },
      new Set(),
    );
    expect(r).toMatchObject({
      nuevos: [],
      terminada: true,
      sincronizado: false,
      siguienteCursor: "c3",
    });
  });

  it("corte por tope en una única página sin cursor: el pendiente es CURSOR_RELLENO, nunca null (H-023-2-1)", () => {
    const r = planificarCaptura(
      estado({ nuevosAcumulados: TOPE_MENSAJES_CAPTURA - 1 }),
      { mensajes: [msg("a"), msg("b")], siguiente: null },
      new Set(),
    );
    expect(r.nuevos.map((m) => m.idSunat)).toEqual(["a"]);
    expect(r.terminada).toBe(true);
    expect(r.siguienteCursor).toBe(CURSOR_RELLENO);
  });
});
