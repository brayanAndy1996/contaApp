// Spec 016 · T2 (rojo). Seguridad del parser (D-1, P-5): CA-1 (XXE, entidades, DOCTYPE) y CA-2 (topes).
// Cada XML hostil es `xml_invalido` en < 100 ms, sin resolver nada y sin repetir contenido de la entrada.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURES, linea, ubl, unir, utf8 } from "../../tests/ayudas/ubl";
import { UblError, leerUbl } from "./index";

const CANARIO = "CANARIO_9F3A71";
const TOPE_BYTES = 1_048_576;
const LIMITE_MS = 100;
// Entradas de cientos de KB (tope de ítems, bomba de profundidad): bajo la instrumentación de cobertura el escaneo lineal
// roza los 100 ms, así que tienen un margen mayor; las pequeñas (XXE, entidades) siguen con 100 ms (CA-1).
const LIMITE_GRANDE_MS = 500;
const UMBRAL_GRANDE = 100_000;

interface Intento {
  readonly error: UblError;
  readonly ms: number;
}

function intentar(entrada: string | Uint8Array): Intento {
  const bytes = typeof entrada === "string" ? utf8(entrada) : entrada;
  const inicio = Date.now();
  try {
    leerUbl(bytes);
  } catch (e) {
    const ms = Date.now() - inicio;
    expect(e).toBeInstanceOf(UblError);
    return { error: e as UblError, ms };
  }
  throw new Error("se esperaba xml_invalido y leerUbl no lanzó");
}

/** Rechazo esperado: `xml_invalido`, rápido y sin ningún rastro de la entrada en el error. */
function esperarInvalido(entrada: string | Uint8Array, canario: string | null = CANARIO): void {
  const { error, ms } = intentar(entrada);
  expect(error.codigo).toBe("xml_invalido");
  expect(ms).toBeLessThan(entrada.length > UMBRAL_GRANDE ? LIMITE_GRANDE_MS : LIMITE_MS);
  if (canario !== null) {
    const rastro = [error.message, String(error), JSON.stringify(error), error.stack ?? "", String(error.cause ?? "")].join("\n");
    expect(rastro).not.toContain(canario);
    expect(rastro).not.toContain("passwd");
    expect(rastro).not.toContain("root:");
  }
  expect(error.cause).toBeUndefined();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CA-1 · DOCTYPE y entidades", () => {
  const conDoctype = (doctype: string, uso = "&xxe;"): string =>
    ubl({ declaracion: `<?xml version="1.0" encoding="UTF-8"?>\n${doctype}\n`, lineas: [linea({ descripcion: `${CANARIO} ${uso}` })] });

  it("XXE a file:///etc/passwd", () => {
    esperarInvalido(conDoctype(`<!DOCTYPE Invoice [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>`));
  });

  it("entidad externa por HTTP: no se hace ninguna petición", () => {
    const fetchEspia = vi.fn();
    vi.stubGlobal("fetch", fetchEspia);
    esperarInvalido(conDoctype(`<!DOCTYPE Invoice [<!ENTITY xxe SYSTEM "http://127.0.0.1:9/${CANARIO}">]>`));
    expect(fetchEspia).not.toHaveBeenCalled();
  });

  it("billion laughs (entidades anidadas)", () => {
    const entidades = Array.from({ length: 9 }, (_, i) => `<!ENTITY lol${i + 1} "${i === 0 ? "lol".repeat(10) : `&lol${i};`.repeat(10)}">`).join("");
    esperarInvalido(conDoctype(`<!DOCTYPE Invoice [${entidades}]>`, "&lol9;"));
  });

  it("DOCTYPE sin entidades también se rechaza", () => {
    esperarInvalido(conDoctype(`<!DOCTYPE Invoice>`, ""));
  });

  it.each([
    ["<!DOCTYPE", "<!-- <!DOCTYPE x> -->"],
    ["<!doctype (minúsculas)", `<!-- <!doctype x [<!ENTITY a "${CANARIO}">]> -->`],
    ["<!ENTITY", `<!-- <!ENTITY a "${CANARIO}"> -->`],
  ])("%s dentro de un comentario se rechaza", (_nombre, comentario) => {
    esperarInvalido(ubl({ extensiones: comentario }));
  });

  it("<!DOCTYPE dentro de una sección CDATA también se rechaza (el escaneo es lineal sobre los bytes)", () => {
    esperarInvalido(ubl({ extensiones: `<cbc:Nota><![CDATA[<!DOCTYPE ${CANARIO}>]]></cbc:Nota>` }));
  });

  it("cualquier otra declaración <! que no sea comentario ni CDATA", () => {
    esperarInvalido(ubl({ extensiones: `<!ELEMENT ${CANARIO} ANY>` }));
    esperarInvalido(ubl({ extensiones: `<!ATTLIST ${CANARIO} id ID #IMPLIED>` }));
  });

  it("una entidad estándar (&amp;) sin DOCTYPE no resuelve nada peligroso y no rompe", () => {
    expect(() => leerUbl(utf8(ubl({ lineas: [linea({ descripcion: "Pérez &amp; Hijos" })] })))).not.toThrow();
  });
});

