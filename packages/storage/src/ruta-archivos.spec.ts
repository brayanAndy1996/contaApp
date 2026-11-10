// 012b T3: rutaArchivo y la segunda gramática de validarRuta (archivos/{tenant}/{cliente}/{id}.zip). Rojo.
import { describe, expect, it } from "vitest";
import { RutaStorageError } from "./errores.js";
import { rutaArchivo, rutaXml, validarRuta } from "./ruta.js";

const TENANT = "0b6f1c1e-5d0a-4b53-9d0e-3f1f6a1b2c3d";
const CLIENTE = "7a9c2e44-1f3b-4c6d-8e5a-9b0c1d2e3f4a";
const ID = "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f";
const ZIP = `archivos/${TENANT}/${CLIENTE}/${ID}.zip`;
const XML = `xml/${TENANT}/${CLIENTE}/${ID}.xml`;

describe("rutaArchivo", () => {
  it("construye archivos/{tenant}/{cliente}/{id}.zip", () => {
    expect(rutaArchivo(TENANT, CLIENTE, ID)).toBe(ZIP);
  });

  it("la ruta construida es válida para validarRuta y se devuelve igual", () => {
    expect(validarRuta(rutaArchivo(TENANT, CLIENTE, ID))).toBe(ZIP);
  });

  it.each([
    ["tenant", ["../x", CLIENTE, ID]],
    ["cliente", [TENANT, "a/b", ID]],
    ["id", [TENANT, CLIENTE, "archivo-final"]],
    ["id con extensión", [TENANT, CLIENTE, `${ID}.zip`]],
    ["tenant vacío", ["", CLIENTE, ID]],
    ["cliente con NUL", [TENANT, `${CLIENTE}\0`, ID]],
    ["id con barra invertida", [TENANT, CLIENTE, "a\\b"]],
    ["tenant en mayúsculas", [TENANT.toUpperCase(), CLIENTE, ID]],
  ] as const)("rechaza %s que no es uuid con RutaStorageError", (_n, [t, c, i]) => {
    expect(() => rutaArchivo(t, c, i)).toThrow(RutaStorageError);
  });

  it("rechaza lo que no es texto", () => {
    expect(() => rutaArchivo(undefined as never, CLIENTE, ID)).toThrow(RutaStorageError);
    expect(() => rutaArchivo(TENANT, 42 as never, ID)).toThrow(RutaStorageError);
  });

  it("el error no incluye el valor recibido", () => {
    try {
      rutaArchivo(TENANT, CLIENTE, "secreto-no-uuid");
      throw new Error("se esperaba un error");
    } catch (e) {
      expect(e).toBeInstanceOf(RutaStorageError);
      expect((e as Error).message).not.toContain("secreto-no-uuid");
    }
  });
});

describe("validarRuta · dos gramáticas (xml/…xml y archivos/…zip)", () => {
  it("acepta xml/…xml y archivos/…zip", () => {
    expect(validarRuta(XML)).toBe(XML);
    expect(validarRuta(ZIP)).toBe(ZIP);
    expect(validarRuta(rutaXml(TENANT, CLIENTE, ID))).toBe(XML);
  });

  it.each([
    ["archivos con extensión xml", `archivos/${TENANT}/${CLIENTE}/${ID}.xml`],
    ["xml con extensión zip", `xml/${TENANT}/${CLIENTE}/${ID}.zip`],
    ["archivos sin extensión", `archivos/${TENANT}/${CLIENTE}/${ID}`],
    ["archivos con otra extensión", `archivos/${TENANT}/${CLIENTE}/${ID}.txt`],
    ["archivos con doble extensión", `archivos/${TENANT}/${CLIENTE}/${ID}.zip.zip`],
    ["archivos con zip y xml", `archivos/${TENANT}/${CLIENTE}/${ID}.zip.xml`],
    ["prefijo en mayúsculas", `ARCHIVOS/${TENANT}/${CLIENTE}/${ID}.zip`],
    ["extensión en mayúsculas", `archivos/${TENANT}/${CLIENTE}/${ID}.ZIP`],
    ["uuid en mayúsculas", `archivos/${TENANT.toUpperCase()}/${CLIENTE}/${ID}.zip`],
    ["con «..» al inicio", `../${TENANT}/${CLIENTE}/${ID}.zip`],
    ["con «..» intermedio", `archivos/${TENANT}/../${CLIENTE}/${ID}.zip`],
    ["con «..» en lugar del id", `archivos/${TENANT}/${CLIENTE}/..`],
    ["con «.» intermedio", `archivos/./${TENANT}/${CLIENTE}/${ID}.zip`],
    ["absoluta", `/${ZIP}`],
    ["absoluta del sistema", "/etc/passwd"],
    ["con unidad de Windows", `C:/${ZIP}`],
    ["con NUL al final", `${ZIP}\0`],
    ["con NUL intermedio", `archivos/${TENANT}/${CLIENTE}/${ID}\0.zip`],
    ["con NUL y extensión falsa", `${ZIP}\0.png`],
    ["con barras invertidas", `archivos\\${TENANT}\\${CLIENTE}\\${ID}.zip`],
    ["con nombre libre", `archivos/${TENANT}/${CLIENTE}/ventas-2026-10.zip`],
    ["con nombre libre del usuario", `archivos/${TENANT}/${CLIENTE}/mi archivo.zip`],
    ["con un nivel de más", `archivos/${TENANT}/${CLIENTE}/otro/${ID}.zip`],
    ["con un nivel de menos", `archivos/${TENANT}/${ID}.zip`],
    ["con tenant que no es uuid", `archivos/tenant/${CLIENTE}/${ID}.zip`],
    ["con cliente que no es uuid", `archivos/${TENANT}/cliente/${ID}.zip`],
    ["con otro prefijo", `zip/${TENANT}/${CLIENTE}/${ID}.zip`],
    ["con barra final", `${ZIP}/`],
    ["con barras dobles", `archivos//${TENANT}/${CLIENTE}/${ID}.zip`],
    ["con salto de línea", `${ZIP}\n`],
    ["con espacio al final", `${ZIP} `],
    ["con «..» codificado", `archivos/%2e%2e/${CLIENTE}/${ID}.zip`],
    ["con URL", `file:///${ZIP}`],
  ])("rechaza una ruta %s con RutaStorageError", (_n, ruta) => {
    expect(() => validarRuta(ruta)).toThrow(RutaStorageError);
  });

  it("el error no incluye la ruta rechazada", () => {
    try {
      validarRuta(`archivos/${TENANT}/${CLIENTE}/secreto-final.zip`);
      throw new Error("se esperaba un error");
    } catch (e) {
      expect(e).toBeInstanceOf(RutaStorageError);
      expect((e as Error).message).not.toContain("secreto-final");
    }
  });
});
