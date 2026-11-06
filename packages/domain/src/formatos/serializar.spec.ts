// Spec 012 (T9): bordes de generarTxt que no fijan los specs de T4 (TC entero, opciones, campos sin
// valor conocido y nombres que devuelve el formato). Solo API pública.
import { describe, expect, it } from "vitest";
import {
  DefinicionFormatoInvalidaError,
  EntradaPrevalidacionInvalidaError,
  NombreArchivoInvalidoError,
  RegistroFormatos,
  generarTxt,
  prevalidar,
  seleccionarFormato,
} from "../index";
import type { FormatoTxt } from "../index";
import { CABECERA, filaReemplazo, latin1, lineasCrlf } from "../../tests/ayudas/filas-reemplazo";

const provisional = seleccionarFormato("compras", "202610");
const registroCon = (cambios: Partial<FormatoTxt>) =>
  RegistroFormatos.desde([{ ...provisional, oficial: true, version: "1", ...cambios }]);

describe("valores de la línea", () => {
  it("un TC sin decimales sale con tres (3 → 3.000)", () => {
    const f = filaReemplazo({ biDg: "1.00", igvDg: "0.18" }, { moneda: "USD", tipoCambio: "3" });
    expect(latin1(generarTxt([f], CABECERA, { permitirProvisional: true }).bytes)).toContain("|USD|3.000|");
  });

  it("ordena por el tipo de documento del proveedor a igual comprobante", () => {
    const filas = [
      filaReemplazo(undefined, { id: "a", proveedor: { tipo: "7", numero: "20100070970" } }),
      filaReemplazo(undefined, { id: "b", proveedor: { tipo: "6", numero: "20100070970" } }),
    ];
    const lineas = lineasCrlf(generarTxt(filas, CABECERA, { permitirProvisional: true }).bytes);
    expect(lineas.map((l) => l.split("|")[5])).toEqual(["6", "7"]);
  });

  it("un número con ceros a la izquierda se ordena por su valor y sale tal como llegó", () => {
    const filas = [
      filaReemplazo(undefined, { id: "a", comprobante: { tipo: "01", serie: "F001", numero: "0010" } }),
      filaReemplazo(undefined, { id: "b", comprobante: { tipo: "01", serie: "F001", numero: "9" } }),
    ];
    const lineas = lineasCrlf(generarTxt(filas, CABECERA, { permitirProvisional: true }).bytes);
    expect(lineas.map((l) => l.split("|")[3])).toEqual(["9", "0010"]);
  });

  it("un campo del formato sin valor conocido lanza DefinicionFormatoInvalidaError al serializar", () => {
    const registro = registroCon({
      campos: [...provisional.campos, { nombre: "desconocido", obligatorio: false, longitudMax: 5, tipo: "texto" }],
    });
    expect(prevalidar([filaReemplazo()], { cabecera: CABECERA, registro }).apto).toBe(true);
    expect(() => generarTxt([filaReemplazo()], CABECERA, { registro })).toThrow(DefinicionFormatoInvalidaError);
  });
});

describe("opciones", () => {
  it("opciones con forma imposible lanzan EntradaPrevalidacionInvalidaError", () => {
    const f = [filaReemplazo()];
    for (const opciones of [null, "sí", { permitirProvisional: "sí" }, { extra: 1 }]) {
      expect(() => generarTxt(f, CABECERA, opciones as never)).toThrow(EntradaPrevalidacionInvalidaError);
    }
  });

  it("permitirProvisional: undefined equivale a no permitirlo; con un formato oficial no hace falta", () => {
    const registro = registroCon({});
    expect(generarTxt([filaReemplazo()], CABECERA, { permitirProvisional: undefined, registro }).provisional).toBe(false);
  });
});

describe("nombres que devuelve el formato (D7, Ratificación 6)", () => {
  const conNombre = (nombre: (c: { ruc: string; periodo: string }) => unknown) =>
    registroCon({ nombre: nombre as FormatoTxt["nombre"] });
  const gen = (registro: RegistroFormatos) => generarTxt([filaReemplazo()], CABECERA, { registro });

  it.each([
    ["no es objeto", () => null],
    ["nombres que no son string", () => ({ nombreTxt: 1, nombreZip: 2 })],
    ["con ..", () => ({ nombreTxt: "A..B.txt", nombreZip: "A..B.zip" })],
    ["con /", () => ({ nombreTxt: "a/b.txt", nombreZip: "a/b.zip" })],
    ["zip que no es la base del txt", () => ({ nombreTxt: "A.txt", nombreZip: "B.zip" })],
    ["zip igual al txt", () => ({ nombreTxt: "A.zip", nombreZip: "A.zip" })],
  ])("%s lanza NombreArchivoInvalidoError", (_n, nombre) => {
    expect(() => gen(conNombre(nombre))).toThrow(NombreArchivoInvalidoError);
  });

  it("un txt sin extensión admite su base + .zip", () => {
    const r = gen(conNombre(() => ({ nombreTxt: "ARCHIVO", nombreZip: "ARCHIVO.zip" })));
    expect([r.nombreTxt, r.nombreZip]).toEqual(["ARCHIVO", "ARCHIVO.zip"]);
  });
});