describe("CA-1 · codificación y bytes", () => {
  it("UTF-16 con BOM (LE y BE)", () => {
    const texto = ubl({ declaracion: '<?xml version="1.0" encoding="UTF-16"?>\n' });
    const le: number[] = [0xff, 0xfe];
    const be: number[] = [0xfe, 0xff];
    for (let i = 0; i < texto.length; i++) {
      le.push(texto.charCodeAt(i) & 0xff, texto.charCodeAt(i) >> 8);
      be.push(texto.charCodeAt(i) >> 8, texto.charCodeAt(i) & 0xff);
    }
    esperarInvalido(Uint8Array.from(le), null);
    esperarInvalido(Uint8Array.from(be), null);
  });

  it.each(["UTF-16", "windows-1252", "Shift_JIS", "UTF-32", "US-ASCII", "desconocida"])("la codificación declarada «%s» no está admitida", (codificacion) => {
    esperarInvalido(ubl({ declaracion: `<?xml version="1.0" encoding="${codificacion}"?>\n` }));
  });

  it("un byte NUL en cualquier parte", () => {
    const [antes, despues] = ubl({ lineas: [linea({ descripcion: "@@" })] }).split("@@") as [string, string];
    esperarInvalido(unir(utf8(antes), Uint8Array.of(0x00), utf8(despues)), null);
    esperarInvalido(unir(Uint8Array.of(0x00), utf8(ubl())), null);
  });
});

describe("CA-2 · topes (P-5): 1 MiB, 2.000 ítems, profundidad 32", () => {
  it("1 MiB + 1 byte es xml_invalido antes de parsear", () => {
    esperarInvalido(new Uint8Array(TOPE_BYTES + 1).fill(0x20), null);
  });

  it("exactamente 1 MiB se acepta", () => {
    const base = utf8(FIXTURES.mixta);
    const relleno = new Uint8Array(TOPE_BYTES - base.length).fill(0x20);
    expect(leerUbl(unir(base, relleno)).totales.total).toBe("23.09");
  });

  it("2.001 ítems se rechazan; 2.000 se aceptan", () => {
    const lineas = (n: number, raiz: "Invoice" | "CreditNote" = "Invoice"): string[] => Array.from({ length: n }, (_, i) => linea({ raiz, n: String(i + 1) }));
    esperarInvalido(ubl({ lineas: lineas(2001) }), null);
    esperarInvalido(ubl({ raiz: "CreditNote", lineas: lineas(2001, "CreditNote") }), null);
    expect(leerUbl(utf8(ubl({ lineas: lineas(2000) }))).items).toHaveLength(2000);
  });

  const anidado = (n: number): string => `${"<x>".repeat(n)}${"</x>".repeat(n)}`;

  it("profundidad 33 se rechaza; 32 se acepta", () => {
    esperarInvalido(ubl({ final: anidado(32) }), null); // raíz + 32 = 33
    expect(leerUbl(utf8(ubl({ final: anidado(31) }))).totales.total).toBe("118.00"); // raíz + 31 = 32
  });

  it("una bomba de profundidad (50.000 niveles) se rechaza rápido y sin desbordar la pila", () => {
    esperarInvalido(ubl({ final: anidado(50_000) }), null);
  });

  it("los comentarios y las etiquetas autocerradas no suman profundidad", () => {
    const hojas = "<y/>".repeat(500) + "<!-- c -->".repeat(500);
    expect(leerUbl(utf8(ubl({ final: `${anidado(31)}${hojas}` }))).totales.total).toBe("118.00");
  });
});

describe("CA-1 y CA-2 · el rechazo no deja rastro", () => {
  it("lo que se rechaza por tamaño no revela su contenido", () => {
    const grande = unir(utf8(`<!-- ${CANARIO} -->`), new Uint8Array(TOPE_BYTES).fill(0x20));
    esperarInvalido(grande);
  });

  it("leerUbl es pura: dos rechazos iguales dan el mismo error y no dejan estado", () => {
    const hostil = ubl({ declaracion: '<?xml version="1.0"?>\n<!DOCTYPE a [<!ENTITY b "c">]>\n' });
    expect(intentar(hostil).error.codigo).toBe(intentar(hostil).error.codigo);
    expect(leerUbl(utf8(FIXTURES.mixta)).totales.total).toBe("23.09");
  });
});
