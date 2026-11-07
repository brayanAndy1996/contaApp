// Spec 013 (T10): los campos propios de una venta se registran para definir el formato RVIE, pero no se
// serializan hasta 012b (D13, P-8). `valorDeCampo` los reconoce solo en el libro de ventas.
import { describe, expect, it } from "vitest";
import { DefinicionFormatoInvalidaError, RegistroFormatos } from "../index";
import { campoDePrueba, formatoDePrueba } from "../../tests/ayudas/formatos";
import { TIPOS_FIJOS, valorDeCampo } from "./valores";

const SOLO_VENTAS = ["baseGravada", "igv", "exonerada", "inafecta", "otros", "tipoDocContraparte", "docContraparte"];

describe("valorDeCampo · campos propios de ventas", () => {
  it("en ventas se reconocen, y su valor no se puede serializar todavía (lanza)", () => {
    for (const n of SOLO_VENTAS) {
      const valor = valorDeCampo(n, "ventas");
      expect(typeof valor, n).toBe("function");
      expect(() => (valor as () => string)(), n).toThrow(DefinicionFormatoInvalidaError);
    }
  });

  it("en compras (y sin libro) se rechazan: «apto» sigue queriendo decir «genera»", () => {
    for (const n of SOLO_VENTAS) {
      expect(() => valorDeCampo(n), n).toThrow(DefinicionFormatoInvalidaError);
      expect(() => valorDeCampo(n, "compras"), n).toThrow(DefinicionFormatoInvalidaError);
    }
  });

  it("los campos comunes tienen el valor de compras en los dos libros y un nombre desconocido se rechaza", () => {
    for (const n of ["periodo", "serie", "isc", "icbper", "total"]) expect(valorDeCampo(n, "ventas")).toBe(valorDeCampo(n, "compras"));
    expect(() => valorDeCampo("noExiste", "ventas")).toThrow(DefinicionFormatoInvalidaError);
  });

  it("los cinco montos propios tienen tipo fijo `monto`: un `ruc` o un `texto` se rechaza al registrar", () => {
    for (const n of ["baseGravada", "igv", "exonerada", "inafecta", "otros"]) {
      expect(TIPOS_FIJOS.get(n), n).toBe("monto");
      expect(() => RegistroFormatos.desde([formatoDePrueba({ libro: "ventas", campos: [campoDePrueba({ nombre: n, tipo: "texto" })] })]), n).toThrow(
        DefinicionFormatoInvalidaError,
      );
      expect(() => RegistroFormatos.desde([formatoDePrueba({ libro: "ventas", campos: [campoDePrueba({ nombre: n, tipo: "monto" })] })]), n).not.toThrow();
    }
  });

  it("el documento de la contraparte de ventas sí puede ser `ruc`; su tipo de documento no", () => {
    const con = (nombre: string) => formatoDePrueba({ libro: "ventas", campos: [campoDePrueba({ nombre, tipo: "ruc", longitudMax: 11 })] });
    expect(() => RegistroFormatos.desde([con("docContraparte")])).not.toThrow();
    expect(() => RegistroFormatos.desde([con("tipoDocContraparte")])).toThrow(DefinicionFormatoInvalidaError);
  });

  it("un formato de compras con un campo propio de ventas se rechaza al registrar", () => {
    expect(() => RegistroFormatos.desde([formatoDePrueba({ libro: "compras", campos: [campoDePrueba({ nombre: "baseGravada", tipo: "monto" })] })])).toThrow(
      DefinicionFormatoInvalidaError,
    );
  });
});
