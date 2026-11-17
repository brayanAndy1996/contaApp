// Spec 023, T1 (CA-8, D-4, P-10): saneado de nombres, MIME por firma y topes de adjuntos.
// Rojo: sin implementación.
import { describe, expect, it } from "vitest";
import {
  TOPE_ADJUNTO_BYTES,
  TOPE_MENSAJE_BYTES,
  mimePorFirma,
  prepararAdjuntos,
  sanearNombreAdjunto,
  type AdjuntoRecibido,
} from "./index";

const MiB = 1024 * 1024;
const FIRMA_PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const FIRMA_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const FIRMA_JPEG = [0xff, 0xd8, 0xff, 0xe0];
const FIRMA_ZIP = [0x50, 0x4b, 0x03, 0x04];
const texto = (s: string): Uint8Array =>
  Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function conFirma(firma: readonly number[], largo = firma.length): Uint8Array {
  const b = new Uint8Array(Math.max(largo, firma.length));
  b.set(firma);
  return b;
}

const pdf = (idSunat: string, nombre: string, largo = 64): AdjuntoRecibido => ({
  idSunat,
  nombre,
  bytes: conFirma(FIRMA_PDF, largo),
});

describe("constantes", () => {
  it("20 MiB por adjunto y 50 MiB por mensaje", () => {
    expect(TOPE_ADJUNTO_BYTES).toBe(20 * MiB);
    expect(TOPE_MENSAJE_BYTES).toBe(50 * MiB);
  });
});

describe("sanearNombreAdjunto", () => {
  it("deja intacto un nombre normal", () => {
    expect(sanearNombreAdjunto("Resolución 0123-2026.pdf")).toBe(
      "Resolución 0123-2026.pdf",
    );
  });

  it("quita las rutas: '../' y separadores de ambos sistemas", () => {
    expect(sanearNombreAdjunto("../../etc/passwd")).toBe("passwd");
    expect(sanearNombreAdjunto("a/b\\c.pdf")).toBe("c.pdf");
    expect(sanearNombreAdjunto("..\\..\\windows\\system32\\x.dll")).toBe(
      "x.dll",
    );
    expect(sanearNombreAdjunto("/abs/ruta/archivo.xml")).toBe("archivo.xml");
  });

  it("quita NUL y caracteres de control", () => {
    expect(sanearNombreAdjunto("fact\u0000ura.pdf")).toBe("factura.pdf");
    expect(sanearNombreAdjunto("a\u0001b\u001Fc\u007Fd.pdf")).toBe("abcd.pdf");
    expect(sanearNombreAdjunto("lin\neas\r\ny.pdf")).toBe("lineasy.pdf");
  });

  it("quita las marcas bidireccionales (no se puede disfrazar la extensión)", () => {
    const r = sanearNombreAdjunto("recibo‮fdp.exe");
    expect(r).toBe("recibofdp.exe");
    expect(r).not.toMatch(/[‪-‮⁦-⁩‎‏]/u);
  });

  it("nombre vacío, de solo espacios o de solo ruta → 'adjunto'", () => {
    expect(sanearNombreAdjunto("")).toBe("adjunto");
    expect(sanearNombreAdjunto("   ")).toBe("adjunto");
    expect(sanearNombreAdjunto("../")).toBe("adjunto");
    expect(sanearNombreAdjunto("\u0000\u0001")).toBe("adjunto");
  });

  it("nunca devuelve '.' ni '..'", () => {
    for (const n of [".", "..", "../..", "./."]) {
      const r = sanearNombreAdjunto(n);
      expect(r).not.toBe(".");
      expect(r).not.toBe("..");
      expect(r.length).toBeGreaterThan(0);
    }
  });

  it("de 300 caracteres → como máximo 120 y no vacío", () => {
    const r = sanearNombreAdjunto(`${"a".repeat(296)}.pdf`);
    expect(r.length).toBeLessThanOrEqual(120);
    expect(r.length).toBeGreaterThan(0);
  });

  it("120 caracteres exactos se conservan", () => {
    const n = "b".repeat(120);
    expect(sanearNombreAdjunto(n)).toBe(n);
  });
});

