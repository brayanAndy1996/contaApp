// Spec 013 (T3, rojo): `RegistroFormatos.desde` rechaza `tipo: "ruc"` en los campos de texto de la fila distintos del documento
// de la contraparte (012 D23, 013 D13). El RUC de la contraparte ya se valida por su tipo de documento 6 en `prevalidar`
// (estructura.ts), así que un `ruc` en la serie, el número o la razón social haría fallar TODA fila con RUC_INVALIDO sin que
// nadie pueda corregirla (H-012-61). Contrato que fija la prueba (T10): DefinicionFormatoInvalidaError al registrar; el campo
// del documento de la contraparte (`numeroDocProveedor` en compras) sigue pudiendo ser `ruc`.
import { describe, expect, it } from "vitest";
import { DefinicionFormatoInvalidaError, RegistroFormatos, seleccionarFormato } from "../index";
import type { FormatoTxt, Libro, TipoCampo } from "../index";
import { campoDePrueba, formatoDePrueba } from "../../tests/ayudas/formatos";

const conCampo = (nombre: string, tipo: TipoCampo, libro: Libro = "compras"): FormatoTxt =>
  formatoDePrueba({ libro, campos: [campoDePrueba({ nombre, tipo, longitudMax: 20, obligatorio: false })] });
const TEXTO_DE_LA_FILA = ["serie", "numero", "tipoComprobante", "tipoDocProveedor", "razonSocial"];

describe("tipo ruc en campos de texto de la fila (D13)", () => {
  for (const nombre of TEXTO_DE_LA_FILA) {
    it(`«${nombre}» con tipo ruc se rechaza al registrar`, () => {
      expect(() => RegistroFormatos.desde([conCampo(nombre, "ruc")])).toThrow(DefinicionFormatoInvalidaError);
    });
  }

  it("también se rechaza si es uno de varios campos del formato y en un formato de ventas", () => {
    const f = formatoDePrueba({
      campos: [campoDePrueba({ nombre: "numeroDocProveedor", tipo: "ruc", longitudMax: 11 }), campoDePrueba({ nombre: "razonSocial", tipo: "ruc" })],
    });
    expect(() => RegistroFormatos.desde([f])).toThrow(DefinicionFormatoInvalidaError);
    expect(() => RegistroFormatos.desde([conCampo("serie", "ruc", "ventas")])).toThrow(DefinicionFormatoInvalidaError);
  });

  it("el documento de la contraparte (numeroDocProveedor) sí puede ser `ruc`", () => {
    const f = formatoDePrueba({ campos: [campoDePrueba({ nombre: "numeroDocProveedor", tipo: "ruc", longitudMax: 11, obligatorio: true })] });
    expect(() => RegistroFormatos.desde([f])).not.toThrow();
  });

  it("los mismos campos con otro tipo (codigo o texto) se siguen aceptando", () => {
    for (const nombre of TEXTO_DE_LA_FILA) {
      expect(() => RegistroFormatos.desde([conCampo(nombre, "codigo")]), `${nombre} codigo`).not.toThrow();
      expect(() => RegistroFormatos.desde([conCampo(nombre, "texto")]), `${nombre} texto`).not.toThrow();
    }
  });

  it("un monto o la fecha con tipo ruc se siguen rechazando (H-012-61, ya vigente)", () => {
    for (const nombre of ["total", "fechaEmision", "tipoCambio", "periodo"]) {
      expect(() => RegistroFormatos.desde([conCampo(nombre, "ruc")]), nombre).toThrow(DefinicionFormatoInvalidaError);
    }
  });

  it("los formatos del registro por defecto (RCE y RVIE) no usan `ruc` en ningún campo de texto de la fila", () => {
    for (const [libro, nombres] of [
      ["compras", TEXTO_DE_LA_FILA],
      ["ventas", TEXTO_DE_LA_FILA],
    ] as const) {
      const f = seleccionarFormato(libro, "202610");
      for (const c of f.campos) if (nombres.includes(c.nombre)) expect(c.tipo, `${libro}.${c.nombre}`).not.toBe("ruc");
    }
  });
});
