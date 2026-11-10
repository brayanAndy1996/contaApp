// Spec 016, T17a · Entrada de un XML por HTTP (D-1, D-3, D-11): cuerpo crudo -> bytes, error del parser traducido al de las rutas
// con XML, hash y ruta de storage. Un error que no es del parser es un defecto y no se disfraza de error de XML.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@contapp/domain", async (original) => ({
  ...(await original<typeof import("@contapp/domain")>()),
  leerUbl: vi.fn(),
}));

import { UblError, leerUbl } from "@contapp/domain";
import { XmlError } from "./errores-xml.js";
import { bytesDeCuerpo, leerXml, rutaNueva, sha256De } from "./xml-entrada.js";

beforeEach(() => vi.resetAllMocks());

describe("bytesDeCuerpo", () => {
  it("un Buffer (Content-Type de XML) pasa tal cual", () => {
    const b = Buffer.from("<Invoice/>");
    expect(bytesDeCuerpo(b)).toBe(b);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["un objeto JSON", { xml: "<Invoice/>" }],
    ["un objeto vacío (sin cuerpo)", {}],
    ["una cadena", "<Invoice/>"],
    ["un arreglo", [60, 73]],
  ])("%s se lee como un archivo vacío, sin repetir nada de lo recibido", (_n, cuerpo) => {
    const r = bytesDeCuerpo(cuerpo);
    expect(r).toBeInstanceOf(Uint8Array);
    expect(r).toHaveLength(0);
  });
});

describe("leerXml", () => {
  it("devuelve el detalle del parser", () => {
    const detalle = { raiz: "Invoice" };
    vi.mocked(leerUbl).mockReturnValue(detalle as never);
    const bytes = new Uint8Array([1]);
    expect(leerXml(bytes)).toBe(detalle);
    expect(leerUbl).toHaveBeenCalledWith(bytes);
  });

  it.each(["xml_invalido", "xml_incompleto"] as const)("el UblError %s sale como XmlError con el mismo código y sin mensaje del XML", (codigo) => {
    vi.mocked(leerUbl).mockImplementation(() => {
      throw new UblError(codigo);
    });
    const e = (() => {
      try {
        leerXml(new Uint8Array());
      } catch (x) {
        return x;
      }
    })();
    expect(e).toBeInstanceOf(XmlError);
    expect(e).toMatchObject({ codigo, cuerpo: { codigo } });
  });

  it("cualquier otro error es un defecto: se propaga tal cual (500 sin detalle), no se vuelve xml_invalido", () => {
    const defecto = new TypeError("defecto del parser");
    vi.mocked(leerUbl).mockImplementation(() => {
      throw defecto;
    });
    expect(() => leerXml(new Uint8Array())).toThrow(defecto);
  });
});

describe("sha256De", () => {
  it("es el SHA-256 de los bytes, como Uint8Array de 32 bytes", () => {
    const bytes = new TextEncoder().encode("<Invoice/>");
    const h = sha256De(bytes);
    expect(h).toBeInstanceOf(Uint8Array);
    expect(h).toHaveLength(32);
    expect(Buffer.from(h).toString("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});

describe("rutaNueva", () => {
  const TENANT = "11111111-1111-4111-8111-111111111111";
  const CLIENTE = "33333333-3333-4333-8333-333333333333";

  it("solo lleva los ids del estudio y del cliente y un uuid, y es nueva cada vez", () => {
    const a = rutaNueva(TENANT, CLIENTE);
    const b = rutaNueva(TENANT, CLIENTE);
    expect(a).toMatch(new RegExp(`^xml/${TENANT}/${CLIENTE}/[0-9a-f-]{36}\\.xml$`));
    expect(a).not.toBe(b);
  });
});