describe("mimePorFirma", () => {
  it("PDF", () => {
    expect(mimePorFirma(conFirma(FIRMA_PDF))).toEqual({
      mime: "application/pdf",
      ext: "pdf",
    });
  });
  it("XML", () => {
    expect(
      mimePorFirma(texto('<?xml version="1.0" encoding="UTF-8"?><a/>')),
    ).toEqual({
      mime: "application/xml",
      ext: "xml",
    });
  });
  it("PNG", () => {
    expect(mimePorFirma(conFirma(FIRMA_PNG))).toEqual({
      mime: "image/png",
      ext: "png",
    });
  });
  it("JPEG", () => {
    expect(mimePorFirma(conFirma(FIRMA_JPEG))).toEqual({
      mime: "image/jpeg",
      ext: "jpg",
    });
  });
  it("ZIP como archivo opaco", () => {
    expect(mimePorFirma(conFirma(FIRMA_ZIP))).toEqual({
      mime: "application/zip",
      ext: "zip",
    });
  });

  it.each([
    ["ejecutable de Windows (MZ)", texto("MZ\u0090\u0000\u0003")],
    ["ELF", Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x02])],
    ["HTML", texto("<html><script>alert(1)</script></html>")],
    ["SVG", texto('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')],
    ["script de shell", texto("#!/bin/sh\nrm -rf /\n")],
    ["texto plano", texto("hola")],
    ["vacío", new Uint8Array(0)],
    [
      "PDF truncado a la mitad de la firma",
      Uint8Array.from([0x25, 0x50, 0x44]),
    ],
  ])("fuera de la lista blanca: %s → null", (_n, bytes) => {
    expect(mimePorFirma(bytes)).toBeNull();
  });
});

describe("prepararAdjuntos: MIME por firma, no por lo declarado", () => {
  it("guarda un PDF con su MIME y extensión reales, sea cual sea el nombre", () => {
    const r = prepararAdjuntos([pdf("a1", "fotos.exe")]);
    expect(r.omitidos).toEqual([]);
    expect(r.guardar).toHaveLength(1);
    expect(r.guardar[0]).toMatchObject({
      idSunat: "a1",
      nombre: "fotos.exe",
      mime: "application/pdf",
      ext: "pdf",
    });
    expect(r.guardar[0]?.bytes).toEqual(conFirma(FIRMA_PDF, 64));
  });

  it("un ejecutable con nombre .pdf se omite por MIME", () => {
    const r = prepararAdjuntos([
      { idSunat: "a1", nombre: "factura.pdf", bytes: texto("MZ\u0090\u0000") },
    ]);
    expect(r.guardar).toEqual([]);
    expect(r.omitidos).toEqual([
      { idSunat: "a1", nombre: "factura.pdf", motivo: "mime" },
    ]);
  });

  it("PDF, XML, PNG, JPEG y ZIP juntos se guardan en orden de llegada", () => {
    const r = prepararAdjuntos([
      pdf("a1", "uno.pdf"),
      {
        idSunat: "a2",
        nombre: "dos.xml",
        bytes: texto("<?xml version='1.0'?><x/>"),
      },
      { idSunat: "a3", nombre: "tres.png", bytes: conFirma(FIRMA_PNG) },
      { idSunat: "a4", nombre: "cuatro.jpg", bytes: conFirma(FIRMA_JPEG) },
      { idSunat: "a5", nombre: "cinco.zip", bytes: conFirma(FIRMA_ZIP) },
    ]);
    expect(r.omitidos).toEqual([]);
    expect(r.guardar.map((g) => [g.idSunat, g.ext])).toEqual([
      ["a1", "pdf"],
      ["a2", "xml"],
      ["a3", "png"],
      ["a4", "jpg"],
      ["a5", "zip"],
    ]);
  });

  it("el ZIP no se abre: sus bytes salen idénticos", () => {
    const zip = conFirma(FIRMA_ZIP, 1000);
    const r = prepararAdjuntos([
      { idSunat: "a1", nombre: "bomba.zip", bytes: zip },
    ]);
    expect(r.guardar[0]?.bytes).toEqual(zip);
    expect(r.guardar[0]?.mime).toBe("application/zip");
  });
});

