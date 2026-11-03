// T14 (backend, H-008-1a-2): encolado concurrente de lo mismo. El INSERT con `sinDuplicar` no devuelve fila cuando otra
// transacción ya insertó la misma clave viva: `encolar` relee el vivo (D8) o, si ese ya terminó, inserta normal. La
// carrera real con PostgreSQL la fija `apps/worker/src/trabajos/r1a.adv.int.spec.ts` (D8, 50 en paralelo).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as db from "@contapp/db";
import { encolar, registrarTipo } from "./index.js";
import { bd, uuidDe } from "./soporte-pruebas/bd-falsa.js";

vi.mock("@contapp/db", async () => {
  const { moduloDbFalso } = await import("./soporte-pruebas/bd-falsa.js");
  return {
    ...moduloDbFalso,
    insertarTrabajo: vi.fn(moduloDbFalso.insertarTrabajo),
    trabajoVivoPorClave: vi.fn(moduloDbFalso.trabajoVivoPorClave),
  };
});

const tx = { tenantId: uuidDe(0xa1) } as never;
const entrada = {
  tipo: "correccion.encolar_concurrente",
  clienteId: uuidDe(0xc1),
  parametros: {},
  prioridad: "interactivo" as const,
  creadoPor: null,
};
registrarTipo({
  tipo: "correccion.encolar_concurrente",
  cola: "sire",
  canal: "sire",
  credencial: null,
  permiso: null,
  idempotente: true,
  parametros: z.object({}),
});

beforeEach(() => {
  bd.reiniciar();
  vi.mocked(db.insertarTrabajo).mockClear();
});

describe("encolar con la clave de dedupe tomada por otra transacción", () => {
  it("el INSERT pide no duplicar; sin fila devuelta, relee y devuelve el vivo con nuevo=false", async () => {
    const vivo = await encolar(tx, entrada);
    vi.mocked(db.trabajoVivoPorClave).mockResolvedValueOnce(null); // aún no visible al comprobar antes de insertar
    vi.mocked(db.insertarTrabajo).mockResolvedValueOnce(null); // ON CONFLICT DO NOTHING
    const r = await encolar(tx, entrada);
    expect(r).toEqual({ trabajo: vivo.trabajo, nuevo: false });
    expect(vi.mocked(db.insertarTrabajo).mock.calls.at(-1)![2]).toEqual({
      sinDuplicar: true,
    });
  });

  it("si el vivo terminó entre el INSERT y la relectura, inserta normal (sin pedir no duplicar)", async () => {
    vi.mocked(db.insertarTrabajo).mockResolvedValueOnce(null);
    vi.mocked(db.trabajoVivoPorClave)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const r = await encolar(tx, entrada);
    expect(r.nuevo).toBe(true);
    expect(vi.mocked(db.insertarTrabajo).mock.calls.map((c) => c[2])).toEqual([
      { sinDuplicar: true },
      undefined,
    ]);
  });
});
