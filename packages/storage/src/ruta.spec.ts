import { describe, expect, it } from "vitest";
import { RutaStorageError } from "./errores.js";
import { rutaXml, validarRuta } from "./ruta.js";

const TENANT = "0b6f1c1e-5d0a-4b53-9d0e-3f1f6a1b2c3d";
const CLIENTE = "7a9c2e44-1f3b-4c6d-8e5a-9b0c1d2e3f4a";
const UUID = "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f";
const VALIDA = `xml/${TENANT}/${CLIENTE}/${UUID}.xml`;

describe("rutaXml", () => {
  it("construye xml/{tenant}/{cliente}/{uuid}.xml", () => {
    expect(rutaXml(TENANT, CLIENTE, UUID)).toBe(VALIDA);
  });

  it("la ruta construida es válida para validarRuta y se devuelve igual", () => {
    expect(validarRuta(rutaXml(TENANT, CLIENTE, UUID))).toBe(VALIDA);
  });

  it.each([
    ["tenant", ["../x", CLIENTE, UUID]],
    ["cliente", [TENANT, "a/b", UUID]],
    ["uuid", [TENANT, CLIENTE, "factura"]],
    ["uuid con extensión", [TENANT, CLIENTE, `${UUID}.xml`]],
    ["tenant vacío", ["", CLIENTE, UUID]],
    ["cliente con NUL", [TENANT, `${CLIENTE}\0`, UUID]],
    ["uuid con barra invertida", [TENANT, CLIENTE, "a\\b"]],
  ] as const)("rechaza %s que no es uuid con RutaStorageError", (_n, [t, c, u]) => {
    expect(() => rutaXml(t, c, u)).toThrow(RutaStorageError);
  });

  it("el error no incluye el valor recibido", () => {
    try {
      rutaXml(TENANT, CLIENTE, "secreto-no-uuid");
      throw new Error("se esperaba un error");
    } catch (e) {
      expect(e).toBeInstanceOf(RutaStorageError);
      expect((e as Error).message).not.toContain("secreto-no-uuid");
    }
  });
});

describe("validarRuta · gramática (solo xml/{uuid}/{uuid}/{uuid}.xml)", () => {
  it("acepta la ruta canónica", () => {
    expect(validarRuta(VALIDA)).toBe(VALIDA);
  });

  it.each([
    ["vacía", ""],
    ["con «..» al inicio", `../${TENANT}/${CLIENTE}/${UUID}.xml`],
    ["con «..» intermedio", `xml/${TENANT}/../${CLIENTE}/${UUID}.xml`],
    ["con «..» en lugar del uuid", `xml/${TENANT}/${CLIENTE}/..`],
    ["con «.» intermedio", `xml/./${TENANT}/${CLIENTE}/${UUID}.xml`],
    ["absoluta", `/xml/${TENANT}/${CLIENTE}/${UUID}.xml`],
    ["absoluta del sistema", "/etc/passwd"],
    ["con unidad de Windows", `C:/xml/${TENANT}/${CLIENTE}/${UUID}.xml`],
    ["con NUL al final", `${VALIDA}\0`],
    ["con NUL intermedio", `xml/${TENANT}/${CLIENTE}/${UUID}\0.xml`],
    ["con NUL y extensión falsa", `${VALIDA}\0.png`],
    ["con barras invertidas", `xml\\${TENANT}\\${CLIENTE}\\${UUID}.xml`],
    ["con barra invertida mezclada", `xml/${TENANT}\\${CLIENTE}/${UUID}.xml`],
    ["con nombre libre", `xml/${TENANT}/${CLIENTE}/factura-F001-1.xml`],
    ["con nombre libre del usuario", `xml/${TENANT}/${CLIENTE}/mi archivo.xml`],
    ["sin extensión", `xml/${TENANT}/${CLIENTE}/${UUID}`],
    ["con otra extensión", `xml/${TENANT}/${CLIENTE}/${UUID}.exe`],
    ["con doble extensión", `xml/${TENANT}/${CLIENTE}/${UUID}.xml.xml`],
    ["con un nivel de más", `xml/${TENANT}/${CLIENTE}/otro/${UUID}.xml`],
    ["con un nivel de menos", `xml/${TENANT}/${UUID}.xml`],
    ["con otro prefijo", `pdf/${TENANT}/${CLIENTE}/${UUID}.xml`],
    ["con tenant que no es uuid", `xml/tenant/${CLIENTE}/${UUID}.xml`],
    ["con cliente que no es uuid", `xml/${TENANT}/cliente/${UUID}.xml`],
    ["con barra final", `${VALIDA}/`],
    ["con barras dobles", `xml//${TENANT}/${CLIENTE}/${UUID}.xml`],
    ["con salto de línea", `${VALIDA}\n`],
    ["con espacio al final", `${VALIDA} `],
    ["con «..» codificado", `xml/%2e%2e/${CLIENTE}/${UUID}.xml`],
    ["con URL", `file:///${VALIDA}`],
  ])("rechaza una ruta %s con RutaStorageError", (_n, ruta) => {
    expect(() => validarRuta(ruta)).toThrow(RutaStorageError);
  });

  it("rechaza lo que no es texto", () => {
    expect(() => validarRuta(undefined as never)).toThrow(RutaStorageError);
    expect(() => validarRuta(42 as never)).toThrow(RutaStorageError);
  });

  it("el error no incluye la ruta rechazada", () => {
    try {
      validarRuta("/etc/passwd-secreto");
      throw new Error("se esperaba un error");
    } catch (e) {
      expect(e).toBeInstanceOf(RutaStorageError);
      expect((e as Error).message).not.toContain("passwd-secreto");
      expect((e as RutaStorageError).codigo).toBe("storage_ruta_invalida");
    }
  });
});