describe("prepararAdjuntos: nombres hostiles", () => {
  it("el nombre sale saneado tanto al guardar como al omitir", () => {
    const r = prepararAdjuntos([
      {
        idSunat: "a1",
        nombre: "../../x\u0000.pdf",
        bytes: conFirma(FIRMA_PDF),
      },
      { idSunat: "a2", nombre: "../../y\u0000.exe", bytes: texto("MZ") },
    ]);
    expect(r.guardar[0]?.nombre).toBe("x.pdf");
    expect(r.omitidos[0]).toEqual({
      idSunat: "a2",
      nombre: "y.exe",
      motivo: "mime",
    });
  });

  it("nombre vacío → 'adjunto'", () => {
    const r = prepararAdjuntos([pdf("a1", "")]);
    expect(r.guardar[0]?.nombre).toBe("adjunto");
  });

  it("nombre de 300 caracteres → como máximo 120", () => {
    const r = prepararAdjuntos([pdf("a1", "n".repeat(300))]);
    expect(r.guardar[0]?.nombre.length).toBeLessThanOrEqual(120);
  });
});

describe("prepararAdjuntos: tamaño", () => {
  it("20 MiB exactos se guardan", () => {
    const r = prepararAdjuntos([
      {
        idSunat: "a1",
        nombre: "grande.pdf",
        bytes: conFirma(FIRMA_PDF, TOPE_ADJUNTO_BYTES),
      },
    ]);
    expect(r.omitidos).toEqual([]);
    expect(r.guardar).toHaveLength(1);
  });

  it("20 MiB + 1 byte se omite por tamaño", () => {
    const r = prepararAdjuntos([
      {
        idSunat: "a1",
        nombre: "grande.pdf",
        bytes: conFirma(FIRMA_PDF, TOPE_ADJUNTO_BYTES + 1),
      },
    ]);
    expect(r.guardar).toEqual([]);
    expect(r.omitidos).toEqual([
      { idSunat: "a1", nombre: "grande.pdf", motivo: "tamano" },
    ]);
  });

  it("el portal ya lo omitió por tamaño: queda omitido sin bytes", () => {
    const r = prepararAdjuntos([
      { idSunat: "a1", nombre: "enorme.pdf", omitido: "tamano" },
    ]);
    expect(r.guardar).toEqual([]);
    expect(r.omitidos).toEqual([
      { idSunat: "a1", nombre: "enorme.pdf", motivo: "tamano" },
    ]);
  });

  it("sin adjuntos → vacío", () => {
    expect(prepararAdjuntos([])).toEqual({ guardar: [], omitidos: [] });
  });
});

describe("prepararAdjuntos: tope de 50 MiB por mensaje, en orden de llegada", () => {
  // Una sola reserva de memoria compartida entre los adjuntos de la prueba.
  const veinte = conFirma(FIRMA_PDF, TOPE_ADJUNTO_BYTES);
  const diez = veinte.subarray(0, 10 * MiB);
  const grande = (idSunat: string): AdjuntoRecibido => ({
    idSunat,
    nombre: `${idSunat}.pdf`,
    bytes: veinte,
  });

  it("20 + 20 + 10 = 50 MiB exactos: se guardan los tres", () => {
    const r = prepararAdjuntos([
      grande("a1"),
      grande("a2"),
      { idSunat: "a3", nombre: "a3.pdf", bytes: diez },
    ]);
    expect(r.omitidos).toEqual([]);
    expect(r.guardar.map((g) => g.idSunat)).toEqual(["a1", "a2", "a3"]);
  });

  it("el que haría pasar los 50 MiB se omite con 'tope_mensaje'; los anteriores se guardan", () => {
    const r = prepararAdjuntos([grande("a1"), grande("a2"), grande("a3")]);
    expect(r.guardar.map((g) => g.idSunat)).toEqual(["a1", "a2"]);
    expect(r.omitidos).toEqual([
      { idSunat: "a3", nombre: "a3.pdf", motivo: "tope_mensaje" },
    ]);
  });

  it("un solo byte de más sobre 50 MiB basta para omitir el último", () => {
    const masUno = conFirma(FIRMA_PDF, 10 * MiB + 1);
    const r = prepararAdjuntos([
      grande("a1"),
      grande("a2"),
      { idSunat: "a3", nombre: "a3.pdf", bytes: masUno },
    ]);
    expect(r.guardar.map((g) => g.idSunat)).toEqual(["a1", "a2"]);
    expect(r.omitidos.map((o) => [o.idSunat, o.motivo])).toEqual([
      ["a3", "tope_mensaje"],
    ]);
  });

  it("un adjunto chico después del que no cabe sí entra si cabe en lo que queda", () => {
    const r = prepararAdjuntos([
      grande("a1"),
      grande("a2"),
      grande("a3"),
      { idSunat: "a4", nombre: "a4.pdf", bytes: diez },
    ]);
    expect(r.guardar.map((g) => g.idSunat)).toEqual(["a1", "a2", "a4"]);
    expect(r.omitidos.map((o) => [o.idSunat, o.motivo])).toEqual([
      ["a3", "tope_mensaje"],
    ]);
  });

  it("lo omitido por MIME o por tamaño no gasta el tope del mensaje", () => {
    const exe = {
      idSunat: "x1",
      nombre: "x1.exe",
      bytes: new Uint8Array(TOPE_ADJUNTO_BYTES),
    } as const;
    const r = prepararAdjuntos([
      exe,
      { idSunat: "x2", nombre: "x2.pdf", omitido: "tamano" },
      grande("a1"),
      grande("a2"),
      { idSunat: "a3", nombre: "a3.pdf", bytes: diez },
    ]);
    expect(r.guardar.map((g) => g.idSunat)).toEqual(["a1", "a2", "a3"]);
    expect(r.omitidos.map((o) => [o.idSunat, o.motivo])).toEqual([
      ["x1", "mime"],
      ["x2", "tamano"],
    ]);
  });
});

