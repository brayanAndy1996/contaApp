import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorDatos, ErrorTransitorio } from "../errores.js";
import type { TokenSire } from "../puertos.js";
import { generarFilasComprasVolumen, MockSireApiClient } from "./sire-api-client.mock.js";

// Spec 014 (T20a): ramas defensivas del mock que 014 amplió y que el disco real no produce sin tocar los fixtures
// (archivo de RUC de prueba ilegible o fuera de forma), más la entrada con RUC que no es texto y el fallo temporal
// con `veces` mayor que las llamadas hechas. Solo se sustituye la lectura de `rucs-prueba.json`; el resto va al disco real.

const falsos = vi.hoisted(() => ({ rucs: null as null | (() => string) }));
vi.mock("node:fs", async (importar) => {
  const real = await importar<typeof import("node:fs")>();
  return {
    ...real,
    readFileSync: (...a: Parameters<typeof real.readFileSync>) =>
      falsos.rucs !== null && String(a[0]).endsWith("rucs-prueba.json") ? falsos.rucs() : real.readFileSync(...a),
  };
});

const TOKEN: TokenSire = { token: "token-de-prueba", expiraEn: new Date("2026-10-27T16:00:00Z") };

afterEach(() => {
  falsos.rucs = null;
});

describe("generarFilasComprasVolumen · archivo de RUC de prueba defectuoso", () => {
  it("un archivo que no es JSON es ErrorDatos", () => {
    falsos.rucs = () => "esto no es json";
    expect(() => generarFilasComprasVolumen(3)).toThrow(ErrorDatos);
  });

  it("un JSON que no es un arreglo es ErrorDatos", () => {
    falsos.rucs = () => JSON.stringify({ ruc: "20700000011" });
    expect(() => generarFilasComprasVolumen(3)).toThrow(ErrorDatos);
  });

  it("una entrada sin razón social (o nula) es ErrorDatos", () => {
    falsos.rucs = () => JSON.stringify([{ ruc: "20700000011" }]);
    expect(() => generarFilasComprasVolumen(3)).toThrow(ErrorDatos);
    falsos.rucs = () => JSON.stringify([null]);
    expect(() => generarFilasComprasVolumen(3)).toThrow(ErrorDatos);
  });

  it("si solo está el contribuyente no queda ningún proveedor: ErrorDatos", () => {
    falsos.rucs = () => JSON.stringify([{ ruc: "20700000002", razonSocial: "PRUEBA CONTRIBUYENTE S.A.C." }]);
    expect(() => generarFilasComprasVolumen(3)).toThrow(ErrorDatos);
  });

  it("control: con un proveedor válido y el contribuyente genera las filas pedidas con ese proveedor", () => {
    falsos.rucs = () =>
      JSON.stringify([
        { ruc: "20700000002", razonSocial: "PRUEBA CONTRIBUYENTE S.A.C." },
        { ruc: "20700000011", razonSocial: "PROVEEDOR DE PRUEBA S.A.C." },
      ]);
    const filas = generarFilasComprasVolumen(3, "202610");
    expect(filas).toHaveLength(3);
    expect(new Set(filas.map((f) => f.rucContraparte))).toEqual(new Set(["20700000011"]));
  });
});

describe("MockSireApiClient · entrada y fallos forzados", () => {
  it("un RUC que no es texto es ErrorDatos y no se cuenta por RUC", async () => {
    const mock = new MockSireApiClient();
    await expect(
      mock.descargarPropuesta(TOKEN, { ruc: 20700000011 as never, periodo: "202610", libro: "compras" }),
    ).rejects.toBeInstanceOf(ErrorDatos);
    expect(mock.llamadas).toBe(1);
    expect(mock.registro()).toEqual([]);
  });

  it("fallar('5xx', { veces: 2 }) sigue fallando en la segunda llamada y se agota en la tercera", async () => {
    const mock = new MockSireApiClient();
    mock.fallar("5xx", { veces: 2 });
    const pedir = () => mock.descargarPropuesta(TOKEN, { ruc: "20700000002", periodo: "202610", libro: "compras" });
    await expect(pedir()).rejects.toBeInstanceOf(ErrorTransitorio);
    await expect(pedir()).rejects.toBeInstanceOf(ErrorTransitorio);
    await expect(pedir()).resolves.toMatchObject({ libro: "compras", periodo: "202610" });
  });
});
