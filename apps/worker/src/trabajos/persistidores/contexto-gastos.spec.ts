// Spec 027, T11 · Unitarias de `contextoGastos`: qué proveedores pide al lector y cómo arma el contexto del dominio. La lectura con BD
// real está en contexto-gastos.int.spec.ts; aquí un doble de `leerContextoGastos`.
import { DiccionarioGlosas } from "@contapp/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/db", async (original) => ({
  ...(await original<typeof import("@contapp/db")>()),
  leerContextoGastos: vi.fn(),
}));

import { leerContextoGastos } from "@contapp/db";
import { contextoGastos } from "./contexto-gastos.js";

const CLIENTE = "33333333-3333-4333-8333-333333333333";
const TX = { tx: true } as never;
const PROV = { tipo: "6", numero: "20700000045" };

function leido(extra: Record<string, unknown> = {}) {
  return {
    umbral: 5,
    globales: [
      { palabra: "zapatilla", categoria: "calzado-ropa", excepciones: [] },
      { palabra: "polo", categoria: "calzado-ropa", excepciones: [] },
    ],
    desactivadas: ["polo"],
    propias: [{ palabra: "audifono", categoria: "entretenimiento", excepciones: [] }],
    ciiuCliente: "4752",
    ciiuProveedores: [{ proveedor: PROV, ciiu: "4771" }],
    categoriasCliente: { permitidas: ["calzado-ropa"], quitadas: [] },
    historial: [{ proveedor: PROV, aceptadas6: 1, excluidas6: 2, excluidas12: 3 }],
    ...extra,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("contextoGastos", () => {
  it("arma el contexto del dominio con lo leído: diccionario efectivo, umbral, CIIU, categorías e historial", async () => {
    vi.mocked(leerContextoGastos).mockResolvedValue(leido() as never);
    const ctx = await contextoGastos(TX, CLIENTE, "202610", [PROV]);

    expect(ctx.diccionario).toBeInstanceOf(DiccionarioGlosas);
    expect(ctx.diccionario.coincidenciasPorItem(["ZAPATILLA", "polo azul", "audifono"]).map((c) => c.palabra)).toEqual([
      "zapatilla",
      "audifono",
    ]);
    expect(ctx).toMatchObject({
      umbral: 5,
      ciiuCliente: "4752",
      ciiuProveedores: [{ proveedor: PROV, ciiu: "4771" }],
      categoriasCliente: { permitidas: ["calzado-ropa"], quitadas: [] },
      historial: [{ proveedor: PROV, aceptadas6: 1, excluidas6: 2, excluidas12: 3 }],
    });
    expect(vi.mocked(leerContextoGastos).mock.calls[0]).toEqual([TX, { clienteId: CLIENTE, periodo: "202610", proveedores: [PROV] }]);
  });

  it("no pide los proveedores cuyo documento no cumple la gramática del dominio (no tumban el trabajo)", async () => {
    vi.mocked(leerContextoGastos).mockResolvedValue(leido({ ciiuProveedores: [], historial: [] }) as never);
    const largo = { tipo: "6", numero: "1234567890123456" };
    const raro = { tipo: "66", numero: "20700000045" };
    const conEspacio = { tipo: "6", numero: "2070 0000045" };
    await contextoGastos(TX, CLIENTE, "202610", [largo, PROV, raro, conEspacio]);

    expect(vi.mocked(leerContextoGastos).mock.calls[0]![1].proveedores).toEqual([PROV]);
  });

  it("un fallo del lector sube tal cual", async () => {
    const fallo = new Error("conexión perdida");
    vi.mocked(leerContextoGastos).mockRejectedValue(fallo);
    await expect(contextoGastos(TX, CLIENTE, "202610", [])).rejects.toBe(fallo);
  });
});