describe("ramas restantes de nombres y XML (T15)", () => {
  it("nombre largo con extensión demasiado larga: recorta todo el nombre", () => {
    const n = `${"a".repeat(50)}.${"b".repeat(100)}`;
    const r = sanearNombreAdjunto(n);
    expect(Array.from(r).length).toBe(120);
    expect(r.startsWith("aaaa")).toBe(true);
  });

  it("nombre largo sin punto: se recorta a 120 puntos de código", () => {
    const r = sanearNombreAdjunto("x".repeat(500));
    expect(r).toBe("x".repeat(120));
  });

  it("nombre largo con punto solo al inicio (sin extensión real): se recorta entero", () => {
    const r = sanearNombreAdjunto(`.${"y".repeat(300)}`);
    expect(Array.from(r).length).toBe(120);
  });

  it("nombre largo con extensión corta conserva la extensión", () => {
    const r = sanearNombreAdjunto(`${"z".repeat(300)}.pdf`);
    expect(Array.from(r).length).toBe(120);
    expect(r.endsWith(".pdf")).toBe(true);
  });

  it("nombre largo que termina en punto (extensión de un solo carácter): recorta entero", () => {
    const r = sanearNombreAdjunto(`${"w".repeat(300)}.`);
    expect(Array.from(r).length).toBe(120);
    expect(r).toBe("w".repeat(120));
  });

  const XML = Array.from("<?xml").map((c) => c.charCodeAt(0));
  const BOM = [0xef, 0xbb, 0xbf];

  it.each([
    ["espacio", 0x20],
    ["tabulación", 0x09],
    ["salto de línea", 0x0a],
    ["retorno de carro", 0x0d],
  ])("XML con prólogo seguido de %s", (_n, byte) => {
    expect(mimePorFirma(Uint8Array.from([...XML, byte, 0x76]))).toEqual({
      mime: "application/xml",
      ext: "xml",
    });
  });

  it("XML con BOM de UTF-8 delante", () => {
    expect(mimePorFirma(Uint8Array.from([...BOM, ...XML, 0x20, 0x76]))).toEqual(
      { mime: "application/xml", ext: "xml" },
    );
  });

  it("no es XML: prólogo seguido de otro carácter, o cortado, o BOM sin prólogo", () => {
    expect(mimePorFirma(Uint8Array.from([...XML, 0x73]))).toBeNull();
    expect(mimePorFirma(Uint8Array.from(XML))).toBeNull();
    expect(mimePorFirma(Uint8Array.from(BOM))).toBeNull();
    expect(
      mimePorFirma(Uint8Array.from([...BOM, 0x20, ...XML, 0x20])),
    ).toBeNull();
  });
});
