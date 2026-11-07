// Unitarias del persistidor de ventas (spec 013, T12): normalización de lo recibido para compararlo con lo guardado,
// filas ilegibles sin eco y mapeo de lo existente. La inserción real la cubre la integración.
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  leer: vi.fn(),
  insertar: vi.fn(async () => undefined),
}));
vi.mock("@contapp/db", async (importarOriginal) => ({
  ...(await importarOriginal<typeof import("@contapp/db")>()),
  leerExistentes: h.leer,
  insertarVentas: h.insertar,
}));

import { ErrorPropuesta } from "./errores.js";
import { PERSISTIDORES } from "./index.js";
import {
  persistidorVentas,
  tipoCambioConEscala,
  TIPO_DOC_AUSENTE,
} from "./ventas.js";

const cruda = (extra: Record<string, unknown> = {}) => ({
  tipo: "03",
  serie: "b001",
  numero: "00290",
  docContraparte: "-",
  fechaEmision: "2026-10-03",
  moneda: "PEN",
  baseGravada: "100",
  igv: "18.0",
  exonerada: "0",
  inafecta: "0",
  isc: "0",
  icbper: "0",
  otros: "0",
  total: "118",
  ...extra,
});

describe("tipoCambioConEscala", () => {
  it.each([
    ["3.3", "3.300"],
    ["3", "3.000"],
    ["3.456", "3.456"],
    ["0.5", "0.500"],
  ])("%s -> %s", (e, s) => expect(tipoCambioConEscala(e)).toBe(s));
});

describe("persistidorVentas.preparar", () => {
  it("normaliza como lo hace la base: montos con 2 decimales, TC con 3 (vacío si falta) y documento «0» si falta", () => {
    const [f] = persistidorVentas.preparar([cruda()]);
    expect(f!.clave).toBe("03|B001|290");
    expect(f!.campos).toEqual({
      fechaEmision: "2026-10-03",
      moneda: "PEN",
      tipoCambio: "",
      tipoDocContraparte: TIPO_DOC_AUSENTE,
      docContraparte: "-",
      baseGravada: "100.00",
      igv: "18.00",
      exonerada: "0.00",
      inafecta: "0.00",
      isc: "0.00",
      icbper: "0.00",
      otros: "0.00",
      total: "118.00",
    });
    // Lo que se inserta conserva el número tal como llegó; la serie va en mayúsculas (T18, H-013-6: antes conservaba «b001»).
    expect(f!.datos).toMatchObject({
      serie: "B001",
      numero: "00290",
      tipoCambio: null,
      tipoDocContraparte: "0",
    });
  });

  it("USD con tipo de cambio: «3.3» queda «3.300» en los dos lados", () => {
    const [f] = persistidorVentas.preparar([
      cruda({ moneda: "USD", tipoCambio: "3.3", tipoDocContraparte: "6" }),
    ]);
    expect(f!.campos).toMatchObject({
      tipoCambio: "3.300",
      tipoDocContraparte: "6",
    });
    expect(f!.datos).toMatchObject({ tipoCambio: "3.300" });
  });

  it("una fila ilegible lanza fila_invalida sin incluir su contenido", () => {
    let e: unknown;
    try {
      persistidorVentas.preparar([cruda(), cruda({ total: "SECRETO-123" })]);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(ErrorPropuesta);
    expect(e).toMatchObject({ detalle: "fila_invalida" });
    expect(JSON.stringify(e) + String((e as Error).stack)).not.toContain(
      "SECRETO-123",
    );
  });
});

describe("persistidorVentas.leerExistentes e insertar", () => {
  it("renombra la fecha al nombre de FilaVentaSire y conserva el resto", async () => {
    h.leer.mockResolvedValueOnce([
      {
        clave: "03|B001|290",
        origen: "manual",
        campos: { fecha: "2026-10-03", total: "118.00", tipoCambio: "" },
      },
    ]);
    const r = await persistidorVentas.leerExistentes(
      {} as never,
      { clienteId: "c-1", periodo: "202610" },
    );
    expect(h.leer).toHaveBeenCalledWith({}, "c-1", "202610");
    expect(r).toEqual([
      {
        clave: "03|B001|290",
        origen: "manual",
        campos: { fechaEmision: "2026-10-03", total: "118.00", tipoCambio: "" },
      },
    ]);
  });

  it("inserta los datos de las nuevas con la propuesta y el periodo", async () => {
    const [f] = persistidorVentas.preparar([cruda()]);
    await persistidorVentas.insertar(
      {} as never,
      { clienteId: "c-1", periodo: "202610" },
      "p-1",
      [f!],
    );
    expect(h.insertar).toHaveBeenCalledWith(
      {},
      { clienteId: "c-1", periodo: "202610", propuestaId: "p-1" },
      [f!.datos],
    );
  });
});

describe("registro de persistidores", () => {
  it("ventas está registrado y compras todavía no (lo agrega 014)", () => {
    expect(PERSISTIDORES.ventas).toBe(persistidorVentas);
    expect(PERSISTIDORES.compras).toBeUndefined();
  });
});
