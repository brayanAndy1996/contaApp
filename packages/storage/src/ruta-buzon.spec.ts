// 023 T4b: rutaBuzon y la tercera gramática de validarRuta (buzon/{tenant}/{cliente}/{uuid}.{ext}). Rojo.
import { describe, expect, it } from "vitest";
import { RutaStorageError } from "./errores.js";
import { rutaBuzon, validarRuta } from "./ruta.js";

const TENANT = "0b6f1c1e-5d0a-4b53-9d0e-3f1f6a1b2c3d";
const CLIENTE = "7a9c2e44-1f3b-4c6d-8e5a-9b0c1d2e3f4a";
const ID = "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f";
const base = `buzon/${TENANT}/${CLIENTE}/${ID}`;

describe("validarRuta · buzon/{uuid}/{uuid}/{uuid}.{ext}", () => {
  it.each(["pdf", "xml", "png", "jpg", "zip", "txt"])("acepta la extensión %s y devuelve la ruta igual", (ext) => {
    expect(validarRuta(`${base}.${ext}`)).toBe(`${base}.${ext}`);
  });

  it.each([
    ["extensión en mayúsculas", `${base}.PDF`],
    ["extensión mixta", `${base}.Txt`],
    ["extensión fuera de la lista", `${base}.exe`],
    ["extensión jpeg", `${base}.jpeg`],
    ["sin extensión", base],
    ["extensión vacía", `${base}.`],
    ["doble extensión", `${base}.pdf.pdf`],
    ["«..» al inicio", `../${TENANT}/${CLIENTE}/${ID}.pdf`],
    ["«..» intermedio", `buzon/${TENANT}/../${ID}.pdf`],
    ["«..» en lugar del uuid", `buzon/${TENANT}/${CLIENTE}/..`],
    ["absoluta", `/${base}.pdf`],
    ["barras dobles", `buzon//${TENANT}/${CLIENTE}/${ID}.pdf`],
    ["un nivel de más", `buzon/${TENANT}/${CLIENTE}/otro/${ID}.pdf`],
    ["un nivel de menos", `buzon/${TENANT}/${ID}.pdf`],
    ["barra final", `${base}.pdf/`],
    ["barras invertidas", `buzon\\${TENANT}\\${CLIENTE}\\${ID}.pdf`],
    ["NUL al final", `${base}.pdf\0`],
    ["salto de línea", `${base}.pdf\n`],
    ["uuid mal formado", `buzon/${TENANT}/${CLIENTE}/${ID.slice(1)}.pdf`],
    ["uuid en mayúsculas", `buzon/${TENANT}/${CLIENTE}/${ID.toUpperCase()}.pdf`],
    ["nombre libre", `buzon/${TENANT}/${CLIENTE}/factura-marzo.pdf`],
    ["tenant que no es uuid", `buzon/tenant/${CLIENTE}/${ID}.pdf`],
    ["cliente que no es uuid", `buzon/${TENANT}/cliente/${ID}.pdf`],
    ["solo el prefijo", "buzon"],
    ["prefijo con barra", "buzon/"],
    ["prefijo y tenant", `buzon/${TENANT}`],
    ["prefijo, tenant y cliente", `buzon/${TENANT}/${CLIENTE}`],
    ["prefijo, tenant y cliente con barra", `buzon/${TENANT}/${CLIENTE}/`],
    ["otro prefijo", `buzones/${TENANT}/${CLIENTE}/${ID}.pdf`],
    ["prefijo en mayúsculas", `BUZON/${TENANT}/${CLIENTE}/${ID}.pdf`],
  ])("rechaza %s con RutaStorageError", (_n, ruta) => {
    expect(() => validarRuta(ruta)).toThrow(RutaStorageError);
  });

  it("no mezcla extensiones de otros prefijos", () => {
    expect(() => validarRuta(`xml/${TENANT}/${CLIENTE}/${ID}.pdf`)).toThrow(RutaStorageError);
    expect(() => validarRuta(`archivos/${TENANT}/${CLIENTE}/${ID}.txt`)).toThrow(RutaStorageError);
  });
});

describe("rutaBuzon", () => {
  it("construye buzon/{tenant}/{cliente}/{uuid}.{ext} y es válida para validarRuta", () => {
    expect(rutaBuzon(TENANT, CLIENTE, ID, "pdf")).toBe(`${base}.pdf`);
    expect(validarRuta(rutaBuzon(TENANT, CLIENTE, ID, "txt"))).toBe(`${base}.txt`);
  });

  it.each([
    ["tenant", ["../x", CLIENTE, ID, "pdf"]],
    ["cliente", [TENANT, "a/b", ID, "pdf"]],
    ["uuid", [TENANT, CLIENTE, "factura", "pdf"]],
    ["uuid en mayúsculas", [TENANT, CLIENTE, ID.toUpperCase(), "pdf"]],
    ["extensión en mayúsculas", [TENANT, CLIENTE, ID, "PDF"]],
    ["extensión fuera de la lista", [TENANT, CLIENTE, ID, "exe"]],
    ["extensión con punto", [TENANT, CLIENTE, ID, ".pdf"]],
    ["extensión vacía", [TENANT, CLIENTE, ID, ""]],
  ] as const)("rechaza %s inválido con RutaStorageError", (_n, [t, c, u, e]) => {
    expect(() => rutaBuzon(t, c, u, e)).toThrow(RutaStorageError);
  });
});
