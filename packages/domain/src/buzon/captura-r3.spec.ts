// Spec 023 (T25a): R-1 de la revisión final. Una captura debe terminar siempre: una página sin mensajes utilizables con
// `siguiente` no nulo corta como «todo repetido», y el tope `MAX_PAGINAS_LECTURA` corta con relleno pendiente aunque las páginas
// sean de conocidos distintos. Firma que fijan estas pruebas (T25b la implementa):
//  - `export const MAX_PAGINAS_LECTURA = 500` en `packages/domain/src/buzon/captura.ts` (reexportado por `./index`).
//  - `EstadoCaptura.leidas?: number`: páginas YA leídas en esta captura, con o sin nuevos, sin contar la que se planifica (como
//    `paginasLeidas`, pero cuenta todas). Sin el dato se toma 0.
//  - `EstadoCaptura.maxPaginasLectura?: number`: tope inyectable; por omisión `MAX_PAGINAS_LECTURA`.
//  - Con `leidas + 1 >= tope` y `siguiente !== null`: `terminada: true`, `sincronizado: false`, `siguienteCursor: pagina.siguiente`
//    (los nuevos de esa página sí se aceptan). Sin `siguiente`, termina sincronizado como siempre.
import { describe, expect, it } from "vitest";
import {
  CURSOR_RELLENO,
  MAX_PAGINAS_LECTURA,
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

/** Las propiedades nuevas de T25b no existen aún en `EstadoCaptura`: se agregan aparte para que la prueba se lea igual después. */
const estado = (
  e: Partial<EstadoCaptura> & { leidas?: number; maxPaginasLectura?: number } = {},
): EstadoCaptura =>
  ({
    cursorPendiente: null,
    cursorActual: null,
    nuevosAcumulados: 0,
    paginasLeidas: 0,
    ...e,
  }) as EstadoCaptura;

describe("página sin mensajes con siguiente (R-1)", () => {
  it.each([
    ["con relleno (captura anterior cortada)", { cursorPendiente: CURSOR_RELLENO }],
    ["con relleno (cliente sin sincronizar)", { sincronizado: false }],
    ["sin relleno (cliente sincronizado)", { sincronizado: true }],
    ["sin relleno (sin el dato de sincronización)", {}],
  ] as const)("%s: termina, no sincroniza y deja un cursor pendiente no nulo", (_c, e) => {
    const r = planificarCaptura(
      estado(e),
      { mensajes: [], siguiente: "p2" },
      new Set(),
    );
    expect(r.terminada).toBe(true);
    expect(r.sincronizado).toBe(false);
    expect(r.siguienteCursor).not.toBeNull();
    expect(r.nuevos).toEqual([]);
  });

  it("también en una página intermedia (cursor propio) con nuevos acumulados", () => {
    const r = planificarCaptura(
      estado({ cursorActual: "p5", nuevosAcumulados: 40, paginasLeidas: 1, sincronizado: true }),
      { mensajes: [], siguiente: "p6" },
      new Set(),
    );
    expect(r).toMatchObject({ terminada: true, sincronizado: false, siguienteCursor: "p6" });
  });

  it("control: una página vacía SIN siguiente es el final del buzón (sincronizado)", () => {
    const r = planificarCaptura(
      estado({ sincronizado: false }),
      { mensajes: [], siguiente: null },
      new Set(),
    );
    expect(r).toMatchObject({ terminada: true, sincronizado: true, siguienteCursor: null });
  });
});

describe("tope MAX_PAGINAS_LECTURA (R-1)", () => {
  it("vale 500 (decisión técnica aprobada)", () => {
    expect(MAX_PAGINAS_LECTURA).toBe(500);
  });

  it("en la página número MAX_PAGINAS_LECTURA corta con relleno pendiente aunque solo traiga conocidos distintos", () => {
    const r = planificarCaptura(
      estado({
        sincronizado: false,
        cursorActual: "p499",
        leidas: MAX_PAGINAS_LECTURA - 1,
      } as Partial<EstadoCaptura>),
      { mensajes: [msg("k499")], siguiente: "p500" },
      new Set(["k499"]),
    );
    expect(r.terminada).toBe(true);
    expect(r.sincronizado).toBe(false);
    expect(r.siguienteCursor).toBe("p500");
  });

  it("una página antes del tope sigue (los conocidos distintos no cortan con relleno)", () => {
    const r = planificarCaptura(
      estado({
        sincronizado: false,
        cursorActual: "p498",
        leidas: MAX_PAGINAS_LECTURA - 2,
      } as Partial<EstadoCaptura>),
      { mensajes: [msg("k498")], siguiente: "p499" },
      new Set(["k498"]),
    );
    expect(r.terminada).toBe(false);
    expect(r.siguienteCursor).toBe("p499");
  });

  it("tope inyectable: con maxPaginasLectura = 3, la tercera página corta y la segunda no", () => {
    const base = { sincronizado: false, maxPaginasLectura: 3 };
    const tercera = planificarCaptura(
      estado({ ...base, leidas: 2, cursorActual: "p3" }),
      { mensajes: [msg("k3")], siguiente: "p4" },
      new Set(["k3"]),
    );
    expect(tercera).toMatchObject({ terminada: true, sincronizado: false, siguienteCursor: "p4" });
    const segunda = planificarCaptura(
      estado({ ...base, leidas: 1, cursorActual: "p2" }),
      { mensajes: [msg("k2")], siguiente: "p3" },
      new Set(["k2"]),
    );
    expect(segunda).toMatchObject({ terminada: false, siguienteCursor: "p3" });
  });

  it("el corte por tope acepta los nuevos de esa página (sin pérdida) y deja el siguiente como pendiente", () => {
    const r = planificarCaptura(
      estado({ maxPaginasLectura: 3, leidas: 2, sincronizado: true, cursorActual: "p3" }),
      { mensajes: [msg("n1"), msg("n2")], siguiente: "p4" },
      new Set(),
    );
    expect(r.nuevos.map((m) => m.idSunat)).toEqual(["n1", "n2"]);
    expect(r).toMatchObject({ terminada: true, sincronizado: false, siguienteCursor: "p4" });
  });

  it("en el tope pero sin siguiente: es el final del buzón, no un corte", () => {
    const r = planificarCaptura(
      estado({ maxPaginasLectura: 3, leidas: 2, sincronizado: false, cursorActual: "p3" }),
      { mensajes: [msg("k3")], siguiente: null },
      new Set(["k3"]),
    );
    expect(r).toMatchObject({ terminada: true, sincronizado: true, siguienteCursor: null });
  });
});
